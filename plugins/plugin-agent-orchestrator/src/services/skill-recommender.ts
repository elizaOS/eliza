/**
 * Skill recommender — suggests relevant skills for a task description.
 *
 * Two-pass strategy:
 *  1. Cheap keyword/category match against installed skill metadata. Returns
 *     up to 10 candidate slugs sorted by overlap score.
 *  2. Optional LLM scoring pass over the surviving candidates that returns a
 *     small JSON scores array. Skipped when any keyword
 *     match already scores ≥ 0.9 (no need to spend a model call) or when the
 *     runtime model is unavailable.
 *
 * The output is task-aware ranking: the orchestrator can then write the top
 * N into SKILLS.md and reference them in the spawned agent's initial prompt.
 *
 * @module services/skill-recommender
 */

import { type IAgentRuntime, type Logger, ModelType } from "@elizaos/core";
import { parseJsonObjectResponse } from "./json-model-output.js";
import { withTrajectoryContext } from "./trajectory-context.js";

const LOG_PREFIX = "[SkillRecommender]";
const DEFAULT_MAX = 5;
const KEYWORD_CANDIDATE_LIMIT = 10;
const LLM_SHORT_CIRCUIT_SCORE = 0.9;
const BUILD_MONETIZED_APP_SLUG = "build-monetized-app";
const APP_BUILD_TASK_RE =
  /\b(build|create|make|ship|write|develop|generate)\b(?:(?!\b(?:article|blog|post)\b)[\s\S]){0,120}\b(app|site|page|tool|game|dashboard|chatbot|chat\s*bot|chat\s+app|assistant|companion)\b/i;
// Tokens shorter than this carry no signal — they show up in nearly every
// task description and would inflate every skill's score equally.
const MIN_TOKEN_LENGTH = 4;
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "onto",
  "than",
  "then",
  "will",
  "have",
  "been",
  "your",
  "their",
  "them",
  "they",
  "what",
  "when",
  "where",
  "which",
  "while",
  "about",
  "after",
  "before",
  "should",
  "could",
  "would",
  "make",
  "made",
  "using",
  "use",
  "code",
  "task",
  "agent",
  "agents",
  "please",
]);

export interface RecommendedSkill {
  slug: string;
  name: string;
  /** Score in [0, 1]. 0 = irrelevant, 1 = perfect fit. */
  score: number;
  /** Short, human-readable justification (≤ 1 line). */
  reason: string;
}

export interface RecommendSkillsOptions {
  /** Optional task kind classification (coding | research | planning | ops | mixed). */
  taskKind?: string;
  /** Free-form task description provided by the user or planner. */
  taskText: string;
  /** Optional repo/language context — used to bias toward language-specific skills. */
  repoContext?: {
    language?: string;
    framework?: string;
  };
  /** Maximum number of recommendations to return. Defaults to 5. */
  max?: number;
  /**
   * Force-disable the LLM scoring pass. Defaults to false; when omitted the
   * recommender runs the LLM pass unless a keyword match already scores ≥ 0.9.
   */
  disableLlmPass?: boolean;
}

interface SkillCandidate {
  slug: string;
  name: string;
  description: string;
  /** Optional category from Otto metadata. */
  category?: string;
  /** Optional tags from Otto metadata. */
  tags?: string[];
}

interface LlmScoreEntry {
  slug: string;
  score: number;
  reason: string;
}

/**
 * Minimal subset of AgentSkillsService used for skill discovery. We avoid a
 * type import on the skills plugin so the orchestrator stays loosely coupled.
 */
interface SkillsServiceShape {
  getEligibleSkills: () => Promise<
    Array<{
      slug: string;
      name: string;
      description: string;
      frontmatter?: {
        metadata?: {
          otto?: {
            category?: string;
            tags?: string[];
          };
        };
      };
    }>
  >;
  isSkillEnabled: (slug: string) => boolean;
}

function getLogger(runtime: IAgentRuntime): Logger | Console {
  const candidate = (runtime as unknown as { logger?: Logger }).logger;
  return candidate ?? console;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(
      (token) => token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token),
    );
}

function buildCandidateText(candidate: SkillCandidate): string {
  const tagText = candidate.tags?.join(" ") ?? "";
  const categoryText = candidate.category ?? "";
  return [
    candidate.slug,
    candidate.name,
    candidate.description,
    categoryText,
    tagText,
  ]
    .filter((value) => value.length > 0)
    .join(" ");
}

function scoreCandidateByKeywords(
  candidate: SkillCandidate,
  taskTokens: Set<string>,
): number {
  if (taskTokens.size === 0) return 0;
  const candidateTokens = new Set(tokenize(buildCandidateText(candidate)));
  if (candidateTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of taskTokens) {
    if (candidateTokens.has(token)) intersection += 1;
  }
  if (intersection === 0) return 0;

  // Jaccard-style similarity, slightly biased toward task-token coverage so
  // a skill whose entire description matches one task token still scores.
  const union = candidateTokens.size + taskTokens.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const taskCoverage = intersection / taskTokens.size;
  return Math.min(1, 0.4 * jaccard + 0.6 * taskCoverage);
}

function applyContextBoost(
  base: number,
  candidate: SkillCandidate,
  contextTokens: Set<string>,
): number {
  if (contextTokens.size === 0) return base;
  const candidateTokens = new Set(tokenize(buildCandidateText(candidate)));
  let hits = 0;
  for (const token of contextTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }
  if (hits === 0) return base;
  // Small additive boost — context is hint-quality, not authoritative.
  return Math.min(1, base + Math.min(0.15, hits * 0.05));
}

function buildKeywordReason(
  candidate: SkillCandidate,
  taskTokens: Set<string>,
): string {
  const candidateTokens = new Set(tokenize(buildCandidateText(candidate)));
  const overlap: string[] = [];
  for (const token of taskTokens) {
    if (candidateTokens.has(token)) {
      overlap.push(token);
      if (overlap.length >= 3) break;
    }
  }
  if (overlap.length === 0) {
    return "matched skill description";
  }
  return `matched task tokens: ${overlap.join(", ")}`;
}

function shouldForceCloudAppSkill(taskText: string): boolean {
  return APP_BUILD_TASK_RE.test(taskText);
}

function withForcedCloudAppSkill(
  recommendations: RecommendedSkill[],
  candidates: SkillCandidate[],
  taskText: string,
  max: number,
): RecommendedSkill[] {
  if (!shouldForceCloudAppSkill(taskText)) {
    return recommendations.slice(0, max);
  }

  const candidate = candidates.find(
    (skill) => skill.slug === BUILD_MONETIZED_APP_SLUG,
  );
  if (!candidate) {
    return recommendations.slice(0, max);
  }

  const forced: RecommendedSkill = {
    slug: candidate.slug,
    name: candidate.name,
    score: 1,
    reason:
      "standard Eliza Cloud app build, container deploy, monetization, and domain flow",
  };

  return [
    forced,
    ...recommendations.filter((rec) => rec.slug !== BUILD_MONETIZED_APP_SLUG),
  ].slice(0, max);
}

function buildLlmScoringPrompt(
  taskText: string,
  taskKind: string | undefined,
  candidates: Array<{ slug: string; name: string; description: string }>,
): string {
  const skillBlock = candidates.flatMap((skill, idx) => [
    `  ${idx + 1}:`,
    `    slug: ${skill.slug}`,
    `    name: ${skill.name}`,
    `    description: ${skill.description.replace(/\s+/g, " ").trim()}`,
  ]);
  return [
    "task: score_candidate_skills",
    "taskDescription: |",
    ...taskText.split("\n").map((line) => `  ${line}`),
    `taskKind: ${taskKind ?? "unknown"}`,
    `candidates[${candidates.length}]:`,
    ...skillBlock,
    "scoring:",
    "  irrelevant: 0",
    "  perfectFit: 1",
    "  reasonLength: one short sentence",
    "Return JSON only with this shape:",
    JSON.stringify(
      {
        scores: [
          { slug: "first-skill", score: 0.9, reason: "One short sentence." },
          { slug: "second-skill", score: 0.1, reason: "One short sentence." },
        ],
      },
      null,
      2,
    ),
    "No preamble; no markdown fences.",
  ].join("\n");
}

function normalizeLlmScoreEntry(entry: unknown): LlmScoreEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const slug = typeof record.slug === "string" ? record.slug.trim() : "";
  const rawScore = record.score;
  const score =
    typeof rawScore === "number"
      ? rawScore
      : typeof rawScore === "string"
        ? Number.parseFloat(rawScore)
        : Number.NaN;
  const reason =
    typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : "model-scored relevance";
  if (!slug || !Number.isFinite(score)) return null;
  return {
    slug,
    score: Math.max(0, Math.min(1, score)),
    reason,
  };
}

function parseLlmScores(raw: string): LlmScoreEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const parsedJson = parseJsonObjectResponse<Record<string, unknown>>(trimmed);
  const jsonScores = Array.isArray(parsedJson?.scores)
    ? parsedJson.scores
        .map(normalizeLlmScoreEntry)
        .filter((entry): entry is LlmScoreEntry => Boolean(entry))
    : [];
  if (jsonScores.length > 0) {
    return jsonScores;
  }

  // Strip a leading code fence if the model added one despite instructions.
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const firstBracket = fenceStripped.indexOf("[");
  const lastBracket = fenceStripped.lastIndexOf("]");
  if (firstBracket < 0 || lastBracket <= firstBracket) {
    return [];
  }
  const payload = fenceStripped.slice(firstBracket, lastBracket + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: LlmScoreEntry[] = [];
  for (const entry of parsed) {
    const normalized = normalizeLlmScoreEntry(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Recommend skills relevant to a task.
 *
 * Always returns the top `max` (default 5) candidates ranked by score.
 * Returns an empty array if no skills are eligible/enabled.
 */
export async function recommendSkillsForTask(
  runtime: IAgentRuntime,
  opts: RecommendSkillsOptions,
): Promise<RecommendedSkill[]> {
  const log = getLogger(runtime);
  const max = opts.max ?? DEFAULT_MAX;
  if (max <= 0) return [];

  const service = runtime.getService("AGENT_SKILLS_SERVICE") as unknown as
    | SkillsServiceShape
    | undefined;
  if (!service) {
    log.debug?.(
      `${LOG_PREFIX} AGENT_SKILLS_SERVICE not registered; no recommendations`,
    );
    return [];
  }

  const eligible = await service.getEligibleSkills();
  const enabledEligible = eligible.filter((skill) =>
    service.isSkillEnabled(skill.slug),
  );
  if (enabledEligible.length === 0) {
    return [];
  }

  const candidates: SkillCandidate[] = enabledEligible.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    category: skill.frontmatter?.metadata?.otto?.category,
    tags: skill.frontmatter?.metadata?.otto?.tags,
  }));

  const taskTokens = new Set(tokenize(opts.taskText));
  const contextParts: string[] = [];
  if (opts.repoContext?.language) contextParts.push(opts.repoContext.language);
  if (opts.repoContext?.framework)
    contextParts.push(opts.repoContext.framework);
  const contextTokens = new Set(tokenize(contextParts.join(" ")));

  // Pass 1: keyword fast path.
  const scoredCandidates = candidates
    .map((candidate) => {
      const baseScore = scoreCandidateByKeywords(candidate, taskTokens);
      const score = applyContextBoost(baseScore, candidate, contextTokens);
      return { candidate, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, KEYWORD_CANDIDATE_LIMIT);

  if (scoredCandidates.length === 0) {
    log.debug?.(`${LOG_PREFIX} no keyword overlap for task; skipping LLM pass`);
    return withForcedCloudAppSkill([], candidates, opts.taskText, max);
  }

  const fastPathRecommendations: RecommendedSkill[] = scoredCandidates.map(
    ({ candidate, score }) => ({
      slug: candidate.slug,
      name: candidate.name,
      score,
      reason: buildKeywordReason(candidate, taskTokens),
    }),
  );

  const topFastScore = fastPathRecommendations[0]?.score ?? 0;
  const llmDisabled = opts.disableLlmPass === true;
  const llmShortCircuit = topFastScore >= LLM_SHORT_CIRCUIT_SCORE;

  if (llmDisabled || llmShortCircuit) {
    return withForcedCloudAppSkill(
      fastPathRecommendations,
      candidates,
      opts.taskText,
      max,
    );
  }

  const useModelFn = (runtime as { useModel?: unknown }).useModel;
  if (typeof useModelFn !== "function") {
    return withForcedCloudAppSkill(
      fastPathRecommendations,
      candidates,
      opts.taskText,
      max,
    );
  }

  // Pass 2: LLM scoring over surviving candidates.
  const llmCandidates = scoredCandidates.map(({ candidate }) => ({
    slug: candidate.slug,
    name: candidate.name,
    description: candidate.description,
  }));
  const prompt = buildLlmScoringPrompt(
    opts.taskText,
    opts.taskKind,
    llmCandidates,
  );

  const rawResponse = await withTrajectoryContext(
    runtime,
    { source: "orchestrator", decisionType: "swarm-context-generation" },
    () =>
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.1,
        stream: false,
      }),
  );

  const responseText = typeof rawResponse === "string" ? rawResponse : "";
  const llmScores = parseLlmScores(responseText);
  if (llmScores.length === 0) {
    log.debug?.(
      `${LOG_PREFIX} LLM scoring returned no parseable entries; falling back to keyword pass`,
    );
    return withForcedCloudAppSkill(
      fastPathRecommendations,
      candidates,
      opts.taskText,
      max,
    );
  }

  const llmBySlug = new Map<string, LlmScoreEntry>();
  for (const entry of llmScores) {
    // Drop slugs the model invented that weren't in the candidate list.
    if (!llmCandidates.some((c) => c.slug === entry.slug)) continue;
    const existing = llmBySlug.get(entry.slug);
    // Keep the highest-scoring entry when the model emits duplicates.
    if (!existing || entry.score > existing.score) {
      llmBySlug.set(entry.slug, entry);
    }
  }

  const merged: RecommendedSkill[] = [];
  for (const fast of fastPathRecommendations) {
    const llm = llmBySlug.get(fast.slug);
    if (llm) {
      merged.push({
        slug: fast.slug,
        name: fast.name,
        // Blend the two signals so a strong keyword match can still surface
        // even when the LLM hedges.
        score: Math.max(0, Math.min(1, 0.4 * fast.score + 0.6 * llm.score)),
        reason: llm.reason,
      });
    } else {
      merged.push(fast);
    }
  }

  // Deduplicate (defensive — fast-path is already unique by slug).
  const dedupedBySlug = new Map<string, RecommendedSkill>();
  for (const rec of merged) {
    const existing = dedupedBySlug.get(rec.slug);
    if (!existing || rec.score > existing.score) {
      dedupedBySlug.set(rec.slug, rec);
    }
  }

  const finalRecommendations = Array.from(dedupedBySlug.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return withForcedCloudAppSkill(
    finalRecommendations,
    candidates,
    opts.taskText,
    max,
  );
}
