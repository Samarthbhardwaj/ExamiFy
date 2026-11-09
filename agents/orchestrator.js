import { registry } from './registry.js';
import { GeneratorAgent } from './generator-agent.js';
import { IngestionAgent } from './ingestion-agent.js';
import { ComposerAgent } from './composer-agent.js';
import { SessionAgent } from './session-agent.js';
import { EvaluationAgent } from './evaluation-agent.js';
import { WeaknessAgent } from './weakness-agent.js';
import { ReportAgent } from './report-agent.js';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Orchestrator — Coordinates the full agent pipeline and manages state transitions.
 *
 * State machine:
 *   idle → uploading → pool-ready → composing → paper-ready →
 *   in-progress → submitted → evaluating → report-ready
 *
 * Error handling: Each agent call is wrapped in try/catch.
 * The orchestrator owns retries and error propagation.
 */

const ATTEMPTS_DIR = join(process.cwd(), 'data', 'attempts');

export class Orchestrator {
  constructor(options = {}) {
    this.username = options.username || null;
    this.userDir = options.userDir || null;
    this.attemptsDir = options.attemptsDir || (this.userDir ? join(this.userDir, 'attempts') : ATTEMPTS_DIR);
    this.state = 'idle';
    this.validatedPool = null;
    this.validationReport = null;
    this.currentPaper = null;
    this.compositionMetadata = null;

    // Register all agents
    this._registerAgents();
  }

  _registerAgents() {
    if (!registry.has('generator')) registry.register('generator', new GeneratorAgent(), 5);
    if (!registry.has('ingestion')) registry.register('ingestion', new IngestionAgent(), 10);
    if (!registry.has('composer')) registry.register('composer', new ComposerAgent(), 20);
    if (!registry.has('session')) registry.register('session', new SessionAgent(), 30);
    if (!registry.has('evaluation')) registry.register('evaluation', new EvaluationAgent(), 40);
    if (!registry.has('weakness')) registry.register('weakness', new WeaknessAgent(), 50);
    if (!registry.has('report')) registry.register('report', new ReportAgent(), 60);
  }

  /**
   * Phase 0: Generate questions using Google Gemini AI and automatically ingest into pool.
   * @param {{ prompt: string, count?: number, difficulty?: string, includeCode?: boolean, apiKey: string, model?: string }} options
   */
  async generateFromAI(options = {}) {
    const generator = registry.get('generator');
    const genResult = await generator.execute(options);

    // Ingest the generated questions directly into the pool
    const uploadResult = this.upload({ questions: genResult.questions });

    return {
      success: uploadResult.success,
      name: genResult.name,
      topic: genResult.topic,
      questions: genResult.questions,
      modelUsed: genResult.modelUsed,
      fallbackUsed: genResult.fallbackUsed,
      requestedModel: genResult.requestedModel,
      validationReport: uploadResult.validationReport,
      error: uploadResult.error
    };
  }

  /**
   * Phase 1: Upload and validate a question bank.
   * @param {{ questions: object[] }} input
   * @returns {{ validatedPool, validationReport }}
   */
  upload(input) {
    this.state = 'uploading';

    const ingestion = registry.get('ingestion');

    // Validate input contract
    const validation = ingestion.validate(input);
    if (!validation.valid) {
      this.state = 'idle';
      return { success: false, error: 'Invalid input', details: validation.errors };
    }

    try {
      const result = ingestion.execute(input);
      this.validatedPool = result.validatedPool;
      this.validationReport = result.validationReport;

      if (this.validatedPool.length === 0) {
        this.state = 'idle';
        return { success: false, error: 'No valid questions after validation', validationReport: result.validationReport };
      }

      this.state = 'pool-ready';
      return { success: true, ...result };
    } catch (err) {
      this.state = 'idle';
      return { success: false, error: `Ingestion failed: ${err.message}` };
    }
  }

  /**
   * Scan user's past attempts to count how many times each question has been answered CORRECTLY.
   * Questions that were skipped, unanswered, or answered incorrectly are NOT counted,
   * ensuring users never lose questions from abandoned or partially-completed exams.
   * @returns {Record<string, number>} Map of questionId -> timesCorrectlyAnswered
   */
  getPastCorrectQuestionCounts() {
    const correctCounts = {};
    if (!this.attemptsDir || !existsSync(this.attemptsDir)) {
      return correctCounts;
    }

    try {
      const files = readdirSync(this.attemptsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = JSON.parse(readFileSync(join(this.attemptsDir, file), 'utf8'));
          
          // 1. Structured perQuestion evaluation
          const perQ = content.evaluation?.perQuestion;
          if (perQ && typeof perQ === 'object') {
            for (const [qid, qData] of Object.entries(perQ)) {
              if (qData && qData.correct === true) {
                correctCounts[qid] = (correctCounts[qid] || 0) + 1;
              }
            }
            continue;
          }

          // 2. Fallback for older attempts with session answers and paper questions
          const answers = content.session?.answers || content.sessionLog?.answers;
          const questions = content.paper?.questions;
          if (answers && Array.isArray(questions)) {
            for (const q of questions) {
              if (q && q.id && q.correct_option !== undefined) {
                const userAns = answers[q.id];
                if (userAns !== null && userAns !== undefined && Number(userAns) === Number(q.correct_option)) {
                  correctCounts[q.id] = (correctCounts[q.id] || 0) + 1;
                }
              }
            }
          }
        } catch {}
      }
    } catch (err) {
      console.warn('[Orchestrator] Could not scan past attempts for correct questions:', err.message);
    }

    return correctCounts;
  }

  // Alias for backward compatibility
  getPastSeenQuestionCounts() {
    return this.getPastCorrectQuestionCounts();
  }

  /**
   * Phase 2: Generate a paper from the validated pool.
   * @param {{ seed?: number }} options
   * @returns {{ paper, compositionMetadata }}
   */
  generatePaper(options = {}) {
    if (!this.validatedPool || this.validatedPool.length === 0) {
      return { success: false, error: 'Cannot generate paper. Upload or select a question bank first.' };
    }

    this.state = 'composing';
    const composer = registry.get('composer');

    const durationMinutes = options.durationMinutes ? parseInt(options.durationMinutes, 10) : 60;
    const timeLimitSec = durationMinutes * 60;
    const requestedCount = options.questionCount ? parseInt(options.questionCount, 10) : 40;

    // Only count questions answered correctly in past attempts (never burn skipped/wrong questions)
    const seenQuestionCounts = this.getPastCorrectQuestionCounts();

    const composerInput = {
      validatedPool: this.validatedPool,
      config: {
        questionCount: requestedCount,
        durationMinutes,
        targetTimeSec: timeLimitSec,
        topics: Array.isArray(options.topics) && options.topics.length > 0 ? options.topics : null,
        difficultyDistribution: options.difficultyDistribution || { easy: 0.4, medium: 0.4, hard: 0.2 },
        maxPerSubtopic: options.maxPerSubtopic || 3,
        seed: options.seed || null,
        seenQuestionCounts,
        avoidRepeats: options.avoidRepeats !== false,
      },
    };

    const validation = composer.validate(composerInput);
    if (!validation.valid) {
      this.state = 'pool-ready';
      return { success: false, error: 'Composer validation failed', details: validation.errors };
    }

    try {
      const result = composer.execute(composerInput);
      this.currentPaper = result.paper;
      this.compositionMetadata = result.compositionMetadata;
      this.state = 'paper-ready';

      // Return paper WITHOUT correct answers for the frontend (unless interactive mode)
      const isInteractive = Boolean(options.interactive);
      const safeQuestions = result.paper.questions.map(q => {
        const item = {
          id: q.id,
          topic: q.topic,
          subtopic: q.subtopic,
          difficulty: q.difficulty,
          question_text: q.question_text,
          options: q.options,
          tags: q.tags,
          recommended_time_sec: q.recommended_time_sec,
        };
        if (isInteractive) {
          item.correct_option = q.correct_option;
          item.explanation = q.explanation;
        }
        return item;
      });

      return {
        success: true,
        paper: {
          ...result.paper,
          questions: safeQuestions,
          interactive: isInteractive
        },
        compositionMetadata: result.compositionMetadata,
      };
    } catch (err) {
      this.state = 'pool-ready';
      return { success: false, error: `Paper composition failed: ${err.message}` };
    }
  }

  /**
   * Phase 3: Submit answers and generate the full report.
   * @param {object} rawSession — Raw session log from frontend
   * @returns {{ report }}
   */
  submit(rawSession) {
    if (!this.currentPaper) {
      return { success: false, error: 'No paper is active. Generate a paper first.' };
    }

    this.state = 'submitted';

    try {
      // --- Session Agent ---
      const sessionAgent = registry.get('session');
      const sessionValidation = sessionAgent.validate(rawSession);
      if (!sessionValidation.valid) {
        return { success: false, error: 'Session validation failed', details: sessionValidation.errors };
      }
      const processedSession = sessionAgent.execute(rawSession);

      // --- Evaluation Agent ---
      this.state = 'evaluating';
      const evalAgent = registry.get('evaluation');
      const evalInput = { paper: this.currentPaper, processedSession };
      const evalValidation = evalAgent.validate(evalInput);
      if (!evalValidation.valid) {
        return { success: false, error: 'Evaluation validation failed', details: evalValidation.errors };
      }
      const evaluation = evalAgent.execute(evalInput);

      // --- Weakness Agent ---
      const weakAgent = registry.get('weakness');
      const weakValidation = weakAgent.validate(evaluation);
      if (!weakValidation.valid) {
        return { success: false, error: 'Weakness analysis validation failed', details: weakValidation.errors };
      }
      const insights = weakAgent.execute(evaluation);

      // --- Report Agent ---
      const reportAgent = registry.get('report');
      const reportInput = { evaluation, insights, attemptsDir: this.attemptsDir };
      const reportValidation = reportAgent.validate(reportInput);
      if (!reportValidation.valid) {
        return { success: false, error: 'Report generation validation failed', details: reportValidation.errors };
      }
      const report = reportAgent.execute(reportInput);

      // Include answer key for review
      const answerKey = {};
      for (const q of this.currentPaper.questions) {
        answerKey[q.id] = {
          correct_option: q.correct_option,
          explanation: q.explanation,
          correctText: q.options[q.correct_option],
        };
      }

      // --- Persist attempt ---
      this._persistAttempt(report, processedSession, evaluation, insights, answerKey);

      this.state = 'report-ready';

      return { success: true, report, answerKey, paper: this.currentPaper };
    } catch (err) {
      console.error('Submit pipeline error:', err);
      return { success: false, error: `Submission pipeline failed: ${err.message}` };
    }
  }

  /**
   * Reset state for a new exam.
   */
  reset() {
    this.state = this.validatedPool && this.validatedPool.length > 0 ? 'pool-ready' : 'idle';
    this.currentPaper = null;
    this.compositionMetadata = null;
    // Keep validatedPool so user can re-generate papers without re-uploading
  }

  /**
   * Full reset — clears everything.
   */
  fullReset() {
    this.state = 'idle';
    this.validatedPool = null;
    this.validationReport = null;
    this.currentPaper = null;
    this.compositionMetadata = null;
  }

  /**
   * Get current orchestrator state.
   */
  getState() {
    const topics = {};
    if (this.validatedPool) {
      for (const q of this.validatedPool) {
        topics[q.topic] = (topics[q.topic] || 0) + 1;
      }
    }
    return {
      state: this.state,
      hasPool: this.validatedPool !== null,
      poolSize: this.validatedPool?.length || 0,
      hasPaper: this.currentPaper !== null,
      paperId: this.currentPaper?.id || null,
      topics,
    };
  }

  /**
   * Persist an attempt to disk for historical tracking.
   */
  _persistAttempt(report, processedSession, evaluation, insights, answerKey = {}) {
    try {
      const targetDir = this.attemptsDir || ATTEMPTS_DIR;
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      const attempt = {
        id: `attempt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        username: this.username || 'guest',
        paper: this.currentPaper,
        answerKey,
        report,
        session: {
          totalTimeSec: processedSession.totalTimeSec,
          sessionFlags: processedSession.sessionFlags,
          answers: processedSession.answers || {},
        },
        evaluation: {
          overallScore: evaluation.overallScore,
          totalMarks: evaluation.totalMarks,
          accuracyPercent: evaluation.accuracyPercent,
          totalAttempted: evaluation.totalAttempted,
          totalSkipped: evaluation.totalSkipped,
          topicBreakdown: evaluation.topicBreakdown,
          difficultyBreakdown: evaluation.difficultyBreakdown,
          perQuestion: evaluation.perQuestion,
        },
        insights: {
          weakTopics: insights.weakTopics,
          overallPatterns: insights.overallPatterns,
        },
      };

      const filename = `${attempt.id}.json`;
      writeFileSync(join(targetDir, filename), JSON.stringify(attempt, null, 2));
      console.log(`[Orchestrator] Attempt persisted to ${join(targetDir, filename)}`);
    } catch (err) {
      console.error('[Orchestrator] Failed to persist attempt:', err.message);
    }
  }
}
