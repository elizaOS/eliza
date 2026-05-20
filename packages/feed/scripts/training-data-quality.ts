#!/usr/bin/env bun

/**
 * Training Data Quality Report
 *
 * Measures the quality and diversity of simulation output data
 * that will be used for model training. Flags systematic biases,
 * repetitive patterns, and concentration that would corrupt training.
 *
 * Usage:
 *   bun run report:training-quality                        # Full report
 *   bun run report:training-quality -- --days 7            # Last 7 days
 *   bun run report:training-quality -- --warnings-only     # Just problems
 *   bun run report:training-quality -- --export json       # Machine-readable
 */

import { parseArgs } from 'node:util';
import {
  db,
  desc,
  gte,
  npcTrades,
  posts,
  questions,
  worldEvents,
} from '@babylon/db';

// ── CLI args ──────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '7' },
    'warnings-only': { type: 'boolean', default: false },
    export: { type: 'string', default: 'text' },
  },
  strict: true,
});

const days = Number.parseInt(args.days || '7', 10);
const warningsOnly = args['warnings-only'] ?? false;
const exportFormat = args.export || 'text';
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// ── ANSI helpers ──────────────────────────────────────────────────────
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
// const DIM = '\x1b[2m'; // available for future use
const RESET = '\x1b[0m';

function ok(msg: string) {
  return `${GREEN}✅${RESET} ${msg}`;
}
function warn(msg: string) {
  return `${YELLOW}⚠️${RESET}  ${msg}`;
}
function crit(msg: string) {
  return `${RED}❌${RESET} ${msg}`;
}
function heading(msg: string) {
  return `\n${BOLD}${msg}${RESET}`;
}

// ── Math helpers ──────────────────────────────────────────────────────
function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  if (sum === 0) return 0;
  // O(n log n) formula: G = (2 * Σ(i * x_i) / (n * Σx_i)) - (n + 1) / n
  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += (i + 1) * sorted[i]!;
  }
  return (2 * weightedSum) / (n * sum) - (n + 1) / n;
}

function hhi(shares: number[]): number {
  const total = shares.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  return shares.reduce((s, v) => s + (v / total) ** 2, 0);
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function skewness(values: number[]): number {
  if (values.length < 3) return 0;
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = stdDev(values);
  if (sd === 0) return 0;
  const m3 = values.reduce((s, v) => s + ((v - mean) / sd) ** 3, 0) / n;
  return m3;
}

// ── Stop words for text analysis ──────────────────────────────────────
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'will',
  'be',
  'been',
  'by',
  'to',
  'of',
  'in',
  'for',
  'and',
  'or',
  'on',
  'at',
  'it',
  'its',
  'as',
  'if',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'not',
  'no',
  'but',
  'that',
  'this',
  'with',
  'from',
  'they',
  'them',
  'their',
  'just',
  'about',
  'into',
  'than',
  'more',
  'very',
  'can',
  'could',
  'would',
]);

function extractTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function getOpeningTrigram(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── Warnings collector ────────────────────────────────────────────────
interface Warning {
  category: string;
  severity: 'warning' | 'critical';
  metric: string;
  value: number | string;
  threshold: number | string;
  message: string;
}

const warnings: Warning[] = [];

function checkThreshold(
  category: string,
  metric: string,
  value: number,
  threshold: number,
  direction: 'above' | 'below',
  severity: 'warning' | 'critical',
  message: string
): boolean {
  const triggered =
    direction === 'above' ? value > threshold : value < threshold;
  if (triggered) {
    warnings.push({
      category,
      severity,
      metric,
      value,
      threshold,
      message,
    });
  }
  return triggered;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  // Fetch all data
  const [allPosts, allTrades, allEvents, allQuestions] = await Promise.all([
    db
      .select()
      .from(posts)
      .where(gte(posts.createdAt, since))
      .orderBy(desc(posts.createdAt)),
    db
      .select()
      .from(npcTrades)
      .where(gte(npcTrades.executedAt, since))
      .orderBy(desc(npcTrades.executedAt)),
    db
      .select()
      .from(worldEvents)
      .where(gte(worldEvents.timestamp, since))
      .orderBy(desc(worldEvents.timestamp)),
    db
      .select()
      .from(questions)
      .where(gte(questions.createdAt, since))
      .orderBy(desc(questions.createdAt)),
  ]);

  const npcPosts = allPosts.filter((p) => p.type !== 'article');
  const articles = allPosts.filter((p) => p.type === 'article');

  console.log(heading('=== TRAINING DATA QUALITY REPORT ==='));
  console.log(
    `Period: last ${days} days (since ${since.toISOString().slice(0, 10)})`
  );
  console.log(
    `Data: ${allPosts.length} posts (${npcPosts.length} NPC, ${articles.length} articles) | ${allTrades.length} trades | ${allEvents.length} events | ${allQuestions.length} questions`
  );

  // ── ENTITY DISTRIBUTION ───────────────────────────────────────────
  if (!warningsOnly) console.log(heading('ENTITY DISTRIBUTION'));

  // Count entity mentions in posts
  const entityCounts = new Map<string, number>();
  for (const post of npcPosts) {
    const authorId = post.authorId;
    entityCounts.set(authorId, (entityCounts.get(authorId) || 0) + 1);
  }

  const entityValues = [...entityCounts.values()];
  const totalEntityMentions = entityValues.reduce((s, v) => s + v, 0);
  const entityGini = gini(entityValues);
  const sortedEntities = [...entityCounts.entries()].sort(
    (a, b) => b[1] - a[1]
  );
  const top1Share =
    totalEntityMentions > 0
      ? (sortedEntities[0]?.[1] || 0) / totalEntityMentions
      : 0;
  const top5Share =
    totalEntityMentions > 0
      ? sortedEntities.slice(0, 5).reduce((s, e) => s + e[1], 0) /
        totalEntityMentions
      : 0;
  const uniqueAuthors = entityCounts.size;
  const entityHHI = hhi(entityValues);

  const giniOk = entityGini >= 0.3 && entityGini <= 0.75;
  const top1Ok = top1Share < 0.15;
  const top5Ok = top5Share < 0.4;
  const hhiOk = entityHHI < 0.1;

  checkThreshold(
    'Entity',
    'gini',
    entityGini,
    0.75,
    'above',
    'warning',
    `Entity Gini ${(entityGini * 100).toFixed(0)}% indicates severe concentration`
  );
  checkThreshold(
    'Entity',
    'top1_share',
    top1Share,
    0.25,
    'above',
    'critical',
    `Top entity has ${(top1Share * 100).toFixed(0)}% of all mentions`
  );
  checkThreshold(
    'Entity',
    'top5_share',
    top5Share,
    0.6,
    'above',
    'warning',
    `Top 5 entities have ${(top5Share * 100).toFixed(0)}% of mentions`
  );
  checkThreshold(
    'Entity',
    'hhi',
    entityHHI,
    0.15,
    'above',
    'warning',
    `Entity HHI ${entityHHI.toFixed(3)} indicates concentration`
  );

  if (!warningsOnly) {
    console.log(
      `  Gini coefficient: ${entityGini.toFixed(3)} ${giniOk ? ok('(0.3-0.75)') : warn(`(target: 0.3-0.75)`)}`
    );
    console.log(
      `  Top-1 share: ${sortedEntities[0]?.[0] || 'N/A'} ${(top1Share * 100).toFixed(1)}% ${top1Ok ? ok('(<15%)') : warn('(target: <15%)')}`
    );
    console.log(
      `  Top-5 share: ${(top5Share * 100).toFixed(1)}% ${top5Ok ? ok('(<40%)') : warn('(target: <40%)')}`
    );
    console.log(`  Unique authors: ${uniqueAuthors}`);
    console.log(
      `  HHI: ${entityHHI.toFixed(4)} ${hhiOk ? ok('(<0.10)') : warn('(target: <0.10)')}`
    );

    if (sortedEntities.length > 0) {
      console.log(`  Top 10 entities:`);
      for (const [entity, count] of sortedEntities.slice(0, 10)) {
        const pct = ((count / totalEntityMentions) * 100).toFixed(1);
        console.log(`    ${entity.padEnd(30)} ${count} (${pct}%)`);
      }
    }
  }

  // ── STRUCTURAL DIVERSITY ──────────────────────────────────────────
  if (!warningsOnly) console.log(heading('STRUCTURAL DIVERSITY'));

  const postContents = npcPosts.map((p) => p.content).filter(Boolean);
  const postLengths = postContents.map((c) => c.length);

  // Opening trigrams
  const trigrams = postContents.map(getOpeningTrigram);
  const uniqueTrigrams = new Set(trigrams);
  const trigramDiversity =
    trigrams.length > 0 ? uniqueTrigrams.size / trigrams.length : 0;

  // Opening repetition
  const trigramCounts = new Map<string, number>();
  for (const t of trigrams) {
    trigramCounts.set(t, (trigramCounts.get(t) || 0) + 1);
  }
  const maxTrigramCount = Math.max(...[...trigramCounts.values(), 0]);
  const openingRepRate =
    trigrams.length > 0 ? maxTrigramCount / trigrams.length : 0;

  // Sentence types
  let questionCount = 0;
  let exclamationCount = 0;
  let statementCount = 0;
  for (const c of postContents) {
    if (c.endsWith('?')) questionCount++;
    else if (c.endsWith('!')) exclamationCount++;
    else statementCount++;
  }
  const totalSentences = postContents.length || 1;
  const questionRate = questionCount / totalSentences;
  const exclamationRate = exclamationCount / totalSentences;
  const statementRate = statementCount / totalSentences;

  // Length stats
  const lengthStd = stdDev(postLengths);
  const lengthSkew = skewness(postLengths);
  const avgLength =
    postLengths.length > 0
      ? postLengths.reduce((s, v) => s + v, 0) / postLengths.length
      : 0;
  const ceilingHits = postLengths.filter((l) => l >= 195).length;
  const ceilingRate =
    postLengths.length > 0 ? ceilingHits / postLengths.length : 0;

  // Vocabulary richness (TTR on first 1000 words)
  const allWords = postContents.flatMap(extractTokens).slice(0, 1000);
  const uniqueWords = new Set(allWords);
  const ttr = allWords.length > 0 ? uniqueWords.size / allWords.length : 0;

  // Pairwise similarity between consecutive posts by same actor
  const postsByActor = new Map<string, string[]>();
  for (const p of npcPosts) {
    const list = postsByActor.get(p.authorId) || [];
    list.push(p.content);
    postsByActor.set(p.authorId, list);
  }
  let totalJaccard = 0;
  let jaccardCount = 0;
  for (const [, actorPosts] of postsByActor) {
    for (let i = 1; i < actorPosts.length; i++) {
      const a = new Set(extractTokens(actorPosts[i - 1]!));
      const b = new Set(extractTokens(actorPosts[i]!));
      totalJaccard += jaccardSimilarity(a, b);
      jaccardCount++;
    }
  }
  const avgJaccard = jaccardCount > 0 ? totalJaccard / jaccardCount : 0;

  checkThreshold(
    'Structure',
    'trigram_diversity',
    trigramDiversity,
    0.5,
    'below',
    'warning',
    `Opening trigram diversity ${(trigramDiversity * 100).toFixed(0)}% is low`
  );
  checkThreshold(
    'Structure',
    'opening_rep_rate',
    openingRepRate,
    0.1,
    'above',
    'warning',
    `Opening "${[...trigramCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]}" repeated ${(openingRepRate * 100).toFixed(0)}% of posts`
  );
  checkThreshold(
    'Structure',
    'length_stddev',
    lengthStd,
    20,
    'below',
    'warning',
    `Post length std dev ${lengthStd.toFixed(0)} chars is low (target: >40)`
  );
  checkThreshold(
    'Structure',
    'ceiling_rate',
    ceilingRate,
    0.3,
    'above',
    'warning',
    `${(ceilingRate * 100).toFixed(0)}% of posts hit 200-char ceiling`
  );
  checkThreshold(
    'Structure',
    'ttr',
    ttr,
    0.25,
    'below',
    'warning',
    `Vocabulary richness ${(ttr * 100).toFixed(0)}% is low`
  );
  checkThreshold(
    'Structure',
    'consecutive_jaccard',
    avgJaccard,
    0.25,
    'above',
    'warning',
    `Consecutive post similarity ${(avgJaccard * 100).toFixed(0)}% is high`
  );

  if (!warningsOnly) {
    console.log(
      `  Unique opening trigrams: ${uniqueTrigrams.size}/${trigrams.length} (${(trigramDiversity * 100).toFixed(0)}%) ${trigramDiversity > 0.5 ? ok('') : warn('(target: >50%)')}`
    );
    console.log(
      `  Max opening repetition: ${(openingRepRate * 100).toFixed(0)}% ${openingRepRate < 0.1 ? ok('') : warn('(target: <10%)')}`
    );
    console.log(
      `  Sentence types: ${(questionRate * 100).toFixed(0)}% questions, ${(exclamationRate * 100).toFixed(0)}% exclamations, ${(statementRate * 100).toFixed(0)}% statements`
    );
    console.log(
      `  Post length: avg ${avgLength.toFixed(0)} chars, std ${lengthStd.toFixed(0)}, skew ${lengthSkew.toFixed(2)} ${lengthStd > 40 ? ok('') : warn('(target std: >40)')}`
    );
    console.log(
      `  200-char ceiling hits: ${ceilingHits}/${postLengths.length} (${(ceilingRate * 100).toFixed(0)}%) ${ceilingRate < 0.15 ? ok('') : warn('(target: <15%)')}`
    );
    console.log(
      `  Vocabulary richness (TTR): ${(ttr * 100).toFixed(0)}% ${ttr > 0.4 ? ok('') : ttr > 0.25 ? warn('(target: >40%)') : crit('(target: >25%)')}`
    );
    console.log(
      `  Consecutive post similarity: ${(avgJaccard * 100).toFixed(0)}% ${avgJaccard < 0.15 ? ok('') : warn('(target: <15%)')}`
    );
  }

  // ── TOPIC & THEME CONCENTRATION ───────────────────────────────────
  if (!warningsOnly) console.log(heading('TOPIC CONCENTRATION'));

  const topicCounts = new Map<string, number>();
  for (const q of allQuestions) {
    const key = q.topicKey || 'general';
    topicCounts.set(key, (topicCounts.get(key) || 0) + 1);
  }
  const topicHHI = hhi([...topicCounts.values()]);

  // Event type distribution
  const eventTypeCounts = new Map<string, number>();
  for (const e of allEvents) {
    const t = e.eventType || 'unknown';
    eventTypeCounts.set(t, (eventTypeCounts.get(t) || 0) + 1);
  }
  const eventTypeShares = [...eventTypeCounts.values()];
  const maxEventTypeShare =
    allEvents.length > 0 ? Math.max(...eventTypeShares) / allEvents.length : 0;

  // Question near-duplicate rate
  const questionTexts = allQuestions
    .filter((q) => q.status === 'active')
    .map((q) => q.text);
  let nearDuplicates = 0;
  let totalPairs = 0;
  for (let i = 0; i < questionTexts.length; i++) {
    for (let j = i + 1; j < questionTexts.length; j++) {
      const a = new Set(extractTokens(questionTexts[i]!));
      const b = new Set(extractTokens(questionTexts[j]!));
      if (jaccardSimilarity(a, b) > 0.4) nearDuplicates++;
      totalPairs++;
    }
  }
  const nearDupRate = totalPairs > 0 ? nearDuplicates / totalPairs : 0;

  checkThreshold(
    'Topic',
    'topic_hhi',
    topicHHI,
    0.25,
    'above',
    'warning',
    `Topic HHI ${topicHHI.toFixed(3)} indicates concentration`
  );
  checkThreshold(
    'Topic',
    'max_event_type_share',
    maxEventTypeShare,
    0.4,
    'above',
    'warning',
    `Event type concentration: ${(maxEventTypeShare * 100).toFixed(0)}%`
  );
  checkThreshold(
    'Topic',
    'near_duplicate_rate',
    nearDupRate,
    0.2,
    'above',
    'critical',
    `${(nearDupRate * 100).toFixed(0)}% of active question pairs are near-duplicates`
  );

  if (!warningsOnly) {
    console.log(
      `  Topic HHI: ${topicHHI.toFixed(3)} ${topicHHI < 0.15 ? ok('') : warn('(target: <0.15)')}`
    );
    console.log(`  Topic distribution:`);
    for (const [topic, count] of [...topicCounts.entries()].sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`    ${topic.padEnd(20)} ${count} questions`);
    }
    console.log(`  Event type distribution:`);
    for (const [type, count] of [...eventTypeCounts.entries()].sort(
      (a, b) => b[1] - a[1]
    )) {
      const pct = ((count / allEvents.length) * 100).toFixed(0);
      console.log(
        `    ${type.padEnd(20)} ${count} (${pct}%) ${Number(pct) > 40 ? warn('DOMINANT') : ''}`
      );
    }
    console.log(
      `  Question near-duplicate rate: ${(nearDupRate * 100).toFixed(0)}% ${nearDupRate < 0.1 ? ok('') : warn('(target: <10%)')}`
    );
  }

  // ── ACTION DISTRIBUTION ───────────────────────────────────────────
  if (!warningsOnly) console.log(heading('ACTION DISTRIBUTION'));

  const actionCounts = new Map<string, number>();
  for (const t of allTrades) {
    actionCounts.set(t.action, (actionCounts.get(t.action) || 0) + 1);
  }
  const maxActionShare =
    allTrades.length > 0
      ? Math.max(...[...actionCounts.values()]) / allTrades.length
      : 0;

  // YES vs NO balance
  const yesCount = allTrades.filter(
    (t) => t.action === 'buy_yes' || t.action === 'open_long'
  ).length;
  const noCount = allTrades.filter(
    (t) => t.action === 'buy_no' || t.action === 'open_short'
  ).length;
  const yesPct = allTrades.length > 0 ? yesCount / allTrades.length : 0.5;

  // Market outcome balance
  const resolvedQs = allQuestions.filter(
    (q) => q.status === 'resolved' && q.resolvedOutcome !== null
  );
  const yesOutcomes = resolvedQs.filter(
    (q) => q.resolvedOutcome === true
  ).length;
  const outcomePct =
    resolvedQs.length > 0 ? yesOutcomes / resolvedQs.length : 0.5;

  checkThreshold(
    'Action',
    'max_action_share',
    maxActionShare,
    0.5,
    'above',
    'warning',
    `Trade action "${[...actionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]}" is ${(maxActionShare * 100).toFixed(0)}% of all trades`
  );
  checkThreshold(
    'Action',
    'yes_bias',
    yesPct,
    0.7,
    'above',
    'warning',
    `YES/long trades are ${(yesPct * 100).toFixed(0)}% of all trades`
  );

  if (!warningsOnly) {
    console.log(`  Trade actions:`);
    for (const [action, count] of [...actionCounts.entries()].sort(
      (a, b) => b[1] - a[1]
    )) {
      const pct = ((count / allTrades.length) * 100).toFixed(0);
      console.log(
        `    ${action.padEnd(15)} ${count} (${pct}%) ${Number(pct) > 50 ? warn('DOMINANT') : ''}`
      );
    }
    console.log(
      `  YES/long vs NO/short: ${yesCount} (${(yesPct * 100).toFixed(0)}%) / ${noCount} (${((1 - yesPct) * 100).toFixed(0)}%) ${Math.abs(yesPct - 0.5) < 0.2 ? ok('balanced') : warn('imbalanced')}`
    );
    if (resolvedQs.length > 0) {
      console.log(
        `  Market outcomes: ${(outcomePct * 100).toFixed(0)}% YES / ${((1 - outcomePct) * 100).toFixed(0)}% NO ${Math.abs(outcomePct - 0.5) < 0.2 ? ok('') : warn('(target: 40-60%)')}`
      );
    }
  }

  // ── TEMPORAL PATTERNS ──────────────────────────────────────────────
  if (!warningsOnly) console.log(heading('TEMPORAL PATTERNS'));

  // Posts per hour distribution
  const postsPerHour = new Map<number, number>();
  for (let h = 0; h < 24; h++) postsPerHour.set(h, 0);
  for (const p of npcPosts) {
    const hour = new Date(p.createdAt).getHours();
    postsPerHour.set(hour, (postsPerHour.get(hour) || 0) + 1);
  }
  const hourCounts = [...postsPerHour.values()];
  const hourMean = hourCounts.reduce((s, v) => s + v, 0) / 24;
  const hourStd = stdDev(hourCounts);
  const hourCV = hourMean > 0 ? hourStd / hourMean : 0;

  // Event clustering — max events in any 1-hour window
  const eventsByHour = new Map<string, number>();
  for (const e of allEvents) {
    const key = new Date(e.timestamp).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    eventsByHour.set(key, (eventsByHour.get(key) || 0) + 1);
  }
  const maxEventsPerHour = Math.max(...[...eventsByHour.values(), 0]);
  const avgEventsPerHour =
    eventsByHour.size > 0
      ? [...eventsByHour.values()].reduce((s, v) => s + v, 0) /
        eventsByHour.size
      : 0;
  const eventClusterRatio =
    avgEventsPerHour > 0 ? maxEventsPerHour / avgEventsPerHour : 0;

  // Activity autocorrelation (lag-1): are consecutive hours correlated?
  let autoCorr = 0;
  if (hourCounts.length > 1) {
    let sumProd = 0;
    let sumSq = 0;
    for (let i = 1; i < hourCounts.length; i++) {
      const a = hourCounts[i - 1]! - hourMean;
      const b = hourCounts[i]! - hourMean;
      sumProd += a * b;
      sumSq += a * a;
    }
    autoCorr = sumSq > 0 ? sumProd / sumSq : 0;
  }

  checkThreshold(
    'Temporal',
    'hour_cv',
    hourCV,
    1.0,
    'above',
    'warning',
    `Hourly activity CV ${hourCV.toFixed(2)} indicates extreme bunching`
  );
  checkThreshold(
    'Temporal',
    'event_cluster_ratio',
    eventClusterRatio,
    10,
    'above',
    'warning',
    `Event clustering ratio ${eventClusterRatio.toFixed(1)}x (max ${maxEventsPerHour} in one hour)`
  );
  checkThreshold(
    'Temporal',
    'autocorrelation',
    Math.abs(autoCorr),
    0.6,
    'above',
    'warning',
    `Activity autocorrelation ${autoCorr.toFixed(2)} indicates predictable pattern`
  );

  if (!warningsOnly) {
    console.log(
      `  Hourly activity CV: ${hourCV.toFixed(2)} ${hourCV < 0.5 ? ok('uniform') : hourCV < 1.0 ? warn('moderate variation') : crit('extreme bunching')}`
    );

    // Show hour distribution as sparkline
    const maxH = Math.max(...hourCounts, 1);
    const bars = hourCounts.map((c) => {
      const height = Math.round((c / maxH) * 8);
      return ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '█'][height] || '▁';
    });
    console.log(`  Hour distribution: ${bars.join('')}`);
    console.log(
      `  ${'                    '}0         6        12        18       23`
    );

    console.log(
      `  Event clustering: max ${maxEventsPerHour}/hour, avg ${avgEventsPerHour.toFixed(1)}/hour, ratio ${eventClusterRatio.toFixed(1)}x ${eventClusterRatio < 5 ? ok('') : warn('(target: <5x)')}`
    );
    console.log(
      `  Autocorrelation (lag-1): ${autoCorr.toFixed(2)} ${Math.abs(autoCorr) < 0.3 ? ok('low') : warn('predictable pattern')}`
    );
  }

  // ── TRAINING-SPECIFIC ─────────────────────────────────────────────
  if (!warningsOnly) console.log(heading('TRAINING-SPECIFIC'));

  // Real name leakage — derive from actor/org data instead of hardcoding
  const { StaticDataRegistry } = await import('@babylon/engine');
  const realNames: string[] = [];
  for (const actor of StaticDataRegistry.getAllActors()) {
    const pack = StaticDataRegistry.getPackActor(actor.id);
    if (pack?.realName && pack.realName !== actor.name) {
      realNames.push(pack.realName);
    }
  }
  // Add common org real names
  realNames.push(
    'OpenAI',
    'Tesla',
    'Meta ',
    'Google',
    'Microsoft',
    'Amazon',
    'Apple',
    'NVIDIA',
    'BlackRock',
    'Bitcoin',
    'Ethereum'
  );
  let realNameLeaks = 0;
  const leakExamples: string[] = [];
  for (const p of npcPosts) {
    for (const name of realNames) {
      if (p.content.includes(name)) {
        realNameLeaks++;
        if (leakExamples.length < 3) {
          leakExamples.push(
            `"${p.content.substring(0, 60)}..." contains "${name}"`
          );
        }
        break;
      }
    }
  }
  const leakRate = npcPosts.length > 0 ? realNameLeaks / npcPosts.length : 0;

  // Hashtag leakage
  const hashtagPosts = npcPosts.filter((p) => p.content.includes('#')).length;
  const hashtagRate = npcPosts.length > 0 ? hashtagPosts / npcPosts.length : 0;

  // Emoji leakage (basic check)
  const emojiRegex =
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}]/u;
  const emojiPosts = npcPosts.filter((p) => emojiRegex.test(p.content)).length;
  const emojiRate = npcPosts.length > 0 ? emojiPosts / npcPosts.length : 0;

  checkThreshold(
    'Training',
    'real_name_leakage',
    leakRate,
    0.05,
    'above',
    'critical',
    `${(leakRate * 100).toFixed(1)}% of posts contain real names`
  );
  checkThreshold(
    'Training',
    'hashtag_leakage',
    hashtagRate,
    0.02,
    'above',
    'critical',
    `${(hashtagRate * 100).toFixed(1)}% of posts contain hashtags`
  );
  checkThreshold(
    'Training',
    'emoji_leakage',
    emojiRate,
    0.02,
    'above',
    'warning',
    `${(emojiRate * 100).toFixed(1)}% of posts contain emojis`
  );

  if (!warningsOnly) {
    console.log(
      `  Real name leakage: ${realNameLeaks}/${npcPosts.length} (${(leakRate * 100).toFixed(1)}%) ${leakRate === 0 ? ok('none') : crit(`${realNameLeaks} posts`)}`
    );
    for (const ex of leakExamples) {
      console.log(`    ${RED}→ ${ex}${RESET}`);
    }
    console.log(
      `  Hashtag leakage: ${hashtagPosts}/${npcPosts.length} (${(hashtagRate * 100).toFixed(1)}%) ${hashtagRate === 0 ? ok('none') : crit(`${hashtagPosts} posts`)}`
    );
    console.log(
      `  Emoji leakage: ${emojiPosts}/${npcPosts.length} (${(emojiRate * 100).toFixed(1)}%) ${emojiRate === 0 ? ok('none') : warn(`${emojiPosts} posts`)}`
    );

    // Game mechanic leakage — posts that expose simulation internals
    const mechanicTerms = [
      'predetermined',
      'scripted',
      'arc plan',
      'game tick',
      'simulation',
      'clueStrength',
      'pointsToward',
      'insider status',
      'NPC',
    ];
    let mechanicLeaks = 0;
    for (const p of npcPosts) {
      const lower = p.content.toLowerCase();
      if (mechanicTerms.some((t) => lower.includes(t.toLowerCase()))) {
        mechanicLeaks++;
      }
    }
    const mechanicRate =
      npcPosts.length > 0 ? mechanicLeaks / npcPosts.length : 0;
    checkThreshold(
      'Training',
      'mechanic_leakage',
      mechanicRate,
      0.01,
      'above',
      'critical',
      `${(mechanicRate * 100).toFixed(1)}% of posts expose game mechanics`
    );
    console.log(
      `  Game mechanic leakage: ${mechanicLeaks}/${npcPosts.length} (${(mechanicRate * 100).toFixed(1)}%) ${mechanicLeaks === 0 ? ok('none') : crit(`${mechanicLeaks} posts`)}`
    );

    // Sentiment distribution analysis
    const sentimentValues = npcPosts
      .map((p) => {
        const s = p.sentiment;
        if (typeof s === 'number') return s;
        if (s === 'positive') return 0.5;
        if (s === 'negative') return -0.5;
        return 0;
      })
      .filter((s) => s !== 0);

    if (sentimentValues.length > 2) {
      const sentMean =
        sentimentValues.reduce((s, v) => s + v, 0) / sentimentValues.length;
      const sentStd = stdDev(sentimentValues);
      const sentSkew = skewness(sentimentValues);
      console.log(
        `  Sentiment: mean ${sentMean.toFixed(2)}, std ${sentStd.toFixed(2)}, skew ${sentSkew.toFixed(2)} ${Math.abs(sentSkew) < 1.5 ? ok('') : warn('skewed')}`
      );
      checkThreshold(
        'Training',
        'sentiment_skew',
        Math.abs(sentSkew),
        1.5,
        'above',
        'warning',
        `Sentiment skewness ${sentSkew.toFixed(2)} indicates bias`
      );
    } else {
      console.log(
        `  Sentiment: insufficient numeric data (${sentimentValues.length} values)`
      );
    }

    // Market outcome balance
    const resolvedQs = allQuestions.filter(
      (q) => q.status === 'resolved' && q.resolvedOutcome !== null
    );
    if (resolvedQs.length > 0) {
      const yesOutcomes = resolvedQs.filter(
        (q) => q.resolvedOutcome === true
      ).length;
      const outcomePct = yesOutcomes / resolvedQs.length;
      console.log(
        `  Market outcomes: ${yesOutcomes}/${resolvedQs.length} YES (${(outcomePct * 100).toFixed(0)}%) ${Math.abs(outcomePct - 0.5) < 0.2 ? ok('balanced') : warn('imbalanced')}`
      );
      checkThreshold(
        'Training',
        'outcome_imbalance',
        Math.abs(outcomePct - 0.5),
        0.2,
        'above',
        'warning',
        `Market outcomes ${(outcomePct * 100).toFixed(0)}% YES (target: 40-60%)`
      );
    }
  }

  // ── WARNINGS SUMMARY ──────────────────────────────────────────────
  console.log(heading('WARNINGS SUMMARY'));
  if (warnings.length === 0) {
    console.log(ok('No warnings. Training data quality looks healthy.'));
  } else {
    const criticals = warnings.filter((w) => w.severity === 'critical');
    const warns = warnings.filter((w) => w.severity === 'warning');
    console.log(
      `${criticals.length > 0 ? crit(`${criticals.length} critical`) : ''} ${warns.length > 0 ? warn(`${warns.length} warnings`) : ''}`
    );
    for (const w of warnings) {
      const icon = w.severity === 'critical' ? crit('') : warn('');
      console.log(`  ${icon} [${w.category}] ${w.message}`);
    }
  }

  // ── JSON EXPORT ───────────────────────────────────────────────────
  if (exportFormat === 'json') {
    const report = {
      period: { days, since: since.toISOString() },
      counts: {
        posts: allPosts.length,
        npcPosts: npcPosts.length,
        articles: articles.length,
        trades: allTrades.length,
        events: allEvents.length,
        questions: allQuestions.length,
      },
      entity: {
        gini: entityGini,
        top1Share,
        top5Share,
        hhi: entityHHI,
        uniqueAuthors,
        topEntities: sortedEntities.slice(0, 10),
      },
      structure: {
        trigramDiversity,
        openingRepRate,
        questionRate,
        exclamationRate,
        statementRate,
        avgLength,
        lengthStdDev: lengthStd,
        lengthSkewness: lengthSkew,
        ceilingRate,
        ttr,
        avgConsecutiveJaccard: avgJaccard,
      },
      topics: {
        hhi: topicHHI,
        distribution: Object.fromEntries(topicCounts),
        eventTypes: Object.fromEntries(eventTypeCounts),
        nearDuplicateRate: nearDupRate,
      },
      actions: {
        distribution: Object.fromEntries(actionCounts),
        maxShare: maxActionShare,
        yesBias: yesPct,
        outcomeBalance: outcomePct,
      },
      temporal: {
        hourlyCV: hourCV,
        eventClusterRatio,
        autocorrelation: autoCorr,
        postsPerHour: Object.fromEntries(postsPerHour),
      },
      training: {
        realNameLeakRate: leakRate,
        hashtagLeakRate: hashtagRate,
        emojiLeakRate: emojiRate,
      },
      warnings,
    };
    console.log('\n' + JSON.stringify(report, null, 2));
  }

  process.exit(warnings.some((w) => w.severity === 'critical') ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
