import { BaseAgent } from './base-agent.js';

/**
 * ComposerAgent — Selects questions for a mock paper using composition rules.
 *
 * Input:  { validatedPool: object[], config: { questionCount, targetTimeSec, difficultyDistribution, maxPerSubtopic, seed } }
 * Output: { paper: object, compositionMetadata: object }
 *
 * Composition rules:
 *  - Difficulty distribution: 40% easy, 40% medium, 20% hard (configurable)
 *  - No more than maxPerSubtopic questions from the same subtopic
 *  - Total estimated time ≈ targetTimeSec
 *  - Deterministic given a seed; random by default
 */

// Mulberry32 — fast, seedable 32-bit PRNG
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Prioritizes unseen questions from user's attempt history.
 * Groups questions into tiers by times seen: 0 (unseen), 1, 2, ...
 * Shuffles within each tier, placing unseen questions first.
 */
function prioritizeByHistory(arr, seenCounts, rng, avoidRepeats = true) {
  if (!avoidRepeats || !seenCounts || Object.keys(seenCounts).length === 0) {
    return shuffle(arr, rng);
  }

  const tiers = new Map();
  for (const q of arr) {
    const times = seenCounts[q.id] || 0;
    if (!tiers.has(times)) tiers.set(times, []);
    tiers.get(times).push(q);
  }

  const sortedTimes = Array.from(tiers.keys()).sort((a, b) => a - b);
  const prioritized = [];

  for (const t of sortedTimes) {
    prioritized.push(...shuffle(tiers.get(t), rng));
  }

  return prioritized;
}

const DEFAULT_CONFIG = {
  questionCount: 40,
  targetTimeSec: 3600,
  difficultyDistribution: { easy: 0.4, medium: 0.4, hard: 0.2 },
  maxPerSubtopic: 3,
  seed: null,
};

export class ComposerAgent extends BaseAgent {
  constructor(config = {}) {
    super('ComposerAgent', config);
  }

  validate(input) {
    const errors = [];
    if (!input) errors.push('Input is null');
    else {
      if (!Array.isArray(input.validatedPool)) errors.push('validatedPool must be an array');
      else if (input.validatedPool.length === 0) errors.push('validatedPool is empty');
    }
    return { valid: errors.length === 0, errors };
  }

  execute(input) {
    const cfg = { ...DEFAULT_CONFIG, ...input.config };
    const seed = cfg.seed !== null && cfg.seed !== undefined ? cfg.seed : Date.now();
    const rng = mulberry32(seed);

    // --- Filter by topic if specified ---
    let pool = input.validatedPool;
    if (Array.isArray(cfg.topics) && cfg.topics.length > 0) {
      const allowed = new Set(cfg.topics.map(t => String(t).trim().toLowerCase()));
      pool = pool.filter(q => allowed.has(String(q.topic).trim().toLowerCase()));
    }

    if (pool.length === 0) {
      throw new Error('No questions match the selected topics.');
    }

    // Determine target question count based on available pool
    const requestedCount = cfg.questionCount ? parseInt(cfg.questionCount, 10) : 40;
    const targetCount = Math.min(requestedCount, pool.length);
    cfg.questionCount = targetCount;

    // Determine time limit in seconds
    const durationMinutes = cfg.durationMinutes ? parseInt(cfg.durationMinutes, 10) : (cfg.targetTimeSec ? Math.round(cfg.targetTimeSec / 60) : 60);
    const targetTimeSec = durationMinutes * 60;

    this.log(`Composing paper: ${cfg.questionCount} questions (target time: ${durationMinutes}m), seed=${seed}, pool size=${pool.length}`);

    // --- Group by difficulty ---
    const byDifficulty = { easy: [], medium: [], hard: [] };
    for (const q of pool) {
      if (byDifficulty[q.difficulty]) byDifficulty[q.difficulty].push(q);
    }

    // --- Calculate target counts per difficulty ---
    const targets = {};
    let remaining = cfg.questionCount;
    const diffs = Object.keys(cfg.difficultyDistribution);
    for (let i = 0; i < diffs.length; i++) {
      const d = diffs[i];
      if (i === diffs.length - 1) {
        targets[d] = remaining; // last bucket gets remainder
      } else {
        targets[d] = Math.round(cfg.questionCount * cfg.difficultyDistribution[d]);
        remaining -= targets[d];
      }
    }

    this.log(`Difficulty targets: ${JSON.stringify(targets)}`);

    // Dynamic subtopic cap (if pool or target is small/focused, relax cap)
    const effectiveMaxPerSubtopic = Math.max(cfg.maxPerSubtopic || 3, Math.ceil(targetCount / 2));

    // --- Select questions per difficulty with subtopic balancing ---
    const selected = [];
    const selectionLog = [];
    const rejectedCandidates = [];
    const subtopicCount = {};

    const avoidRepeats = cfg.avoidRepeats !== false;
    const seenCounts = cfg.seenQuestionCounts || {};

    // Phase 1: Pick unmastered (Tier 0: 0 times correct) questions per difficulty according to targets
    for (const diff of ['easy', 'medium', 'hard']) {
      const target = targets[diff] || 0;
      // If avoidRepeats is active, strictly pick unmastered questions (0 times correct) in Phase 1
      const diffPool = avoidRepeats
        ? byDifficulty[diff].filter(q => (seenCounts[q.id] || 0) === 0)
        : byDifficulty[diff];
      const candidates = shuffle(diffPool, rng);
      let picked = 0;

      for (const q of candidates) {
        if (picked >= target) {
          rejectedCandidates.push({ questionId: q.id, reason: `Difficulty "${diff}" quota filled` });
          continue;
        }

        const stKey = `${q.topic}::${q.subtopic}`;
        const currentStCount = subtopicCount[stKey] || 0;
        if (currentStCount >= effectiveMaxPerSubtopic) {
          rejectedCandidates.push({ questionId: q.id, reason: `Subtopic "${q.subtopic}" cap (${effectiveMaxPerSubtopic}) reached` });
          continue;
        }

        selected.push(q);
        subtopicCount[stKey] = currentStCount + 1;
        selectionLog.push({ questionId: q.id, reason: `Phase 1: Selected for ${diff} slot ${picked + 1}/${target}, subtopic "${q.subtopic}"` });
        picked++;
      }
    }

    // Phase 2: If we still need more questions, fill with any remaining UNMASTERED questions from other difficulties
    if (selected.length < cfg.questionCount && avoidRepeats) {
      const selectedIds = new Set(selected.map(q => q.id));
      const remainingUnmastered = pool.filter(q => !selectedIds.has(q.id) && (seenCounts[q.id] || 0) === 0);
      const candidates = shuffle(remainingUnmastered, rng);

      for (const q of candidates) {
        if (selected.length >= cfg.questionCount) break;
        const stKey = `${q.topic}::${q.subtopic}`;
        if ((subtopicCount[stKey] || 0) < effectiveMaxPerSubtopic) {
          selected.push(q);
          subtopicCount[stKey] = (subtopicCount[stKey] || 0) + 1;
          selectionLog.push({ questionId: q.id, reason: `Phase 2: Filled with unmastered question (${q.difficulty})` });
        }
      }
    }

    // Phase 3: If still below target count, fill unconditionally from remaining UNMASTERED pool
    if (selected.length < cfg.questionCount && avoidRepeats) {
      const selectedIds = new Set(selected.map(q => q.id));
      const remainingUnmastered = pool.filter(q => !selectedIds.has(q.id) && (seenCounts[q.id] || 0) === 0);
      for (const q of shuffle(remainingUnmastered, rng)) {
        if (selected.length >= cfg.questionCount) break;
        selected.push(q);
        selectionLog.push({ questionId: q.id, reason: `Phase 3: Unconditional unmastered fill` });
      }
    }

    // Phase 4: Only if ALL unmastered questions in the pool are exhausted, dip into previously correct questions
    if (selected.length < cfg.questionCount) {
      const selectedIds = new Set(selected.map(q => q.id));
      const previouslyCorrect = pool.filter(q => !selectedIds.has(q.id));
      const candidates = prioritizeByHistory(previouslyCorrect, seenCounts, rng, avoidRepeats);

      for (const q of candidates) {
        if (selected.length >= cfg.questionCount) break;
        selected.push(q);
        const times = seenCounts[q.id] || 0;
        selectionLog.push({ questionId: q.id, reason: `Phase 4: Pool exhausted, repeated question (previously correct ${times}x)` });
      }
    }

    // --- Shuffle final order ---
    const finalQuestions = shuffle(selected, rng);

    // --- Compute distributions ---
    const topicDist = {};
    const diffDist = { easy: 0, medium: 0, hard: 0 };
    let totalEstTime = 0;

    for (const q of finalQuestions) {
      topicDist[q.topic] = (topicDist[q.topic] || 0) + 1;
      diffDist[q.difficulty]++;
      totalEstTime += q.recommended_time_sec;
    }

    const paper = {
      id: `paper-${seed}-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      seed,
      questions: finalQuestions,
      totalMarks: finalQuestions.length, // 1 mark per question
      estimatedTimeSec: totalEstTime,
      durationMinutes,
      timeLimitSec: targetTimeSec,
    };

    const unseenSelected = finalQuestions.filter(q => (seenCounts[q.id] || 0) === 0).length;
    const repeatedSelected = finalQuestions.length - unseenSelected;

    const compositionMetadata = {
      topicDistribution: topicDist,
      difficultyDistribution: diffDist,
      selectionLog,
      rejectedCandidates,
      poolSize: pool.length,
      targetCount: cfg.questionCount,
      actualCount: finalQuestions.length,
      durationMinutes,
      timeLimitSec: targetTimeSec,
      unseenSelected,
      repeatedSelected,
      unmasteredSelected: unseenSelected,
      masteredSelected: repeatedSelected,
      avoidRepeatsActive: avoidRepeats,
    };

    this.log(`Paper composed: ${finalQuestions.length} questions (${unseenSelected} unmastered/new, ${repeatedSelected} previously mastered), est. time ${totalEstTime}s (time limit ${durationMinutes}m)`);

    return { paper, compositionMetadata };
  }
}
