import { BaseAgent } from './base-agent.js';

/**
 * IngestionAgent — Parses, validates, and normalizes an uploaded question bank.
 *
 * Input:  { questions: object[] }
 * Output: { validatedPool: object[], validationReport: object }
 */

const REQUIRED_FIELDS = ['id', 'topic', 'subtopic', 'difficulty', 'question_text', 'options', 'correct_option', 'explanation', 'recommended_time_sec'];
const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];

export class IngestionAgent extends BaseAgent {
  constructor(config = {}) {
    super('IngestionAgent', config);
  }

  validate(input) {
    const errors = [];
    if (!input) errors.push('Input is null or undefined.');
    else if (!Array.isArray(input.questions)) errors.push('"questions" must be an array.');
    else if (input.questions.length === 0) errors.push('"questions" array is empty.');
    return { valid: errors.length === 0, errors };
  }

  execute(input) {
    this.log(`Processing ${input.questions.length} questions...`);

    const validatedPool = [];
    const errors = [];
    const warnings = [];
    const normalizations = [];
    const seenIds = new Set();

    for (let i = 0; i < input.questions.length; i++) {
      const raw = input.questions[i];
      const qLabel = raw.id || `index-${i}`;

      // --- Check required fields ---
      const missingFields = REQUIRED_FIELDS.filter(f => raw[f] === undefined || raw[f] === null);
      if (missingFields.length > 0) {
        errors.push({ questionId: qLabel, field: missingFields.join(', '), message: `Missing required field(s): ${missingFields.join(', ')}` });
        continue;
      }

      // --- Duplicate ID ---
      if (seenIds.has(raw.id)) {
        errors.push({ questionId: raw.id, field: 'id', message: 'Duplicate question ID' });
        continue;
      }
      seenIds.add(raw.id);

      // --- Validate options ---
      if (!Array.isArray(raw.options) || raw.options.length < 2) {
        errors.push({ questionId: raw.id, field: 'options', message: 'Options must be an array with at least 2 entries' });
        continue;
      }

      // --- Validate correct_option range ---
      const correctOpt = Number(raw.correct_option);
      if (isNaN(correctOpt) || correctOpt < 0 || correctOpt >= raw.options.length) {
        errors.push({ questionId: raw.id, field: 'correct_option', message: `correct_option ${raw.correct_option} is out of range [0..${raw.options.length - 1}]` });
        continue;
      }

      // --- Validate recommended_time_sec ---
      const timeSec = Number(raw.recommended_time_sec);
      if (isNaN(timeSec) || timeSec <= 0) {
        errors.push({ questionId: raw.id, field: 'recommended_time_sec', message: 'recommended_time_sec must be a positive number' });
        continue;
      }

      // --- Normalize difficulty ---
      let difficulty = String(raw.difficulty).trim().toLowerCase();
      if (difficulty !== raw.difficulty) {
        normalizations.push({ questionId: raw.id, field: 'difficulty', from: raw.difficulty, to: difficulty });
      }
      if (!VALID_DIFFICULTIES.includes(difficulty)) {
        // Try fuzzy match
        const fuzzy = VALID_DIFFICULTIES.find(d => d.startsWith(difficulty.slice(0, 2)));
        if (fuzzy) {
          warnings.push({ questionId: raw.id, field: 'difficulty', message: `Normalized "${raw.difficulty}" to "${fuzzy}"` });
          normalizations.push({ questionId: raw.id, field: 'difficulty', from: difficulty, to: fuzzy });
          difficulty = fuzzy;
        } else {
          errors.push({ questionId: raw.id, field: 'difficulty', message: `Invalid difficulty "${raw.difficulty}". Must be easy, medium, or hard.` });
          continue;
        }
      }

      // --- Normalize topic / subtopic ---
      const topic = String(raw.topic).trim();
      const subtopic = String(raw.subtopic).trim();
      if (topic !== raw.topic) {
        normalizations.push({ questionId: raw.id, field: 'topic', from: raw.topic, to: topic });
      }
      if (subtopic !== raw.subtopic) {
        normalizations.push({ questionId: raw.id, field: 'subtopic', from: raw.subtopic, to: subtopic });
      }

      // --- Validate question_text ---
      if (typeof raw.question_text !== 'string' || raw.question_text.trim().length === 0) {
        errors.push({ questionId: raw.id, field: 'question_text', message: 'question_text must be a non-empty string' });
        continue;
      }

      // --- Build validated question ---
      const validated = {
        id: raw.id,
        topic,
        subtopic,
        difficulty,
        question_text: raw.question_text.trim(),
        options: raw.options.map(o => String(o)),
        correct_option: correctOpt,
        explanation: String(raw.explanation || '').trim(),
        tags: Array.isArray(raw.tags) ? raw.tags.map(t => String(t).trim().toLowerCase()) : [],
        recommended_time_sec: timeSec,
      };

      validatedPool.push(validated);
    }

    // Tally topics and difficulties
    const topics = {};
    const difficulties = { easy: 0, medium: 0, hard: 0 };
    for (const q of validatedPool) {
      topics[q.topic] = (topics[q.topic] || 0) + 1;
      if (difficulties[q.difficulty] !== undefined) difficulties[q.difficulty]++;
    }

    const report = {
      totalReceived: input.questions.length,
      accepted: validatedPool.length,
      rejected: input.questions.length - validatedPool.length,
      topics,
      difficulties,
      errors,
      warnings,
      normalizations,
    };

    this.log(`Validation complete: ${report.accepted} accepted, ${report.rejected} rejected, ${warnings.length} warnings`);

    return { validatedPool, validationReport: report };
  }
}
