/* ============================================================
   Paper Simulator — Frontend Application
   SPA with exam engine, timer, and results visualization
   ============================================================ */

// ==================== STATE ====================
const state = {
  currentView: 'upload',
  user: null,               // { username, displayName }
  currentUploadedData: null,// raw questions data for saving
  authMode: 'login',        // 'login' | 'register'
  paper: null,
  compositionMeta: null,
  validationReport: null,

  // Exam state
  examStartTime: null,
  examEndTime: null,
  currentQuestion: 0,
  answers: {},         // questionId -> selectedOption (index)
  flagged: new Set(),
  events: [],          // session events log
  timerInterval: null,
  totalSeconds: 3600,  // 60 minutes
  remainingSeconds: 3600,

  // Results
  report: null,
  answerKey: null,
};

// ==================== UTILITIES ====================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatContent(text) {
  if (!text) return '';

  // Extract triple-backtick code blocks first to protect them from regex/break replacing
  const codeBlocks = [];
  let processed = String(text).replace(/```([a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g, (match, lang, code) => {
    const trimmedCode = code.replace(/^\r?\n|\r?\n$/g, '');
    let highlighted = escapeHtml(trimmedCode);
    const language = (lang || '').trim().toLowerCase();

    if (window.hljs) {
      try {
        if (language && hljs.getLanguage(language)) {
          highlighted = hljs.highlight(trimmedCode, { language, ignoreIllegals: true }).value;
        } else {
          highlighted = hljs.highlightAuto(trimmedCode).value;
        }
      } catch (e) {
        highlighted = escapeHtml(trimmedCode);
      }
    }

    const blockId = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${language || 'code'}</span>
          <button type="button" class="copy-code-btn" onclick="copySnippet(this)">Copy</button>
        </div>
        <pre><code class="language-${language || 'plaintext'}">${highlighted}</code></pre>
      </div>
    `);
    return blockId;
  });

  // Extract inline code `...`
  const inlineCodes = [];
  processed = processed.replace(/`([^`]+)`/g, (match, code) => {
    const inlineId = `__INLINE_CODE_${inlineCodes.length}__`;
    inlineCodes.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
    return inlineId;
  });

  // Escape HTML on remaining prose text
  processed = escapeHtml(processed);

  // Convert newlines to <br> for remaining prose
  processed = processed.replace(/\r?\n/g, '<br>');

  // Restore inline codes
  inlineCodes.forEach((html, i) => {
    processed = processed.replace(`__INLINE_CODE_${i}__`, html);
  });

  // Restore code blocks
  codeBlocks.forEach((html, i) => {
    processed = processed.replace(`__CODE_BLOCK_${i}__`, html);
  });

  return processed;
}

window.copySnippet = function (button) {
  const wrapper = button.closest('.code-block-wrapper');
  if (!wrapper) return;
  const codeEl = wrapper.querySelector('code');
  if (!codeEl) return;
  const text = codeEl.innerText || codeEl.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const oldText = button.textContent;
    button.textContent = 'Copied! ✓';
    button.style.background = 'var(--emerald)';
    button.style.borderColor = 'var(--emerald)';
    button.style.color = '#fff';
    setTimeout(() => {
      button.textContent = oldText;
      button.style.background = '';
      button.style.borderColor = '';
      button.style.color = '';
    }, 2000);
  }).catch(() => {
    toast('Failed to copy to clipboard', 'warning');
  });
};

function showView(viewName) {
  $$('.view').forEach(v => v.classList.remove('active'));
  const view = $(`#view-${viewName}`);
  if (view) {
    view.classList.add('active');
    // Re-trigger animation
    view.style.animation = 'none';
    view.offsetHeight; // reflow
    view.style.animation = '';
  }
  state.currentView = viewName;

  // Update nav
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = $(`[data-view="${viewName}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Sync running session state and hub UI
  if (viewName !== 'exam') {
    saveActiveSession();
    updateRunningSessionUI();
    if (viewName === 'upload') {
      renderEndedSessions();
    }
  } else {
    // When inside exam, hide top nav resume button
    const navResumeBtn = $('#nav-resume-btn');
    if (navResumeBtn) navResumeBtn.classList.add('hidden');
  }
}

function showLoading(text = 'Processing...') {
  $('.loader-text').textContent = text;
  $('#loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  $('#loading-overlay').classList.add('hidden');
}

function toast(message, type = 'info', duration = 4000) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function confirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <h3>${title}</h3>
        <p>${message}</p>
        <div class="confirm-actions">
          <button class="btn btn-outline" id="confirm-cancel">Cancel</button>
          <button class="btn btn-primary" id="confirm-ok">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#confirm-ok').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
  });
}

async function api(endpoint, method = 'GET', body = null) {
  const token = localStorage.getItem('ps_auth_token');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${endpoint}`, opts);

  if (res.status === 401 && !endpoint.startsWith('/auth/')) {
    state.user = null;
    localStorage.removeItem('ps_auth_token');
    renderUserBadge();
    const data = await res.json().catch(() => ({}));
    toast(data.error || 'Please sign in to continue', 'warning');
    openAuthModal('login');
    return data;
  }

  return res.json();
}

function ensureLoggedIn(actionDescription = 'take mock exams') {
  if (state.user) return true;
  toast(`🔒 Sign in required to ${actionDescription}. Please sign in or create an account.`, 'warning');
  openAuthModal('login');
  return false;
}

// ==================== AUTH & USER MANAGEMENT ====================
async function checkAuth() {
  const token = localStorage.getItem('ps_auth_token');
  if (!token) {
    state.user = null;
    renderUserBadge();
    return;
  }

  try {
    const res = await api('/auth/me');
    if (res.authenticated && res.user) {
      state.user = res.user;
    } else {
      localStorage.removeItem('ps_auth_token');
      state.user = null;
    }
  } catch {
    state.user = null;
  }
  renderUserBadge();
}

function renderUserBadge() {
  const badge = $('#user-badge');
  const loginBtn = $('#login-modal-btn');
  const roleBadge = $('#user-role-badge');
  const publishBtn = $('#publish-global-btn');
  const savedBanksSection = $('#saved-banks-section');
  const authBanner = $('#auth-required-banner');

  if (state.user) {
    badge.classList.remove('hidden');
    loginBtn.classList.add('hidden');
    if (authBanner) authBanner.classList.add('hidden');
    $('#user-display-name').textContent = state.user.displayName || state.user.username;

    // Admin role handling
    if (state.user.role === 'admin') {
      if (roleBadge) roleBadge.classList.remove('hidden');
      if (publishBtn) publishBtn.classList.remove('hidden');
    } else {
      if (roleBadge) roleBadge.classList.add('hidden');
      if (publishBtn) publishBtn.classList.add('hidden');
    }

    if (savedBanksSection) {
      savedBanksSection.classList.remove('hidden');
      loadSavedBanks();
    }
  } else {
    badge.classList.add('hidden');
    loginBtn.classList.remove('hidden');
    if (authBanner) authBanner.classList.remove('hidden');
    if (roleBadge) roleBadge.classList.add('hidden');
    if (publishBtn) publishBtn.classList.add('hidden');
    if (savedBanksSection) savedBanksSection.classList.add('hidden');
  }

  // Refresh shared banks to show/hide admin controls if any
  loadSharedBanks();
}

function openAuthModal(mode = 'login') {
  state.authMode = mode;
  const modal = $('#auth-modal');
  const title = $('#auth-modal-title');
  const submitBtn = $('#auth-submit-btn');
  const nameGroup = $('#display-name-group');
  const errorMsg = $('#auth-error-msg');

  errorMsg.classList.add('hidden');
  errorMsg.textContent = '';
  $('#auth-username').value = '';
  $('#auth-password').value = '';

  if (mode === 'register') {
    title.textContent = 'Create an Account';
    submitBtn.textContent = 'Register & Create Folders';
    nameGroup.style.display = 'block';
    $('#tab-register-btn').classList.add('active');
    $('#tab-login-btn').classList.remove('active');
  } else {
    title.textContent = 'Sign In';
    submitBtn.textContent = 'Sign In';
    nameGroup.style.display = 'none';
    $('#tab-login-btn').classList.add('active');
    $('#tab-register-btn').classList.remove('active');
  }

  modal.classList.remove('hidden');
}

function closeAuthModal() {
  $('#auth-modal').classList.add('hidden');
}

async function handleAuthSubmit() {
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value.trim();
  const displayName = $('#auth-display-name').value.trim();
  const errorMsg = $('#auth-error-msg');

  if (!username || !password) {
    errorMsg.textContent = 'Please enter both username and password';
    errorMsg.classList.remove('hidden');
    return;
  }

  const endpoint = state.authMode === 'register' ? '/auth/register' : '/auth/login';
  const body = state.authMode === 'register' ? { username, password, displayName } : { username, password };

  showLoading(state.authMode === 'register' ? 'Creating your account...' : 'Signing in...');

  try {
    const res = await api(endpoint, 'POST', body);
    hideLoading();

    if (!res.success) {
      errorMsg.textContent = res.error || 'Authentication failed';
      errorMsg.classList.remove('hidden');
      return;
    }

    localStorage.setItem('ps_auth_token', res.token);
    state.user = res.user;
    closeAuthModal();
    renderUserBadge();
    toast(`👋 Welcome, ${state.user.displayName || state.user.username}!`, 'success');

    // Reload history for this user
    if (state.currentView === 'history') loadHistory();
  } catch (err) {
    hideLoading();
    errorMsg.textContent = 'Network error: ' + err.message;
    errorMsg.classList.remove('hidden');
  }
}

async function logout() {
  await api('/auth/logout', 'POST');
  localStorage.removeItem('ps_auth_token');
  state.user = null;
  renderUserBadge();
  toast('Logged out successfully', 'info');
  if (state.currentView === 'history') loadHistory();
}

// ==================== SAVED BANKS MANAGEMENT ====================
async function loadSavedBanks() {
  if (!state.user) return;
  try {
    const res = await api('/user/banks');
    if (!res.success || !res.banks) return;

    const list = $('#saved-banks-list');
    const count = $('#saved-banks-count');

    count.textContent = `${res.banks.length} bank${res.banks.length === 1 ? '' : 's'}`;

    if (res.banks.length === 0) {
      list.innerHTML = `<p class="text-muted" style="font-size:0.9rem; grid-column: 1/-1;">No saved banks yet. Upload or generate a bank and click "Save to My Banks"!</p>`;
      return;
    }

    list.innerHTML = res.banks.map(b => {
      const date = b.savedAt ? new Date(b.savedAt).toLocaleDateString() : '';
      return `
        <div class="saved-bank-card glass">
          <div>
            <div class="saved-bank-title">${escapeHtml(b.name)}</div>
            <div class="saved-bank-meta">📝 ${b.questionCount} questions ${date ? '· ' + date : ''}</div>
          </div>
          <div class="saved-bank-actions">
            <button class="btn btn-sm btn-primary" onclick="loadSavedBankById('${b.id}')" style="flex:1;">Load Bank</button>
            <button class="btn btn-sm btn-outline" onclick="deleteSavedBankById('${b.id}')" title="Delete">🗑</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load saved banks:', err);
  }
}

window.loadSavedBankById = async function(bankId) {
  showLoading('Loading saved bank from your PC...');
  try {
    const res = await api(`/user/banks/${bankId}`);
    hideLoading();
    if (!res.success || !res.bank) {
      toast(res.error || 'Failed to load bank', 'error');
      return;
    }
    handleUpload(res.bank);
  } catch (err) {
    hideLoading();
    toast('Error loading bank: ' + err.message, 'error');
  }
};

window.deleteSavedBankById = async function(bankId) {
  const confirmed = await confirm('Delete Bank', 'Are you sure you want to delete this saved question bank?');
  if (!confirmed) return;

  try {
    const res = await api(`/user/banks/${bankId}`, 'DELETE');
    if (res.success) {
      toast('Bank deleted from your folder', 'info');
      loadSavedBanks();
    } else {
      toast('Failed to delete bank', 'error');
    }
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
};

function openSaveBankModal() {
  if (!state.user) {
    toast('Please sign in first to save banks to your PC folder', 'warning');
    openAuthModal('login');
    return;
  }
  if (!state.currentUploadedData) {
    toast('No question bank loaded to save', 'warning');
    return;
  }
  $('#save-bank-name').value = '';
  $('#save-bank-modal').classList.remove('hidden');
}

function closeSaveBankModal() {
  $('#save-bank-modal').classList.add('hidden');
}

async function confirmSaveBank() {
  const name = $('#save-bank-name').value.trim() || 'My Question Bank';
  showLoading('Saving to your private folder on PC...');

  try {
    const res = await api('/user/banks', 'POST', {
      name,
      data: state.currentUploadedData
    });
    hideLoading();

    if (res.success) {
      toast(`💾 Saved "${name}" (${res.questionCount} Qs) to your folder!`, 'success');
      closeSaveBankModal();
      loadSavedBanks();
    } else {
      toast(res.error || 'Failed to save bank', 'error');
    }
  } catch (err) {
    hideLoading();
    toast('Network error: ' + err.message, 'error');
  }
}

// ==================== SHARED / GLOBAL QUESTION BANKS ====================
async function loadSharedBanks() {
  const list = $('#shared-banks-list');
  const count = $('#shared-banks-count');
  if (!list) return;

  try {
    const res = await api('/shared/banks');
    if (!res.success || !res.banks) {
      list.innerHTML = `<p class="text-muted" style="grid-column: 1/-1;">Could not load shared banks.</p>`;
      return;
    }

    count.textContent = `${res.banks.length} shared bank${res.banks.length === 1 ? '' : 's'}`;

    if (res.banks.length === 0) {
      list.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 1.5rem; color: var(--text-muted);">
          <div style="font-size: 1.8rem; margin-bottom: 0.5rem;">📭</div>
          <p>No global shared banks published yet.</p>
          ${state.user?.role === 'admin' ? '<p style="color:var(--amber); font-size:0.85rem; margin-top:0.3rem;">👑 As Admin, upload any bank and click "Publish to Global Banks" to share it with all users!</p>' : ''}
        </div>
      `;
      return;
    }

    const isAdmin = state.user?.role === 'admin';

    list.innerHTML = res.banks.map(b => {
      const date = b.publishedAt ? new Date(b.publishedAt).toLocaleDateString() : '';
      const desc = b.description ? `<div class="shared-bank-desc">${escapeHtml(b.description)}</div>` : '';
      const deleteBtn = isAdmin ? `
        <button class="btn btn-sm btn-outline" onclick="deleteSharedBankById('${b.id}')" title="Admin Delete" style="border-color: rgba(244,63,94,0.3); color: var(--rose);">
          🗑
        </button>
      ` : '';

      return `
        <div class="shared-bank-card">
          <div>
            <div class="shared-bank-title">${escapeHtml(b.name)}</div>
            ${desc}
            <div class="shared-bank-meta">
              <span>📝 ${b.questionCount} Questions</span>
              <span>•</span>
              <span>👤 ${escapeHtml(b.publishedBy || 'Admin')}</span>
              ${date ? `<span>•</span><span>${date}</span>` : ''}
            </div>
          </div>
          <div class="shared-bank-actions">
            <button class="btn btn-sm btn-primary" onclick="loadSharedBankById('${b.id}')" style="flex:1;">
              ⚡ Take Paper
            </button>
            ${deleteBtn}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load shared banks:', err);
    if (list) list.innerHTML = `<p class="text-muted" style="grid-column: 1/-1;">Error loading shared banks: ${escapeHtml(err.message)}</p>`;
  }
}

window.loadSharedBankById = async function(bankId) {
  if (!ensureLoggedIn('take shared exams')) return;
  showLoading('Loading shared bank from server...');
  try {
    const res = await api(`/shared/banks/${bankId}`);
    hideLoading();
    if (!res.success || !res.bank) {
      toast(res.error || 'Failed to load shared bank', 'error');
      return;
    }
    toast(`📥 Loaded "${res.bank.name}" (${res.bank.questions?.length || 0} questions)`, 'success');
    handleUpload(res.bank);
  } catch (err) {
    hideLoading();
    toast('Error loading shared bank: ' + err.message, 'error');
  }
};

window.deleteSharedBankById = async function(bankId) {
  if (state.user?.role !== 'admin') {
    toast('Admin access required to delete global banks', 'error');
    return;
  }

  const confirmed = await confirm('Delete Global Bank', 'Are you sure you want to delete this shared question bank? It will be removed for ALL users.');
  if (!confirmed) return;

  showLoading('Deleting shared bank...');
  try {
    const res = await api(`/admin/banks/${bankId}`, 'DELETE');
    hideLoading();
    if (res.success) {
      toast('Global shared bank deleted', 'info');
      loadSharedBanks();
    } else {
      toast(res.error || 'Failed to delete bank', 'error');
    }
  } catch (err) {
    hideLoading();
    toast('Error deleting bank: ' + err.message, 'error');
  }
};

// ==================== ADMIN PUBLISH BANK MODAL ====================
function openPublishBankModal() {
  if (state.user?.role !== 'admin') {
    toast('Only administrators can publish global question banks', 'warning');
    return;
  }
  if (!state.currentUploadedData) {
    toast('No question bank loaded to publish', 'warning');
    return;
  }
  $('#publish-bank-name').value = '';
  $('#publish-bank-desc').value = '';
  $('#publish-bank-modal').classList.remove('hidden');
}

function closePublishBankModal() {
  $('#publish-bank-modal').classList.add('hidden');
}

async function confirmPublishBank() {
  const name = $('#publish-bank-name').value.trim() || 'Global Question Bank';
  const description = $('#publish-bank-desc').value.trim();

  showLoading('Publishing question bank for all users...');

  try {
    const res = await api('/admin/banks', 'POST', {
      name,
      description,
      data: state.currentUploadedData
    });
    hideLoading();

    if (res.success) {
      toast(`👑 Published "${name}" (${res.questionCount} Qs) to Global Shared Banks!`, 'success');
      closePublishBankModal();
      loadSharedBanks();
    } else {
      toast(res.error || 'Failed to publish bank', 'error');
    }
  } catch (err) {
    hideLoading();
    toast('Network error: ' + err.message, 'error');
  }
}

// ==================== GOOGLE GEMINI AI GENERATOR ====================
function openAiModal() {
  if (!ensureLoggedIn('generate AI exams')) return;
  const modal = $('#ai-generator-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  $('#ai-prompt-input')?.focus();
}

function closeAiModal() {
  const modal = $('#ai-generator-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleAiGenerate() {
  if (!ensureLoggedIn('generate AI exams')) {
    closeAiModal();
    return;
  }

  const prompt = ($('#ai-prompt-input')?.value || '').trim();
  const count = parseInt($('#ai-count-input')?.value, 10) || 10;
  const difficulty = $('#ai-difficulty-select')?.value || 'mixed';
  const includeCode = $('#ai-include-code')?.checked !== false;
  const model = $('#ai-model-select')?.value || 'gemini-3.5-flash-lite';

  if (!prompt) {
    toast('Please enter a topic, concepts, or prompt for the exam', 'warning');
    $('#ai-prompt-input')?.focus();
    return;
  }

  closeAiModal();
  showLoading(`✨ AI is generating ${count} questions on "${prompt.slice(0, 30)}..." (Fast failover active)`);

  try {
    const res = await api('/ai/generate', 'POST', {
      prompt,
      count,
      difficulty,
      includeCode,
      model
    });
    hideLoading();

    if (!res.success) {
      const isHighDemand = (res.error || '').includes('503') || (res.error || '').includes('demand') || (res.error || '').includes('traffic');
      toast(res.error || 'AI generation failed', isHighDemand ? 'warning' : 'error', 6000);
      return;
    }

    state.currentUploadedData = {
      name: res.name || `${prompt.slice(0, 35)} Exam`,
      questions: res.questions
    };
    state.validationReport = res.validationReport;

    renderValidationReport(res.validationReport);
    showView('validation');

    if (res.fallbackUsed) {
      toast(`✨ Generated ${res.questions.length} questions using ${res.modelUsed} (auto-switched from ${res.requestedModel} due to high traffic)`, 'info', 6000);
    } else {
      toast(`✨ Generated ${res.questions.length} questions successfully with ${res.modelUsed || 'Gemini'}!`, 'success');
    }
  } catch (err) {
    hideLoading();
    toast('Network error during generation: ' + err.message, 'error');
  }
}

// ==================== NETWORK INFO ====================
async function fetchNetworkInfo() {
  try {
    const res = await api('/info');
    const display = $('#network-ip-display');
    if (res.localIPs && res.localIPs.length > 0) {
      const primaryIP = res.localIPs[0];
      display.textContent = `http://${primaryIP}:${res.port}`;
    } else {
      display.textContent = `http://localhost:${res.port}`;
    }
  } catch {
    $('#network-ip-display').textContent = 'http://localhost:3000';
  }
}
async function handleUpload(jsonData) {
  if (!ensureLoggedIn('upload or take mock exams')) return;
  let parsed;
  try {
    parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  } catch (e) {
    toast('Invalid JSON format: ' + e.message, 'error');
    return;
  }

  if (!parsed.questions || !Array.isArray(parsed.questions)) {
    toast('JSON must have a "questions" array at the top level', 'error');
    return;
  }

  state.currentUploadedData = parsed;
  showLoading('Validating question bank...');

  try {
    const result = await api('/upload', 'POST', parsed);
    hideLoading();

    if (!result.success) {
      toast(result.error || 'Upload failed', 'error');
      if (result.validationReport) {
        renderValidationReport(result.validationReport);
        showView('validation');
      }
      return;
    }

    state.validationReport = result.validationReport;
    renderValidationReport(result.validationReport);
    showView('validation');
    toast(`✅ ${result.validationReport.accepted} questions validated successfully`, 'success');
  } catch (err) {
    hideLoading();
    toast('Network error: ' + err.message, 'error');
  }
}

function renderValidationReport(report) {
  // Stats
  $('#validation-stats').innerHTML = `
    <div class="v-stat">
      <div class="v-stat-value">${report.totalReceived}</div>
      <div class="v-stat-label">Total Received</div>
    </div>
    <div class="v-stat">
      <div class="v-stat-value success">${report.accepted}</div>
      <div class="v-stat-label">Accepted</div>
    </div>
    <div class="v-stat">
      <div class="v-stat-value danger">${report.rejected}</div>
      <div class="v-stat-label">Rejected</div>
    </div>
    <div class="v-stat">
      <div class="v-stat-value warning">${report.warnings.length}</div>
      <div class="v-stat-label">Warnings</div>
    </div>
  `;

  // Details
  let html = '';
  if (report.errors.length > 0) {
    html += `<div class="v-detail-group"><h4>❌ Errors (${report.errors.length})</h4>`;
    for (const e of report.errors) {
      html += `<div class="v-detail-item"><span class="v-id">${e.questionId}</span><span class="v-msg">${e.field}: ${e.message}</span></div>`;
    }
    html += '</div>';
  }

  if (report.warnings.length > 0) {
    html += `<div class="v-detail-group"><h4>⚠️ Warnings (${report.warnings.length})</h4>`;
    for (const w of report.warnings) {
      html += `<div class="v-detail-item"><span class="v-id">${w.questionId}</span><span class="v-msg">${w.field}: ${w.message}</span></div>`;
    }
    html += '</div>';
  }

  if (report.normalizations.length > 0) {
    html += `<div class="v-detail-group"><h4>🔄 Normalizations (${report.normalizations.length})</h4>`;
    for (const n of report.normalizations) {
      html += `<div class="v-detail-item"><span class="v-id">${n.questionId}</span><span class="v-msg">${n.field}: "${n.from}" → "${n.to}"</span></div>`;
    }
    html += '</div>';
  }

  if (report.errors.length === 0 && report.warnings.length === 0 && report.normalizations.length === 0) {
    html = '<p style="text-align:center;color:var(--emerald);padding:2rem;">✨ All questions passed validation with no issues!</p>';
  }

  $('#validation-details').innerHTML = html;

  // Enable/disable generate button
  const btn = $('#generate-paper-btn');
  btn.disabled = report.accepted < 1;
}

// ==================== EXAM CONFIGURATION & GENERATION ====================
function openExamConfigModal() {
  const modal = $('#exam-config-modal');
  if (!modal) return;

  // Gather topics from validationReport or current pool
  let topics = {};
  if (state.validationReport && state.validationReport.topics) {
    topics = state.validationReport.topics;
  } else if (state.currentUploadedData && Array.isArray(state.currentUploadedData.questions)) {
    for (const q of state.currentUploadedData.questions) {
      if (q.topic) topics[q.topic] = (topics[q.topic] || 0) + 1;
    }
  }

  const topicEntries = Object.entries(topics);
  if (topicEntries.length === 0) {
    toast('Please upload or load a question bank first', 'warning');
    return;
  }

  // Populate topics grid
  const grid = $('#config-topics-list');
  grid.innerHTML = topicEntries.map(([t, count]) => `
    <label class="topic-checkbox-label">
      <input type="checkbox" class="topic-cb" value="${escapeHtml(t)}" checked data-count="${count}">
      <span class="topic-label-name" title="${escapeHtml(t)}">${escapeHtml(t)}</span>
      <span class="topic-label-count">${count}</span>
    </label>
  `).join('');

  // Wire checkbox listeners
  grid.querySelectorAll('.topic-cb').forEach(cb => {
    cb.onchange = updateExamConfigState;
  });

  // Default values
  const totalCount = topicEntries.reduce((sum, [, count]) => sum + count, 0);
  const defaultCount = Math.min(40, totalCount);

  $('#config-q-input').value = defaultCount;
  $('#config-q-input').max = totalCount;
  $('#config-time-input').value = 60;

  // Wire mode card clicks
  const examCard = $('#mode-card-exam');
  const interactiveCard = $('#mode-card-interactive');
  const examRadio = $('input[name="exam-mode"][value="exam"]');
  const interactiveRadio = $('input[name="exam-mode"][value="interactive"]');

  if (examCard && interactiveCard) {
    examCard.onclick = () => {
      if (examRadio) examRadio.checked = true;
      examCard.classList.add('active');
      interactiveCard.classList.remove('active', 'interactive-selected');
      const badge = $('#config-mode-badge');
      if (badge) badge.textContent = '🎯 Standard Exam';
      updateExamConfigState();
    };

    interactiveCard.onclick = () => {
      if (interactiveRadio) interactiveRadio.checked = true;
      interactiveCard.classList.add('active', 'interactive-selected');
      examCard.classList.remove('active');
      const badge = $('#config-mode-badge');
      if (badge) badge.textContent = '⚡ Interactive Practice';
      updateExamConfigState();
    };
  }

  updateExamConfigState();
  modal.classList.remove('hidden');
}

function closeExamConfigModal() {
  const modal = $('#exam-config-modal');
  if (modal) modal.classList.add('hidden');
}

function updateExamConfigState() {
  const checkboxes = Array.from(document.querySelectorAll('.topic-cb:checked'));
  const availableQuestions = checkboxes.reduce((sum, cb) => sum + (parseInt(cb.dataset.count, 10) || 0), 0);

  $('#config-available-count').textContent = availableQuestions;

  // Adjust question input limits
  const qInput = $('#config-q-input');
  qInput.max = availableQuestions;

  let currentQ = parseInt(qInput.value, 10);
  if (isNaN(currentQ) || currentQ < 1) currentQ = Math.min(10, availableQuestions);
  if (currentQ > availableQuestions && availableQuestions > 0) currentQ = availableQuestions;
  qInput.value = currentQ;

  $('#config-q-badge').textContent = `${currentQ} Questions`;

  // Question presets active state
  $$('#q-presets-row .preset-btn').forEach(btn => {
    const val = btn.dataset.q;
    if (val === 'max') {
      btn.classList.toggle('active', currentQ === availableQuestions);
    } else {
      btn.classList.toggle('active', parseInt(val, 10) === currentQ);
    }
  });

  // Time input
  const timeInput = $('#config-time-input');
  let currentMins = parseInt(timeInput.value, 10);
  if (isNaN(currentMins) || currentMins < 1) currentMins = 15;
  timeInput.value = currentMins;

  $('#config-time-badge').textContent = `${currentMins} Mins`;

  // Time presets active state
  $$('#time-presets-row .preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.time, 10) === currentMins);
  });

  // Pacing
  if (currentQ > 0) {
    const totalSecs = currentMins * 60;
    const secPerQ = Math.round(totalSecs / currentQ);
    $('#config-pacing-info').textContent = `Pacing: ~${secPerQ}s per question`;
  }

  // Update launch button text based on mode
  const startBtn = $('#config-modal-start');
  const selectedMode = document.querySelector('input[name="exam-mode"]:checked')?.value || 'exam';
  const isInteractive = selectedMode === 'interactive';

  if (availableQuestions === 0) {
    startBtn.disabled = true;
    startBtn.textContent = 'Select at least 1 topic';
  } else if (isInteractive) {
    startBtn.disabled = false;
    startBtn.textContent = `⚡ Start Interactive Quiz (${currentQ} Qs · ${currentMins}m)`;
  } else {
    startBtn.disabled = false;
    startBtn.textContent = `🚀 Start Exam (${currentQ} Qs · ${currentMins}m)`;
  }
}

async function startCustomPaper() {
  const selectedCbs = Array.from(document.querySelectorAll('.topic-cb:checked'));
  if (selectedCbs.length === 0) {
    toast('Please select at least one topic', 'warning');
    return;
  }

  const topics = selectedCbs.map(cb => cb.value);
  const questionCount = parseInt($('#config-q-input').value, 10) || 40;
  const durationMinutes = parseInt($('#config-time-input').value, 10) || 60;
  const avoidRepeats = $('#config-avoid-repeats') ? $('#config-avoid-repeats').checked : true;
  const selectedMode = document.querySelector('input[name="exam-mode"]:checked')?.value || 'exam';
  const isInteractive = selectedMode === 'interactive';

  closeExamConfigModal();
  showLoading(`Composing your ${questionCount}-question ${isInteractive ? 'interactive practice quiz' : 'mock exam'} (${durationMinutes} min)...`);

  try {
    const result = await api('/generate', 'POST', {
      topics,
      questionCount,
      durationMinutes,
      avoidRepeats,
      interactive: isInteractive,
    });
    hideLoading();

    if (!result.success) {
      toast(result.error || 'Paper generation failed', 'error');
      return;
    }

    state.paper = result.paper;
    state.compositionMeta = result.compositionMetadata;

    // Set exam timer to chosen duration
    state.totalSeconds = result.paper.timeLimitSec || (durationMinutes * 60);
    state.remainingSeconds = state.totalSeconds;

    const meta = result.compositionMetadata;
    const modeLabel = isInteractive ? '⚡ Interactive Quiz ready' : '📝 Paper ready';
    if (meta && meta.unseenSelected !== undefined && meta.unseenSelected > 0) {
      toast(`${modeLabel}: ${result.paper.questions.length} questions (${meta.unseenSelected} unmastered/fresh from your history)!`, 'success');
    } else {
      toast(`${modeLabel}: ${result.paper.questions.length} questions, ${durationMinutes} minutes`, 'success');
    }
    startExam();
  } catch (err) {
    hideLoading();
    toast('Network error: ' + err.message, 'error');
  }
}

// Backward-compatible alias
const generatePaper = openExamConfigModal;

// ==================== EXAM ENGINE ====================
function playFeedbackSound(isCorrect) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (isCorrect) {
      // Pleasant rising major chime
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.08); // E5
      osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.16); // G5
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } else {
      // Low gentle buzz
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(220, ctx.currentTime); // A3
      osc.frequency.setValueAtTime(164.81, ctx.currentTime + 0.08); // E3
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
      osc.start();
      osc.stop(ctx.currentTime + 0.28);
    }
  } catch {}
}

function updateInteractiveStats() {
  const liveBar = $('#interactive-live-pill');
  if (!liveBar) return;

  if (!state.isInteractive) {
    liveBar.classList.add('hidden');
    return;
  }

  liveBar.classList.remove('hidden');
  const questions = state.paper.questions;
  let correct = 0;
  let answered = 0;

  for (const q of questions) {
    if (state.answers[q.id] !== undefined) {
      answered++;
      if (state.answers[q.id] === q.correct_option) correct++;
    }
  }

  const pct = answered > 0 ? Math.round((correct / answered) * 100) : 0;
  const statsEl = $('#interactive-stats-text');
  if (statsEl) {
    statsEl.innerHTML = `<strong>${correct} / ${answered}</strong> Correct (${pct}%)`;
  }

  const streakEl = $('#interactive-streak-tag');
  if (streakEl) {
    const currentStreak = state.streak || 0;
    streakEl.textContent = `🔥 ${currentStreak} streak`;
    streakEl.style.display = currentStreak > 0 ? 'inline-flex' : 'none';
  }
}

// ==================== TEST SESSIONS & RESUME MANAGEMENT ====================
const ACTIVE_SESSION_STORAGE_KEY = 'paper_simulator_active_session';

function hasActiveSession() {
  if (state.paper && Array.isArray(state.paper.questions) && state.paper.questions.length > 0 && state.remainingSeconds > 0) {
    return true;
  }
  const saved = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  if (saved) {
    try {
      const data = JSON.parse(saved);
      return Boolean(data && data.paper && data.paper.questions && data.paper.questions.length > 0 && (data.remainingSeconds > 0 || !data.totalSeconds));
    } catch {
      return false;
    }
  }
  return false;
}

function saveActiveSession() {
  if (!state.paper || !state.paper.questions || state.paper.questions.length === 0 || state.remainingSeconds <= 0) {
    return;
  }
  try {
    const payload = {
      paper: state.paper,
      compositionMeta: state.compositionMeta,
      currentQuestion: state.currentQuestion,
      answers: state.answers,
      flagged: Array.from(state.flagged || []),
      events: state.events || [],
      examStartTime: state.examStartTime,
      totalSeconds: state.totalSeconds,
      remainingSeconds: state.remainingSeconds,
      isInteractive: Boolean(state.isInteractive),
      streak: state.streak || 0,
      bestStreak: state.bestStreak || 0,
      lastSaved: Date.now()
    };
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Failed to save active session to localStorage:', err);
  }
}

function restoreActiveSession() {
  const raw = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (!data.paper || !data.paper.questions || data.paper.questions.length === 0) {
      localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      return false;
    }

    // Calculate time elapsed while page was closed
    const elapsedSec = Math.floor((Date.now() - (data.lastSaved || Date.now())) / 1000);
    const remaining = Math.max(0, (data.remainingSeconds ?? 3600) - elapsedSec);

    state.paper = data.paper;
    state.compositionMeta = data.compositionMeta || null;
    state.currentQuestion = Math.max(0, Math.min(data.currentQuestion || 0, data.paper.questions.length - 1));
    state.answers = data.answers || {};
    state.flagged = new Set(Array.isArray(data.flagged) ? data.flagged : []);
    state.events = Array.isArray(data.events) ? data.events : [];
    state.examStartTime = data.examStartTime || new Date().toISOString();
    state.totalSeconds = data.totalSeconds || 3600;
    state.remainingSeconds = remaining;
    state.isInteractive = Boolean(data.isInteractive);
    state.streak = data.streak || 0;
    state.bestStreak = data.bestStreak || 0;

    return true;
  } catch (err) {
    console.warn('Failed to parse active session:', err);
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    return false;
  }
}

function clearActiveSession() {
  localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  const navResumeBtn = $('#nav-resume-btn');
  if (navResumeBtn) navResumeBtn.classList.add('hidden');
  updateRunningSessionUI();
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function updateRunningSessionUI(rebuildCard = true) {
  const isActive = hasActiveSession();
  const navResumeBtn = $('#nav-resume-btn');
  const navTimer = $('#nav-resume-timer');
  const runningPill = $('#hub-running-pill');
  const statusText = $('#sessions-hub-status-text');
  const container = $('#active-test-container');

  const timeStr = formatDuration(state.remainingSeconds);

  // Top header nav resume button
  if (navResumeBtn) {
    if (isActive && state.currentView !== 'exam') {
      navResumeBtn.classList.remove('hidden');
      if (navTimer) navTimer.textContent = timeStr;
    } else {
      navResumeBtn.classList.add('hidden');
    }
  }

  // Pill badge
  if (runningPill) {
    runningPill.textContent = isActive ? '1' : '0';
  }

  // Status text in hub header
  if (statusText) {
    if (isActive) {
      statusText.className = 'sessions-hub-status active';
      statusText.innerHTML = '<span class="active-live-dot"></span> Test in progress';
    } else {
      statusText.className = 'sessions-hub-status';
      statusText.textContent = 'No active test session';
    }
  }

  // Quick timer update if card is already built
  const cardTimerVal = $('#active-test-timer-val');
  if (cardTimerVal) {
    cardTimerVal.textContent = timeStr;
  }

  if (!rebuildCard || !container) return;

  if (!isActive) {
    container.innerHTML = `
      <div class="active-test-empty">
        <div class="active-test-empty-icon">📝</div>
        <p style="font-weight:600; color:var(--text-primary); margin-bottom:0.3rem;">No Exam Currently Running</p>
        <p style="font-size:0.85rem;">Generate a fresh exam with Gemini AI above, upload JSON, or pick a sample bank to begin.</p>
      </div>
    `;
    return;
  }

  const paper = state.paper;
  const total = paper?.questions?.length || 0;
  const answeredCount = Object.keys(state.answers || {}).length;
  const progressPercent = total > 0 ? Math.round((answeredCount / total) * 100) : 0;
  const paperTitle = escapeHtml(paper?.name || 'Mock Exam');
  const topicName = escapeHtml(paper?.topic || (paper?.questions?.[0]?.topic) || 'Computer Science');
  const isInteractive = Boolean(state.isInteractive);

  container.innerHTML = `
    <div class="active-test-card glass">
      <div class="active-test-header-wrap">
        <div>
          <div class="active-test-title">
            <span>📝</span> ${paperTitle}
          </div>
          <div class="active-test-badges">
            <span class="active-live-badge"><span class="active-live-dot"></span> In Progress</span>
            <span class="badge-pill">${topicName}</span>
            <span class="badge-pill">${total} Questions</span>
            ${isInteractive ? '<span class="badge-pill" style="background:rgba(124,58,237,0.2); border-color:rgba(124,58,237,0.4); color:#c4b5fd;">⚡ Interactive Mode</span>' : ''}
          </div>
        </div>
        <div class="active-test-timer-box">
          <div class="active-test-timer-label">Time Left</div>
          <div class="active-test-timer-val" id="active-test-timer-val">${timeStr}</div>
        </div>
      </div>

      <div class="active-test-progress-section">
        <div class="active-test-progress-labels">
          <span>Question Progress: <strong>${answeredCount} / ${total}</strong> answered</span>
          <span>${progressPercent}% Complete</span>
        </div>
        <div class="active-test-bar">
          <div class="active-test-bar-fill" style="width: ${progressPercent}%;"></div>
        </div>
      </div>

      <div class="active-test-actions">
        <button type="button" class="btn btn-danger-outline btn-sm" id="discard-active-test-btn">
          🗑️ Discard Test
        </button>
        <button type="button" class="btn btn-primary" id="resume-active-test-btn" style="padding: 0.55rem 1.4rem; font-weight:700;">
          ⚡ Resume Test Now
        </button>
      </div>
    </div>
  `;

  // Wire buttons inside active test card
  const resumeBtn = $('#resume-active-test-btn');
  if (resumeBtn) resumeBtn.onclick = resumeActiveExam;
  const discardBtn = $('#discard-active-test-btn');
  if (discardBtn) discardBtn.onclick = discardActiveExam;
}

function resumeActiveExam() {
  if (!state.paper || !state.paper.questions) {
    const restored = restoreActiveSession();
    if (!restored) {
      toast('No active exam found to resume', 'warning');
      updateRunningSessionUI();
      return;
    }
  }

  // Set up palettes and question rendering
  renderPalette();
  renderQuestion(state.currentQuestion || 0);

  // If interactive mode, update streak bar
  if (state.isInteractive) {
    const liveBar = $('#interactive-live-pill');
    if (liveBar) liveBar.classList.remove('hidden');
    updateInteractiveStats();
  }

  // Ensure timer is running
  if (!state.timerInterval && state.remainingSeconds > 0) {
    startTimer();
  }

  showView('exam');
  toast(`🏃 Resumed "${state.paper.name || 'Exam'}" at question ${state.currentQuestion + 1}`, 'info', 3000);
}

async function discardActiveExam() {
  const confirmed = await confirm(
    'Discard Active Exam',
    'Are you sure you want to abandon this in-progress exam? All unsaved answers and progress will be permanently lost.'
  );
  if (!confirmed) return;

  clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.paper = null;
  state.answers = {};
  state.flagged = new Set();
  state.events = [];
  state.currentQuestion = 0;

  clearActiveSession();
  updateRunningSessionUI();
  toast('Active exam discarded', 'info', 3000);
}

async function renderEndedSessions() {
  const container = $('#ended-tests-container');
  const pill = $('#hub-ended-pill');
  if (!container) return;

  try {
    const res = await api('/attempts');
    const attempts = res.attempts || [];

    if (pill) pill.textContent = String(attempts.length);

    if (attempts.length === 0) {
      container.innerHTML = `
        <div class="active-test-empty">
          <div class="active-test-empty-icon">📋</div>
          <p style="font-weight:600; color:var(--text-primary); margin-bottom:0.3rem;">No Completed Tests Yet</p>
          <p style="font-size:0.85rem;">Complete a mock exam to view detailed score cards and AI diagnostic reports here.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = attempts.map(att => {
      const date = new Date(att.timestamp);
      const formattedDate = date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      const grade = att.grade || '—';
      const isPass = grade.startsWith('A') || grade.startsWith('B') || grade.startsWith('C');
      const gradeClass = isPass ? 'grade-badge-pass' : 'grade-badge-fail';
      const durationMin = Math.max(1, Math.round((att.durationSec || 0) / 60));
      const paperName = escapeHtml(att.paperName || 'Mock Exam');
      const percentStr = (att.percent ?? 0).toFixed(1);

      return `
        <div class="ended-test-card glass">
          <div class="ended-test-info">
            <div class="ended-test-name">📝 ${paperName}</div>
            <div class="ended-test-meta">
              <span>📅 ${formattedDate}</span>
              <span>⏱️ ${durationMin} min</span>
              <span>🎯 ${att.score} / ${att.total} marks</span>
            </div>
          </div>
          <div class="ended-test-actions">
            <span class="ended-test-grade-badge ${gradeClass}">
              ${grade} (${percentStr}%)
            </span>
            <button type="button" class="btn btn-sm btn-outline view-ended-report-btn" data-attempt-id="${att.id}">
              📊 View Report
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Wire "View Report" buttons
    container.querySelectorAll('.view-ended-report-btn').forEach(btn => {
      btn.onclick = () => {
        const attemptId = btn.dataset.attemptId;
        if (attemptId) viewEndedReport(attemptId);
      };
    });
  } catch (err) {
    container.innerHTML = `
      <div class="active-test-empty">
        <p class="text-danger" style="font-size:0.85rem;">Failed to load completed tests: ${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

async function viewEndedReport(attemptId) {
  try {
    showLoading('Loading performance report...');
    const data = await api(`/attempt/${encodeURIComponent(attemptId)}`);
    hideLoading();

    if (!data || !data.report) {
      toast('Failed to load report data', 'error');
      return;
    }

    state.report = data.report;
    state.answerKey = data.answerKey || null;
    if (data.paper) {
      state.paper = data.paper;
    }
    const paperToUse = data.paper || state.paper || null;
    const answersToUse = (data.session && data.session.answers) || state.answers || {};

    renderResults(data.report, data.answerKey, paperToUse, answersToUse, data.evaluation);
    showView('results');
    toast(`📊 Loaded report for ${data.report.name || 'exam attempt'}`, 'info', 2500);
  } catch (err) {
    hideLoading();
    toast('Error loading attempt report: ' + err.message, 'error');
  }
}
window.viewEndedReport = viewEndedReport;

function switchHubTab(tabName) {
  const tabRunning = $('#hub-tab-running');
  const tabEnded = $('#hub-tab-ended');
  const paneRunning = $('#hub-pane-running');
  const paneEnded = $('#hub-pane-ended');

  if (tabName === 'running') {
    tabRunning?.classList.add('active');
    tabEnded?.classList.remove('active');
    paneRunning?.classList.remove('hidden');
    paneEnded?.classList.add('hidden');
    updateRunningSessionUI();
  } else if (tabName === 'ended') {
    tabEnded?.classList.add('active');
    tabRunning?.classList.remove('active');
    paneEnded?.classList.remove('hidden');
    paneRunning?.classList.add('hidden');
    renderEndedSessions();
  }
}

function startExam() {
  // Reset exam state
  state.currentQuestion = 0;
  state.answers = {};
  state.flagged = new Set();
  state.events = [];
  state.examStartTime = new Date().toISOString();
  state.remainingSeconds = state.totalSeconds;
  state.isInteractive = Boolean(state.paper && state.paper.interactive);
  state.streak = 0;
  state.bestStreak = 0;

  // Toggle visibility of live stats bar
  const liveBar = $('#interactive-live-pill');
  if (liveBar) {
    if (state.isInteractive) {
      liveBar.classList.remove('hidden');
    } else {
      liveBar.classList.add('hidden');
    }
  }

  // Build question palette
  renderPalette();

  // Show first question
  renderQuestion(0);

  // Start timer
  startTimer();

  // Log initial navigation
  logEvent('navigate', state.paper.questions[0].id);

  saveActiveSession();
  updateRunningSessionUI();

  showView('exam');
}

function renderPalette() {
  const palette = $('#question-palette');
  palette.innerHTML = '';
  state.paper.questions.forEach((q, i) => {
    const btn = document.createElement('button');
    btn.className = 'palette-btn';
    btn.textContent = i + 1;
    btn.dataset.index = i;
    btn.onclick = () => navigateTo(i);
    palette.appendChild(btn);
  });
  updatePalette();
}

function updatePalette() {
  const buttons = $$('.palette-btn');
  const questions = state.paper.questions;
  let answered = 0, flagged = 0;

  buttons.forEach((btn, i) => {
    const q = questions[i];
    const qid = q.id;
    btn.classList.remove('current', 'answered', 'flagged', 'correct', 'incorrect');

    if (i === state.currentQuestion) btn.classList.add('current');
    if (state.answers[qid] !== undefined) {
      btn.classList.add('answered');
      answered++;

      // In interactive mode, color-code palette buttons by correctness
      if (state.isInteractive && q.correct_option !== undefined) {
        if (state.answers[qid] === q.correct_option) {
          btn.classList.add('correct');
        } else {
          btn.classList.add('incorrect');
        }
      }
    }
    if (state.flagged.has(qid)) { btn.classList.add('flagged'); flagged++; }
  });

  $('#stat-answered').textContent = answered;
  $('#stat-flagged').textContent = flagged;
  $('#stat-remaining').textContent = questions.length - answered;
}

function renderQuestion(index) {
  const q = state.paper.questions[index];
  state.currentQuestion = index;
  const isInteractive = Boolean(state.isInteractive);
  const isAnswered = state.answers[q.id] !== undefined;
  const userAns = state.answers[q.id];

  // Mode badge in question-meta
  const modeBadge = isInteractive
    ? `<span class="q-tag interactive-badge">⚡ Interactive Mode</span>`
    : '';

  // Meta tags
  $('#question-meta').innerHTML = `
    ${modeBadge}
    <span class="q-tag topic">${escapeHtml(q.topic)}</span>
    <span class="q-tag difficulty-${q.difficulty}">${escapeHtml(q.difficulty)}</span>
    <span style="color:var(--text-muted);font-size:0.8rem;">⏱ ${q.recommended_time_sec}s recommended</span>
  `;

  // Flag button
  const flagBtn = $('#flag-btn');
  if (state.flagged.has(q.id)) {
    flagBtn.classList.add('active');
    flagBtn.textContent = '🏳️ Flagged';
  } else {
    flagBtn.classList.remove('active');
    flagBtn.textContent = '🏳️ Flag';
  }

  // Question text
  $('#question-text').innerHTML = `<strong>Q${index + 1}.</strong> ${formatContent(q.question_text)}`;

  // Options
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const optionsHtml = q.options.map((opt, oi) => {
    let classes = ['option-item'];
    let badgeHtml = '';

    if (isInteractive && isAnswered) {
      classes.push('interactive-locked');
      const isCorrectOption = oi === q.correct_option;
      const isUserChoice = userAns === oi;

      if (isCorrectOption) {
        if (isUserChoice) {
          classes.push('is-correct');
          badgeHtml = `<span class="option-badge correct">✓ Correct</span>`;
        } else {
          classes.push('reveal-correct');
          badgeHtml = `<span class="option-badge reveal">✓ Correct Answer</span>`;
        }
      } else if (isUserChoice) {
        classes.push('is-wrong');
        badgeHtml = `<span class="option-badge wrong">✗ Your Choice</span>`;
      }
    } else {
      if (userAns === oi) classes.push('selected');
    }

    const clickAttr = (isInteractive && isAnswered)
      ? ''
      : `onclick="selectOption('${q.id}', ${oi})"`;

    return `
      <div class="${classes.join(' ')}" data-option="${oi}" ${clickAttr}>
        <span class="option-letter">${letters[oi]}</span>
        <span class="option-text">${formatContent(opt)}</span>
        ${badgeHtml}
      </div>
    `;
  }).join('');

  // In interactive mode, if answered, display full explanation card
  let explanationHtml = '';
  if (isInteractive && isAnswered && q.explanation) {
    const isCorrect = userAns === q.correct_option;
    explanationHtml = `
      <div class="interactive-explanation-card ${isCorrect ? 'correct' : 'incorrect'}">
        <div class="explanation-header">
          <div class="explanation-result-pill ${isCorrect ? 'correct' : 'incorrect'}">
            ${isCorrect ? '🎉 Correct!' : '💡 Incorrect — Correct Choice: Option ' + letters[q.correct_option]}
          </div>
          <div class="text-muted" style="font-size:0.82rem; font-weight:600;">
            ${escapeHtml(q.subtopic || q.topic)}
          </div>
        </div>
        <div class="explanation-body">
          <div class="explanation-title">
            <span>📖 Detailed Explanation</span>
          </div>
          <div class="explanation-content">
            ${formatContent(q.explanation)}
          </div>
        </div>
      </div>
    `;
  }

  $('#options-list').innerHTML = optionsHtml + explanationHtml;

  // Counter
  $('#question-counter').textContent = `${index + 1} / ${state.paper.questions.length}`;

  // Nav buttons
  $('#prev-btn').disabled = index === 0;
  $('#next-btn').textContent = index === state.paper.questions.length - 1 ? 'Finish' : 'Next →';

  // Highlight Next button when answered in interactive mode to encourage moving forward
  if (isInteractive && isAnswered) {
    $('#next-btn').classList.add('pulse-next-btn');
  } else {
    $('#next-btn').classList.remove('pulse-next-btn');
  }

  updatePalette();
  updateInteractiveStats();
}

function selectOption(questionId, optionIndex) {
  const q = state.paper.questions[state.currentQuestion];
  const isInteractive = Boolean(state.isInteractive);

  // In interactive mode, once answered, locking prevents changes
  if (isInteractive && state.answers[questionId] !== undefined) {
    return;
  }

  const hadPrevious = state.answers[questionId] !== undefined;
  state.answers[questionId] = optionIndex;

  if (isInteractive && q && q.correct_option !== undefined) {
    const isCorrect = optionIndex === q.correct_option;
    if (isCorrect) {
      state.streak = (state.streak || 0) + 1;
      if (state.streak > (state.bestStreak || 0)) state.bestStreak = state.streak;
    } else {
      state.streak = 0;
    }
    playFeedbackSound(isCorrect);
  }

  logEvent(hadPrevious ? 'change_answer' : 'answer', questionId, optionIndex);
  renderQuestion(state.currentQuestion);
  saveActiveSession();
}

// Make selectOption globally accessible for onclick
window.selectOption = selectOption;

function navigateTo(index) {
  const q = state.paper.questions[index];
  logEvent('navigate', q.id);
  renderQuestion(index);
  saveActiveSession();
}

function logEvent(type, questionId, value = null) {
  state.events.push({
    type,
    questionId,
    timestamp: new Date().toISOString(),
    value,
  });
}

// ==================== TIMER ====================
function startTimer() {
  clearInterval(state.timerInterval);

  // Add SVG gradient definition
  const svg = $('.timer-ring svg');
  if (!svg.querySelector('defs')) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <linearGradient id="timer-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" style="stop-color:#6c63ff"/>
        <stop offset="100%" style="stop-color:#00d4ff"/>
      </linearGradient>
    `;
    svg.prepend(defs);
  }

  updateTimerDisplay();

  state.timerInterval = setInterval(() => {
    state.remainingSeconds--;

    if (state.remainingSeconds <= 0) {
      state.remainingSeconds = 0;
      clearInterval(state.timerInterval);
      autoSubmit();
      return;
    }

    updateTimerDisplay();

    // If user has navigated away from exam, keep header and card timers fresh
    if (state.currentView !== 'exam') {
      const timeStr = formatDuration(state.remainingSeconds);
      const navTimer = $('#nav-resume-timer');
      if (navTimer) navTimer.textContent = timeStr;
      const cardTimer = $('#active-test-timer-val');
      if (cardTimer) cardTimer.textContent = timeStr;
    }

    // Periodically persist to localStorage every 5 seconds
    if (state.remainingSeconds % 5 === 0) {
      saveActiveSession();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const mins = Math.floor(state.remainingSeconds / 60);
  const secs = state.remainingSeconds % 60;
  const display = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  $('#timer-text').textContent = display;

  // Progress ring
  const circumference = 2 * Math.PI * 54; // 339.292
  const progress = state.remainingSeconds / (state.totalSeconds || 3600);
  const offset = circumference * (1 - progress);
  $('#timer-progress').style.strokeDashoffset = offset;

  // Timer urgency states scaled by exam length
  const ring = $('#timer-ring');
  ring.classList.remove('timer-warning', 'timer-critical');
  const criticalThreshold = Math.min(60, Math.max(10, (state.totalSeconds || 3600) * 0.08));
  const warningThreshold = Math.min(300, Math.max(30, (state.totalSeconds || 3600) * 0.2));
  if (state.remainingSeconds <= criticalThreshold) {
    ring.classList.add('timer-critical');
  } else if (state.remainingSeconds <= warningThreshold) {
    ring.classList.add('timer-warning');
  }
}

async function autoSubmit() {
  toast('⏰ Time is up! Auto-submitting your exam...', 'warning');
  await submitExam(true);
}

// ==================== SUBMISSION ====================
async function submitExam(autoSubmitted = false) {
  clearInterval(state.timerInterval);

  state.examEndTime = new Date().toISOString();

  const sessionLog = {
    paperId: state.paper.id,
    startTime: state.examStartTime,
    endTime: state.examEndTime,
    answers: {},
    events: state.events,
    autoSubmitted,
  };

  // Build answers map (null for unanswered)
  for (const q of state.paper.questions) {
    sessionLog.answers[q.id] = state.answers[q.id] !== undefined ? state.answers[q.id] : null;
  }

  showLoading('Evaluating your performance...');

  try {
    const result = await api('/submit', 'POST', sessionLog);
    hideLoading();

    if (!result.success) {
      toast(result.error || 'Submission failed', 'error');
      return;
    }

    // Stop timer and clear active running test from localStorage
    clearActiveSession();

    // Preserve questions and answers for results display
    const paperToRender = result.paper || state.paper;
    const answersToRender = { ...state.answers };

    state.report = result.report;
    state.answerKey = result.answerKey;
    if (paperToRender) state.paper = paperToRender;

    renderResults(result.report, result.answerKey, paperToRender, answersToRender, result.evaluation);
    renderEndedSessions();
    showView('results');
    toast('📊 Your performance report is ready!', 'success');
  } catch (err) {
    hideLoading();
    toast('Submission error: ' + err.message, 'error');
  }
}

// ==================== RESULTS RENDERING ====================
function renderResults(report, answerKey = {}, paper = null, userAnswers = null, evaluation = null) {
  // === Score Hero ===
  const gradeClass = report.scoreSummary.grade.startsWith('A') ? 'grade-a'
    : report.scoreSummary.grade.startsWith('B') ? 'grade-b'
      : report.scoreSummary.grade === 'C' ? 'grade-c'
        : report.scoreSummary.grade === 'D' ? 'grade-d'
          : 'grade-f';

  let comparisonHtml = '';
  if (report.priorComparison && report.priorComparison.available) {
    const diff = report.priorComparison.scoreDiff;
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    const color = diff > 0 ? 'var(--emerald)' : diff < 0 ? 'var(--rose)' : 'var(--text-muted)';
    comparisonHtml = `<div class="r-stat"><div class="r-stat-value" style="color:${color}">${arrow} ${Math.abs(diff).toFixed(1)}%</div><div class="r-stat-label">vs Last Attempt</div></div>`;
  }

  $('#results-hero').innerHTML = `
    <div class="score-circle">
      <div class="score-value" id="animated-score-value">0.0%</div>
      <div class="score-label">${report.scoreSummary.score} / ${report.scoreSummary.total}</div>
    </div>
    <div class="grade-badge ${gradeClass}">Grade ${report.scoreSummary.grade}</div>
    <div class="results-stats-row">
      <div class="r-stat"><div class="r-stat-value">${report.scoreSummary.attempted}</div><div class="r-stat-label">Attempted</div></div>
      <div class="r-stat"><div class="r-stat-value">${report.scoreSummary.skipped}</div><div class="r-stat-label">Skipped</div></div>
      <div class="r-stat"><div class="r-stat-value">${formatTime(report.timeAnalysis.totalTimeSec)}</div><div class="r-stat-label">Total Time</div></div>
      <div class="r-stat"><div class="r-stat-value">${report.timeAnalysis.avgPerQuestion}s</div><div class="r-stat-label">Avg / Question</div></div>
      ${comparisonHtml}
    </div>
  `;

  // Animate score count-up
  const targetPercent = report.scoreSummary.percent;
  const scoreEl = document.getElementById('animated-score-value');
  if (scoreEl) {
    const startTime = performance.now();
    const duration = 900;
    function countUp(now) {
      const progress = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      scoreEl.textContent = `${(targetPercent * ease).toFixed(1)}%`;
      if (progress < 1) requestAnimationFrame(countUp);
    }
    requestAnimationFrame(countUp);
  }

  // === Charts ===
  renderCharts(report.chartData);

  // === Weak Areas ===
  if (report.weakAreas.length > 0) {
    let weakHtml = '<h3>🎯 Weak Areas (Ranked by Impact)</h3>';
    for (const wa of report.weakAreas) {
      const accColor = wa.accuracy < 30 ? 'var(--rose)' : wa.accuracy < 50 ? 'var(--amber)' : 'var(--text-primary)';
      weakHtml += `
        <div class="weak-area-item">
          <div class="weak-rank">${wa.rank}</div>
          <div class="weak-info">
            <div class="weak-topic">${wa.topic}</div>
            <div class="weak-recommendation">${wa.recommendation}</div>
          </div>
          <div class="weak-accuracy" style="color:${accColor}">${wa.accuracy.toFixed(1)}%</div>
        </div>
      `;
    }
    $('#weak-areas-section').innerHTML = weakHtml;
    $('#weak-areas-section').style.display = '';
  } else {
    $('#weak-areas-section').innerHTML = '<h3>🎯 Weak Areas</h3><p style="color:var(--emerald);padding:1rem;">No significant weak areas detected. Great work!</p>';
  }

  // === Recommendations ===
  let recHtml = '<h3>💡 What to Study Next</h3>';
  for (const rec of report.recommendations) {
    recHtml += `<div class="rec-item"><span class="rec-icon">→</span><span>${rec}</span></div>`;
  }
  $('#recommendations-section').innerHTML = recHtml;

  // === Patterns ===
  let patHtml = '<h3>🔍 Performance Patterns</h3>';
  for (const pat of report.overallPatterns) {
    patHtml += `<div class="pattern-item">${pat}</div>`;
  }

  // Guessing patterns
  if (report.guessingPatterns) {
    const { rushedWrong, slowWrong } = report.guessingPatterns;
    if (rushedWrong.length > 0) {
      patHtml += `<div class="pattern-item" style="border-left-color:var(--amber);">⚡ ${rushedWrong.length} questions answered too quickly and incorrectly (possible guessing)</div>`;
    }
    if (slowWrong.length > 0) {
      patHtml += `<div class="pattern-item" style="border-left-color:var(--rose);">🐌 ${slowWrong.length} questions where you spent excessive time but still got wrong</div>`;
    }
  }

  // Difficulty insights
  if (report.difficultyInsights) {
    for (const di of report.difficultyInsights) {
      const icon = di.pattern === 'strong' ? '💪' : di.pattern === 'struggling' ? '😰' : di.pattern === 'needs-improvement' ? '📚' : '✓';
      patHtml += `<div class="pattern-item" style="border-left-color:var(--cyan);">${icon} ${capitalize(di.difficulty)}: ${di.accuracy.toFixed(1)}% accuracy, avg ${di.avgTimeSec}s/question — ${di.pattern}</div>`;
    }
  }

  $('#patterns-section').innerHTML = patHtml;

  // === Question Review ===
  renderQuestionReview(report, answerKey, paper, userAnswers, evaluation);
}

function renderQuestionReview(report, answerKey = {}, paper = null, userAnswers = null, evaluation = null) {
  const list = $('#question-review-list');
  if (!list) return;

  const questions = (paper && paper.questions && paper.questions.length > 0)
    ? paper.questions
    : (state.paper && state.paper.questions && state.paper.questions.length > 0)
      ? state.paper.questions
      : [];

  const answersMap = userAnswers || state.answers || {};

  // Case 1: Full question objects are available
  if (questions.length > 0) {
    let html = '';
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

    questions.forEach((q, i) => {
      const key = (answerKey && answerKey[q.id]) || {
        correct_option: q.correct_option,
        explanation: q.explanation || 'No detailed explanation provided.',
        correctText: (q.options && q.options[q.correct_option]) || ''
      };

      const selected = answersMap[q.id];
      const isCorrect = selected !== undefined && selected === key.correct_option;
      const isSkipped = selected === undefined;

      const statusClass = isSkipped ? 'skipped' : isCorrect ? 'correct' : 'wrong';
      const statusText = isSkipped ? 'Skipped' : isCorrect ? 'Correct' : 'Wrong';

      let answerInfo = '';
      if (isSkipped) {
        answerInfo = `<span>Not answered</span> · Correct: <span class="correct-ans">${letters[key.correct_option]}. ${formatContent(key.correctText)}</span>`;
      } else if (isCorrect) {
        answerInfo = `<span class="correct-ans">✓ ${letters[selected]}. ${formatContent(q.options[selected])}</span>`;
      } else {
        answerInfo = `Your answer: <span class="wrong-ans">${letters[selected]}. ${formatContent(q.options[selected])}</span> · Correct: <span class="correct-ans">${letters[key.correct_option]}. ${formatContent(key.correctText)}</span>`;
      }

      html += `
        <div class="review-item ${statusClass}">
          <div class="review-header">
            <span class="review-q-num">Q${i + 1} · ${escapeHtml(q.topic)} · ${escapeHtml(q.difficulty)}</span>
            <span class="review-status ${statusClass}">${statusText}</span>
          </div>
          <div class="review-question">${formatContent(q.question_text)}</div>
          <div class="review-answers">${answerInfo}</div>
          <div class="review-explanation">💡 <strong>Explanation:</strong> ${formatContent(key.explanation)}</div>
        </div>
      `;
    });

    list.innerHTML = html;
    return;
  }

  // Case 2: Archived attempt where only evaluation.perQuestion summary is present
  const perQ = evaluation?.perQuestion || report?.evaluation?.perQuestion;
  if (perQ && typeof perQ === 'object') {
    const qIds = Object.keys(perQ);
    if (qIds.length > 0) {
      let html = '<div style="margin-bottom:0.8rem; font-size:0.85rem; color:var(--text-muted);">Showing archived performance breakdown per question:</div>';
      const letters = ['A', 'B', 'C', 'D'];
      qIds.forEach((qid, idx) => {
        const item = perQ[qid];
        const isCorrect = Boolean(item.correct);
        const statusClass = isCorrect ? 'correct' : 'wrong';
        const statusText = isCorrect ? 'Correct' : 'Wrong';
        const selectedLetter = (item.selectedOption !== undefined && item.selectedOption !== null)
          ? (letters[item.selectedOption] || item.selectedOption)
          : 'Skipped';
        const correctLetter = item.correctOption !== undefined ? (letters[item.correctOption] || item.correctOption) : '—';

        html += `
          <div class="review-item ${statusClass}">
            <div class="review-header">
              <span class="review-q-num">Q${idx + 1} · ${escapeHtml(item.topic || 'General')} · ${escapeHtml(item.difficulty || '')}</span>
              <span class="review-status ${statusClass}">${statusText}</span>
            </div>
            <div class="review-answers">
              Your Choice: <strong>Option ${selectedLetter}</strong> · Correct Choice: <span class="correct-ans">Option ${correctLetter}</span> · Time: ${Math.round(item.timeSpentSec || 0)}s
            </div>
          </div>
        `;
      });
      list.innerHTML = html;
      return;
    }
  }

  // Case 3: Empty fallback
  list.innerHTML = '<p class="text-muted" style="text-align:center; padding:1.5rem;">Detailed question review is not available for this archived report.</p>';
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ==================== CHARTS ====================
let radarChart = null, diffChart = null, timeChart = null, historyChart = null;

function renderCharts(chartData) {
  // Destroy previous chart instances
  if (radarChart) radarChart.destroy();
  if (diffChart) diffChart.destroy();
  if (timeChart) timeChart.destroy();

  const chartFont = { family: "'Inter', sans-serif" };
  const gridColor = 'rgba(120, 130, 255, 0.08)';
  const tickColor = '#5f6589';

  Chart.defaults.color = '#9ea4c4';
  Chart.defaults.font.family = "'Inter', sans-serif";

  // --- Radar Chart: Topic Accuracy ---
  radarChart = new Chart($('#chart-radar'), {
    type: 'radar',
    data: {
      labels: chartData.radarLabels,
      datasets: [{
        label: 'Accuracy %',
        data: chartData.radarValues,
        backgroundColor: 'rgba(108, 99, 255, 0.15)',
        borderColor: '#6c63ff',
        borderWidth: 2,
        pointBackgroundColor: '#6c63ff',
        pointBorderColor: '#fff',
        pointBorderWidth: 1,
        pointRadius: 4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        r: {
          beginAtZero: true,
          max: 100,
          ticks: { stepSize: 20, color: tickColor, backdropColor: 'transparent', font: { size: 10 } },
          grid: { color: gridColor },
          angleLines: { color: gridColor },
          pointLabels: { font: { size: 11, weight: '600' }, color: '#9ea4c4' },
        },
      },
      plugins: {
        legend: { display: false },
      },
    },
  });

  // --- Bar Chart: Difficulty Breakdown ---
  diffChart = new Chart($('#chart-difficulty'), {
    type: 'bar',
    data: {
      labels: chartData.barLabels,
      datasets: [
        {
          label: 'Correct',
          data: chartData.barCorrect,
          backgroundColor: 'rgba(52, 211, 153, 0.7)',
          borderColor: '#34d399',
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: 'Total',
          data: chartData.barTotal,
          backgroundColor: 'rgba(108, 99, 255, 0.3)',
          borderColor: '#6c63ff',
          borderWidth: 1,
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: tickColor } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, stepSize: 4 } },
      },
      plugins: {
        legend: { labels: { boxWidth: 12, padding: 16 } },
      },
    },
  });

  // --- Line Chart: Time Distribution ---
  timeChart = new Chart($('#chart-time'), {
    type: 'line',
    data: {
      labels: chartData.timeLabels,
      datasets: [
        {
          label: 'Actual Time (s)',
          data: chartData.timeActual,
          borderColor: '#6c63ff',
          backgroundColor: 'rgba(108, 99, 255, 0.1)',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Recommended Time (s)',
          data: chartData.timeRecommended,
          borderColor: 'rgba(52, 211, 153, 0.5)',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: tickColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 20, font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor }, title: { display: true, text: 'Seconds', color: tickColor } },
      },
      plugins: {
        legend: { labels: { boxWidth: 12, padding: 16 } },
      },
      interaction: {
        mode: 'index',
        intersect: false,
      },
    },
  });
}

// ==================== HISTORY ====================
async function loadHistory() {
  try {
    const result = await api('/attempts');
    const list = $('#history-list');
    const empty = $('#history-empty');
    const chartArea = $('#history-chart-area');

    if (!result.attempts || result.attempts.length === 0) {
      list.innerHTML = '';
      empty.style.display = '';
      chartArea.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    chartArea.style.display = '';

    // Render list
    list.innerHTML = result.attempts.map(a => {
      const date = new Date(a.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const gradeClass = (a.grade || '').startsWith('A') ? 'grade-a' : (a.grade || '').startsWith('B') ? 'grade-b' : a.grade === 'C' ? 'grade-c' : a.grade === 'D' ? 'grade-d' : 'grade-f';
      return `
        <div class="history-item" style="cursor: pointer;" title="Click to view full report" onclick="viewEndedReport('${a.id}')">
          <div class="history-date">${date}</div>
          <div class="history-score">${a.score}/${a.total} (${a.percent?.toFixed(1)}%)</div>
          <span class="history-grade ${gradeClass}">${a.grade || '—'}</span>
        </div>
      `;
    }).join('');

    // Render history chart
    renderHistoryChart(result.attempts.reverse());
  } catch (err) {
    toast('Failed to load history: ' + err.message, 'error');
  }
}

function renderHistoryChart(attempts) {
  if (historyChart) historyChart.destroy();

  const labels = attempts.map((a, i) => `#${i + 1}`);
  const data = attempts.map(a => a.percent || 0);

  historyChart = new Chart($('#chart-history'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Score %',
        data,
        borderColor: '#6c63ff',
        backgroundColor: 'rgba(108, 99, 255, 0.1)',
        borderWidth: 2.5,
        pointBackgroundColor: '#6c63ff',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        x: { grid: { color: 'rgba(120, 130, 255, 0.08)' }, ticks: { color: '#5f6589' } },
        y: { beginAtZero: true, max: 100, grid: { color: 'rgba(120, 130, 255, 0.08)' }, ticks: { color: '#5f6589', stepSize: 20 } },
      },
      plugins: {
        legend: { display: false },
      },
    },
  });
}

// ==================== EVENT LISTENERS ====================
document.addEventListener('DOMContentLoaded', () => {
  // Network Info, Auth & Shared Banks init
  fetchNetworkInfo();
  checkAuth();
  loadSharedBanks();

  // Active Session and Test Sessions Hub init
  restoreActiveSession();
  updateRunningSessionUI();
  renderEndedSessions();

  // Test sessions hub tab buttons & nav resume button
  const navResumeBtn = $('#nav-resume-btn');
  if (navResumeBtn) navResumeBtn.onclick = resumeActiveExam;

  const hubTabRunning = $('#hub-tab-running');
  if (hubTabRunning) hubTabRunning.onclick = () => switchHubTab('running');

  const hubTabEnded = $('#hub-tab-ended');
  if (hubTabEnded) hubTabEnded.onclick = () => switchHubTab('ended');

  // Refresh shared banks button
  const refreshSharedBtn = $('#refresh-shared-btn');
  if (refreshSharedBtn) refreshSharedBtn.onclick = () => {
    loadSharedBanks();
    toast('🔄 Refreshed shared question banks', 'info', 2000);
  };

  // Auth UI Listeners
  $('#login-modal-btn').onclick = () => openAuthModal('login');
  $('#auth-modal-close').onclick = closeAuthModal;
  $('#logout-btn').onclick = logout;

  $('#tab-login-btn').onclick = () => openAuthModal('login');
  $('#tab-register-btn').onclick = () => openAuthModal('register');

  $('#auth-form').onsubmit = (e) => {
    e.preventDefault();
    handleAuthSubmit();
  };
  $('#auth-submit-btn').onclick = handleAuthSubmit;

  // Save Bank Modal (Personal)
  $('#save-bank-btn').onclick = openSaveBankModal;
  $('#save-bank-close').onclick = closeSaveBankModal;
  $('#confirm-save-bank-btn').onclick = confirmSaveBank;

  // Publish Global Bank Modal (Admin)
  const pubGlobalBtn = $('#publish-global-btn');
  if (pubGlobalBtn) pubGlobalBtn.onclick = openPublishBankModal;
  const pubCloseBtn = $('#publish-bank-close');
  if (pubCloseBtn) pubCloseBtn.onclick = closePublishBankModal;
  const pubConfirmBtn = $('#confirm-publish-bank-btn');
  if (pubConfirmBtn) pubConfirmBtn.onclick = confirmPublishBank;

  // Floating Action Button (FAB)
  const fabContainer = $('#fab-container');
  const fabMain = $('#fab-main');
  if (fabMain && fabContainer) {
    fabMain.onclick = (e) => {
      e.stopPropagation();
      fabContainer.classList.toggle('open');
    };

    document.addEventListener('click', (e) => {
      if (!fabContainer.contains(e.target)) {
        fabContainer.classList.remove('open');
      }
    });

    const fabScrollTop = $('#fab-scroll-top');
    if (fabScrollTop) fabScrollTop.onclick = () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      fabContainer.classList.remove('open');
    };

    const fabHistory = $('#fab-history');
    if (fabHistory) fabHistory.onclick = () => {
      showView('history');
      loadHistory();
      fabContainer.classList.remove('open');
    };

    const fabShared = $('#fab-shared');
    if (fabShared) fabShared.onclick = () => {
      showView('upload');
      fabContainer.classList.remove('open');
      setTimeout(() => {
        const sec = $('#shared-banks-section');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    };

    const fabHome = $('#fab-home');
    if (fabHome) fabHome.onclick = () => {
      showView('upload');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      fabContainer.classList.remove('open');
    };

    const fabAi = $('#fab-ai');
    if (fabAi) fabAi.onclick = () => {
      fabContainer.classList.remove('open');
      openAiModal();
    };
  }

  // AI Generator Modal Listeners
  const openAiBtn = $('#open-ai-modal-btn');
  if (openAiBtn) openAiBtn.onclick = openAiModal;

  const aiCloseBtn = $('#ai-modal-close');
  if (aiCloseBtn) aiCloseBtn.onclick = closeAiModal;

  const aiCancelBtn = $('#ai-modal-cancel');
  if (aiCancelBtn) aiCancelBtn.onclick = closeAiModal;

  const aiSubmitBtn = $('#ai-submit-generate-btn');
  if (aiSubmitBtn) aiSubmitBtn.onclick = handleAiGenerate;

  // AI Prompt Chips
  $$('.ai-chip').forEach(chip => {
    chip.onclick = () => {
      const promptInput = $('#ai-prompt-input');
      if (promptInput) {
        promptInput.value = chip.dataset.prompt || chip.textContent;
        promptInput.focus();
      }
    };
  });

  // AI Count Presets
  $$('#ai-count-presets .preset-btn').forEach(btn => {
    btn.onclick = () => {
      $$('#ai-count-presets .preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const val = btn.dataset.count;
      const countInput = $('#ai-count-input');
      if (countInput) countInput.value = val;
    };
  });

  const aiCountInput = $('#ai-count-input');
  if (aiCountInput) {
    aiCountInput.oninput = () => {
      const current = parseInt(aiCountInput.value, 10);
      $$('#ai-count-presets .preset-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.count, 10) === current);
      });
    };
  }

  // Banner buttons for guests
  const bannerLoginBtn = $('#banner-login-btn');
  if (bannerLoginBtn) bannerLoginBtn.onclick = () => openAuthModal('login');
  const bannerRegBtn = $('#banner-register-btn');
  if (bannerRegBtn) bannerRegBtn.onclick = () => openAuthModal('register');

  // Header Scroll Effect
  window.addEventListener('scroll', () => {
    const header = $('.app-header');
    if (header) {
      if (window.scrollY > 20) {
        header.classList.add('scrolled');
      } else {
        header.classList.remove('scrolled');
      }
    }
  });

  // Global Button Ripple Effect
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    const circle = document.createElement('span');
    const diameter = Math.max(btn.clientWidth, btn.clientHeight);
    const radius = diameter / 2;
    const rect = btn.getBoundingClientRect();
    circle.style.width = circle.style.height = `${diameter}px`;
    circle.style.left = `${e.clientX - rect.left - radius}px`;
    circle.style.top = `${e.clientY - rect.top - radius}px`;
    circle.classList.add('ripple');
    const existingRipple = btn.querySelector('.ripple');
    if (existingRipple) existingRipple.remove();
    btn.appendChild(circle);
    setTimeout(() => circle.remove(), 600);
  });

  // Exam Configuration Modal
  $('#config-modal-close').onclick = closeExamConfigModal;
  $('#config-modal-cancel').onclick = closeExamConfigModal;
  $('#config-modal-start').onclick = startCustomPaper;

  $('#topic-select-all').onclick = () => {
    $$('.topic-cb').forEach(cb => cb.checked = true);
    updateExamConfigState();
  };

  $('#topic-deselect-all').onclick = () => {
    $$('.topic-cb').forEach(cb => cb.checked = false);
    updateExamConfigState();
  };

  // Question presets
  $$('#q-presets-row .preset-btn').forEach(btn => {
    btn.onclick = () => {
      const qVal = btn.dataset.q;
      const qInput = $('#config-q-input');
      if (qVal === 'max') {
        qInput.value = qInput.max || 40;
      } else {
        qInput.value = qVal;
      }
      updateExamConfigState();
    };
  });

  // Time presets
  $$('#time-presets-row .preset-btn').forEach(btn => {
    btn.onclick = () => {
      $('#config-time-input').value = btn.dataset.time;
      updateExamConfigState();
    };
  });

  $('#config-q-input').oninput = updateExamConfigState;
  $('#config-time-input').oninput = updateExamConfigState;

  // Nav
  $('#logo-home').onclick = () => showView('upload');
  $('#nav-home').onclick = () => showView('upload');
  $('#nav-history').onclick = () => { showView('history'); loadHistory(); };
  $('#history-start-btn').onclick = () => showView('upload');

  // Upload - File
  const dropZone = $('#upload-drop-zone');
  const fileInput = $('#file-input');

  $('#browse-btn').onclick = () => {
    if (!ensureLoggedIn('upload question banks')) return;
    fileInput.click();
  };

  fileInput.onchange = (e) => {
    if (!ensureLoggedIn('upload question banks')) return;
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => handleUpload(ev.target.result);
    reader.readAsText(file);
  };

  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
  dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (!ensureLoggedIn('upload question banks')) return;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => handleUpload(ev.target.result);
    reader.readAsText(file);
  };

  // Upload - Paste
  $('#paste-upload-btn').onclick = () => {
    if (!ensureLoggedIn('paste question banks')) return;
    const text = $('#json-textarea').value.trim();
    if (!text) { toast('Please paste your JSON first', 'warning'); return; }
    handleUpload(text);
  };

  // Upload - Sample CS Bank
  $('#sample-btn').onclick = async () => {
    if (!ensureLoggedIn('take sample mock exams')) return;
    showLoading('Loading CS Theory question bank...');
    try {
      const data = await api('/sample');
      hideLoading();
      handleUpload(data);
    } catch (err) {
      hideLoading();
      toast('Failed to load sample data: ' + err.message, 'error');
    }
  };

  // Upload - Sample Code Snippets Bank
  $('#sample-code-btn').onclick = async () => {
    if (!ensureLoggedIn('take sample code exams')) return;
    showLoading('Loading Code Snippets question bank...');
    try {
      const data = await api('/sample-code');
      hideLoading();
      handleUpload(data);
    } catch (err) {
      hideLoading();
      toast('Failed to load code sample data: ' + err.message, 'error');
    }
  };

  // Validation
  $('#generate-paper-btn').onclick = generatePaper;
  $('#re-upload-btn').onclick = async () => {
    await api('/full-reset', 'POST');
    showView('upload');
  };

  // Exam navigation
  $('#prev-btn').onclick = () => {
    if (state.currentQuestion > 0) navigateTo(state.currentQuestion - 1);
  };

  $('#next-btn').onclick = async () => {
    if (!state.paper || !state.paper.questions) return;

    if (state.currentQuestion < state.paper.questions.length - 1) {
      navigateTo(state.currentQuestion + 1);
    } else {
      // User is on the last question and clicks 'Finish'
      $('#submit-exam-btn')?.click();
    }
  };

  // Flag
  $('#flag-btn').onclick = () => {
    if (!state.paper || !state.paper.questions) return;
    const qid = state.paper.questions[state.currentQuestion].id;
    if (state.flagged.has(qid)) {
      state.flagged.delete(qid);
      logEvent('unflag', qid);
    } else {
      state.flagged.add(qid);
      logEvent('flag', qid);
    }
    renderQuestion(state.currentQuestion);
  };

  // Submit exam
  $('#submit-exam-btn').onclick = async () => {
    if (!state.paper || !state.paper.questions) {
      toast('No active exam to submit', 'warning');
      return;
    }
    const unanswered = state.paper.questions.filter(q => state.answers[q.id] === undefined).length;
    const msg = unanswered > 0
      ? `You have answered ${state.paper.questions.length - unanswered} of ${state.paper.questions.length} questions (${unanswered} unanswered). Are you sure you want to finish and submit?`
      : 'You have answered all questions. Are you ready to finish and submit your exam?';

    const confirmed = await confirm('Finish & Submit Exam', msg);
    if (confirmed) await submitExam(false);
  };

  // Results actions
  $('#retake-btn').onclick = async () => {
    await api('/reset', 'POST');
    generatePaper();
  };

  $('#new-upload-btn').onclick = async () => {
    await api('/full-reset', 'POST');
    showView('upload');
  };

  // Keyboard shortcuts for exam
  document.addEventListener('keydown', (e) => {
    if (state.currentView !== 'exam') return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.currentQuestion > 0) navigateTo(state.currentQuestion - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.paper && state.currentQuestion < state.paper.questions.length - 1) {
        navigateTo(state.currentQuestion + 1);
      }
    } else if (e.key >= '1' && e.key <= '4') {
      const idx = parseInt(e.key) - 1;
      const q = state.paper?.questions?.[state.currentQuestion];
      if (q && idx < q.options.length) selectOption(q.id, idx);
    } else if (e.key === 'f' || e.key === 'F') {
      $('#flag-btn').click();
    } else if (e.key === ' ' || e.key === 'Enter') {
      const q = state.paper?.questions?.[state.currentQuestion];
      if (q && state.isInteractive && state.answers[q.id] !== undefined) {
        e.preventDefault();
        if (state.currentQuestion < state.paper.questions.length - 1) {
          navigateTo(state.currentQuestion + 1);
        } else {
          // On last question in interactive mode, pressing Enter or Space triggers Finish
          $('#next-btn')?.click();
        }
      }
    }
  });
});
