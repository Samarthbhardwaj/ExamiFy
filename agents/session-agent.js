import { BaseAgent } from './base-agent.js';

/**
 * SessionAgent — Processes raw exam session logs into structured per-question metrics.
 *
 * Input:  Raw session log from the frontend (events, answers, timestamps)
 * Output: Processed session with per-question time, visit counts, answer changes, flags
 */

export class SessionAgent extends BaseAgent {
  constructor(config = {}) {
    super('SessionAgent', config);
  }

  validate(input) {
    const errors = [];
    if (!input) errors.push('Input is null');
    else {
      if (!input.paperId) errors.push('paperId is required');
      if (!input.startTime) errors.push('startTime is required');
      if (!input.endTime) errors.push('endTime is required');
      if (typeof input.answers !== 'object') errors.push('answers must be an object');
      if (!Array.isArray(input.events)) errors.push('events must be an array');
    }
    return { valid: errors.length === 0, errors };
  }

  execute(input) {
    this.log(`Processing session for paper ${input.paperId}, ${input.events.length} events`);

    const startMs = new Date(input.startTime).getTime();
    const endMs = new Date(input.endTime).getTime();
    const totalTimeSec = Math.round((endMs - startMs) / 1000);

    // --- Build per-question metrics from event stream ---
    const metrics = {}; // questionId -> { timeSpentMs, visitCount, answerChanges, flagged, visits: [{enter, exit}] }

    // Sort events by timestamp
    const sortedEvents = [...input.events].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Track navigation to compute time per question
    let currentQuestion = null;
    let currentEnterTime = null;
    const flaggedSet = new Set();

    const ensureMetric = (qid) => {
      if (!metrics[qid]) {
        metrics[qid] = { timeSpentMs: 0, visitCount: 0, answerChanges: 0, flagged: false, visits: [] };
      }
    };

    for (const event of sortedEvents) {
      const eventTime = new Date(event.timestamp).getTime();
      const qid = event.questionId;

      if (event.type === 'navigate') {
        // Close the previous question's time window
        if (currentQuestion && currentEnterTime) {
          ensureMetric(currentQuestion);
          const duration = eventTime - currentEnterTime;
          metrics[currentQuestion].timeSpentMs += duration;
          metrics[currentQuestion].visits.push({ enter: currentEnterTime, exit: eventTime });
        }
        // Open new time window
        ensureMetric(qid);
        metrics[qid].visitCount++;
        currentQuestion = qid;
        currentEnterTime = eventTime;
      } else if (event.type === 'answer' || event.type === 'change_answer') {
        ensureMetric(qid);
        if (event.type === 'change_answer') {
          metrics[qid].answerChanges++;
        }
      } else if (event.type === 'flag') {
        ensureMetric(qid);
        metrics[qid].flagged = true;
        flaggedSet.add(qid);
      } else if (event.type === 'unflag') {
        ensureMetric(qid);
        metrics[qid].flagged = false;
        flaggedSet.delete(qid);
      }
    }

    // Close final question's time window
    if (currentQuestion && currentEnterTime) {
      ensureMetric(currentQuestion);
      const duration = endMs - currentEnterTime;
      metrics[currentQuestion].timeSpentMs += duration;
      metrics[currentQuestion].visits.push({ enter: currentEnterTime, exit: endMs });
    }

    // --- Build output ---
    const perQuestionMetrics = {};
    for (const [qid, m] of Object.entries(metrics)) {
      perQuestionMetrics[qid] = {
        timeSpentSec: Math.round(m.timeSpentMs / 1000 * 10) / 10,
        visitCount: m.visitCount,
        answerChanges: m.answerChanges,
        flagged: m.flagged,
      };
    }

    // --- Session-level flags ---
    const sessionFlags = [];
    if (input.autoSubmitted) sessionFlags.push('auto-submitted');

    const manyRevisits = Object.values(perQuestionMetrics).filter(m => m.visitCount > 3).length;
    if (manyRevisits > 5) sessionFlags.push('many-revisits');

    const output = {
      paperId: input.paperId,
      totalTimeSec,
      answers: input.answers,
      perQuestionMetrics,
      sessionFlags,
    };

    this.log(`Session processed: ${totalTimeSec}s total, ${Object.keys(perQuestionMetrics).length} questions tracked, flags: [${sessionFlags.join(', ')}]`);

    return output;
  }
}
