/**
 * Step 5 — narrate: LLM post-mortem for drift inflections.
 *
 * One LLM call per drift, capped by `budget`.
 *
 * All commit text + diff snippets pass through {@link scrubSecrets} before
 * leaving the process.
 */

import { type IAgentRuntime, logger, ModelType } from "@elizaos/core";
import { scrubSecrets } from "../secret-scrubber.ts";
import type { CommitHealthPoint, InflectionPoint, RotCategory, RotCause } from "../types.ts";
import { fetchDiffSnippet } from "./scan.ts";

const LOG_PREFIX = "[GitPathology/narrate]";

const VALID_CATEGORIES: ReadonlySet<RotCategory> = new Set([
  "rushed-fix",
  "scope-creep",
  "bad-merge",
  "revert-cycle",
  "churn-spiral",
  "other",
]);

export interface NarrateContext {
  surfacePath: string;
  repoRoot: string;
  timeline: CommitHealthPoint[];
  drifts: InflectionPoint[];
  budget: number;
}

interface UseModelLike {
  useModel?: (modelType: string, options: Record<string, unknown>) => Promise<unknown>;
}

export async function narrate(
  runtime: IAgentRuntime | null,
  ctx: NarrateContext
): Promise<{ rotCauses: RotCause[]; llmCalls: number }> {
  const rotCauses: RotCause[] = [];
  let llmCalls = 0;
  const indexBySha = new Map<string, number>(ctx.timeline.map((point, idx) => [point.sha, idx]));
  const useModelFn = (runtime as UseModelLike | null)?.useModel;
  const budget = Math.max(0, Math.floor(ctx.budget));

  for (const drift of ctx.drifts) {
    const idx = indexBySha.get(drift.sha);
    if (idx === undefined) continue;
    const point = ctx.timeline[idx];
    if (!point) continue;
    const before = ctx.timeline.slice(Math.max(0, idx - 3), idx);
    const after = ctx.timeline.slice(idx + 1, idx + 4);
    const fallback = deterministicRotCause(point, before, after, drift);

    if (typeof useModelFn === "function" && llmCalls < budget) {
      const diff = scrubSecrets(
        fetchDiffSnippet(ctx.repoRoot, point.sha, ctx.surfacePath, 8 * 1024)
      );
      try {
        const result = await callModel(
          useModelFn,
          buildPrompt(ctx.surfacePath, point, before, after, diff)
        );
        llmCalls += 1;
        const parsed = parseRotCause(result);
        if (parsed) {
          rotCauses.push({
            ...fallback,
            category: parsed.category,
            narrative: parsed.narrative,
          });
          continue;
        }
        logger.warn(`${LOG_PREFIX} model returned unparseable rot cause for ${point.sha}`);
      } catch (err) {
        logger.warn(`${LOG_PREFIX} model call failed for ${point.sha}: ${(err as Error).message}`);
      }
    } else if (typeof useModelFn !== "function" && llmCalls === 0 && rotCauses.length === 0) {
      logger.warn(`${LOG_PREFIX} runtime has no useModel; using deterministic rot-cause fallback`);
    }

    rotCauses.push(fallback);
  }

  return { rotCauses, llmCalls };
}

function deterministicRotCause(
  point: CommitHealthPoint,
  before: CommitHealthPoint[],
  after: CommitHealthPoint[],
  drift: InflectionPoint
): RotCause {
  const category = categorizeDeterministically(point, before, after);
  const flags = point.riskFlags.length > 0 ? point.riskFlags.join(", ") : "no explicit flags";
  const previousScore = before.at(-1)?.score;
  const nextScore = after.at(-1)?.score;
  const narrative = [
    `${point.sha.slice(0, 7)} marks a ${Math.abs(drift.delta).toFixed(2)}-point quality drop on this surface, with ${point.churn} churn across ${point.files.length} file(s) and ${flags}.`,
    `The surrounding window moves from ${typeof previousScore === "number" ? previousScore.toFixed(2) : "no prior score"} to ${point.score.toFixed(2)}${typeof nextScore === "number" ? ` and then ${nextScore.toFixed(2)}` : ""}, so this commit is a deterministic inflection even without LLM narration.`,
  ].join(" ");
  return {
    shaRange: rangeFor(point, after),
    category,
    evidence: evidenceShas(point, before, after),
    narrative,
  };
}

function categorizeDeterministically(
  point: CommitHealthPoint,
  before: CommitHealthPoint[],
  after: CommitHealthPoint[]
): RotCategory {
  const subject = point.subject.toLowerCase();
  const flags = new Set(point.riskFlags.map((flag) => flag.toLowerCase()));
  if (point.type === "revert" || subject.includes("revert")) return "revert-cycle";
  if (point.type === "merge" || flags.has("merge")) return "bad-merge";
  if (flags.has("hotfix") || subject.includes("hotfix") || subject.includes("quick fix")) {
    return "rushed-fix";
  }
  const neighboringChurn = [...before, ...after].reduce((sum, commit) => sum + commit.churn, 0);
  if (point.churn > 500 || neighboringChurn > 1000) return "churn-spiral";
  if (point.files.length > 8 || flags.has("large-change")) return "scope-creep";
  return "other";
}

function rangeFor(point: CommitHealthPoint, after: CommitHealthPoint[]): [string, string] {
  const last = after.length > 0 ? after[after.length - 1] : null;
  return [point.sha, last ? last.sha : point.sha];
}

function evidenceShas(
  point: CommitHealthPoint,
  before: CommitHealthPoint[],
  after: CommitHealthPoint[]
): string[] {
  return [...before.map((p) => p.sha), point.sha, ...after.map((p) => p.sha)];
}

function buildPrompt(
  surface: string,
  point: CommitHealthPoint,
  before: CommitHealthPoint[],
  after: CommitHealthPoint[],
  diff: string
): string {
  const fmt = (p: CommitHealthPoint) =>
    `  ${p.sha.slice(0, 7)} [${p.type}] (${p.churn} churn, score ${p.score.toFixed(2)}) ${scrubSecrets(p.subject)}`;
  return [
    "You are diagnosing the start of a code-quality decline in a git repository surface.",
    "",
    `Surface: ${surface}`,
    `Drift commit: ${point.sha.slice(0, 7)} by ${point.author} on ${point.date.slice(0, 10)}`,
    `  Subject: ${scrubSecrets(point.subject)}`,
    `  Type: ${point.type}  Risk flags: ${point.riskFlags.join(", ") || "(none)"}  Churn: ${point.churn}  Files: ${point.files.length}`,
    `  Score: ${point.score.toFixed(2)}  Delta: ${point.delta.toFixed(2)}`,
    "",
    "Commits immediately before (oldest first):",
    before.length === 0 ? "  (none in window)" : before.map(fmt).join("\n"),
    "",
    "Commits immediately after (oldest first):",
    after.length === 0 ? "  (none in window)" : after.map(fmt).join("\n"),
    "",
    "Diff snippet of the drift commit (secrets redacted):",
    diff || "  (no diff available)",
    "",
    "Classify the most likely cause from this set:",
    '  "rushed-fix", "scope-creep", "bad-merge", "revert-cycle", "churn-spiral", "other"',
    "",
    "Then write a 2-3 sentence narrative explaining WHY this commit looks like the start of decline. Reference specific evidence from the commits or diff above.",
    "",
    'Respond with exactly one JSON object: {"category": "<one of the above>", "narrative": "<2-3 sentences>"}',
  ].join("\n");
}

async function callModel(
  useModelFn: NonNullable<UseModelLike["useModel"]>,
  prompt: string
): Promise<string> {
  const result = await useModelFn(ModelType.TEXT_SMALL, {
    prompt,
    temperature: 0.2,
    stream: false,
  });
  if (typeof result !== "string") return "";
  return result;
}

function parseRotCause(raw: string): { category: RotCategory; narrative: string } | null {
  if (!raw) return null;
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  const slice = raw.slice(jsonStart, jsonEnd + 1);
  try {
    const obj = JSON.parse(slice) as { category?: unknown; narrative?: unknown };
    const category = typeof obj.category === "string" ? obj.category : "other";
    const narrative = typeof obj.narrative === "string" ? obj.narrative.trim() : "";
    if (!narrative) return null;
    const safeCategory = VALID_CATEGORIES.has(category as RotCategory)
      ? (category as RotCategory)
      : "other";
    return { category: safeCategory, narrative };
  } catch {
    return null;
  }
}
