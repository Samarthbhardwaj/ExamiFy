import { BaseAgent } from './base-agent.js';

/**
 * EvaluationAgent — Scores submitted answers and computes structured metrics.
 *
 * Input:  { paper, processedSession }
 * Output: Structured evaluation with score, topic/difficulty breakdowns, time efficiency
 *
 * This agent produces ONLY structured metrics — no prose feedback.
 */

export class EvaluationAgent extends BaseAgent {
  constructor(config = {}) {
    super('EvaluationAgent', config);
  }

  validate(input) {
    const errors = [];
    if (!input) errors.push('Input is null');
    else {
      if (!input.paper || !Array.isArray(input.paper.questions)) errors.push('paper.questions is required');
      if (!input.processedSession) errors.push('processedSession is required');
      if (typeof input.processedSession.answers !== 'object') errors.push('processedSession.answers is required');
    }
    return { valid: errors.length === 0, errors };
  }

  execute(input) {
    const { paper, processedSession } = input;
    const { answers, perQuestionMetrics } = processedSession;

    this.log(`Evaluating paper ${paper.id}: ${paper.questions.length} questions`);

    let overallScore = 0;
    let totalAttempted = 0;
    let totalSkipped = 0;
    const perQuestion = {};
    const topicAcc = {};   // topic -> { correct, total }
    const diffAcc = {};    // difficulty -> { correct, total }

    for (const q of paper.questions) {
      const selected = answers[q.id];
      const isAttempted = selected !== null && selected !== undefined;
      const isCorrect = isAttempted && Number(selected) === q.correct_option;
      const qMetrics = perQuestionMetrics[q.id] || {};

      if (isAttempted) totalAttempted++;
      else totalSkipped++;

      if (isCorrect) overallScore++;

      // Per-question evaluation
      perQuestion[q.id] = {
        correct: isCorrect,
        selectedOption: isAttempted ? Number(selected) : null,
        correctOption: q.correct_option,
        timeSpentSec: qMetrics.timeSpentSec || 0,
        recommendedTimeSec: q.recommended_time_sec,
        timeEfficiency: q.recommended_time_sec > 0
          ? Math.round(((qMetrics.timeSpentSec || 0) / q.recommended_time_sec) * 100) / 100
          : null,
        topic: q.topic,
        subtopic: q.subtopic,
        difficulty: q.difficulty,
      };

      // Topic breakdown
      if (!topicAcc[q.topic]) topicAcc[q.topic] = { correct: 0, total: 0 };
      topicAcc[q.topic].total++;
      if (isCorrect) topicAcc[q.topic].correct++;

      // Difficulty breakdown
      if (!diffAcc[q.difficulty]) diffAcc[q.difficulty] = { correct: 0, total: 0 };
      diffAcc[q.difficulty].total++;
      if (isCorrect) diffAcc[q.difficulty].correct++;
    }

    // --- Build breakdown objects with accuracy ---
    const topicBreakdown = {};
    for (const [topic, data] of Object.entries(topicAcc)) {
      topicBreakdown[topic] = {
        correct: data.correct,
        total: data.total,
        accuracy: data.total > 0 ? Math.round((data.correct / data.total) * 10000) / 100 : 0,
      };
    }

    const difficultyBreakdown = {};
    for (const [diff, data] of Object.entries(diffAcc)) {
      difficultyBreakdown[diff] = {
        correct: data.correct,
        total: data.total,
        accuracy: data.total > 0 ? Math.round((data.correct / data.total) * 10000) / 100 : 0,
      };
    }

    const totalMarks = paper.questions.length;
    const accuracyPercent = totalMarks > 0 ? Math.round((overallScore / totalMarks) * 10000) / 100 : 0;

    const output = {
      paperId: paper.id,
      overallScore,
      totalMarks,
      accuracyPercent,
      totalAttempted,
      totalSkipped,
      perQuestion,
      topicBreakdown,
      difficultyBreakdown,
    };

    this.log(`Evaluation complete: ${overallScore}/${totalMarks} (${accuracyPercent}%)`);

    return output;
  }
}
