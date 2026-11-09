import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, sep } from 'path';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import os from 'os';
import crypto from 'crypto';
import { Orchestrator } from './agents/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Automatically load .env configuration if present (standard for Linux/EC2 & local dev)
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  try {
    const envContent = readFileSync(envPath, 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
    console.warn('[Env] Notice loading .env file:', err.message);
  }
}

const app = express();
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3000;

// Security Hardening: Disable Express fingerprinting header
app.disable('x-powered-by');

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Directories
const DATA_DIR = join(process.cwd(), 'data');
const USERS_DIR = join(DATA_DIR, 'users');
const GLOBAL_ATTEMPTS_DIR = join(DATA_DIR, 'attempts');

if (!existsSync(USERS_DIR)) mkdirSync(USERS_DIR, { recursive: true });
if (!existsSync(GLOBAL_ATTEMPTS_DIR)) mkdirSync(GLOBAL_ATTEMPTS_DIR, { recursive: true });

const GLOBAL_BANKS_DIR = join(DATA_DIR, 'global-banks');
if (!existsSync(GLOBAL_BANKS_DIR)) mkdirSync(GLOBAL_BANKS_DIR, { recursive: true });

// Admin usernames — strictly configured via ADMIN_USERNAMES env var or trusted defaults
const envAdmins = (process.env.ADMIN_USERNAMES || 'samar,samarth,samarth1')
  .split(',')
  .map(u => u.trim().toLowerCase())
  .filter(Boolean);
const ADMIN_USERNAMES = new Set(envAdmins);
function isAdminUsername(username) {
  return ADMIN_USERNAMES.has((username || '').toLowerCase());
}

// ==================== SECURITY & RATE LIMITING ====================
const authRateLimiter = new Map(); // ip -> { count, firstAttempt }
const AUTH_RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_RATE_MAX_ATTEMPTS = 15;

function checkAuthRateLimit(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const record = authRateLimiter.get(ip);

  if (record) {
    if (now - record.firstAttempt < AUTH_RATE_WINDOW_MS) {
      if (record.count >= AUTH_RATE_MAX_ATTEMPTS) {
        const remainingSec = Math.ceil((AUTH_RATE_WINDOW_MS - (now - record.firstAttempt)) / 1000);
        res.status(429).json({
          success: false,
          error: `Too many login attempts from this network. Please wait ${remainingSec} seconds before trying again.`
        });
        return false;
      }
      record.count++;
    } else {
      authRateLimiter.set(ip, { count: 1, firstAttempt: now });
    }
  } else {
    authRateLimiter.set(ip, { count: 1, firstAttempt: now });
  }
  return true;
}

function resetAuthRateLimit(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  authRateLimiter.delete(ip);
}

/**
 * Path Traversal Sanitizer (CWE-22 Defense)
 * Ensures file access stays strictly inside the designated directory.
 */
function getSafeFilePath(baseDir, fileId) {
  if (!fileId || typeof fileId !== 'string') return null;
  // Strictly enforce valid slug / ID: alphanumeric, underscores, hyphens only
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(fileId)) return null;
  const canonicalBase = resolve(baseDir);
  const target = resolve(join(baseDir, `${fileId}.json`));
  if (!target.startsWith(canonicalBase + sep)) return null;
  return target;
}

// Seed default shared banks if global-banks is empty
function seedGlobalBanks() {
  try {
    const existing = readdirSync(GLOBAL_BANKS_DIR).filter(f => f.endsWith('.json'));
    if (existing.length === 0) {
      const csPath = join(__dirname, 'sample-questions.json');
      const codePath = join(__dirname, 'sample-code-questions.json');
      if (existsSync(csPath)) {
        const csData = JSON.parse(readFileSync(csPath, 'utf8'));
        writeFileSync(join(GLOBAL_BANKS_DIR, 'shared-cs-theory.json'), JSON.stringify({
          id: 'shared-cs-theory',
          name: 'Computer Science Core (82 Questions)',
          description: 'Algorithms, Data Structures, Operating Systems, Networks & Databases',
          publishedAt: new Date().toISOString(),
          publishedBy: 'System Admin',
          questions: csData.questions || []
        }, null, 2));
      }
      if (existsSync(codePath)) {
        const codeData = JSON.parse(readFileSync(codePath, 'utf8'));
        writeFileSync(join(GLOBAL_BANKS_DIR, 'shared-code-snippets.json'), JSON.stringify({
          id: 'shared-code-snippets',
          name: 'Code Snippets & Debugging (44 Questions)',
          description: 'Python, JavaScript, SQL, C++, Java & Algorithmic Tracing',
          publishedAt: new Date().toISOString(),
          publishedBy: 'System Admin',
          questions: codeData.questions || []
        }, null, 2));
      }
      console.log('[Setup] Seeded initial global shared banks into data/global-banks/');
    }
  } catch (err) {
    console.warn('[Setup] Note on seeding global banks:', err.message);
  }
}
seedGlobalBanks();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

// ==================== AUTH & SESSION STORE ====================
const activeSessions = new Map();     // token -> { username, displayName, userDir, createdAt }
const userOrchestrators = new Map();  // username -> Orchestrator instance
const guestOrchestrator = new Orchestrator();

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Modern password hashing using Node.js crypto.scrypt
 */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/**
 * Timing-safe password verification with automatic migration from legacy SHA-256
 */
function verifyPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return { valid: false };

  // Legacy SHA-256 verification (length 64)
  if (storedHash.length === 64) {
    const legacyHash = crypto.createHash('sha256').update(password + salt).digest('hex');
    const bufLegacy = Buffer.from(legacyHash);
    const bufStored = Buffer.from(storedHash);
    if (bufLegacy.length === bufStored.length && crypto.timingSafeEqual(bufLegacy, bufStored)) {
      return { valid: true, needsUpgrade: true };
    }
  }

  // Modern scrypt verification (length 128)
  const scryptHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const bufScrypt = Buffer.from(scryptHash);
  const bufStored = Buffer.from(storedHash);
  if (bufScrypt.length === bufStored.length && crypto.timingSafeEqual(bufScrypt, bufStored)) {
    return { valid: true, needsUpgrade: false };
  }

  return { valid: false };
}

function getUserDir(username) {
  const safeName = (username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return join(USERS_DIR, safeName);
}

function ensureUserDirs(userDir) {
  const banksDir = join(userDir, 'banks');
  const attemptsDir = join(userDir, 'attempts');
  if (!existsSync(banksDir)) mkdirSync(banksDir, { recursive: true });
  if (!existsSync(attemptsDir)) mkdirSync(attemptsDir, { recursive: true });
  return { banksDir, attemptsDir };
}

// Authentication middleware with session expiration check
app.use((req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-session-token'] || null);
  if (token && activeSessions.has(token)) {
    const session = activeSessions.get(token);
    if (Date.now() - session.createdAt > SESSION_MAX_AGE_MS) {
      activeSessions.delete(token);
      req.user = null;
      req.token = null;
    } else {
      req.user = session;
      req.token = token;
    }
  } else {
    req.user = null;
    req.token = null;
  }
  next();
});

function getOrchestratorForReq(req) {
  if (req.user) {
    if (!userOrchestrators.has(req.user.username)) {
      const { attemptsDir } = ensureUserDirs(req.user.userDir);
      userOrchestrators.set(req.user.username, new Orchestrator({
        username: req.user.username,
        userDir: req.user.userDir,
        attemptsDir
      }));
    }
    return userOrchestrators.get(req.user.username);
  }
  return guestOrchestrator;
}

function getAttemptsDirForReq(req) {
  if (req.user) {
    const { attemptsDir } = ensureUserDirs(req.user.userDir);
    return attemptsDir;
  }
  return GLOBAL_ATTEMPTS_DIR;
}

/**
 * Require authentication middleware.
 * Ensures no unauthenticated guest can give input, start exams, upload question banks, or generate AI quizzes.
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please sign in or create an account to access this feature.'
    });
  }
  next();
}

// ==================== AUTH ROUTES ====================

/**
 * POST /api/auth/register — Create a new user profile with private folders
 */
app.post('/api/auth/register', (req, res) => {
  try {
    if (!checkAuthRateLimit(req, res)) return;

    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
      return res.status(400).json({ success: false, error: 'Username must be 3-20 alphanumeric characters or underscores' });
    }

    if (password.length < 4) {
      return res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
    }

    const userDir = getUserDir(cleanUsername);
    const profilePath = join(userDir, 'profile.json');

    if (existsSync(profilePath)) {
      return res.status(409).json({ success: false, error: 'Username already taken' });
    }

    // Ensure folder structure: data/users/<username>/{banks, attempts}
    ensureUserDirs(userDir);

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);

    const isAdmin = isAdminUsername(cleanUsername);
    const profile = {
      username: cleanUsername,
      displayName: (displayName || cleanUsername).trim(),
      role: isAdmin ? 'admin' : 'user',
      salt,
      passwordHash,
      createdAt: new Date().toISOString()
    };

    writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    // Create session token
    const token = crypto.randomBytes(24).toString('hex');
    activeSessions.set(token, {
      username: cleanUsername,
      displayName: profile.displayName,
      role: profile.role,
      userDir,
      createdAt: Date.now()
    });

    resetAuthRateLimit(req);
    console.log(`[Auth] Registered new user "${cleanUsername}" (role: ${profile.role}) with private folder: ${userDir}`);
    res.json({
      success: true,
      token,
      user: { username: cleanUsername, displayName: profile.displayName, role: profile.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/login — Authenticate an existing user
 */
app.post('/api/auth/login', (req, res) => {
  try {
    if (!checkAuthRateLimit(req, res)) return;

    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const userDir = getUserDir(cleanUsername);
    const profilePath = join(userDir, 'profile.json');

    if (!existsSync(profilePath)) {
      return res.status(401).json({ success: false, error: 'Invalid username or password' });
    }

    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    const authCheck = verifyPassword(password, profile.salt, profile.passwordHash);

    if (!authCheck.valid) {
      return res.status(401).json({ success: false, error: 'Invalid username or password' });
    }

    // Auto-upgrade legacy hash to modern scrypt
    if (authCheck.needsUpgrade) {
      profile.passwordHash = hashPassword(password, profile.salt);
      try {
        writeFileSync(profilePath, JSON.stringify(profile, null, 2));
        console.log(`[Auth Security] Upgraded password hash to scrypt for user "${cleanUsername}"`);
      } catch (e) {
        console.warn(`[Auth Security] Failed to save upgraded hash:`, e.message);
      }
    }

    resetAuthRateLimit(req);
    ensureUserDirs(userDir);

    const token = crypto.randomBytes(24).toString('hex');
    const userRole = profile.role || (isAdminUsername(cleanUsername) ? 'admin' : 'user');
    activeSessions.set(token, {
      username: cleanUsername,
      displayName: profile.displayName,
      role: userRole,
      userDir,
      createdAt: Date.now()
    });

    console.log(`[Auth] User "${cleanUsername}" (role: ${userRole}) logged in`);
    res.json({
      success: true,
      token,
      user: { username: cleanUsername, displayName: profile.displayName, role: userRole }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/logout — Log out of active session
 */
app.post('/api/auth/logout', (req, res) => {
  if (req.token) {
    activeSessions.delete(req.token);
  }
  res.json({ success: true });
});

/**
 * GET /api/auth/me — Return current user session status
 */
app.get('/api/auth/me', (req, res) => {
  if (req.user) {
    res.json({
      authenticated: true,
      user: { username: req.user.username, displayName: req.user.displayName, role: req.user.role || 'user' }
    });
  } else {
    res.json({ authenticated: false, user: null });
  }
});

// ==================== USER SAVED BANKS ROUTES ====================

/**
 * GET /api/user/banks — List user's saved question banks
 */
app.get('/api/user/banks', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Login required to view saved question banks' });
  }

  try {
    const { banksDir } = ensureUserDirs(req.user.userDir);
    const files = readdirSync(banksDir).filter(f => f.endsWith('.json'));

    const banks = files.map(filename => {
      try {
        const content = JSON.parse(readFileSync(join(banksDir, filename), 'utf8'));
        return {
          id: filename.replace('.json', ''),
          name: content.name || filename.replace('.json', ''),
          questionCount: Array.isArray(content.questions) ? content.questions.length : 0,
          savedAt: content.savedAt || null,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    res.json({ success: true, banks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/user/banks — Save a question bank to user's private folder
 */
app.post('/api/user/banks', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Login required to save question banks' });
  }

  try {
    const { name, data } = req.body || {};
    if (!data || !Array.isArray(data.questions)) {
      return res.status(400).json({ success: false, error: 'Valid question bank data with questions array required' });
    }

    const { banksDir } = ensureUserDirs(req.user.userDir);
    const safeName = (name || 'question-bank').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const bankId = `bank-${Date.now()}-${safeName}`;

    const bankRecord = {
      id: bankId,
      name: name || 'Custom Bank',
      savedAt: new Date().toISOString(),
      questions: data.questions
    };

    writeFileSync(join(banksDir, `${bankId}.json`), JSON.stringify(bankRecord, null, 2));
    console.log(`[Banks] Saved bank "${bankRecord.name}" to user ${req.user.username}`);
    res.json({ success: true, bankId, name: bankRecord.name, questionCount: data.questions.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/user/banks/:id — Load a specific saved question bank
 */
app.get('/api/user/banks/:id', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Login required' });
  }

  try {
    const { banksDir } = ensureUserDirs(req.user.userDir);
    const bankFile = getSafeFilePath(banksDir, req.params.id);
    if (!bankFile || !existsSync(bankFile)) {
      return res.status(404).json({ success: false, error: 'Question bank not found' });
    }

    const content = JSON.parse(readFileSync(bankFile, 'utf8'));
    res.json({ success: true, bank: content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/user/banks/:id — Delete a saved question bank
 */
app.delete('/api/user/banks/:id', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Login required' });
  }

  try {
    const { banksDir } = ensureUserDirs(req.user.userDir);
    const bankFile = getSafeFilePath(banksDir, req.params.id);
    if (bankFile && existsSync(bankFile)) {
      unlinkSync(bankFile);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== SHARED / GLOBAL QUESTION BANKS ====================

/**
 * Helper: ensure requester has admin privileges
 */
function requireAdmin(req, res) {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return false;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Administrator access required' });
    return false;
  }
  return true;
}

/**
 * GET /api/shared/banks (or /api/admin/banks) — List all globally shared question banks
 * Accessible to all users and guests
 */
function handleListSharedBanks(req, res) {
  try {
    const files = readdirSync(GLOBAL_BANKS_DIR).filter(f => f.endsWith('.json'));
    const banks = files.map(filename => {
      try {
        const content = JSON.parse(readFileSync(join(GLOBAL_BANKS_DIR, filename), 'utf8'));
        return {
          id: filename.replace('.json', ''),
          name: content.name || filename.replace('.json', ''),
          description: content.description || '',
          questionCount: Array.isArray(content.questions) ? content.questions.length : 0,
          publishedAt: content.publishedAt || null,
          publishedBy: content.publishedBy || 'admin'
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    res.json({ success: true, banks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

app.get('/api/shared/banks', handleListSharedBanks);
app.get('/api/admin/banks', handleListSharedBanks);

/**
 * GET /api/shared/banks/:id — Load a specific shared question bank
 * Accessible to all users and guests
 */
function handleGetSharedBank(req, res) {
  try {
    const bankFile = getSafeFilePath(GLOBAL_BANKS_DIR, req.params.id);
    if (!bankFile || !existsSync(bankFile)) {
      return res.status(404).json({ success: false, error: 'Shared bank not found' });
    }
    const content = JSON.parse(readFileSync(bankFile, 'utf8'));
    res.json({ success: true, bank: content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

app.get('/api/shared/banks/:id', handleGetSharedBank);
app.get('/api/admin/banks/:id', handleGetSharedBank);

/**
 * POST /api/admin/banks — Admin saves/publishes a question bank to the shared global directory
 */
app.post('/api/admin/banks', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const { name, description, data } = req.body || {};
    if (!data || !Array.isArray(data.questions)) {
      return res.status(400).json({ success: false, error: 'Valid question bank data with questions array required' });
    }

    const safeName = (name || 'shared-bank').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const bankId = `shared-${Date.now()}-${safeName}`;

    const bankRecord = {
      id: bankId,
      name: name || 'Shared Question Bank',
      description: description || 'Created by Admin',
      publishedAt: new Date().toISOString(),
      publishedBy: req.user.displayName || req.user.username,
      questions: data.questions
    };

    writeFileSync(join(GLOBAL_BANKS_DIR, `${bankId}.json`), JSON.stringify(bankRecord, null, 2));
    console.log(`[Admin] Admin "${req.user.username}" published shared bank "${bankRecord.name}" (${data.questions.length} Qs)`);
    res.json({ success: true, bankId, name: bankRecord.name, questionCount: data.questions.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/admin/banks/:id — Admin deletes a shared question bank
 */
app.delete('/api/admin/banks/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const bankFile = getSafeFilePath(GLOBAL_BANKS_DIR, req.params.id);
    if (bankFile && existsSync(bankFile)) {
      unlinkSync(bankFile);
      console.log(`[Admin] Admin "${req.user.username}" deleted shared bank ${req.params.id}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== EXAM & ORCHESTRATOR ROUTES ====================

/**
 * POST /api/ai/generate — Generate questions using Google Gemini API (Embedded Key & Login Required)
 */
app.post('/api/ai/generate', requireAuth, async (req, res) => {
  try {
    const { prompt, count, difficulty, includeCode, model, apiKey } = req.body || {};
    const effectiveApiKey = (process.env.GEMINI_API_KEY || apiKey || '').trim();

    if (!effectiveApiKey) {
      return res.status(500).json({
        success: false,
        error: 'Google Gemini API key not configured on server. Please set GEMINI_API_KEY in .env.'
      });
    }

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Prompt or topic description is required.'
      });
    }

    const orchestrator = getOrchestratorForReq(req);
    const result = await orchestrator.generateFromAI({
      prompt,
      count: parseInt(count, 10) || 10,
      difficulty: difficulty || 'mixed',
      includeCode: includeCode !== false,
      apiKey: effectiveApiKey,
      model: model || 'gemini-3.5-flash-lite'
    });

    res.json(result);
  } catch (err) {
    console.error('[AI Gen Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/state — Current user's orchestrator state
 */
app.get('/api/state', requireAuth, (req, res) => {
  const orchestrator = getOrchestratorForReq(req);
  res.json(orchestrator.getState());
});

/**
 * POST /api/upload — Upload and validate a question bank
 */
app.post('/api/upload', requireAuth, (req, res) => {
  try {
    const orchestrator = getOrchestratorForReq(req);
    const result = orchestrator.upload(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/generate — Generate a paper from the validated pool
 */
app.post('/api/generate', requireAuth, (req, res) => {
  try {
    const orchestrator = getOrchestratorForReq(req);
    const result = orchestrator.generatePaper(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/submit — Submit exam answers
 */
app.post('/api/submit', requireAuth, (req, res) => {
  try {
    const orchestrator = getOrchestratorForReq(req);
    const result = orchestrator.submit(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/reset — Reset for a new exam (keeps pool)
 */
app.post('/api/reset', requireAuth, (req, res) => {
  const orchestrator = getOrchestratorForReq(req);
  orchestrator.reset();
  res.json({ success: true, state: orchestrator.getState() });
});

/**
 * POST /api/full-reset — Full reset (clears everything)
 */
app.post('/api/full-reset', requireAuth, (req, res) => {
  const orchestrator = getOrchestratorForReq(req);
  orchestrator.fullReset();
  res.json({ success: true, state: orchestrator.getState() });
});

/**
 * GET /api/attempts — List past attempts for this user
 */
app.get('/api/attempts', requireAuth, (req, res) => {
  try {
    const targetDir = getAttemptsDirForReq(req);
    if (!existsSync(targetDir)) {
      return res.json({ attempts: [] });
    }

    const files = readdirSync(targetDir).filter(f => f.endsWith('.json'));
    const attempts = files.map(file => {
      try {
        const data = JSON.parse(readFileSync(join(targetDir, file), 'utf-8'));
        return {
          id: data.id,
          timestamp: data.timestamp,
          score: data.report?.scoreSummary?.score ?? data.evaluation?.overallScore ?? 0,
          total: data.report?.scoreSummary?.total ?? data.evaluation?.totalMarks ?? 0,
          percent: data.report?.scoreSummary?.percent ?? data.evaluation?.accuracyPercent ?? 0,
          grade: data.report?.scoreSummary?.grade ?? '—',
          attempted: data.report?.scoreSummary?.attempted ?? data.evaluation?.totalAttempted ?? 0,
          skipped: data.report?.scoreSummary?.skipped ?? data.evaluation?.totalSkipped ?? 0,
          durationSec: data.session?.totalTimeSec ?? data.report?.timeAnalysis?.totalTimeSec ?? 0,
          paperName: data.report?.name || data.paper?.name || (data.report?.topicAnalysis?.[0]?.topic ? `${data.report.topicAnalysis[0].topic} Exam` : 'Practice Exam'),
          topTopic: data.report?.topicAnalysis?.[0]?.topic || null,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    attempts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ attempts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/attempt/:id — Get a specific attempt's full report
 */
app.get('/api/attempt/:id', requireAuth, (req, res) => {
  try {
    const targetDir = getAttemptsDirForReq(req);
    const filePath = getSafeFilePath(targetDir, req.params.id);
    if (!filePath || !existsSync(filePath)) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sample — Serve the sample question bank
 */
app.get('/api/sample', (req, res) => {
  try {
    const samplePath = join(__dirname, 'sample-questions.json');
    if (!existsSync(samplePath)) {
      return res.status(404).json({ error: 'Sample question bank not found' });
    }
    const data = JSON.parse(readFileSync(samplePath, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sample-code — Serve the code-snippet question bank
 */
app.get('/api/sample-code', (req, res) => {
  try {
    const samplePath = join(__dirname, 'sample-code-questions.json');
    if (!existsSync(samplePath)) {
      return res.status(404).json({ error: 'Code question bank not found' });
    }
    const data = JSON.parse(readFileSync(samplePath, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/info — Server network info
 */
app.get('/api/info', (req, res) => {
  const ips = getNetworkIPs();
  res.json({
    localIPs: ips,
    port: DEFAULT_PORT
  });
});

// Fallback — serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Network IP helper
function getNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Start server on 0.0.0.0 (all network interfaces) with automatic port fallback
function startServer(port) {
  // Bind to '0.0.0.0' to host on local IP for phones, tablets, and LAN PCs
  const server = app.listen(port, '0.0.0.0', () => {
    const ips = getNetworkIPs();
    console.log(`\n  ╔════════════════════════════════════════════════════════════╗`);
    console.log(`  ║   📝 Paper Simulator v1.0 — Multi-User & Network Ready     ║`);
    console.log(`  ╠════════════════════════════════════════════════════════════╣`);
    console.log(`  ║   Local:   http://localhost:${port}                           ║`);
    ips.forEach(ip => {
      const padded = `  ║   Network: http://${ip}:${port}`.padEnd(63) + '║';
      console.log(padded);
    });
    console.log(`  ╚════════════════════════════════════════════════════════════╝\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`  ⚠️  Port ${port} in use, trying port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(DEFAULT_PORT);
