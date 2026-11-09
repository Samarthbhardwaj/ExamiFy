import { BaseAgent } from './base-agent.js';

// Clean and escape control characters (raw newlines, tabs) and fix invalid escape sequences (e.g. SQL \%, regex \d, \s) inside JSON string literals
function sanitizeJsonString(str) {
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = str.charCodeAt(i);

    if (inString) {
      if (escape) {
        escape = false;
        // Check valid JSON escape character: ", \, /, b, f, n, r, t, or unicode \uXXXX
        if (ch === '"' || ch === '\\' || ch === '/' || ch === 'b' || ch === 'f' || ch === 'n' || ch === 'r' || ch === 't') {
          result += '\\' + ch;
        } else if (ch === 'u') {
          const next4 = str.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(next4)) {
            result += '\\u';
          } else {
            result += '\\\\u';
          }
        } else if (ch === "'") {
          // Single quote is completely valid inside double-quoted string without backslash
          result += "'";
        } else {
          // Any other escape like \%, \d, \s, \w, \_, \( -> escape the backslash to preserve as literal
          result += '\\\\' + ch;
        }
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        result += '"';
        inString = false;
      } else if (code < 32) {
        if (ch === '\n') result += '\\n';
        else if (ch === '\r') result += '\\r';
        else if (ch === '\t') result += '\\t';
        else if (ch === '\b') result += '\\b';
        else if (ch === '\f') result += '\\f';
      } else {
        result += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
      }
      result += ch;
    }
  }

  if (escape) {
    result += '\\\\';
  }

  return result;
}

/**
 * GeneratorAgent — Leverages the Google Gemini API to dynamically
 * generate high-quality question banks based on custom prompts.
 */
export class GeneratorAgent extends BaseAgent {
  constructor(config = {}) {
    super('generator', config);
    this.defaultModel = config.defaultModel || 'gemini-3.5-flash-lite';
  }

  /**
   * Normalize and resolve model name to ensure compatibility with latest Gemini API
   */
  resolveModel(model) {
    let m = (model || '').trim();
    if (m.startsWith('models/')) m = m.slice(7);

    const lower = m.toLowerCase();
    if (!lower || lower === 'gemini-3.5-flash' || lower === 'gemini-3.5' || lower === 'default') {
      return 'gemini-3.5-flash';
    }
    if (lower === 'gemini-3.8' || lower === 'gemini-3.8-flash') {
      return 'gemini-3.8-flash';
    }
    if (lower === 'gemini-3.8-pro') {
      return 'gemini-3.8-pro';
    }
    if (lower === 'gemini-3.6-flash' || lower === 'gemini-3.6') {
      return 'gemini-3.6-flash';
    }
    if (lower === 'gemini-3.5-flash-lite' || lower === 'gemini-flash-lite') {
      return 'gemini-3.5-flash-lite';
    }
    if (lower === 'gemini-3.7-flash') {
      return 'gemini-3.7-flash';
    }
    if (lower.includes('2.0') || lower.includes('1.5') || lower.includes('2.5')) {
      // Legacy models that Gemini API rejects with 404
      return 'gemini-3.5-flash';
    }
    return m;
  }

  /**
   * Validate generator parameters
   */
  validate(input) {
    const errors = [];
    if (!input || typeof input !== 'object') {
      errors.push('Input must be a valid object');
      return { valid: false, errors };
    }

    if (!input.prompt || typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      errors.push('A topic or prompt description is required');
    }

    if (!input.apiKey || typeof input.apiKey !== 'string' || input.apiKey.trim().length === 0) {
      errors.push('Google Gemini API Key is required');
    }

    const count = parseInt(input.count, 10);
    if (isNaN(count) || count < 1 || count > 50) {
      errors.push('Question count must be between 1 and 50');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Execute question generation using Google Gemini API
   */
  async execute(input) {
    const validation = this.validate(input);
    if (!validation.valid) {
      throw new Error(`Generator validation failed: ${validation.errors.join('; ')}`);
    }

    const {
      prompt,
      count = 10,
      difficulty = 'mixed',
      includeCode = true,
      apiKey,
      model = this.defaultModel
    } = input;

    this.log(`Generating ${count} questions (difficulty: ${difficulty}, includeCode: ${includeCode}) with model: ${model}`);

    const systemPrompt = `You are an elite Computer Science and STEM Exam Professor & Technical Interviewer.
Your task is to generate exactly ${count} high-quality, rigorous multiple-choice questions (MCQs) based on the user's request.

REQUEST DETAILS:
- Topic / Focus: "${prompt.trim()}"
- Target Question Count: ${count}
- Target Difficulty: ${difficulty} (if "mixed", provide ~30% easy, ~50% medium, ~20% hard)
- Include Code Snippets: ${includeCode ? 'YES (Use markdown code blocks with language specifiers like ```python, ```javascript, ```sql, ```cpp, etc. in question_text and options when relevant)' : 'NO'}

STRICT QUESTION FORMAT RULES:
1. Each question must have:
   - "id": A unique string like "gemini-q-1", "gemini-q-2", etc.
   - "topic": High-level subject area (e.g., "Python", "Operating Systems", "React", "Data Structures", etc.)
   - "subtopic": Specific subtopic (e.g., "Asyncio", "Deadlocks", "State Management", "Binary Trees", etc.)
   - "difficulty": Exactly one of "easy", "medium", or "hard".
   - "question_text": The clear question scenario or prompt. If including code snippets, format them using triple backticks with language tag.
   - "options": An array of exactly 4 plausible choices (strings). Each choice must be distinct and well-formed.
   - "correct_option": The zero-based integer index (0, 1, 2, or 3) of the correct choice in the "options" array.
   - "explanation": A thorough, educational explanation of why the correct option is right and why distractors are wrong.
   - "tags": Array of 2-5 relevant keywords.
   - "recommended_time_sec": Reasonable time in seconds to answer (between 30 and 120).

OUTPUT REQUIREMENTS:
Output ONLY a single valid JSON object with this exact structure:
{
  "name": "A concise, engaging title for this question bank",
  "topic": "Primary overarching topic",
  "questions": [
    ... ${count} question objects conforming to the schema above ...
  ]
}
No additional prose, no markdown fences outside the JSON.`;

    const requestedModel = this.resolveModel(model);
    const candidateModels = [...new Set([
      requestedModel,
      'gemini-3.5-flash-lite',
      'gemini-flash-lite-latest',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite'
    ])];

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: systemPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.5,
        responseMimeType: 'application/json'
      }
    };

    let data = null;
    let lastError = null;
    let modelUsed = requestedModel;

    modelLoop:
    for (const currentModel of candidateModels) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

      this.log(`Calling Gemini API with model: ${currentModel}...`);

      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(20000)
        });
      } catch (networkErr) {
        lastError = new Error(`Network/timeout calling Gemini (${currentModel}): ${networkErr.message}`);
        this.log(`Network or timeout on ${currentModel}: ${networkErr.message}. Trying next candidate model...`, 'warn');
        continue; // Immediately try next model in fallback list
      }

      if (response.ok) {
        data = await response.json();
        modelUsed = currentModel;
        this.log(`Successfully received questions using model: ${currentModel}`);
        break modelLoop;
      }

      let errBody = '';
      try {
        const errJson = await response.json();
        errBody = errJson.error?.message || JSON.stringify(errJson);
      } catch {
        errBody = await response.text();
      }

      lastError = new Error(`Gemini API error (${response.status}): ${errBody}`);

      // If 503 (High demand), 429 (Rate limit), 500, 502, 504: immediately switch to next model
      if ([503, 429, 500, 502, 504].includes(response.status)) {
        this.log(`Model "${currentModel}" returned ${response.status} ("${errBody}"). Automatically switching to next candidate model...`, 'warn');
        continue;
      }

      // If 404 (Model not found / deprecated): immediately try next model
      if (response.status === 404) {
        this.log(`Model "${currentModel}" returned 404 (not found). Switching to next candidate model...`, 'warn');
        continue;
      }

      // For client-side auth errors like 400 (invalid API key) or 403 (unauthorized): throw immediately
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw lastError;
      }
    }

    if (!data) {
      if (lastError && (lastError.message.includes('503') || lastError.message.includes('demand'))) {
        throw new Error('Google Gemini servers are currently experiencing high traffic. All automatic model fallbacks were attempted. Please try again in a few moments.');
      }
      throw lastError || new Error('Failed to generate exam with Gemini models.');
    }
    const candidate = data.candidates?.[0];
    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      throw new Error('Gemini API returned an empty or invalid response.');
    }

    let rawText = candidate.content.parts[0].text.trim();

    // If the entire output is wrapped in an outer markdown code block, unwrap only the outer fence
    if (rawText.startsWith('```')) {
      rawText = rawText.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?\s*```$/g, '').trim();
    }

    // Extract the complete root JSON object from the first '{' to the last '}'
    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      rawText = rawText.substring(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (firstErr) {
      // 1. Try sanitizing unescaped control characters inside string literals (e.g. raw newlines in code snippets)
      try {
        const sanitized = sanitizeJsonString(rawText);
        parsed = JSON.parse(sanitized);
      } catch (secondErr) {
        // 2. Try fixing trailing commas before } or ]
        try {
          const fixedCommas = sanitizeJsonString(rawText).replace(/,\s*([}\]])/g, '$1');
          parsed = JSON.parse(fixedCommas);
        } catch {
          this.log(`Failed to parse Gemini JSON output: ${firstErr.message}`, 'error');
          throw new Error(`Gemini generated non-JSON output. Please try again. Raw snippet: ${rawText.slice(0, 150)}...`);
        }
      }
    }

    if (!parsed.questions || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      throw new Error('Gemini response did not contain a valid "questions" array.');
    }

    // Sanitize and ensure full compliance
    const sanitizedQuestions = parsed.questions.map((q, idx) => {
      const qNum = idx + 1;
      const options = Array.isArray(q.options) && q.options.length >= 2
        ? q.options.map(o => String(o))
        : ['Option A', 'Option B', 'Option C', 'Option D'];

      let correctOption = parseInt(q.correct_option, 10);
      if (isNaN(correctOption) || correctOption < 0 || correctOption >= options.length) {
        correctOption = 0;
      }

      let diff = String(q.difficulty || 'medium').toLowerCase();
      if (!['easy', 'medium', 'hard'].includes(diff)) diff = 'medium';

      return {
        id: q.id ? String(q.id).trim() : `gemini-q-${Date.now()}-${qNum}`,
        topic: q.topic ? String(q.topic).trim() : (parsed.topic || 'General Computer Science'),
        subtopic: q.subtopic ? String(q.subtopic).trim() : 'Core Concepts',
        difficulty: diff,
        question_text: String(q.question_text || `Question ${qNum}`).trim(),
        options,
        correct_option: correctOption,
        explanation: String(q.explanation || 'No detailed explanation provided.').trim(),
        tags: Array.isArray(q.tags) ? q.tags.map(t => String(t).trim()).filter(Boolean) : [diff],
        recommended_time_sec: Math.max(20, Math.min(300, parseInt(q.recommended_time_sec, 10) || 60))
      };
    });

    this.log(`Successfully generated and sanitized ${sanitizedQuestions.length} questions`);

    return {
      success: true,
      name: parsed.name || `${prompt.trim().slice(0, 40)} Quiz`,
      topic: parsed.topic || 'AI Generated Quiz',
      questions: sanitizedQuestions,
      modelUsed,
      fallbackUsed: modelUsed !== requestedModel,
      requestedModel
    };
  }
}

