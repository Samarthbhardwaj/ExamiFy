import { BaseAgent } from './base-agent.js';

/**
 * WeaknessAgent — Identifies performance patterns and weak areas from evaluation data.
 *
 * Input:  Evaluation agent output (structured metrics)
 * Output: Ranked weak areas, guessing patterns, difficulty insights, overall observations
 *
 * Pattern detection:
 *  - "Rushed wrong": answered wrong in < 50% of recommended time → likely guessed
 *  - "Slow wrong": answered wrong in > 150% of recommended time → struggled but failed
 *  - Impact score: (questionCount / totalQuestions) × (1 - accuracy) — higher = more impactful weakness
 */

export class WeaknessAgent extends BaseAgent {
  constructor(config = {}) {
    super('WeaknessAgent', config);
    this.accuracyThreshold = config.accuracyThreshold || 50; // % below which a topic is "weak"
    this.rushedThreshold = config.rushedThreshold || 0.5;     // timeEfficiency < 0.5 = rushed
    this.slowThreshold = config.slowThreshold || 1.5;         // timeEfficiency > 1.5 = slow
  }

  validate(input) {
    const errors = [];
    if (!input) errors.push('Input is null');
    else {
      if (!input.perQuestion || typeof input.perQuestion !== 'object') errors.push('perQuestion is required');
      if (!input.topicBreakdown) errors.push('topicBreakdown is required');
      if (!input.difficultyBreakdown) errors.push('difficultyBreakdown is required');
    }
    return { valid: errors.length === 0, errors };
  }

  execute(input) {
    this.log('Analyzing weaknesses and patterns...');

    const { perQuestion, topicBreakdown, difficultyBreakdown, totalMarks } = input;
    const questions = Object.entries(perQuestion);

    // --- Weak Topics ---
    const weakTopics = [];
    for (const [topic, data] of Object.entries(topicBreakdown)) {
      const impactScore = (data.total / totalMarks) * (1 - data.accuracy / 100);
      if (data.accuracy < this.accuracyThreshold || impactScore > 0.1) {
        weakTopics.push({
          topic,
          accuracy: data.accuracy,
          questionCount: data.total,
          correct: data.correct,
          impactScore: Math.round(impactScore * 1000) / 1000,
        });
      }
    }
    weakTopics.sort((a, b) => b.impactScore - a.impactScore);
    weakTopics.forEach((t, i) => t.rank = i + 1);

    // --- Weak Subtopics ---
    const subtopicAcc = {};
    for (const [, q] of questions) {
      const key = `${q.topic}::${q.subtopic}`;
      if (!subtopicAcc[key]) subtopicAcc[key] = { topic: q.topic, subtopic: q.subtopic, correct: 0, total: 0 };
      subtopicAcc[key].total++;
      if (q.correct) subtopicAcc[key].correct++;
    }

    const weakSubtopics = [];
    for (const [, data] of Object.entries(subtopicAcc)) {
      const accuracy = data.total > 0 ? Math.round((data.correct / data.total) * 10000) / 100 : 0;
      const impactScore = (data.total / totalMarks) * (1 - accuracy / 100);
      if (accuracy < this.accuracyThreshold) {
        weakSubtopics.push({
          subtopic: data.subtopic,
          topic: data.topic,
          accuracy,
          correct: data.correct,
          total: data.total,
          impactScore: Math.round(impactScore * 1000) / 1000,
        });
      }
    }
    weakSubtopics.sort((a, b) => b.impactScore - a.impactScore);

    // --- Difficulty Insights ---
    const difficultyInsights = [];
    for (const [diff, data] of Object.entries(difficultyBreakdown)) {
      // Compute average time for this difficulty
      const diffQs = questions.filter(([, q]) => q.difficulty === diff);
      const avgTime = diffQs.length > 0
        ? Math.round(diffQs.reduce((s, [, q]) => s + q.timeSpentSec, 0) / diffQs.length * 10) / 10
        : 0;

      let pattern = 'normal';
      if (data.accuracy < 40) pattern = 'struggling';
      else if (data.accuracy >= 80) pattern = 'strong';
      else if (data.accuracy < 60) pattern = 'needs-improvement';

      difficultyInsights.push({
        difficulty: diff,
        accuracy: data.accuracy,
        avgTimeSec: avgTime,
        correct: data.correct,
        total: data.total,
        pattern,
      });
    }

    // --- Guessing Patterns ---
    const rushedWrong = [];
    const slowWrong = [];

    for (const [qid, q] of questions) {
      if (q.correct) continue; // Only analyze wrong answers
      if (q.selectedOption === null) continue; // Skip unanswered

      const eff = q.timeEfficiency;
      if (eff !== null && eff < this.rushedThreshold) {
        rushedWrong.push({ questionId: qid, timeSpentSec: q.timeSpentSec, recommendedTimeSec: q.recommendedTimeSec, timeEfficiency: eff });
      } else if (eff !== null && eff > this.slowThreshold) {
        slowWrong.push({ questionId: qid, timeSpentSec: q.timeSpentSec, recommendedTimeSec: q.recommendedTimeSec, timeEfficiency: eff });
      }
    }

    // --- Overall Patterns ---
    const overallPatterns = [];
    const totalQuestions = questions.length;
    const totalWrong = questions.filter(([, q]) => !q.correct && q.selectedOption !== null).length;
    const totalUnanswered = questions.filter(([, q]) => q.selectedOption === null).length;

    if (rushedWrong.length > totalWrong * 0.4 && totalWrong > 0) {
      overallPatterns.push(`High guessing tendency: ${rushedWrong.length} of ${totalWrong} wrong answers were rushed (< ${this.rushedThreshold * 100}% of recommended time). Consider slowing down and reading carefully.`);
    }

    if (slowWrong.length > totalWrong * 0.3 && totalWrong > 0) {
      overallPatterns.push(`Time sink on hard questions: ${slowWrong.length} of ${totalWrong} wrong answers took excessive time (> ${this.slowThreshold * 100}% of recommended). Try the skip-and-return strategy.`);
    }

    if (totalUnanswered > totalQuestions * 0.2) {
      overallPatterns.push(`Left ${totalUnanswered} questions unanswered (${Math.round(totalUnanswered / totalQuestions * 100)}%). Work on time management to attempt all questions.`);
    }

    const easyAcc = difficultyBreakdown.easy?.accuracy || 0;
    const hardAcc = difficultyBreakdown.hard?.accuracy || 0;
    if (easyAcc < 70) {
      overallPatterns.push(`Easy questions accuracy is only ${easyAcc}%. Focus on fundamentals — these should be free marks.`);
    }
    if (hardAcc > 60) {
      overallPatterns.push(`Strong performance on hard questions (${hardAcc}%). Consider focusing on medium-difficulty gaps for quick wins.`);
    }

    if (overallPatterns.length === 0) {
      overallPatterns.push('Overall solid performance. Keep practicing for consistency.');
    }

    const output = {
      weakTopics,
      weakSubtopics,
      difficultyInsights,
      guessingPatterns: { rushedWrong, slowWrong },
      overallPatterns,
    };

    this.log(`Weakness analysis complete: ${weakTopics.length} weak topics, ${rushedWrong.length} rushed, ${slowWrong.length} slow wrong`);

    return output;
  }
}
