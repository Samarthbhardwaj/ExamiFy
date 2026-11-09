import { BaseAgent } from './base-agent.js';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * ReportAgent — Produces the final human-readable report with chart data and recommendations.
 *
 * Input:  { evaluation, insights, paperId, attemptsDir }
 * Output: Complete report object ready for frontend rendering
 */

export class ReportAgent extends BaseAgent {
  constructor(config = {}) {
    super('ReportAgent', config);
  }

  validate(input) {
    const errors = [];
    if (!input) errors.push('Input is null');
    else {
      if (!input.evaluation) errors.push('evaluation is required');
      if (!input.insights) errors.push('insights is required');
    }
    return { valid: errors.length === 0, errors };
  }

  execute(input) {
    const { evaluation, insights, attemptsDir } = input;

    this.log(`Generating report for paper ${evaluation.paperId}`);

    // --- Score Summary ---
    const scoreSummary = {
      score: evaluation.overallScore,
      total: evaluation.totalMarks,
      percent: evaluation.accuracyPercent,
      attempted: evaluation.totalAttempted,
      skipped: evaluation.totalSkipped,
      grade: this._computeGrade(evaluation.accuracyPercent),
    };

    // --- Topic Analysis ---
    const topicAnalysis = Object.entries(evaluation.topicBreakdown).map(([topic, data]) => ({
      topic,
      correct: data.correct,
      total: data.total,
      accuracy: data.accuracy,
    })).sort((a, b) => b.total - a.total);

    // --- Difficulty Analysis ---
    const difficultyAnalysis = ['easy', 'medium', 'hard']
      .filter(d => evaluation.difficultyBreakdown[d])
      .map(d => ({
        difficulty: d,
        correct: evaluation.difficultyBreakdown[d].correct,
        total: evaluation.difficultyBreakdown[d].total,
        accuracy: evaluation.difficultyBreakdown[d].accuracy,
      }));

    // --- Time Analysis ---
    const perQArr = Object.entries(evaluation.perQuestion);
    const totalTimeSec = perQArr.reduce((s, [, q]) => s + q.timeSpentSec, 0);
    const avgPerQuestion = perQArr.length > 0 ? Math.round(totalTimeSec / perQArr.length * 10) / 10 : 0;

    const timeDistribution = perQArr.map(([qid, q], i) => ({
      questionIndex: i + 1,
      questionId: qid,
      timeSec: q.timeSpentSec,
      recommendedSec: q.recommendedTimeSec,
      efficiency: q.timeEfficiency,
    }));

    const timeAnalysis = {
      totalTimeSec: Math.round(totalTimeSec),
      avgPerQuestion,
      distribution: timeDistribution,
    };

    // --- Weak Areas (from insights) ---
    const weakAreas = insights.weakTopics.map(wt => ({
      rank: wt.rank,
      topic: wt.topic,
      accuracy: wt.accuracy,
      impactScore: wt.impactScore,
      recommendation: this._topicRecommendation(wt),
    }));

    // --- Recommendations ---
    const recommendations = this._generateRecommendations(evaluation, insights);

    // --- Chart Data ---
    const chartData = {
      // Radar chart — topic accuracy
      radarLabels: topicAnalysis.map(t => t.topic),
      radarValues: topicAnalysis.map(t => t.accuracy),

      // Bar chart — difficulty accuracy
      barLabels: difficultyAnalysis.map(d => d.difficulty.charAt(0).toUpperCase() + d.difficulty.slice(1)),
      barValues: difficultyAnalysis.map(d => d.accuracy),
      barCorrect: difficultyAnalysis.map(d => d.correct),
      barTotal: difficultyAnalysis.map(d => d.total),

      // Time distribution
      timeLabels: timeDistribution.map(t => `Q${t.questionIndex}`),
      timeActual: timeDistribution.map(t => t.timeSec),
      timeRecommended: timeDistribution.map(t => t.recommendedSec),
    };

    // --- Prior Comparison ---
    const priorComparison = this._comparePrior(evaluation.paperId, evaluation.accuracyPercent, attemptsDir);

    const report = {
      paperId: evaluation.paperId,
      generatedAt: new Date().toISOString(),
      scoreSummary,
      topicAnalysis,
      difficultyAnalysis,
      timeAnalysis,
      weakAreas,
      recommendations,
      chartData,
      priorComparison,
      guessingPatterns: insights.guessingPatterns,
      difficultyInsights: insights.difficultyInsights,
      overallPatterns: insights.overallPatterns,
    };

    this.log('Report generation complete');
    return report;
  }

  _computeGrade(percent) {
    if (percent >= 90) return 'A+';
    if (percent >= 80) return 'A';
    if (percent >= 70) return 'B+';
    if (percent >= 60) return 'B';
    if (percent >= 50) return 'C';
    if (percent >= 40) return 'D';
    return 'F';
  }

  _topicRecommendation(weakTopic) {
    if (weakTopic.accuracy < 25) {
      return `Critical: Review all ${weakTopic.topic} fundamentals from scratch. Accuracy is only ${weakTopic.accuracy}%.`;
    } else if (weakTopic.accuracy < 50) {
      return `Focus on ${weakTopic.topic} — practice more problems, especially core concepts.`;
    } else {
      return `${weakTopic.topic} needs some polish — review the specific subtopics you got wrong.`;
    }
  }

  _generateRecommendations(evaluation, insights) {
    const recs = [];

    // Priority 1: Weak topics
    if (insights.weakTopics.length > 0) {
      const topWeak = insights.weakTopics.slice(0, 3).map(t => t.topic).join(', ');
      recs.push(`Priority study areas: ${topWeak}. These have the highest impact on your score.`);
    }

    // Priority 2: Guessing
    const { rushedWrong, slowWrong } = insights.guessingPatterns;
    if (rushedWrong.length > 0) {
      recs.push(`You rushed through ${rushedWrong.length} question(s) and got them wrong. Spend at least the recommended time reading each question carefully.`);
    }
    if (slowWrong.length > 0) {
      recs.push(`You spent too long on ${slowWrong.length} question(s) and still got them wrong. If unsure after the recommended time, mark and move on.`);
    }

    // Priority 3: Unanswered
    if (evaluation.totalSkipped > 0) {
      recs.push(`You left ${evaluation.totalSkipped} question(s) unanswered. Even educated guesses improve your expected score.`);
    }

    // Priority 4: Difficulty-specific
    const easyBd = evaluation.difficultyBreakdown.easy;
    if (easyBd && easyBd.accuracy < 80) {
      recs.push(`Easy questions: ${easyBd.accuracy}% accuracy. These are low-hanging fruit — solidify your basics for quick score gains.`);
    }

    // Priority 5: Time management
    if (evaluation.totalAttempted < evaluation.totalMarks * 0.8) {
      recs.push('Time management: You attempted fewer than 80% of questions. Practice under timed conditions to build speed.');
    }

    if (recs.length === 0) {
      recs.push('Excellent performance! Continue with timed practice to maintain consistency.');
    }

    return recs;
  }

  _comparePrior(currentPaperId, currentPercent, attemptsDir) {
    if (!attemptsDir || !existsSync(attemptsDir)) {
      return { available: false, previousScore: null, trend: null, history: [] };
    }

    try {
      const files = readdirSync(attemptsDir).filter(f => f.endsWith('.json'));
      const history = [];

      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(attemptsDir, file), 'utf-8'));
          if (data.report && data.report.paperId !== currentPaperId) {
            history.push({
              paperId: data.report.paperId,
              percent: data.report.scoreSummary.percent,
              date: data.report.generatedAt,
              grade: data.report.scoreSummary.grade,
            });
          }
        } catch { /* skip malformed files */ }
      }

      history.sort((a, b) => new Date(b.date) - new Date(a.date));

      if (history.length === 0) {
        return { available: false, previousScore: null, trend: null, history: [] };
      }

      const previousScore = history[0].percent;
      const diff = currentPercent - previousScore;
      let trend = 'stable';
      if (diff > 5) trend = 'improving';
      else if (diff < -5) trend = 'declining';

      return {
        available: true,
        previousScore,
        scoreDiff: Math.round(diff * 100) / 100,
        trend,
        history: history.slice(0, 10), // last 10 attempts
      };
    } catch {
      return { available: false, previousScore: null, trend: null, history: [] };
    }
  }
}
