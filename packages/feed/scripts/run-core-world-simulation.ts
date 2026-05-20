#!/usr/bin/env bun

/**
 * Core World Simulation Runner
 *
 * Executes the real core-world generation pipeline in-process, without a web
 * server and without user agents. It captures prompt inputs/outputs, runs the
 * content-producing cron jobs, builds the public feed surfaces, and writes a
 * report bundle under runs/core-simulations/.
 *
 * Scope:
 * - world facts / RSS / parodies / daily topic
 * - game tick
 * - markets tick
 * - NPC tick
 * - organization tick
 * - article tick
 * - breaking news / trending widgets
 * - stories + for-you feed assembly (public, no user personalization)
 *
 * Explicitly excluded:
 * - agent-tick (user/external agents)
 */

import 'dotenv/config';

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  and,
  arcStates,
  closeDatabase,
  dailyTopics,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  llmCallLogs,
  parodyHeadlines,
  posts,
  postTags,
  predictionPriceHistories,
  questionArcPlans,
  questions,
  rssFeedSources,
  rssHeadlines,
  stockPrices,
  subMarketSpawnLogs,
  tags,
  timeframedMarkets,
  trajectories,
  trendingTags,
  worldEvents,
  worldFacts,
} from '@feed/db';
import {
  bootstrapGameIfNeeded,
  executeGameTick,
  StaticDataRegistry,
} from '@feed/engine';
import { logger } from '@feed/shared';
import { Actions } from '../packages/agents/src/autonomous/templates/multi-step-decision';
import {
  getLLMCallCallback,
  type LLMCallInput,
  setLLMCallCallback,
} from '../packages/engine/src/dag-trace';

type JsonRecord = Record<string, unknown>;

interface JobArtifact {
  name: string;
  cycle: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  success: boolean;
  statusCode?: number;
  body?: unknown;
  error?: string;
}

interface TextItem {
  id: string;
  text: string;
}

interface PromptCallArtifact extends LLMCallInput {
  capturedAt: string;
  source: 'engine' | 'npc' | 'debug-log';
  actionType?: string;
  trajectoryId?: string;
  agentId?: string;
  filePath?: string;
}

interface ActionAttemptRecord {
  trajectoryId: string;
  agentId: string;
  finalStatus: string;
  stepId: string;
  stepNumber: number;
  timestamp: number;
  actionType: string;
  success: boolean;
  error?: string;
  reasoning?: string;
  result?: JsonRecord;
}

interface TrajectoryAudit {
  trajectories: Array<{
    id: string;
    trajectoryId: string;
    agentId: string;
    createdAt: string;
    finalStatus: string;
    episodeLength: number;
    totalReward: number;
    tradesExecuted: number | null;
    postsCreated: number | null;
  }>;
  llmCalls: PromptCallArtifact[];
  actionAttempts: ActionAttemptRecord[];
  actionSummary: {
    totalAttempts: number;
    totalSuccesses: number;
    totalFailures: number;
    byActionType: Array<{
      actionType: string;
      attempts: number;
      successes: number;
      failures: number;
      uniqueAgents: number;
      exampleErrors: string[];
    }>;
    unusedCoreActions: string[];
  };
}

interface FeedStoryPost {
  id: string;
  content: string;
  fullContent?: string | null;
  articleTitle?: string | null;
  category?: string | null;
  imageUrl?: string | null;
  type?: string;
  timestamp?: string;
  authorId?: string;
  authorName?: string;
  authorUsername?: string;
  relatedQuestion?: number | null;
  originalPostId?: string | null;
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    timestamp: string;
  } | null;
}

interface FeedStory {
  storyKey: string;
  title?: string;
  storyTitle?: string;
  questionNumber?: number | null;
  arcState?: string | null;
  storyScore?: number;
  finalRankScore?: number;
  postCount?: number;
  posts: FeedStoryPost[];
}

interface FeedResult {
  stories: FeedStory[];
  topic?: {
    topicKey: string;
    topicLabel: string;
    summary: string;
  } | null;
  generatedAt?: string;
  postIds?: string[];
  [key: string]: unknown;
}

interface CycleSnapshot {
  counts: {
    posts: number;
    orgPosts: number;
    actorPosts: number;
    articlePosts: number;
    events: number;
    questions: number;
    activeTimeframedMarkets: number;
    rssHeadlines: number;
    parodyHeadlines: number;
    worldFacts: number;
    predictionPriceHistoryRows: number;
    stockPriceRows: number;
  };
  samples: {
    posts: Array<{
      id: string;
      authorId: string;
      content: string;
      type: string | null;
      articleTitle: string | null;
      category: string | null;
      createdAt: Date;
      timestamp: Date | null;
      relatedQuestion: string | null;
    }>;
    events: Array<{
      id: string;
      eventType: string;
      description: string;
      actors: string[] | null;
      relatedQuestion: string | null;
      timestamp: Date;
      createdAt: Date;
    }>;
    questions: Array<{
      id: string;
      questionNumber: number;
      text: string;
      status: string;
      topicKey: string | null;
      topicLabel: string | null;
      createdAt: Date;
      resolutionDate: Date | null;
    }>;
    headlines: Array<{
      id: string;
      title: string;
      publishedAt: Date | null;
      fetchedAt: Date;
    }>;
    parodies: Array<{
      id: string;
      originalTitle: string;
      parodyTitle: string;
      generatedAt: Date;
    }>;
    worldFacts: Array<{
      id: string;
      category: string;
      value: string;
      source: string | null;
      createdAt: Date;
    }>;
    predictionPriceHistory: Array<{
      id: string;
      marketId: string;
      eventType: string;
      source: string | null;
      createdAt: Date;
      yesPrice: string | null;
      noPrice: string | null;
    }>;
    stockPrices: Array<{
      id: string;
      organizationId: string;
      price: string;
      changePercent: string | null;
      volume: string | null;
      timestamp: Date;
    }>;
  };
  duplicateStats: {
    questionTexts: ReturnType<typeof buildDuplicateStats>;
    eventDescriptions: ReturnType<typeof buildDuplicateStats>;
    postBodies: ReturnType<typeof buildDuplicateStats>;
    articleTitles: ReturnType<typeof buildDuplicateStats>;
    activeMarketQuestions: ReturnType<typeof buildDuplicateStats>;
  };
  timeframeBreakdown: Record<string, number>;
}

const CORE_NPC_ACTIONS = [
  Actions.TRADE,
  Actions.POST,
  Actions.COMMENT,
  Actions.REPLY_COMMENT,
  Actions.LIKE,
  Actions.REPOST,
] as const;

const DAG_TRACE_DIR = path.resolve(process.cwd(), 'runs', 'dag-traces');

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonArray(value: string): unknown[] {
  const parsed = safeJsonParse(value);
  return Array.isArray(parsed) ? parsed : [];
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'and',
  'but',
  'or',
  'not',
  'so',
  'if',
  'when',
  'where',
  'how',
  'what',
  'which',
  'who',
  'this',
  'that',
  'these',
  'those',
  'i',
  'me',
  'my',
  'we',
  'us',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'it',
  'its',
  'they',
  'them',
  'their',
  'about',
  'up',
  'out',
  'then',
  'here',
  'there',
  'also',
  'over',
  'new',
  'said',
  'says',
  'like',
  'well',
  'back',
  'even',
  'still',
  'way',
  'just',
  'into',
  'than',
  'after',
  'before',
]);

const { values: args } = parseArgs({
  options: {
    cycles: { type: 'string', default: '1' },
    out: { type: 'string', default: '' },
    rss: { type: 'string', default: 'snapshot' },
    'npc-trade-probability': { type: 'string', default: '0.1' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (args.help) {
  console.log(`Usage:
  bun run scripts/run-core-world-simulation.ts [options]

Options:
  --cycles <n>                  Number of back-to-back simulation cycles to run (default: 1)
  --rss <mode>                  snapshot | live (default: snapshot)
  --npc-trade-probability <p>   Simulation-only NPC trading probability (default: 0.1)
  --out <path>                  Output directory (default: runs/core-simulations/<timestamp>)
  --help                        Show this message
`);
  process.exit(0);
}

const cycles = Math.max(1, Number.parseInt(args.cycles, 10) || 1);
const rssMode = args.rss === 'live' ? 'live' : 'snapshot';
const npcTradeProbability = Math.min(
  1,
  Math.max(0, Number.parseFloat(args['npc-trade-probability']) || 0.1)
);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir =
  args.out && args.out.trim().length > 0
    ? path.resolve(args.out)
    : path.resolve(process.cwd(), 'runs', 'core-simulations', runId);
const jobsDir = path.join(outputDir, 'jobs');
const cycleDir = path.join(outputDir, 'cycles');
const promptsDir = path.join(outputDir, 'prompts');
const feedsDir = path.join(outputDir, 'feeds');
const widgetsDir = path.join(outputDir, 'widgets');
const rssCacheDir = path.join(outputDir, 'rss-cache');

mkdirSync(outputDir, { recursive: true });
mkdirSync(jobsDir, { recursive: true });
mkdirSync(cycleDir, { recursive: true });
mkdirSync(promptsDir, { recursive: true });
mkdirSync(feedsDir, { recursive: true });
mkdirSync(widgetsDir, { recursive: true });
mkdirSync(rssCacheDir, { recursive: true });

process.env.FEED_DAG_TRACE = 'true';
process.env.DEBUG_SAVE_PROMPTS = 'true';
process.env.GAME_START ??= 'true';
process.env.NODE_ENV ??= 'development';
process.env.VERCEL_ENV ??= 'production';
process.env.REDIRECT_CRON_STAGING = 'false';
process.env.NPC_TRADE_PROBABILITY = npcTradeProbability.toString();

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, value: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildDuplicateStats(items: TextItem[], threshold = 0.55) {
  const normalizedGroups = new Map<
    string,
    { ids: string[]; sample: string; count: number }
  >();

  for (const item of items) {
    const normalized = normalizeText(item.text);
    if (!normalized) continue;
    const existing = normalizedGroups.get(normalized);
    if (existing) {
      existing.ids.push(item.id);
      existing.count += 1;
      continue;
    }
    normalizedGroups.set(normalized, {
      ids: [item.id],
      sample: item.text,
      count: 1,
    });
  }

  const exactDuplicates = [...normalizedGroups.entries()]
    .filter(([, group]) => group.count > 1)
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 20)
    .map(([normalized, group]) => ({
      normalized,
      count: group.count,
      ids: group.ids,
      sample: group.sample,
    }));

  const tokenized = items.map((item) => ({
    ...item,
    tokens: tokenize(item.text),
  }));

  const similarPairs: Array<{
    leftId: string;
    rightId: string;
    score: number;
    leftText: string;
    rightText: string;
  }> = [];

  for (let index = 0; index < tokenized.length; index++) {
    const left = tokenized[index];
    if (!left) continue;
    for (let offset = index + 1; offset < tokenized.length; offset++) {
      const right = tokenized[offset];
      if (!right) continue;
      const score = jaccard(left.tokens, right.tokens);
      if (score < threshold) continue;
      similarPairs.push({
        leftId: left.id,
        rightId: right.id,
        score: Number(score.toFixed(3)),
        leftText: left.text,
        rightText: right.text,
      });
    }
  }

  similarPairs.sort((left, right) => right.score - left.score);

  return {
    total: items.length,
    exactDuplicateGroups: exactDuplicates,
    similarPairs: similarPairs.slice(0, 25),
  };
}

function excerpt(text: string, maxLength = 240): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildContextSignalCoverage(calls: PromptCallArtifact[]) {
  const signals = {
    worldFacts: /world facts|world context/i,
    recentEvents: /recent events|world events/i,
    dailyTopic: /daily topic|topic label|topic summary/i,
    headlines: /headline|rss|breaking news|parody/i,
    markets: /market data|prediction market|perp/i,
    actors: /actor|character|persona/i,
  };

  const coverage: Record<string, number> = {};

  for (const [key, pattern] of Object.entries(signals)) {
    const hitCount = calls.filter(
      (call) => pattern.test(call.systemPrompt) || pattern.test(call.userPrompt)
    ).length;
    coverage[key] =
      calls.length === 0 ? 0 : Number((hitCount / calls.length).toFixed(3));
  }

  return coverage;
}

function buildPromptAudit(calls: PromptCallArtifact[]) {
  const byPromptType = new Map<string, PromptCallArtifact[]>();
  for (const call of calls) {
    const existing = byPromptType.get(call.promptType);
    if (existing) {
      existing.push(call);
      continue;
    }
    byPromptType.set(call.promptType, [call]);
  }

  const promptTypes = [...byPromptType.entries()]
    .map(([promptType, group]) => {
      const normalizedInputs = new Map<string, number>();
      const normalizedOutputs = new Map<string, number>();
      for (const call of group) {
        const inputKey = normalizeText(call.userPrompt);
        const outputKey = normalizeText(call.rawResponse);
        normalizedInputs.set(
          inputKey,
          (normalizedInputs.get(inputKey) ?? 0) + 1
        );
        normalizedOutputs.set(
          outputKey,
          (normalizedOutputs.get(outputKey) ?? 0) + 1
        );
      }

      const repeatedInputs = [...normalizedInputs.values()].filter(
        (count) => count > 1
      );
      const repeatedOutputs = [...normalizedOutputs.values()].filter(
        (count) => count > 1
      );

      return {
        promptType,
        calls: group.length,
        successCount: group.filter((call) => call.success).length,
        errorCount: group.filter((call) => !call.success).length,
        avgInputTokens: Math.round(
          group.reduce((sum, call) => sum + call.inputTokens, 0) / group.length
        ),
        avgOutputTokens: Math.round(
          group.reduce((sum, call) => sum + call.outputTokens, 0) / group.length
        ),
        avgDurationMs: Math.round(
          group.reduce((sum, call) => sum + call.durationMs, 0) / group.length
        ),
        uniqueInputs: normalizedInputs.size,
        uniqueOutputs: normalizedOutputs.size,
        repeatedInputCalls: repeatedInputs.reduce(
          (sum, count) => sum + count,
          0
        ),
        repeatedOutputCalls: repeatedOutputs.reduce(
          (sum, count) => sum + count,
          0
        ),
        contextCoverage: buildContextSignalCoverage(group),
        examples: group.slice(0, 2).map((call) => ({
          capturedAt: call.capturedAt,
          success: call.success,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          userPromptExcerpt: excerpt(call.userPrompt, 500),
          rawResponseExcerpt: excerpt(call.rawResponse, 300),
        })),
      };
    })
    .sort((left, right) => right.calls - left.calls);

  const repeatedParagraphs = new Map<
    string,
    { count: number; promptTypes: Set<string>; sample: string }
  >();
  for (const call of calls) {
    const seenInCall = new Set<string>();
    const blocks = `${call.systemPrompt}\n\n${call.userPrompt}`
      .split(/\n\s*\n/g)
      .map((block) => block.trim())
      .filter((block) => block.length >= 80);

    for (const block of blocks) {
      const normalized = normalizeText(block);
      if (!normalized || seenInCall.has(normalized)) continue;
      seenInCall.add(normalized);
      const existing = repeatedParagraphs.get(normalized);
      if (existing) {
        existing.count += 1;
        existing.promptTypes.add(call.promptType);
        continue;
      }
      repeatedParagraphs.set(normalized, {
        count: 1,
        promptTypes: new Set([call.promptType]),
        sample: block,
      });
    }
  }

  const repeatedPromptBlocks = [...repeatedParagraphs.values()]
    .filter((value) => value.count >= 3)
    .sort((left, right) => right.count - left.count)
    .slice(0, 25)
    .map((value) => ({
      count: value.count,
      promptTypes: [...value.promptTypes].sort(),
      sample: excerpt(value.sample, 400),
    }));

  const warnings: string[] = [];
  const recommendations: string[] = [];
  for (const promptType of promptTypes) {
    if (promptType.calls >= 2 && promptType.uniqueInputs <= 1) {
      const message = `${promptType.promptType}: all captured inputs were identical across ${promptType.calls} calls`;
      warnings.push(message);
      recommendations.push(
        `${promptType.promptType}: repeated identical inputs suggest stale or missing context; trim duplicated boilerplate and inject fresher world/event state.`
      );
    }
    if (promptType.calls >= 2 && promptType.uniqueOutputs <= 1) {
      const message = `${promptType.promptType}: all captured outputs were identical across ${promptType.calls} calls`;
      warnings.push(message);
      recommendations.push(
        `${promptType.promptType}: repeated identical outputs suggest over-constrained prompting or missing differentiating context.`
      );
    }
    if (promptType.contextCoverage.worldFacts === 0) {
      const message = `${promptType.promptType}: no obvious world-facts/world-context signal was detected in captured prompts`;
      warnings.push(message);
      recommendations.push(
        `${promptType.promptType}: add explicit world-facts or recent-event grounding so outputs stay tied to the current news cycle.`
      );
    }
  }

  for (const block of repeatedPromptBlocks.slice(0, 10)) {
    if (block.promptTypes.length < 2) continue;
    recommendations.push(
      `Repeated prompt block across ${block.promptTypes.join(', ')}: move shared invariant instructions into a reusable character or system layer, and keep per-call prompts focused on changing state.`
    );
  }

  return {
    totalCalls: calls.length,
    successfulCalls: calls.filter((call) => call.success).length,
    failedCalls: calls.filter((call) => !call.success).length,
    promptTypes,
    repeatedPromptBlocks,
    warnings,
    recommendations: [...new Set(recommendations)],
  };
}

function parsePromptLogSection(
  markdown: string,
  header: '# Input' | '# Output'
): string {
  const nextHeader = header === '# Input' ? '# Output' : '\n---';
  const pattern = new RegExp(
    `${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\`${nextHeader === '\n---' ? '(?=\\n\\n---|\\n---|$)' : `\\n\\n${nextHeader}`}`,
    'm'
  );
  const match = markdown.match(pattern);
  return match?.[1]?.trim() ?? '';
}

function parsePromptMarkdownLog(
  filePath: string,
  markdown: string
): PromptCallArtifact | null {
  const promptTypeMatch = markdown.match(/^# Prompt Debug Log:\s+(.+)$/m);
  const timestampMatch = markdown.match(/^\*\*Timestamp:\*\*\s+(.+)$/m);
  const providerMatch = markdown.match(/- \*\*Provider:\*\*\s+(.+)$/m);
  const modelMatch = markdown.match(/- \*\*Model:\*\*\s+(.+)$/m);
  const temperatureMatch = markdown.match(/- \*\*Temperature:\*\*\s+(.+)$/m);
  const maxTokensMatch = markdown.match(/- \*\*Max Tokens:\*\*\s+(.+)$/m);
  const formatMatch = markdown.match(/- \*\*Format:\*\*\s+(.+)$/m);

  const promptType = promptTypeMatch?.[1]?.trim();
  if (!promptType) return null;

  const inputBlock = parsePromptLogSection(markdown, '# Input');
  const outputBlock = parsePromptLogSection(markdown, '# Output');

  let systemPrompt = '';
  let userPrompt = inputBlock;
  const systemUserSplit = inputBlock.match(
    /^System:\s*([\s\S]*?)\nUser:\s*([\s\S]*)$/
  );
  if (systemUserSplit) {
    systemPrompt = systemUserSplit[1]?.trim() ?? '';
    userPrompt = systemUserSplit[2]?.trim() ?? '';
  }

  const temperature = Number.parseFloat(temperatureMatch?.[1] ?? '');
  const maxTokens = Number.parseInt(maxTokensMatch?.[1] ?? '', 10);

  return {
    provider: providerMatch?.[1]?.trim() ?? 'unknown',
    model: modelMatch?.[1]?.trim() ?? 'unknown',
    promptType,
    format: formatMatch?.[1]?.trim() ?? 'text',
    temperature: Number.isFinite(temperature) ? temperature : 0,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0,
    systemPrompt,
    userPrompt,
    rawResponse: outputBlock,
    parsedResponse: safeJsonParse(outputBlock),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    success:
      outputBlock.trim().length > 0 &&
      !/LLM response missing content/i.test(outputBlock),
    capturedAt: timestampMatch?.[1]?.trim() ?? new Date().toISOString(),
    source: 'debug-log',
    filePath,
  };
}

function mergePromptCalls(calls: PromptCallArtifact[]): PromptCallArtifact[] {
  const merged = new Map<string, PromptCallArtifact>();

  for (const call of calls) {
    const key = [
      call.promptType,
      normalizeText(call.systemPrompt),
      normalizeText(call.userPrompt),
      normalizeText(call.rawResponse),
    ].join('||');
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, call);
      continue;
    }

    if (existing.source === 'debug-log' && call.source !== 'debug-log') {
      merged.set(key, call);
    }
  }

  return [...merged.values()].sort((left, right) =>
    right.capturedAt.localeCompare(left.capturedAt)
  );
}

function getPromptSurface(promptType: string): string {
  const normalized = promptType.toLowerCase();

  if (
    normalized.includes('question') ||
    normalized.includes('scenario') ||
    normalized.includes('rank_questions')
  ) {
    return 'questions';
  }

  if (normalized.includes('trending') || normalized === 'tag_generation') {
    return 'trending';
  }

  if (
    normalized.includes('article') ||
    normalized.includes('headline') ||
    normalized.includes('news_report')
  ) {
    return 'news';
  }

  if (
    normalized.includes('event') ||
    normalized.includes('arc') ||
    normalized.includes('world_fact') ||
    normalized.includes('daily_topic')
  ) {
    return 'narratives';
  }

  if (
    normalized.includes('multi_step_decision') ||
    normalized.startsWith('npc') ||
    normalized.includes('autonomous') ||
    normalized.includes('market-decisions')
  ) {
    return 'npc';
  }

  return 'other';
}

function buildPromptExamples(calls: PromptCallArtifact[], limit = 12) {
  return calls.slice(0, limit).map((call) => ({
    capturedAt: call.capturedAt,
    promptType: call.promptType,
    source: call.source,
    model: call.model,
    success: call.success,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    filePath: call.filePath ?? null,
    userPromptExcerpt: excerpt(call.userPrompt, 400),
    rawResponseExcerpt: excerpt(call.rawResponse, 300),
  }));
}

function buildPromptSurfaceReport(calls: PromptCallArtifact[]) {
  const surfaces = new Map<string, PromptCallArtifact[]>();

  for (const call of calls) {
    const surface = getPromptSurface(call.promptType);
    const existing = surfaces.get(surface);
    if (existing) {
      existing.push(call);
      continue;
    }
    surfaces.set(surface, [call]);
  }

  return [...surfaces.entries()]
    .map(([surface, surfaceCalls]) => ({
      surface,
      callCount: surfaceCalls.length,
      promptTypes: [
        ...new Set(surfaceCalls.map((call) => call.promptType)),
      ].sort(),
      audit: buildPromptAudit(surfaceCalls),
      examples: buildPromptExamples(surfaceCalls),
    }))
    .sort((left, right) => right.callCount - left.callCount);
}

function buildSurfaceModelIO(calls: PromptCallArtifact[], surface: string) {
  const surfaceCalls = calls.filter(
    (call) => getPromptSurface(call.promptType) === surface
  );

  return {
    surface,
    callCount: surfaceCalls.length,
    promptTypes: [
      ...new Set(surfaceCalls.map((call) => call.promptType)),
    ].sort(),
    audit: buildPromptAudit(surfaceCalls),
    examples: buildPromptExamples(surfaceCalls),
  };
}

async function invokeHandler(
  label: string,
  cycle: number,
  handler: (request: Request) => Promise<Response>,
  request: Request
): Promise<JobArtifact> {
  const startedAt = new Date();
  try {
    const response = await handler(request);
    const completedAt = new Date();
    const bodyText = await response.text();
    const body = bodyText.length > 0 ? safeJsonParse(bodyText) : null;
    const semanticSuccess =
      response.ok &&
      !(isJsonRecord(body) && 'success' in body && body.success === false);

    return {
      name: label,
      cycle,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      success: semanticSuccess,
      statusCode: response.status,
      body,
    };
  } catch (error) {
    const completedAt = new Date();
    return {
      name: label,
      cycle,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function invokeCronRoute(
  modulePath: string,
  label: string,
  cycle: number,
  urlPath: string
): Promise<JobArtifact> {
  const module = (await import(modulePath)) as {
    POST: (request: Request) => Promise<Response>;
  };
  const request = new Request(`http://localhost${urlPath}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer development',
      'content-type': 'application/json',
      'user-agent': 'feed-core-sim/1.0',
    },
  });

  return invokeHandler(label, cycle, module.POST, request);
}

async function invokeGetRoute(
  modulePath: string,
  label: string,
  urlPath: string
): Promise<JobArtifact> {
  const module = (await import(modulePath)) as {
    GET: (request: Request) => Promise<Response>;
  };
  const request = new Request(`http://localhost${urlPath}`, {
    method: 'GET',
    headers: {
      'user-agent': 'feed-core-sim/1.0',
    },
  });

  return invokeHandler(label, 0, module.GET, request);
}

async function installRssFetchCache() {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const sources: Array<{
    id: string;
    name: string;
    feedUrl: string;
  }> = await db
    .select({
      id: rssFeedSources.id,
      name: rssFeedSources.name,
      feedUrl: rssFeedSources.feedUrl,
    })
    .from(rssFeedSources)
    .where(eq(rssFeedSources.isActive, true));

  const sourceByUrl = new Map(
    sources.map((source) => [source.feedUrl, source])
  );

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const source = sourceByUrl.get(url);
    if (!source) {
      return originalFetch(input, init);
    }

    const cachePath = path.join(rssCacheDir, `${source.id}.json`);
    if (rssMode === 'snapshot' && statExists(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as {
        status: number;
        headers: Record<string, string>;
        body: string;
        fetchedAt: string;
        url: string;
        sourceName: string;
      };
      return new Response(cached.body, {
        status: cached.status,
        headers: cached.headers,
      });
    }

    const response = await originalFetch(input, init);
    const body = await response.text();

    const cached = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      fetchedAt: new Date().toISOString(),
      url,
      sourceName: source.name,
    };
    writeJson(cachePath, cached);

    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function statExists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectCycleSnapshot(since: Date) {
  const actorIds = new Set(
    StaticDataRegistry.getAllActors().map((actor) => actor.id)
  );
  const organizationIds = new Set(
    StaticDataRegistry.getAllOrganizations().map((org) => org.id)
  );

  const recentPosts: CycleSnapshot['samples']['posts'] = await db
    .select({
      id: posts.id,
      authorId: posts.authorId,
      content: posts.content,
      type: posts.type,
      articleTitle: posts.articleTitle,
      category: posts.category,
      createdAt: posts.createdAt,
      timestamp: posts.timestamp,
      relatedQuestion: posts.relatedQuestion,
    })
    .from(posts)
    .where(and(gte(posts.createdAt, since), isNull(posts.deletedAt)))
    .orderBy(desc(posts.createdAt))
    .limit(200);

  const recentEvents: CycleSnapshot['samples']['events'] = await db
    .select({
      id: worldEvents.id,
      eventType: worldEvents.eventType,
      description: worldEvents.description,
      actors: worldEvents.actors,
      relatedQuestion: worldEvents.relatedQuestion,
      timestamp: worldEvents.timestamp,
      createdAt: worldEvents.createdAt,
    })
    .from(worldEvents)
    .where(gte(worldEvents.createdAt, since))
    .orderBy(desc(worldEvents.createdAt))
    .limit(200);

  const recentQuestions: CycleSnapshot['samples']['questions'] = await db
    .select({
      id: questions.id,
      questionNumber: questions.questionNumber,
      text: questions.text,
      status: questions.status,
      topicKey: questions.topicKey,
      topicLabel: questions.topicLabel,
      createdAt: questions.createdAt,
      resolutionDate: questions.resolutionDate,
    })
    .from(questions)
    .where(gte(questions.createdAt, since))
    .orderBy(desc(questions.createdAt))
    .limit(200);

  const activeTimeframedMarkets: Array<{
    id: string;
    questionId: string | null;
    timeframe: string;
    granularTimeframe: string | null;
    topicKey: string | null;
    topicLabel: string | null;
    affiliatedActorIds: string[] | null;
    affiliatedOrgIds: string[] | null;
    startTime: Date;
    endTime: Date;
  }> = await db
    .select({
      id: timeframedMarkets.id,
      questionId: timeframedMarkets.questionId,
      timeframe: timeframedMarkets.timeframe,
      granularTimeframe: timeframedMarkets.granularTimeframe,
      topicKey: timeframedMarkets.topicKey,
      topicLabel: timeframedMarkets.topicLabel,
      affiliatedActorIds: timeframedMarkets.affiliatedActorIds,
      affiliatedOrgIds: timeframedMarkets.affiliatedOrgIds,
      startTime: timeframedMarkets.startTime,
      endTime: timeframedMarkets.endTime,
    })
    .from(timeframedMarkets)
    .where(
      and(
        eq(timeframedMarkets.isActive, true),
        eq(timeframedMarkets.isResolved, false)
      )
    )
    .orderBy(desc(timeframedMarkets.createdAt))
    .limit(200);

  const activeQuestionIds = activeTimeframedMarkets
    .map((market) => market.questionId)
    .filter((questionId): questionId is string => Boolean(questionId));

  const linkedQuestions: Array<{
    id: string;
    text: string;
    questionNumber: number;
  }> =
    activeQuestionIds.length > 0
      ? await db
          .select({
            id: questions.id,
            text: questions.text,
            questionNumber: questions.questionNumber,
          })
          .from(questions)
          .where(inArray(questions.id, activeQuestionIds))
      : [];

  const linkedQuestionById = new Map(
    linkedQuestions.map((question) => [question.id, question])
  );

  const recentHeadlines: CycleSnapshot['samples']['headlines'] = await db
    .select({
      id: rssHeadlines.id,
      title: rssHeadlines.title,
      publishedAt: rssHeadlines.publishedAt,
      fetchedAt: rssHeadlines.fetchedAt,
    })
    .from(rssHeadlines)
    .where(gte(rssHeadlines.fetchedAt, since))
    .orderBy(desc(rssHeadlines.fetchedAt))
    .limit(100);

  const recentParodies: CycleSnapshot['samples']['parodies'] = await db
    .select({
      id: parodyHeadlines.id,
      originalTitle: parodyHeadlines.originalTitle,
      parodyTitle: parodyHeadlines.parodyTitle,
      generatedAt: parodyHeadlines.generatedAt,
    })
    .from(parodyHeadlines)
    .where(gte(parodyHeadlines.generatedAt, since))
    .orderBy(desc(parodyHeadlines.generatedAt))
    .limit(100);

  const recentFacts: CycleSnapshot['samples']['worldFacts'] = await db
    .select({
      id: worldFacts.id,
      category: worldFacts.category,
      value: worldFacts.value,
      source: worldFacts.source,
      createdAt: worldFacts.createdAt,
    })
    .from(worldFacts)
    .where(gte(worldFacts.createdAt, since))
    .orderBy(desc(worldFacts.createdAt))
    .limit(200);

  const recentPredictionHistory: CycleSnapshot['samples']['predictionPriceHistory'] =
    await db
      .select({
        id: predictionPriceHistories.id,
        marketId: predictionPriceHistories.marketId,
        eventType: predictionPriceHistories.eventType,
        source: predictionPriceHistories.source,
        createdAt: predictionPriceHistories.createdAt,
        yesPrice: predictionPriceHistories.yesPrice,
        noPrice: predictionPriceHistories.noPrice,
      })
      .from(predictionPriceHistories)
      .where(gte(predictionPriceHistories.createdAt, since))
      .orderBy(desc(predictionPriceHistories.createdAt))
      .limit(200);

  const recentStockPrices: CycleSnapshot['samples']['stockPrices'] = await db
    .select({
      id: stockPrices.id,
      organizationId: stockPrices.organizationId,
      price: stockPrices.price,
      changePercent: stockPrices.changePercent,
      volume: stockPrices.volume,
      timestamp: stockPrices.timestamp,
    })
    .from(stockPrices)
    .where(gte(stockPrices.timestamp, since))
    .orderBy(desc(stockPrices.timestamp))
    .limit(200);

  const orgPosts = recentPosts.filter((post) =>
    organizationIds.has(post.authorId)
  );
  const actorPosts = recentPosts.filter((post) => actorIds.has(post.authorId));
  const articlePosts = recentPosts.filter(
    (post) =>
      post.type === 'article' ||
      post.articleTitle !== null ||
      post.category === 'article'
  );

  return {
    counts: {
      posts: recentPosts.length,
      orgPosts: orgPosts.length,
      actorPosts: actorPosts.length,
      articlePosts: articlePosts.length,
      events: recentEvents.length,
      questions: recentQuestions.length,
      activeTimeframedMarkets: activeTimeframedMarkets.length,
      rssHeadlines: recentHeadlines.length,
      parodyHeadlines: recentParodies.length,
      worldFacts: recentFacts.length,
      predictionPriceHistoryRows: recentPredictionHistory.length,
      stockPriceRows: recentStockPrices.length,
    },
    samples: {
      posts: recentPosts.slice(0, 20),
      events: recentEvents.slice(0, 20),
      questions: recentQuestions.slice(0, 20),
      headlines: recentHeadlines.slice(0, 20),
      parodies: recentParodies.slice(0, 20),
      worldFacts: recentFacts.slice(0, 20),
      predictionPriceHistory: recentPredictionHistory.slice(0, 20),
      stockPrices: recentStockPrices.slice(0, 20),
    },
    duplicateStats: {
      questionTexts: buildDuplicateStats(
        recentQuestions.map((question) => ({
          id: question.id,
          text: question.text,
        }))
      ),
      eventDescriptions: buildDuplicateStats(
        recentEvents.map((event) => ({
          id: event.id,
          text: event.description,
        }))
      ),
      postBodies: buildDuplicateStats(
        recentPosts.map((post) => ({
          id: post.id,
          text: post.content,
        }))
      ),
      articleTitles: buildDuplicateStats(
        articlePosts
          .filter((post) => post.articleTitle)
          .map((post) => ({
            id: post.id,
            text: post.articleTitle ?? '',
          }))
      ),
      activeMarketQuestions: buildDuplicateStats(
        activeTimeframedMarkets.map((market) => ({
          id: market.id,
          text: linkedQuestionById.get(market.questionId ?? '')?.text ?? '',
        }))
      ),
    },
    timeframeBreakdown: activeTimeframedMarkets.reduce<Record<string, number>>(
      (acc, market) => {
        const key = market.granularTimeframe ?? market.timeframe;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      },
      {}
    ),
  };
}

async function collectTrendingTagSnapshot() {
  const latestTrending: Array<{
    id: string;
    tagId: string;
    score: string;
    postCount: number;
    rank: number;
    calculatedAt: Date;
    tagDisplayName: string | null;
    tagName: string | null;
    category: string | null;
  }> = await db
    .select({
      id: trendingTags.id,
      tagId: trendingTags.tagId,
      score: trendingTags.score,
      postCount: trendingTags.postCount,
      rank: trendingTags.rank,
      calculatedAt: trendingTags.calculatedAt,
      tagDisplayName: tags.displayName,
      tagName: tags.name,
      category: tags.category,
    })
    .from(trendingTags)
    .leftJoin(tags, eq(trendingTags.tagId, tags.id))
    .orderBy(trendingTags.rank)
    .limit(20);

  return latestTrending;
}

async function collectTrajectoryAudit(since: Date): Promise<TrajectoryAudit> {
  const trajectoryRows: Array<{
    id: string;
    trajectoryId: string;
    agentId: string;
    createdAt: Date;
    finalStatus: string;
    episodeLength: number;
    totalReward: number;
    tradesExecuted: number | null;
    postsCreated: number | null;
    stepsJson: string;
  }> = await db
    .select({
      id: trajectories.id,
      trajectoryId: trajectories.trajectoryId,
      agentId: trajectories.agentId,
      createdAt: trajectories.createdAt,
      finalStatus: trajectories.finalStatus,
      episodeLength: trajectories.episodeLength,
      totalReward: trajectories.totalReward,
      tradesExecuted: trajectories.tradesExecuted,
      postsCreated: trajectories.postsCreated,
      stepsJson: trajectories.stepsJson,
    })
    .from(trajectories)
    .where(gte(trajectories.createdAt, since))
    .orderBy(desc(trajectories.createdAt))
    .limit(500);

  const llmLogRows: Array<{
    id: string;
    trajectoryId: string;
    stepId: string;
    callId: string;
    createdAt: Date;
    latencyMs: number | null;
    model: string;
    purpose: string;
    actionType: string | null;
    systemPrompt: string;
    userPrompt: string;
    response: string;
    promptTokens: number | null;
    completionTokens: number | null;
  }> = await db
    .select({
      id: llmCallLogs.id,
      trajectoryId: llmCallLogs.trajectoryId,
      stepId: llmCallLogs.stepId,
      callId: llmCallLogs.callId,
      createdAt: llmCallLogs.createdAt,
      latencyMs: llmCallLogs.latencyMs,
      model: llmCallLogs.model,
      purpose: llmCallLogs.purpose,
      actionType: llmCallLogs.actionType,
      systemPrompt: llmCallLogs.systemPrompt,
      userPrompt: llmCallLogs.userPrompt,
      response: llmCallLogs.response,
      promptTokens: llmCallLogs.promptTokens,
      completionTokens: llmCallLogs.completionTokens,
    })
    .from(llmCallLogs)
    .where(gte(llmCallLogs.createdAt, since))
    .orderBy(desc(llmCallLogs.createdAt))
    .limit(1000);

  const trajectoryById = new Map(
    trajectoryRows.map((row) => [row.trajectoryId, row])
  );

  const actionAttempts: ActionAttemptRecord[] = [];
  for (const row of trajectoryRows) {
    const steps = parseJsonArray(row.stepsJson);
    for (const rawStep of steps) {
      if (!isJsonRecord(rawStep)) continue;
      const action = isJsonRecord(rawStep.action) ? rawStep.action : null;
      if (!action || typeof action.actionType !== 'string') continue;

      actionAttempts.push({
        trajectoryId: row.trajectoryId,
        agentId: row.agentId,
        finalStatus: row.finalStatus,
        stepId: typeof rawStep.stepId === 'string' ? rawStep.stepId : '',
        stepNumber:
          typeof rawStep.stepNumber === 'number' ? rawStep.stepNumber : 0,
        timestamp:
          typeof rawStep.timestamp === 'number' ? rawStep.timestamp : 0,
        actionType: action.actionType,
        success: action.success === true,
        error: typeof action.error === 'string' ? action.error : undefined,
        reasoning:
          typeof action.reasoning === 'string' ? action.reasoning : undefined,
        result: isJsonRecord(action.result) ? action.result : undefined,
      });
    }
  }

  const byActionType = new Map<
    string,
    {
      attempts: number;
      successes: number;
      failures: number;
      uniqueAgents: Set<string>;
      exampleErrors: Set<string>;
    }
  >();

  for (const attempt of actionAttempts) {
    const existing = byActionType.get(attempt.actionType) ?? {
      attempts: 0,
      successes: 0,
      failures: 0,
      uniqueAgents: new Set<string>(),
      exampleErrors: new Set<string>(),
    };
    existing.attempts += 1;
    existing.uniqueAgents.add(attempt.agentId);
    if (attempt.success) existing.successes += 1;
    else existing.failures += 1;
    if (attempt.error) existing.exampleErrors.add(attempt.error);
    byActionType.set(attempt.actionType, existing);
  }

  const llmCalls: PromptCallArtifact[] = llmLogRows.map((row) => ({
    promptType: row.actionType ?? row.purpose,
    provider: 'trajectory',
    model: row.model,
    format: 'text',
    temperature: 0,
    maxTokens: row.completionTokens ?? 0,
    systemPrompt: row.systemPrompt,
    userPrompt: row.userPrompt,
    rawResponse: row.response,
    parsedResponse: safeJsonParse(row.response),
    inputTokens: row.promptTokens ?? 0,
    outputTokens: row.completionTokens ?? 0,
    totalTokens: (row.promptTokens ?? 0) + (row.completionTokens ?? 0),
    durationMs: row.latencyMs ?? 0,
    success: true,
    capturedAt: row.createdAt.toISOString(),
    source: 'npc',
    actionType: row.actionType ?? undefined,
    trajectoryId: row.trajectoryId,
    agentId: trajectoryById.get(row.trajectoryId)?.agentId,
  }));

  return {
    trajectories: trajectoryRows.map((row) => ({
      id: row.id,
      trajectoryId: row.trajectoryId,
      agentId: row.agentId,
      createdAt: row.createdAt.toISOString(),
      finalStatus: row.finalStatus,
      episodeLength: row.episodeLength,
      totalReward: row.totalReward,
      tradesExecuted: row.tradesExecuted,
      postsCreated: row.postsCreated,
    })),
    llmCalls,
    actionAttempts,
    actionSummary: {
      totalAttempts: actionAttempts.length,
      totalSuccesses: actionAttempts.filter((attempt) => attempt.success)
        .length,
      totalFailures: actionAttempts.filter((attempt) => !attempt.success)
        .length,
      byActionType: [...byActionType.entries()]
        .map(([actionType, value]) => ({
          actionType,
          attempts: value.attempts,
          successes: value.successes,
          failures: value.failures,
          uniqueAgents: value.uniqueAgents.size,
          exampleErrors: [...value.exampleErrors].slice(0, 5),
        }))
        .sort((left, right) => right.attempts - left.attempts),
      unusedCoreActions: CORE_NPC_ACTIONS.filter(
        (actionType) => !byActionType.has(actionType)
      ),
    },
  };
}

function collectDagTraceDirectories(since: Date): string[] {
  if (!statExists(DAG_TRACE_DIR)) return [];

  return readdirSync(DAG_TRACE_DIR)
    .filter((entry) => entry.startsWith('tick-'))
    .map((entry) => path.join(DAG_TRACE_DIR, entry))
    .filter((entryPath) => {
      try {
        return statSync(entryPath).mtimeMs >= since.getTime();
      } catch {
        return false;
      }
    })
    .sort();
}

function getEmptyTrajectoryAudit(): TrajectoryAudit {
  return {
    trajectories: [],
    llmCalls: [],
    actionAttempts: [],
    actionSummary: {
      totalAttempts: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      byActionType: [],
      unusedCoreActions: [...CORE_NPC_ACTIONS],
    },
  };
}

function getHoursSince(
  timestamp: Date | string | null | undefined,
  now: Date
): number | null {
  if (!timestamp) return null;
  const value = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(value.getTime())) return null;
  return Number(
    ((now.getTime() - value.getTime()) / (1000 * 60 * 60)).toFixed(2)
  );
}

function getNarrativeStaleThresholdHours(
  timeframe: string | null | undefined
): number {
  switch (timeframe) {
    case '15m':
    case '30m':
    case 'flash':
      return 1;
    case '1h':
    case '2h':
    case '4h':
    case '6h':
    case 'intraday':
      return 6;
    case '12h':
    case '24h':
    case 'daily':
      return 24;
    case '3d':
    case '7d':
    case 'weekly':
      return 72;
    case 'monthly':
      return 168;
    case 'quarterly':
      return 336;
    case 'longterm':
      return 720;
    default:
      return 24;
  }
}

async function collectEventArtifacts(
  since: Date,
  promptCalls: PromptCallArtifact[]
) {
  const eventRows: Array<{
    id: string;
    eventType: string;
    description: string;
    actors: string[] | null;
    relatedQuestion: number | null;
    pointsToward: string | null;
    visibility: string;
    timestamp: Date;
    createdAt: Date;
  }> = await db
    .select({
      id: worldEvents.id,
      eventType: worldEvents.eventType,
      description: worldEvents.description,
      actors: worldEvents.actors,
      relatedQuestion: worldEvents.relatedQuestion,
      pointsToward: worldEvents.pointsToward,
      visibility: worldEvents.visibility,
      timestamp: worldEvents.timestamp,
      createdAt: worldEvents.createdAt,
    })
    .from(worldEvents)
    .where(gte(worldEvents.createdAt, since))
    .orderBy(desc(worldEvents.createdAt))
    .limit(500);

  const questionNumbers = [
    ...new Set(
      eventRows
        .map((event) => event.relatedQuestion)
        .filter(
          (questionNumber): questionNumber is number =>
            typeof questionNumber === 'number'
        )
    ),
  ];

  const relatedQuestionRows: Array<{
    questionNumber: number;
    text: string;
    status: string;
    topicKey: string | null;
    topicLabel: string | null;
  }> =
    questionNumbers.length > 0
      ? await db
          .select({
            questionNumber: questions.questionNumber,
            text: questions.text,
            status: questions.status,
            topicKey: questions.topicKey,
            topicLabel: questions.topicLabel,
          })
          .from(questions)
          .where(inArray(questions.questionNumber, questionNumbers))
      : [];

  const questionByNumber = new Map(
    relatedQuestionRows.map((question) => [question.questionNumber, question])
  );

  const actorFrequency = new Map<string, number>();
  const eventsByThread = new Map<
    string,
    {
      threadKey: string;
      questionNumber: number | null;
      questionText: string | null;
      eventCount: number;
      eventTypes: Set<string>;
      actorIds: Set<string>;
      firstEventAt: string;
      lastEventAt: string;
      sampleDescriptions: string[];
    }
  >();
  const byType: Record<string, number> = {};

  for (const event of eventRows) {
    byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
    for (const actor of event.actors ?? []) {
      actorFrequency.set(actor, (actorFrequency.get(actor) ?? 0) + 1);
    }

    const question = event.relatedQuestion
      ? (questionByNumber.get(event.relatedQuestion) ?? null)
      : null;
    const threadKey =
      event.relatedQuestion !== null
        ? `question:${event.relatedQuestion}`
        : `actors:${(event.actors ?? []).slice().sort().join('|') || event.eventType}`;
    const existing = eventsByThread.get(threadKey) ?? {
      threadKey,
      questionNumber: event.relatedQuestion,
      questionText: question?.text ?? null,
      eventCount: 0,
      eventTypes: new Set<string>(),
      actorIds: new Set<string>(),
      firstEventAt: event.timestamp.toISOString(),
      lastEventAt: event.timestamp.toISOString(),
      sampleDescriptions: [],
    };

    existing.eventCount += 1;
    existing.eventTypes.add(event.eventType);
    for (const actor of event.actors ?? []) existing.actorIds.add(actor);
    if (existing.sampleDescriptions.length < 4) {
      existing.sampleDescriptions.push(event.description);
    }
    if (event.timestamp.toISOString() < existing.firstEventAt) {
      existing.firstEventAt = event.timestamp.toISOString();
    }
    if (event.timestamp.toISOString() > existing.lastEventAt) {
      existing.lastEventAt = event.timestamp.toISOString();
    }
    eventsByThread.set(threadKey, existing);
  }

  const duplicates = buildDuplicateStats(
    eventRows.map((event) => ({
      id: event.id,
      text: event.description,
    }))
  );
  const modelIO = buildSurfaceModelIO(promptCalls, 'narratives');

  return {
    summary: {
      totalEvents: eventRows.length,
      linkedToQuestionCount: eventRows.filter(
        (event) => event.relatedQuestion !== null
      ).length,
      unlinkedEventCount: eventRows.filter(
        (event) => event.relatedQuestion === null
      ).length,
      byType,
      duplicateDescriptionGroups: duplicates.exactDuplicateGroups.length,
      similarDescriptionPairs: duplicates.similarPairs.length,
      narrativeThreadCount: eventsByThread.size,
      topActors: [...actorFrequency.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 10)
        .map(([actorId, count]) => ({ actorId, count })),
      modelCallCount: modelIO.callCount,
    },
    duplicates,
    threads: [...eventsByThread.values()]
      .sort((left, right) => right.eventCount - left.eventCount)
      .slice(0, 25)
      .map((thread) => ({
        threadKey: thread.threadKey,
        questionNumber: thread.questionNumber,
        questionText: thread.questionText,
        eventCount: thread.eventCount,
        eventTypes: [...thread.eventTypes].sort(),
        actors: [...thread.actorIds].sort(),
        firstEventAt: thread.firstEventAt,
        lastEventAt: thread.lastEventAt,
        sampleDescriptions: thread.sampleDescriptions,
      })),
    items: eventRows.map((event) => ({
      ...event,
      timestamp: event.timestamp.toISOString(),
      createdAt: event.createdAt.toISOString(),
      questionText:
        event.relatedQuestion !== null
          ? (questionByNumber.get(event.relatedQuestion)?.text ?? null)
          : null,
      questionStatus:
        event.relatedQuestion !== null
          ? (questionByNumber.get(event.relatedQuestion)?.status ?? null)
          : null,
      questionTopic:
        event.relatedQuestion !== null
          ? (questionByNumber.get(event.relatedQuestion)?.topicLabel ??
            questionByNumber.get(event.relatedQuestion)?.topicKey ??
            null)
          : null,
    })),
    modelIO,
  };
}

async function collectNarrativeArtifacts(
  since: Date,
  promptCalls: PromptCallArtifact[]
) {
  const now = new Date();
  const latestTopic = await db
    .select({
      id: dailyTopics.id,
      date: dailyTopics.date,
      topicKey: dailyTopics.topicKey,
      topicLabel: dailyTopics.topicLabel,
      summary: dailyTopics.summary,
      sourceType: dailyTopics.sourceType,
      selectionReason: dailyTopics.selectionReason,
      isLocked: dailyTopics.isLocked,
    })
    .from(dailyTopics)
    .orderBy(desc(dailyTopics.date))
    .limit(1);

  const arcRows: Array<{
    arcId: string;
    questionId: string;
    currentState: string;
    stateEnteredAt: Date;
    eventsGenerated: number;
    lastEventAt: Date | null;
    pendingTransitions: unknown;
    questionNumber: number;
    questionText: string;
    questionStatus: string;
    questionCreatedAt: Date;
    topicKey: string | null;
    topicLabel: string | null;
    resolutionDate: Date;
    uncertaintyPeakDay: number | null;
    clarityOnsetDay: number | null;
    verificationDay: number | null;
    eventSchedule: unknown;
  }> = await db
    .select({
      arcId: arcStates.id,
      questionId: arcStates.questionId,
      currentState: arcStates.currentState,
      stateEnteredAt: arcStates.stateEnteredAt,
      eventsGenerated: arcStates.eventsGenerated,
      lastEventAt: arcStates.lastEventAt,
      pendingTransitions: arcStates.pendingTransitions,
      questionNumber: questions.questionNumber,
      questionText: questions.text,
      questionStatus: questions.status,
      questionCreatedAt: questions.createdAt,
      topicKey: questions.topicKey,
      topicLabel: questions.topicLabel,
      resolutionDate: questions.resolutionDate,
      uncertaintyPeakDay: questionArcPlans.uncertaintyPeakDay,
      clarityOnsetDay: questionArcPlans.clarityOnsetDay,
      verificationDay: questionArcPlans.verificationDay,
      eventSchedule: questionArcPlans.eventSchedule,
    })
    .from(arcStates)
    .innerJoin(questions, eq(arcStates.questionId, questions.id))
    .leftJoin(questionArcPlans, eq(questionArcPlans.questionId, questions.id))
    .orderBy(desc(questions.createdAt))
    .limit(500);

  const activeMarketRows: Array<{
    marketId: string;
    questionId: string | null;
    timeframe: string;
    granularTimeframe: string | null;
    topicKey: string | null;
    topicLabel: string | null;
    arcState: string;
    startTime: Date;
    endTime: Date;
    createdAt: Date;
  }> = await db
    .select({
      marketId: timeframedMarkets.id,
      questionId: timeframedMarkets.questionId,
      timeframe: timeframedMarkets.timeframe,
      granularTimeframe: timeframedMarkets.granularTimeframe,
      topicKey: timeframedMarkets.topicKey,
      topicLabel: timeframedMarkets.topicLabel,
      arcState: timeframedMarkets.arcState,
      startTime: timeframedMarkets.startTime,
      endTime: timeframedMarkets.endTime,
      createdAt: timeframedMarkets.createdAt,
    })
    .from(timeframedMarkets)
    .where(
      and(
        eq(timeframedMarkets.isActive, true),
        eq(timeframedMarkets.isResolved, false)
      )
    )
    .orderBy(desc(timeframedMarkets.createdAt))
    .limit(500);

  const marketsByQuestionId = new Map<
    string,
    Array<{
      marketId: string;
      timeframe: string;
      granularTimeframe: string | null;
      topicKey: string | null;
      topicLabel: string | null;
      arcState: string;
      startTime: string;
      endTime: string;
      createdAt: string;
    }>
  >();

  for (const market of activeMarketRows) {
    if (!market.questionId) continue;
    const existing = marketsByQuestionId.get(market.questionId) ?? [];
    existing.push({
      marketId: market.marketId,
      timeframe: market.timeframe,
      granularTimeframe: market.granularTimeframe,
      topicKey: market.topicKey,
      topicLabel: market.topicLabel,
      arcState: market.arcState,
      startTime: market.startTime.toISOString(),
      endTime: market.endTime.toISOString(),
      createdAt: market.createdAt.toISOString(),
    });
    marketsByQuestionId.set(market.questionId, existing);
  }

  const questionNumbers = arcRows.map((row) => row.questionNumber);
  const relatedEvents: Array<{
    id: string;
    relatedQuestion: number | null;
    eventType: string;
    description: string;
    createdAt: Date;
  }> =
    questionNumbers.length > 0
      ? await db
          .select({
            id: worldEvents.id,
            relatedQuestion: worldEvents.relatedQuestion,
            eventType: worldEvents.eventType,
            description: worldEvents.description,
            createdAt: worldEvents.createdAt,
          })
          .from(worldEvents)
          .where(inArray(worldEvents.relatedQuestion, questionNumbers))
          .orderBy(desc(worldEvents.createdAt))
          .limit(1000)
      : [];

  const eventsByQuestionNumber = new Map<
    number,
    Array<{
      id: string;
      eventType: string;
      description: string;
      createdAt: string;
    }>
  >();

  for (const event of relatedEvents) {
    if (event.relatedQuestion === null) continue;
    const existing = eventsByQuestionNumber.get(event.relatedQuestion) ?? [];
    existing.push({
      id: event.id,
      eventType: event.eventType,
      description: event.description,
      createdAt: event.createdAt.toISOString(),
    });
    eventsByQuestionNumber.set(event.relatedQuestion, existing);
  }

  const spawnLogs: Array<{
    id: string;
    parentMarketId: string;
    sourceEventId: string | null;
    eventType: string;
    spawnedMarketId: string | null;
    wasSpawned: boolean;
    skipReason: string | null;
    questionTemplate: string | null;
    generatedQuestion: string | null;
    childTimeframe: string | null;
    createdAt: Date;
  }> = await db
    .select({
      id: subMarketSpawnLogs.id,
      parentMarketId: subMarketSpawnLogs.parentMarketId,
      sourceEventId: subMarketSpawnLogs.sourceEventId,
      eventType: subMarketSpawnLogs.eventType,
      spawnedMarketId: subMarketSpawnLogs.spawnedMarketId,
      wasSpawned: subMarketSpawnLogs.wasSpawned,
      skipReason: subMarketSpawnLogs.skipReason,
      questionTemplate: subMarketSpawnLogs.questionTemplate,
      generatedQuestion: subMarketSpawnLogs.generatedQuestion,
      childTimeframe: subMarketSpawnLogs.childTimeframe,
      createdAt: subMarketSpawnLogs.createdAt,
    })
    .from(subMarketSpawnLogs)
    .where(gte(subMarketSpawnLogs.createdAt, since))
    .orderBy(desc(subMarketSpawnLogs.createdAt))
    .limit(500);

  const duplicates = buildDuplicateStats(
    arcRows.map((arc) => ({
      id: arc.questionId,
      text: arc.questionText,
    }))
  );
  const modelIO = buildSurfaceModelIO(promptCalls, 'narratives');

  const items = arcRows.map((arc) => {
    const linkedMarkets = marketsByQuestionId.get(arc.questionId) ?? [];
    const recentEvents = eventsByQuestionNumber.get(arc.questionNumber) ?? [];
    const scheduledEvents = Array.isArray(arc.eventSchedule)
      ? arc.eventSchedule
      : [];
    const pendingTransitions = Array.isArray(arc.pendingTransitions)
      ? arc.pendingTransitions
      : [];
    const primaryTimeframe =
      linkedMarkets[0]?.granularTimeframe ??
      linkedMarkets[0]?.timeframe ??
      null;
    const hoursSinceNarrativeSignal = getHoursSince(
      arc.lastEventAt ?? arc.stateEnteredAt,
      now
    );
    const isStale =
      arc.questionStatus === 'active' &&
      arc.currentState !== 'resolution' &&
      hoursSinceNarrativeSignal !== null &&
      hoursSinceNarrativeSignal >
        getNarrativeStaleThresholdHours(primaryTimeframe);

    return {
      arcId: arc.arcId,
      questionId: arc.questionId,
      questionNumber: arc.questionNumber,
      questionText: arc.questionText,
      questionStatus: arc.questionStatus,
      questionCreatedAt: arc.questionCreatedAt.toISOString(),
      resolutionDate: arc.resolutionDate.toISOString(),
      topicKey: arc.topicKey,
      topicLabel: arc.topicLabel,
      currentState: arc.currentState,
      stateEnteredAt: arc.stateEnteredAt.toISOString(),
      eventsGenerated: arc.eventsGenerated,
      lastEventAt: arc.lastEventAt?.toISOString() ?? null,
      hoursSinceNarrativeSignal,
      pendingTransitionsCount: pendingTransitions.length,
      pendingTransitions,
      uncertaintyPeakDay: arc.uncertaintyPeakDay,
      clarityOnsetDay: arc.clarityOnsetDay,
      verificationDay: arc.verificationDay,
      scheduledEventCount: scheduledEvents.length,
      firedScheduledEventCount: scheduledEvents.filter(
        (event) =>
          isJsonRecord(event) && 'fired' in event && event.fired === true
      ).length,
      activeMarkets: linkedMarkets,
      recentEvents: recentEvents.slice(0, 8),
      isStale,
    };
  });

  const stateBreakdown = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.currentState] = (acc[item.currentState] ?? 0) + 1;
    return acc;
  }, {});
  const spawnSkipReasons = spawnLogs.reduce<Record<string, number>>(
    (acc, log) => {
      const key = log.skipReason ?? 'none';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );

  return {
    summary: {
      currentTopic: latestTopic[0]
        ? {
            date: latestTopic[0].date.toISOString(),
            topicKey: latestTopic[0].topicKey,
            topicLabel: latestTopic[0].topicLabel,
            summary: latestTopic[0].summary,
            sourceType: latestTopic[0].sourceType,
            selectionReason: latestTopic[0].selectionReason,
            isLocked: latestTopic[0].isLocked,
          }
        : null,
      totalNarratives: items.length,
      activeNarratives: items.filter((item) => item.questionStatus === 'active')
        .length,
      staleNarratives: items.filter((item) => item.isStale).length,
      narrativesWithoutRecentEvents: items.filter(
        (item) => item.recentEvents.length === 0
      ).length,
      stateBreakdown,
      duplicateQuestionGroups: duplicates.exactDuplicateGroups.length,
      spawnAttempts: spawnLogs.length,
      spawnedMarkets: spawnLogs.filter((log) => log.wasSpawned).length,
      skippedSpawnReasons: spawnSkipReasons,
      modelCallCount: modelIO.callCount,
    },
    duplicates,
    items,
    spawnLogs: spawnLogs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
    staleNarratives: items.filter((item) => item.isStale).slice(0, 25),
    modelIO,
  };
}

async function collectQuestionArtifacts(
  since: Date,
  promptCalls: PromptCallArtifact[]
) {
  const createdQuestions: Array<{
    id: string;
    questionNumber: number;
    text: string;
    status: string;
    topicKey: string | null;
    topicLabel: string | null;
    createdAt: Date;
    resolutionDate: Date;
  }> = await db
    .select({
      id: questions.id,
      questionNumber: questions.questionNumber,
      text: questions.text,
      status: questions.status,
      topicKey: questions.topicKey,
      topicLabel: questions.topicLabel,
      createdAt: questions.createdAt,
      resolutionDate: questions.resolutionDate,
    })
    .from(questions)
    .where(gte(questions.createdAt, since))
    .orderBy(desc(questions.createdAt))
    .limit(500);

  const activeQuestionRows: Array<{
    questionId: string;
    questionNumber: number;
    text: string;
    status: string;
    topicKey: string | null;
    topicLabel: string | null;
    createdAt: Date;
    resolutionDate: Date;
    marketId: string;
    timeframe: string;
    granularTimeframe: string | null;
    marketArcState: string;
    startTime: Date;
    endTime: Date;
  }> = await db
    .select({
      questionId: questions.id,
      questionNumber: questions.questionNumber,
      text: questions.text,
      status: questions.status,
      topicKey: questions.topicKey,
      topicLabel: questions.topicLabel,
      createdAt: questions.createdAt,
      resolutionDate: questions.resolutionDate,
      marketId: timeframedMarkets.id,
      timeframe: timeframedMarkets.timeframe,
      granularTimeframe: timeframedMarkets.granularTimeframe,
      marketArcState: timeframedMarkets.arcState,
      startTime: timeframedMarkets.startTime,
      endTime: timeframedMarkets.endTime,
    })
    .from(timeframedMarkets)
    .innerJoin(questions, eq(timeframedMarkets.questionId, questions.id))
    .where(
      and(
        eq(timeframedMarkets.isActive, true),
        eq(timeframedMarkets.isResolved, false)
      )
    )
    .orderBy(desc(timeframedMarkets.createdAt))
    .limit(500);

  const questionMap = new Map<
    string,
    {
      id: string;
      questionNumber: number;
      text: string;
      status: string;
      topicKey: string | null;
      topicLabel: string | null;
      createdAt: Date;
      resolutionDate: Date;
      activeMarkets: Array<{
        marketId: string;
        timeframe: string;
        granularTimeframe: string | null;
        marketArcState: string;
        startTime: string;
        endTime: string;
      }>;
    }
  >();

  for (const question of createdQuestions) {
    questionMap.set(question.id, {
      ...question,
      activeMarkets: [],
    });
  }

  for (const row of activeQuestionRows) {
    const existing = questionMap.get(row.questionId) ?? {
      id: row.questionId,
      questionNumber: row.questionNumber,
      text: row.text,
      status: row.status,
      topicKey: row.topicKey,
      topicLabel: row.topicLabel,
      createdAt: row.createdAt,
      resolutionDate: row.resolutionDate,
      activeMarkets: [],
    };
    existing.activeMarkets.push({
      marketId: row.marketId,
      timeframe: row.timeframe,
      granularTimeframe: row.granularTimeframe,
      marketArcState: row.marketArcState,
      startTime: row.startTime.toISOString(),
      endTime: row.endTime.toISOString(),
    });
    questionMap.set(row.questionId, existing);
  }

  const questionIds = [...questionMap.keys()];
  const questionNumbers = [
    ...new Set(
      [...questionMap.values()].map((question) => question.questionNumber)
    ),
  ];

  const arcRows: Array<{
    questionId: string;
    currentState: string;
    stateEnteredAt: Date;
    eventsGenerated: number;
    lastEventAt: Date | null;
  }> =
    questionIds.length > 0
      ? await db
          .select({
            questionId: arcStates.questionId,
            currentState: arcStates.currentState,
            stateEnteredAt: arcStates.stateEnteredAt,
            eventsGenerated: arcStates.eventsGenerated,
            lastEventAt: arcStates.lastEventAt,
          })
          .from(arcStates)
          .where(inArray(arcStates.questionId, questionIds))
      : [];

  const arcByQuestionId = new Map(arcRows.map((row) => [row.questionId, row]));

  const eventRows: Array<{
    relatedQuestion: number | null;
    description: string;
    eventType: string;
    createdAt: Date;
  }> =
    questionNumbers.length > 0
      ? await db
          .select({
            relatedQuestion: worldEvents.relatedQuestion,
            description: worldEvents.description,
            eventType: worldEvents.eventType,
            createdAt: worldEvents.createdAt,
          })
          .from(worldEvents)
          .where(inArray(worldEvents.relatedQuestion, questionNumbers))
          .orderBy(desc(worldEvents.createdAt))
          .limit(1000)
      : [];

  const eventsByQuestionNumber = new Map<
    number,
    Array<{ description: string; eventType: string; createdAt: string }>
  >();
  for (const event of eventRows) {
    if (event.relatedQuestion === null) continue;
    const existing = eventsByQuestionNumber.get(event.relatedQuestion) ?? [];
    existing.push({
      description: event.description,
      eventType: event.eventType,
      createdAt: event.createdAt.toISOString(),
    });
    eventsByQuestionNumber.set(event.relatedQuestion, existing);
  }

  const items = [...questionMap.values()]
    .map((question) => ({
      id: question.id,
      questionNumber: question.questionNumber,
      text: question.text,
      status: question.status,
      topicKey: question.topicKey,
      topicLabel: question.topicLabel,
      createdAt: question.createdAt.toISOString(),
      resolutionDate: question.resolutionDate.toISOString(),
      activeMarkets: question.activeMarkets,
      currentArcState: arcByQuestionId.get(question.id)?.currentState ?? null,
      stateEnteredAt:
        arcByQuestionId.get(question.id)?.stateEnteredAt.toISOString() ?? null,
      eventsGenerated:
        arcByQuestionId.get(question.id)?.eventsGenerated ??
        eventsByQuestionNumber.get(question.questionNumber)?.length ??
        0,
      lastEventAt:
        arcByQuestionId.get(question.id)?.lastEventAt?.toISOString() ?? null,
      recentEvents: (
        eventsByQuestionNumber.get(question.questionNumber) ?? []
      ).slice(0, 6),
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const duplicates = buildDuplicateStats(
    items.map((question) => ({
      id: question.id,
      text: question.text,
    }))
  );
  const timeframeBreakdown = items
    .flatMap((question) => question.activeMarkets)
    .reduce<Record<string, number>>((acc, market) => {
      const key = market.granularTimeframe ?? market.timeframe;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  const topicBreakdown = items.reduce<Record<string, number>>(
    (acc, question) => {
      const key = question.topicLabel ?? question.topicKey ?? 'unlabeled';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );
  const modelIO = buildSurfaceModelIO(promptCalls, 'questions');

  return {
    summary: {
      createdDuringRun: createdQuestions.length,
      activeQuestionCount: new Set(
        activeQuestionRows.map((row) => row.questionId)
      ).size,
      totalQuestionsEvaluated: items.length,
      duplicateQuestionGroups: duplicates.exactDuplicateGroups.length,
      similarQuestionPairs: duplicates.similarPairs.length,
      zeroEventQuestions: items.filter((item) => item.recentEvents.length === 0)
        .length,
      topicBreakdown,
      timeframeBreakdown,
      modelCallCount: modelIO.callCount,
    },
    duplicates,
    items,
    modelIO,
  };
}

async function collectNewsArtifacts(
  since: Date,
  promptCalls: PromptCallArtifact[],
  storiesFeed: FeedResult,
  breakingNewsWidget: JobArtifact
) {
  const organizationIds = new Set(
    StaticDataRegistry.getAllOrganizations().map(
      (organization) => organization.id
    )
  );
  const recentPosts: Array<{
    id: string;
    content: string;
    authorId: string;
    createdAt: Date;
    timestamp: Date;
    articleTitle: string | null;
    category: string | null;
    fullContent: string | null;
    byline: string | null;
    sentiment: string | null;
    slant: string | null;
    type: string | null;
    relatedQuestion: number | null;
  }> = await db
    .select({
      id: posts.id,
      content: posts.content,
      authorId: posts.authorId,
      createdAt: posts.createdAt,
      timestamp: posts.timestamp,
      articleTitle: posts.articleTitle,
      category: posts.category,
      fullContent: posts.fullContent,
      byline: posts.byline,
      sentiment: posts.sentiment,
      slant: posts.slant,
      type: posts.type,
      relatedQuestion: posts.relatedQuestion,
    })
    .from(posts)
    .where(and(gte(posts.createdAt, since), isNull(posts.deletedAt)))
    .orderBy(desc(posts.createdAt))
    .limit(500);

  const topLevelPosts = recentPosts.filter((post) => post.type !== 'comment');
  const organizationPosts = topLevelPosts.filter((post) =>
    organizationIds.has(post.authorId)
  );
  const articlePosts = topLevelPosts.filter(
    (post) =>
      post.type === 'article' ||
      post.articleTitle !== null ||
      post.category === 'article'
  );

  const headlines: Array<{
    id: string;
    title: string;
    summary: string | null;
    content: string | null;
    link: string | null;
    publishedAt: Date;
    fetchedAt: Date;
  }> = await db
    .select({
      id: rssHeadlines.id,
      title: rssHeadlines.title,
      summary: rssHeadlines.summary,
      content: rssHeadlines.content,
      link: rssHeadlines.link,
      publishedAt: rssHeadlines.publishedAt,
      fetchedAt: rssHeadlines.fetchedAt,
    })
    .from(rssHeadlines)
    .where(gte(rssHeadlines.fetchedAt, since))
    .orderBy(desc(rssHeadlines.fetchedAt))
    .limit(200);

  const parodies: Array<{
    id: string;
    originalTitle: string;
    parodyTitle: string;
    parodyContent: string | null;
    qualityScore: number | null;
    qualityReasons: string[] | null;
    generatedAt: Date;
  }> = await db
    .select({
      id: parodyHeadlines.id,
      originalTitle: parodyHeadlines.originalTitle,
      parodyTitle: parodyHeadlines.parodyTitle,
      parodyContent: parodyHeadlines.parodyContent,
      qualityScore: parodyHeadlines.qualityScore,
      qualityReasons: parodyHeadlines.qualityReasons,
      generatedAt: parodyHeadlines.generatedAt,
    })
    .from(parodyHeadlines)
    .where(gte(parodyHeadlines.generatedAt, since))
    .orderBy(desc(parodyHeadlines.generatedAt))
    .limit(200);

  const storyDuplicates = buildDuplicateStats(
    storiesFeed.stories.map((story) => ({
      id: story.storyKey,
      text:
        story.storyTitle ??
        story.title ??
        story.posts[0]?.content ??
        story.storyKey,
    }))
  );
  const headlineDuplicates = buildDuplicateStats(
    headlines.map((headline) => ({
      id: headline.id,
      text: headline.title,
    }))
  );
  const articleTitleDuplicates = buildDuplicateStats(
    articlePosts
      .filter((post) => post.articleTitle)
      .map((post) => ({
        id: post.id,
        text: post.articleTitle ?? '',
      }))
  );
  const modelIO = buildSurfaceModelIO(promptCalls, 'news');

  return {
    summary: {
      topLevelPosts: topLevelPosts.length,
      organizationPosts: organizationPosts.length,
      articlePosts: articlePosts.length,
      rssHeadlinesFetched: headlines.length,
      parodyHeadlinesGenerated: parodies.length,
      storiesGenerated: storiesFeed.stories.length,
      duplicateStoryGroups: storyDuplicates.exactDuplicateGroups.length,
      duplicateHeadlineGroups: headlineDuplicates.exactDuplicateGroups.length,
      duplicateArticleTitleGroups:
        articleTitleDuplicates.exactDuplicateGroups.length,
      modelCallCount: modelIO.callCount,
    },
    rssHeadlines: headlines.map((headline) => ({
      ...headline,
      publishedAt: headline.publishedAt.toISOString(),
      fetchedAt: headline.fetchedAt.toISOString(),
    })),
    parodyHeadlines: parodies.map((parody) => ({
      ...parody,
      generatedAt: parody.generatedAt.toISOString(),
    })),
    organizationPosts: organizationPosts.map((post) => ({
      ...post,
      createdAt: post.createdAt.toISOString(),
      timestamp: post.timestamp.toISOString(),
    })),
    articlePosts: articlePosts.map((post) => ({
      ...post,
      createdAt: post.createdAt.toISOString(),
      timestamp: post.timestamp.toISOString(),
    })),
    stories: storiesFeed.stories.map((story) => ({
      storyKey: story.storyKey,
      storyTitle: story.storyTitle ?? story.title ?? null,
      questionNumber: story.questionNumber ?? null,
      arcState: story.arcState ?? null,
      storyScore: story.storyScore ?? null,
      finalRankScore: story.finalRankScore ?? null,
      postCount: story.postCount ?? story.posts.length,
      leadText: story.posts[0]?.content ?? null,
      postIds: story.posts.map((post) => post.id),
    })),
    breakingNewsWidget: breakingNewsWidget.body,
    duplicates: {
      stories: storyDuplicates,
      headlines: headlineDuplicates,
      articleTitles: articleTitleDuplicates,
    },
    modelIO,
  };
}

async function collectTrendingArtifacts(
  since: Date,
  promptCalls: PromptCallArtifact[],
  trendingSnapshot: Awaited<ReturnType<typeof collectTrendingTagSnapshot>>,
  trendingWidget: JobArtifact
) {
  const tagIds = trendingSnapshot.map((tag) => tag.tagId);
  const taggedPosts: Array<{
    tagId: string;
    postId: string;
    content: string;
    authorId: string;
    createdAt: Date;
    relatedQuestion: number | null;
  }> =
    tagIds.length > 0
      ? await db
          .select({
            tagId: postTags.tagId,
            postId: posts.id,
            content: posts.content,
            authorId: posts.authorId,
            createdAt: posts.createdAt,
            relatedQuestion: posts.relatedQuestion,
          })
          .from(postTags)
          .innerJoin(posts, eq(postTags.postId, posts.id))
          .where(
            and(
              inArray(postTags.tagId, tagIds),
              isNull(posts.deletedAt),
              gte(posts.createdAt, since)
            )
          )
          .orderBy(desc(posts.createdAt))
          .limit(500)
      : [];

  const postsByTagId = new Map<
    string,
    Array<{
      postId: string;
      content: string;
      authorId: string;
      createdAt: string;
      relatedQuestion: number | null;
    }>
  >();
  for (const post of taggedPosts) {
    const existing = postsByTagId.get(post.tagId) ?? [];
    existing.push({
      postId: post.postId,
      content: post.content,
      authorId: post.authorId,
      createdAt: post.createdAt.toISOString(),
      relatedQuestion: post.relatedQuestion,
    });
    postsByTagId.set(post.tagId, existing);
  }

  const widgetTrending =
    isJsonRecord(trendingWidget.body) &&
    Array.isArray(trendingWidget.body.trending)
      ? trendingWidget.body.trending.filter(isJsonRecord)
      : [];

  const widgetSummaryDuplicates = buildDuplicateStats(
    widgetTrending.map((item, index) => ({
      id: String(item.id ?? index),
      text: typeof item.summary === 'string' ? item.summary : '',
    }))
  );
  const tagNameDuplicates = buildDuplicateStats(
    trendingSnapshot.map((tag) => ({
      id: tag.id,
      text: tag.tagDisplayName ?? tag.tagName ?? '',
    }))
  );
  const categoryBreakdown = trendingSnapshot.reduce<Record<string, number>>(
    (acc, tag) => {
      const key = tag.category ?? 'uncategorized';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );
  const modelIO = buildSurfaceModelIO(promptCalls, 'trending');

  return {
    summary: {
      trendingTagCount: trendingSnapshot.length,
      groupedTrendingStories: widgetTrending.length,
      zeroPostTrendingTags: trendingSnapshot.filter(
        (tag) => tag.postCount === 0
      ).length,
      categoryBreakdown,
      duplicateTagNameGroups: tagNameDuplicates.exactDuplicateGroups.length,
      duplicateWidgetSummaryGroups:
        widgetSummaryDuplicates.exactDuplicateGroups.length,
      modelCallCount: modelIO.callCount,
    },
    items: trendingSnapshot.map((tag) => ({
      id: tag.id,
      tagId: tag.tagId,
      name: tag.tagDisplayName ?? tag.tagName ?? null,
      slug: tag.tagName ?? null,
      category: tag.category,
      score: tag.score,
      postCount: tag.postCount,
      rank: tag.rank,
      calculatedAt: tag.calculatedAt.toISOString(),
      relatedPosts: (postsByTagId.get(tag.tagId) ?? []).slice(0, 8),
      widgetGroup:
        widgetTrending.find(
          (item) =>
            Array.isArray(item.tagIds) && item.tagIds.includes(tag.tagId)
        ) ?? null,
    })),
    widget: trendingWidget.body,
    duplicates: {
      tagNames: tagNameDuplicates,
      widgetSummaries: widgetSummaryDuplicates,
    },
    modelIO,
  };
}

function buildQuestionReport(cycleSnapshots: CycleSnapshot[]) {
  const questionsById = new Map<
    string,
    CycleSnapshot['samples']['questions'][number]
  >();
  for (const snapshot of cycleSnapshots) {
    for (const question of snapshot.samples.questions) {
      questionsById.set(question.id, question);
    }
  }

  const allQuestions = [...questionsById.values()];
  return {
    totalCreated: allQuestions.length,
    duplicates: buildDuplicateStats(
      allQuestions.map((question) => ({
        id: question.id,
        text: question.text,
      }))
    ),
    topicBreakdown: allQuestions.reduce<Record<string, number>>(
      (acc, question) => {
        const key = question.topicLabel ?? question.topicKey ?? 'unlabeled';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      },
      {}
    ),
    samples: allQuestions.slice(0, 25),
  };
}

function buildPredictionMarketReport(cycleSnapshots: CycleSnapshot[]) {
  const latestSnapshot = cycleSnapshots.at(-1);
  const historyRows = cycleSnapshots.flatMap(
    (snapshot) => snapshot.samples.predictionPriceHistory
  );
  const historyByMarket = new Map<
    string,
    Array<{
      createdAt: string;
      yesPrice: string | null;
      noPrice: string | null;
    }>
  >();

  for (const row of historyRows) {
    const existing = historyByMarket.get(row.marketId) ?? [];
    existing.push({
      createdAt: row.createdAt.toISOString(),
      yesPrice: row.yesPrice,
      noPrice: row.noPrice,
    });
    historyByMarket.set(row.marketId, existing);
  }

  return {
    activeMarketCount: latestSnapshot?.counts.activeTimeframedMarkets ?? 0,
    timeframeBreakdown: latestSnapshot?.timeframeBreakdown ?? {},
    duplicateQuestions: latestSnapshot?.duplicateStats
      .activeMarketQuestions ?? {
      total: 0,
      exactDuplicateGroups: [],
      similarPairs: [],
    },
    historyRows: historyRows.length,
    marketsWithMovement: historyByMarket.size,
    recentPriceHistory: [...historyByMarket.entries()]
      .slice(0, 25)
      .map(([marketId, rows]) => ({
        marketId,
        points: rows.slice(0, 10),
      })),
  };
}

function buildNewsReport(cycleSnapshots: CycleSnapshot[]) {
  const latestSnapshot = cycleSnapshots.at(-1);
  const articlePosts = cycleSnapshots.flatMap((snapshot) =>
    snapshot.samples.posts.filter(
      (post) =>
        post.type === 'article' ||
        post.articleTitle !== null ||
        post.category === 'article'
    )
  );

  return {
    postsCreated: cycleSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.counts.posts,
      0
    ),
    articlePostsCreated: cycleSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.counts.articlePosts,
      0
    ),
    rssHeadlinesFetched: cycleSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.counts.rssHeadlines,
      0
    ),
    parodyHeadlinesGenerated: cycleSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.counts.parodyHeadlines,
      0
    ),
    eventDuplicates: latestSnapshot?.duplicateStats.eventDescriptions ?? {
      total: 0,
      exactDuplicateGroups: [],
      similarPairs: [],
    },
    articleTitleDuplicates: buildDuplicateStats(
      articlePosts
        .filter((post) => post.articleTitle)
        .map((post) => ({
          id: post.id,
          text: post.articleTitle ?? '',
        }))
    ),
  };
}

function buildFeedReport(storiesFeed: FeedResult, forYouFeed: FeedResult) {
  const toStoryTextItems = (stories: FeedStory[]) =>
    stories.map((story) => ({
      id: story.storyKey,
      text:
        story.storyTitle ??
        story.posts[0]?.content ??
        (typeof story.title === 'string' ? story.title : story.storyKey),
    }));

  return {
    stories: {
      count: storiesFeed.stories.length,
      duplicates: buildDuplicateStats(toStoryTextItems(storiesFeed.stories)),
    },
    forYou: {
      count: forYouFeed.stories.length,
      duplicates: buildDuplicateStats(toStoryTextItems(forYouFeed.stories)),
    },
  };
}

function buildWarnings(
  jobArtifacts: JobArtifact[],
  promptAudit: ReturnType<typeof buildPromptAudit>,
  cycleSnapshots: CycleSnapshot[],
  trajectoryAudit: TrajectoryAudit
) {
  const warnings = [...promptAudit.warnings];

  for (const job of jobArtifacts) {
    if (!job.success) {
      warnings.push(
        `${job.name}: request failed${job.error ? ` (${job.error})` : ''}`
      );
      continue;
    }
    const body = job.body;
    if (
      body &&
      typeof body === 'object' &&
      body !== null &&
      'skipped' in body
    ) {
      const skipped = (body as JsonRecord).skipped;
      if (skipped === true) {
        warnings.push(`${job.name}: skipped`);
      }
    }
  }

  for (const snapshot of cycleSnapshots) {
    const counts = snapshot.counts;
    if ((counts.questions ?? 0) === 0)
      warnings.push('No questions were created in a cycle snapshot');
    if ((counts.events ?? 0) === 0)
      warnings.push('No world events were created in a cycle snapshot');
    if ((counts.posts ?? 0) === 0)
      warnings.push('No posts were created in a cycle snapshot');
  }

  for (const actionType of trajectoryAudit.actionSummary.unusedCoreActions) {
    warnings.push(`Core NPC action not exercised during run: ${actionType}`);
  }

  if (trajectoryAudit.actionSummary.totalAttempts === 0) {
    warnings.push('No NPC action attempts were recorded in trajectories');
  }

  return [...new Set(warnings)];
}

function buildMarkdownReport(report: {
  runId: string;
  cycles: number;
  rssMode: string;
  jobs: JobArtifact[];
  promptAudit: ReturnType<typeof buildPromptAudit>;
  cycleSnapshots: CycleSnapshot[];
  trajectoryAudit: TrajectoryAudit;
  questionReport: ReturnType<typeof buildQuestionReport>;
  predictionMarketReport: ReturnType<typeof buildPredictionMarketReport>;
  newsReport: ReturnType<typeof buildNewsReport>;
  eventSummary: {
    totalEvents: number;
    linkedToQuestionCount: number;
    unlinkedEventCount: number;
    byType: Record<string, number>;
    duplicateDescriptionGroups: number;
    similarDescriptionPairs: number;
    narrativeThreadCount: number;
    modelCallCount: number;
  };
  narrativeSummary: {
    totalNarratives: number;
    activeNarratives: number;
    staleNarratives: number;
    narrativesWithoutRecentEvents: number;
    stateBreakdown: Record<string, number>;
    spawnAttempts: number;
    spawnedMarkets: number;
    modelCallCount: number;
  };
  questionDetails: {
    createdDuringRun: number;
    activeQuestionCount: number;
    totalQuestionsEvaluated: number;
    duplicateQuestionGroups: number;
    similarQuestionPairs: number;
    zeroEventQuestions: number;
    modelCallCount: number;
  };
  newsDetails: {
    topLevelPosts: number;
    organizationPosts: number;
    articlePosts: number;
    rssHeadlinesFetched: number;
    parodyHeadlinesGenerated: number;
    storiesGenerated: number;
    duplicateStoryGroups: number;
    duplicateHeadlineGroups: number;
    duplicateArticleTitleGroups: number;
    modelCallCount: number;
  };
  trendingSummary: {
    trendingTagCount: number;
    groupedTrendingStories: number;
    zeroPostTrendingTags: number;
    categoryBreakdown: Record<string, number>;
    duplicateTagNameGroups: number;
    duplicateWidgetSummaryGroups: number;
    modelCallCount: number;
  };
  promptSurfaceReport: Array<{
    surface: string;
    callCount: number;
    promptTypes: string[];
  }>;
  stories: {
    count: number;
    duplicates: ReturnType<typeof buildDuplicateStats>;
  };
  forYou: { count: number; duplicates: ReturnType<typeof buildDuplicateStats> };
  trendingWidget: JobArtifact;
  breakingNewsWidget: JobArtifact;
  warnings: string[];
}) {
  const lines: string[] = [];
  lines.push(`# Core World Simulation Report`);
  lines.push('');
  lines.push(`- Run ID: ${report.runId}`);
  lines.push(`- Cycles: ${report.cycles}`);
  lines.push(`- RSS mode: ${report.rssMode}`);
  lines.push(`- NPC trade probability: ${npcTradeProbability}`);
  lines.push(`- Prompt calls captured: ${report.promptAudit.totalCalls}`);
  lines.push('');

  lines.push(`## Jobs`);
  lines.push('');
  for (const job of report.jobs) {
    lines.push(
      `- ${job.name} (cycle ${job.cycle}): ${job.success ? 'ok' : 'failed'} in ${job.durationMs}ms`
    );
  }
  lines.push('');

  lines.push(`## Cycle Snapshots`);
  lines.push('');
  report.cycleSnapshots.forEach((snapshot, index) => {
    lines.push(`### Cycle ${index + 1}`);
    lines.push('');
    lines.push(`- Posts: ${snapshot.counts.posts}`);
    lines.push(`- Org posts: ${snapshot.counts.orgPosts}`);
    lines.push(`- Actor posts: ${snapshot.counts.actorPosts}`);
    lines.push(`- Article posts: ${snapshot.counts.articlePosts}`);
    lines.push(`- Events: ${snapshot.counts.events}`);
    lines.push(`- Questions: ${snapshot.counts.questions}`);
    lines.push(
      `- Active timeframed markets: ${snapshot.counts.activeTimeframedMarkets}`
    );
    lines.push(`- RSS headlines: ${snapshot.counts.rssHeadlines}`);
    lines.push(`- Parody headlines: ${snapshot.counts.parodyHeadlines}`);
    lines.push(`- World facts: ${snapshot.counts.worldFacts}`);
    lines.push('');
  });

  lines.push(`## Feed`);
  lines.push('');
  lines.push(`- Stories feed stories: ${report.stories.count}`);
  lines.push(
    `- Stories feed exact duplicate groups: ${report.stories.duplicates.exactDuplicateGroups.length}`
  );
  lines.push(`- For You feed stories: ${report.forYou.count}`);
  lines.push(
    `- For You exact duplicate groups: ${report.forYou.duplicates.exactDuplicateGroups.length}`
  );
  lines.push('');

  lines.push(`## Questions`);
  lines.push('');
  lines.push(`- Created: ${report.questionReport.totalCreated}`);
  lines.push(
    `- Exact duplicate groups: ${report.questionReport.duplicates.exactDuplicateGroups.length}`
  );
  lines.push(
    `- Similar question pairs: ${report.questionReport.duplicates.similarPairs.length}`
  );
  lines.push('');

  lines.push(`## Prediction Markets`);
  lines.push('');
  lines.push(
    `- Active markets: ${report.predictionMarketReport.activeMarketCount}`
  );
  lines.push(
    `- Price history rows captured: ${report.predictionMarketReport.historyRows}`
  );
  lines.push(
    `- Markets with movement: ${report.predictionMarketReport.marketsWithMovement}`
  );
  lines.push('');

  lines.push(`## News`);
  lines.push('');
  lines.push(`- Posts created: ${report.newsReport.postsCreated}`);
  lines.push(
    `- Article posts created: ${report.newsReport.articlePostsCreated}`
  );
  lines.push(
    `- RSS headlines fetched: ${report.newsReport.rssHeadlinesFetched}`
  );
  lines.push(
    `- Parody headlines generated: ${report.newsReport.parodyHeadlinesGenerated}`
  );
  lines.push('');

  lines.push(`## Events`);
  lines.push('');
  lines.push(`- Total events: ${report.eventSummary.totalEvents}`);
  lines.push(
    `- Linked to questions: ${report.eventSummary.linkedToQuestionCount}`
  );
  lines.push(
    `- Narrative threads: ${report.eventSummary.narrativeThreadCount}`
  );
  lines.push(
    `- Duplicate event groups: ${report.eventSummary.duplicateDescriptionGroups}`
  );
  lines.push('');

  lines.push(`## Narratives`);
  lines.push('');
  lines.push(
    `- Narratives tracked: ${report.narrativeSummary.totalNarratives}`
  );
  lines.push(
    `- Active narratives: ${report.narrativeSummary.activeNarratives}`
  );
  lines.push(`- Stale narratives: ${report.narrativeSummary.staleNarratives}`);
  lines.push(
    `- Narratives without recent events: ${report.narrativeSummary.narrativesWithoutRecentEvents}`
  );
  lines.push(
    `- Spawn attempts / spawned markets: ${report.narrativeSummary.spawnAttempts} / ${report.narrativeSummary.spawnedMarkets}`
  );
  lines.push('');

  lines.push(`## Question Inventory`);
  lines.push('');
  lines.push(
    `- Created during run: ${report.questionDetails.createdDuringRun}`
  );
  lines.push(
    `- Active questions now: ${report.questionDetails.activeQuestionCount}`
  );
  lines.push(
    `- Total questions evaluated: ${report.questionDetails.totalQuestionsEvaluated}`
  );
  lines.push(
    `- Questions without events: ${report.questionDetails.zeroEventQuestions}`
  );
  lines.push('');

  lines.push(`## News Inventory`);
  lines.push('');
  lines.push(`- Top-level posts: ${report.newsDetails.topLevelPosts}`);
  lines.push(`- Organization posts: ${report.newsDetails.organizationPosts}`);
  lines.push(`- Stories generated: ${report.newsDetails.storiesGenerated}`);
  lines.push(
    `- Duplicate story groups: ${report.newsDetails.duplicateStoryGroups}`
  );
  lines.push('');

  lines.push(`## Trending`);
  lines.push('');
  lines.push(`- Trending tags: ${report.trendingSummary.trendingTagCount}`);
  lines.push(
    `- Grouped trending stories: ${report.trendingSummary.groupedTrendingStories}`
  );
  lines.push(
    `- Zero-post trending tags: ${report.trendingSummary.zeroPostTrendingTags}`
  );
  lines.push('');

  lines.push(`## Prompt Audit`);
  lines.push('');
  for (const promptType of report.promptAudit.promptTypes.slice(0, 20)) {
    lines.push(
      `- ${promptType.promptType}: ${promptType.calls} calls, ${promptType.uniqueInputs} unique inputs, ${promptType.uniqueOutputs} unique outputs, avg ${promptType.avgInputTokens}/${promptType.avgOutputTokens} tokens`
    );
  }
  lines.push('');

  lines.push(`## Model Surfaces`);
  lines.push('');
  for (const surface of report.promptSurfaceReport.slice(0, 10)) {
    lines.push(
      `- ${surface.surface}: ${surface.callCount} calls across ${surface.promptTypes.length} prompt types`
    );
  }
  lines.push('');

  lines.push(`## NPC Actions`);
  lines.push('');
  lines.push(
    `- Attempts: ${report.trajectoryAudit.actionSummary.totalAttempts}`
  );
  lines.push(
    `- Successes: ${report.trajectoryAudit.actionSummary.totalSuccesses}`
  );
  lines.push(
    `- Failures: ${report.trajectoryAudit.actionSummary.totalFailures}`
  );
  for (const action of report.trajectoryAudit.actionSummary.byActionType.slice(
    0,
    12
  )) {
    lines.push(
      `- ${action.actionType}: ${action.attempts} attempts, ${action.successes} success, ${action.failures} failure`
    );
  }
  if (report.trajectoryAudit.actionSummary.unusedCoreActions.length > 0) {
    lines.push('');
    lines.push(
      `- Unused core actions: ${report.trajectoryAudit.actionSummary.unusedCoreActions.join(', ')}`
    );
  }
  lines.push('');

  if (report.promptAudit.repeatedPromptBlocks.length > 0) {
    lines.push(`## Repeated Prompt Blocks`);
    lines.push('');
    for (const block of report.promptAudit.repeatedPromptBlocks.slice(0, 10)) {
      lines.push(
        `- ${block.count} uses across ${block.promptTypes.length} prompt types: ${block.sample}`
      );
    }
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push(`## Warnings`);
    lines.push('');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  lines.push(`## Widgets`);
  lines.push('');
  lines.push(
    `- Trending widget: ${report.trendingWidget.success ? 'ok' : 'failed'}`
  );
  lines.push(
    `- Breaking news widget: ${report.breakingNewsWidget.success ? 'ok' : 'failed'}`
  );
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const runStartedAt = new Date();
  const llmCalls: PromptCallArtifact[] = [];
  const priorCallback = getLLMCallCallback();

  setLLMCallCallback((call) => {
    llmCalls.push({
      ...call,
      capturedAt: new Date().toISOString(),
      source: 'engine',
    });
    priorCallback?.(call);
  });

  const restoreFetch =
    rssMode === 'snapshot' ? await installRssFetchCache() : () => {};

  const jobArtifacts: JobArtifact[] = [];
  const cycleSnapshots: CycleSnapshot[] = [];

  logger.info(
    'Starting core world simulation',
    {
      cycles,
      rssMode,
      npcTradeProbability,
      outputDir,
    },
    'CoreWorldSim'
  );

  try {
    const bootstrapResult = await bootstrapGameIfNeeded();
    writeJson(path.join(outputDir, 'bootstrap.json'), bootstrapResult);

    for (let cycle = 1; cycle <= cycles; cycle++) {
      const cycleStartedAt = new Date();
      logger.info(
        `Running simulation cycle ${cycle}/${cycles}`,
        undefined,
        'CoreWorldSim'
      );

      const worldFactsJob = await invokeCronRoute(
        '../apps/web/src/app/api/cron/world-facts/route.ts',
        'world-facts',
        cycle,
        '/api/cron/world-facts'
      );
      jobArtifacts.push(worldFactsJob);
      writeJson(
        path.join(
          jobsDir,
          `${String(cycle).padStart(2, '0')}-world-facts.json`
        ),
        worldFactsJob
      );

      const gameTickStartedAt = new Date();
      let gameTickJob: JobArtifact;
      try {
        const gameTickResult = await executeGameTick();
        const gameTickCompletedAt = new Date();
        gameTickJob = {
          name: 'game-tick',
          cycle,
          startedAt: gameTickStartedAt.toISOString(),
          completedAt: gameTickCompletedAt.toISOString(),
          durationMs:
            gameTickCompletedAt.getTime() - gameTickStartedAt.getTime(),
          success: true,
          body: gameTickResult,
        };
      } catch (error) {
        const gameTickCompletedAt = new Date();
        gameTickJob = {
          name: 'game-tick',
          cycle,
          startedAt: gameTickStartedAt.toISOString(),
          completedAt: gameTickCompletedAt.toISOString(),
          durationMs:
            gameTickCompletedAt.getTime() - gameTickStartedAt.getTime(),
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      jobArtifacts.push(gameTickJob);
      writeJson(
        path.join(jobsDir, `${String(cycle).padStart(2, '0')}-game-tick.json`),
        gameTickJob
      );

      const marketsJob = await invokeCronRoute(
        '../apps/web/src/app/api/cron/markets-tick/route.ts',
        'markets-tick',
        cycle,
        '/api/cron/markets-tick'
      );
      jobArtifacts.push(marketsJob);
      writeJson(
        path.join(
          jobsDir,
          `${String(cycle).padStart(2, '0')}-markets-tick.json`
        ),
        marketsJob
      );

      const npcJob = await invokeCronRoute(
        '../apps/web/src/app/api/cron/npc-tick/route.ts',
        'npc-tick',
        cycle,
        '/api/cron/npc-tick'
      );
      jobArtifacts.push(npcJob);
      writeJson(
        path.join(jobsDir, `${String(cycle).padStart(2, '0')}-npc-tick.json`),
        npcJob
      );

      const organizationJob = await invokeCronRoute(
        '../apps/web/src/app/api/cron/organization-tick/route.ts',
        'organization-tick',
        cycle,
        '/api/cron/organization-tick'
      );
      jobArtifacts.push(organizationJob);
      writeJson(
        path.join(
          jobsDir,
          `${String(cycle).padStart(2, '0')}-organization-tick.json`
        ),
        organizationJob
      );

      const articleJob = await invokeCronRoute(
        '../apps/web/src/app/api/cron/article-tick/route.ts',
        'article-tick',
        cycle,
        '/api/cron/article-tick'
      );
      jobArtifacts.push(articleJob);
      writeJson(
        path.join(
          jobsDir,
          `${String(cycle).padStart(2, '0')}-article-tick.json`
        ),
        articleJob
      );

      const cycleSnapshot = await collectCycleSnapshot(cycleStartedAt);
      cycleSnapshots.push(cycleSnapshot);
      writeJson(path.join(cycleDir, `cycle-${cycle}.json`), cycleSnapshot);
    }

    const { buildStoriesFeed } = (await import(
      '../apps/web/src/app/api/feed/stories/pipeline.ts'
    )) as {
      buildStoriesFeed: () => Promise<FeedResult>;
    };
    const { buildForYouFeed } = (await import(
      '../apps/web/src/app/api/feed/for-you/pipeline.ts'
    )) as {
      buildForYouFeed: (userId?: string | null) => Promise<FeedResult>;
    };

    const storiesFeed = await buildStoriesFeed();
    const forYouFeed = await buildForYouFeed(null);
    writeJson(path.join(feedsDir, 'stories.json'), storiesFeed);
    writeJson(path.join(feedsDir, 'for-you.json'), forYouFeed);

    const trendingWidget = await invokeGetRoute(
      '../apps/web/src/app/api/feed/widgets/trending/route.ts',
      'trending-widget',
      '/api/feed/widgets/trending'
    );
    writeJson(path.join(widgetsDir, 'trending.json'), trendingWidget);

    const breakingNewsWidget = await invokeGetRoute(
      '../apps/web/src/app/api/feed/widgets/breaking-news/route.ts',
      'breaking-news-widget',
      '/api/feed/widgets/breaking-news?limit=10'
    );
    writeJson(path.join(widgetsDir, 'breaking-news.json'), breakingNewsWidget);

    const trendingSnapshot = await collectTrendingTagSnapshot();
    writeJson(path.join(widgetsDir, 'trending-tags-db.json'), trendingSnapshot);

    const trajectoryAudit = await collectTrajectoryAudit(runStartedAt);
    const copiedPromptLogs: string[] = [];
    const debugPromptDir = path.resolve(process.cwd(), 'debug', 'prompts');
    if (statExists(debugPromptDir)) {
      for (const entry of readdirSync(debugPromptDir)) {
        const fullPath = path.join(debugPromptDir, entry);
        const stats = statSync(fullPath);
        if (stats.mtimeMs < runStartedAt.getTime()) continue;
        const targetPath = path.join(promptsDir, 'markdown', entry);
        writeText(targetPath, readFileSync(fullPath, 'utf8'));
        copiedPromptLogs.push(targetPath);
      }
    }

    const debugPromptCalls = copiedPromptLogs
      .map((filePath) =>
        parsePromptMarkdownLog(filePath, readFileSync(filePath, 'utf8'))
      )
      .filter((call): call is PromptCallArtifact => call !== null);
    const allPromptCalls = mergePromptCalls([
      ...llmCalls,
      ...trajectoryAudit.llmCalls,
      ...debugPromptCalls,
    ]);
    const promptAudit = buildPromptAudit(allPromptCalls);
    const promptSurfaceReport = buildPromptSurfaceReport(allPromptCalls);
    writeJson(path.join(promptsDir, 'engine-llm-calls.json'), llmCalls);
    writeJson(
      path.join(promptsDir, 'trajectory-llm-calls.json'),
      trajectoryAudit.llmCalls
    );
    writeJson(path.join(promptsDir, 'debug-log-calls.json'), debugPromptCalls);
    writeJson(path.join(promptsDir, 'llm-calls.json'), allPromptCalls);
    writeJson(path.join(promptsDir, 'audit.json'), promptAudit);
    writeJson(
      path.join(outputDir, 'model-io-surfaces.json'),
      promptSurfaceReport
    );
    writeJson(
      path.join(outputDir, 'actions.json'),
      trajectoryAudit.actionSummary
    );
    writeJson(path.join(outputDir, 'trajectories.json'), trajectoryAudit);

    const feedReport = buildFeedReport(storiesFeed, forYouFeed);
    const questionReport = buildQuestionReport(cycleSnapshots);
    const predictionMarketReport = buildPredictionMarketReport(cycleSnapshots);
    const newsReport = buildNewsReport(cycleSnapshots);
    const questionArtifacts = await collectQuestionArtifacts(
      runStartedAt,
      allPromptCalls
    );
    const eventArtifacts = await collectEventArtifacts(
      runStartedAt,
      allPromptCalls
    );
    const narrativeArtifacts = await collectNarrativeArtifacts(
      runStartedAt,
      allPromptCalls
    );
    const newsArtifacts = await collectNewsArtifacts(
      runStartedAt,
      allPromptCalls,
      storiesFeed,
      breakingNewsWidget
    );
    const trendingArtifacts = await collectTrendingArtifacts(
      runStartedAt,
      allPromptCalls,
      trendingSnapshot,
      trendingWidget
    );
    const dagTraceDirs = collectDagTraceDirectories(runStartedAt);
    const warnings = [
      ...buildWarnings(
        jobArtifacts,
        promptAudit,
        cycleSnapshots,
        trajectoryAudit
      ),
      ...(narrativeArtifacts.summary.staleNarratives > 0
        ? [
            `${narrativeArtifacts.summary.staleNarratives} narratives appear stale or under-advanced`,
          ]
        : []),
      ...(questionArtifacts.summary.activeQuestionCount === 0
        ? ['No active prediction questions remained after the run']
        : []),
      ...(trendingArtifacts.summary.trendingTagCount > 0 &&
      trendingArtifacts.summary.zeroPostTrendingTags ===
        trendingArtifacts.summary.trendingTagCount
        ? ['All trending tags have zero linked posts']
        : []),
      ...(newsArtifacts.summary.rssHeadlinesFetched === 0
        ? ['No new RSS headlines were fetched during the run']
        : []),
    ];

    writeJson(
      path.join(outputDir, 'question-stats.json'),
      questionArtifacts.summary
    );
    writeJson(
      path.join(outputDir, 'prediction-market-stats.json'),
      predictionMarketReport
    );
    writeJson(path.join(outputDir, 'news-stats.json'), newsArtifacts.summary);
    writeJson(path.join(outputDir, 'feed-stats.json'), feedReport);
    writeJson(
      path.join(outputDir, 'events-stats.json'),
      eventArtifacts.summary
    );
    writeJson(
      path.join(outputDir, 'narrative-stats.json'),
      narrativeArtifacts.summary
    );
    writeJson(
      path.join(outputDir, 'trending-stats.json'),
      trendingArtifacts.summary
    );
    writeJson(path.join(outputDir, 'events.json'), eventArtifacts);
    writeJson(path.join(outputDir, 'narratives.json'), narrativeArtifacts);
    writeJson(path.join(outputDir, 'questions.json'), questionArtifacts);
    writeJson(path.join(outputDir, 'news-stories.json'), newsArtifacts);
    writeJson(path.join(outputDir, 'trending.json'), trendingArtifacts);
    writeJson(path.join(outputDir, 'dag-traces.json'), dagTraceDirs);

    const summary = {
      runId,
      startedAt: runStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      cycles,
      rssMode,
      outputDir,
      dagTraceDirs,
      copiedPromptLogs,
      jobs: jobArtifacts,
      cycleSnapshots,
      trajectories: trajectoryAudit.trajectories,
      actionSummary: trajectoryAudit.actionSummary,
      feeds: {
        ...feedReport,
      },
      widgets: {
        trending: trendingWidget,
        breakingNews: breakingNewsWidget,
        trendingTagsDb: trendingSnapshot,
      },
      questionReport,
      predictionMarketReport,
      newsReport,
      detailedReports: {
        events: eventArtifacts.summary,
        narratives: narrativeArtifacts.summary,
        questions: questionArtifacts.summary,
        news: newsArtifacts.summary,
        trending: trendingArtifacts.summary,
        modelIOSurfaces: promptSurfaceReport.map((surface) => ({
          surface: surface.surface,
          callCount: surface.callCount,
          promptTypes: surface.promptTypes,
        })),
      },
      promptAudit,
      warnings,
    };

    writeJson(path.join(outputDir, 'summary.json'), summary);
    writeText(
      path.join(outputDir, 'report.md'),
      buildMarkdownReport({
        runId,
        cycles,
        rssMode,
        jobs: jobArtifacts,
        promptAudit,
        cycleSnapshots,
        trajectoryAudit,
        questionReport,
        predictionMarketReport,
        newsReport,
        eventSummary: eventArtifacts.summary,
        narrativeSummary: narrativeArtifacts.summary,
        questionDetails: questionArtifacts.summary,
        newsDetails: newsArtifacts.summary,
        trendingSummary: trendingArtifacts.summary,
        promptSurfaceReport,
        stories: {
          count: feedReport.stories.count,
          duplicates: feedReport.stories.duplicates,
        },
        forYou: {
          count: feedReport.forYou.count,
          duplicates: feedReport.forYou.duplicates,
        },
        trendingWidget,
        breakingNewsWidget,
        warnings,
      })
    );

    logger.info(
      'Core world simulation completed',
      {
        outputDir,
        cycles,
        promptCalls: llmCalls.length,
      },
      'CoreWorldSim'
    );
  } catch (error) {
    const trajectoryAudit = await collectTrajectoryAudit(runStartedAt).catch(
      () => getEmptyTrajectoryAudit()
    );
    const copiedPromptLogs: string[] = [];
    const debugPromptDir = path.resolve(process.cwd(), 'debug', 'prompts');
    if (statExists(debugPromptDir)) {
      for (const entry of readdirSync(debugPromptDir)) {
        const fullPath = path.join(debugPromptDir, entry);
        const stats = statSync(fullPath);
        if (stats.mtimeMs < runStartedAt.getTime()) continue;
        const targetPath = path.join(promptsDir, 'markdown', entry);
        writeText(targetPath, readFileSync(fullPath, 'utf8'));
        copiedPromptLogs.push(targetPath);
      }
    }
    const debugPromptCalls = copiedPromptLogs
      .map((filePath) =>
        parsePromptMarkdownLog(filePath, readFileSync(filePath, 'utf8'))
      )
      .filter((call): call is PromptCallArtifact => call !== null);
    const allPromptCalls = mergePromptCalls([
      ...llmCalls,
      ...trajectoryAudit.llmCalls,
      ...debugPromptCalls,
    ]);
    const promptAudit = buildPromptAudit(allPromptCalls);
    const promptSurfaceReport = buildPromptSurfaceReport(allPromptCalls);
    const dagTraceDirs = collectDagTraceDirectories(runStartedAt);
    const warnings = buildWarnings(
      jobArtifacts,
      promptAudit,
      cycleSnapshots,
      trajectoryAudit
    );
    const failure = error instanceof Error ? error : new Error(String(error));

    writeJson(path.join(promptsDir, 'engine-llm-calls.json'), llmCalls);
    writeJson(
      path.join(promptsDir, 'trajectory-llm-calls.json'),
      trajectoryAudit.llmCalls
    );
    writeJson(path.join(promptsDir, 'debug-log-calls.json'), debugPromptCalls);
    writeJson(path.join(promptsDir, 'llm-calls.json'), allPromptCalls);
    writeJson(path.join(promptsDir, 'audit.json'), promptAudit);
    writeJson(
      path.join(outputDir, 'model-io-surfaces.json'),
      promptSurfaceReport
    );
    writeJson(
      path.join(outputDir, 'actions.json'),
      trajectoryAudit.actionSummary
    );
    writeJson(path.join(outputDir, 'trajectories.json'), trajectoryAudit);
    writeJson(path.join(outputDir, 'dag-traces.json'), dagTraceDirs);
    writeJson(path.join(outputDir, 'failure.json'), {
      runId,
      cycles,
      rssMode,
      npcTradeProbability,
      outputDir,
      error: {
        name: failure.name,
        message: failure.message,
        stack: failure.stack,
      },
      jobs: jobArtifacts,
      cycleSnapshots,
      warnings,
    });

    throw failure;
  } finally {
    restoreFetch();
    setLLMCallCallback(priorCallback);
    await closeDatabase();
  }
}

main().catch((error) => {
  logger.error(
    'Core world simulation failed',
    error instanceof Error ? error : new Error(String(error)),
    'CoreWorldSim'
  );
  process.exit(1);
});
