/**
 * Phase 5 — narrate: LLM post-mortem for drift inflections.
 *
 * One LLM call per drift, capped by `budget`. When the runtime exposes no
 * `useModel`, or when the call fails or returns unparseable JSON, we fall
 * back to a deterministic narrative derived from risk flags + classification.
 * The fallback is honest about its origin (`narrative` says "(no LLM)").
 *
 * All commit text + diff snippets pass through {@link scrubSecrets} before
 * leaving the process.
 */

import { ModelType, type IAgentRuntime, logger } from "@elizaos/core";
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
  ctx: NarrateContext,
): Promise<{ rotCauses: RotCause[]; llmCalls: number }> {
  const rotCauses: RotCause[] = [];
  let llmCalls = 0;
  const indexBySha = new Map<string, number>(
    ctx.timeline.map((point, idx) => [point.sha, idx]),
  );
  const useModelFn = (runtime as UseModelLike | null)?.useModel;
  const canCallLlm = typeof useModelFn === "function";
  const budget = Math.max(0, Math.floor(ctx.budget));

  for (const drift of ctx.drifts) {
    if (rotCauses.length >= budget) break;
    const idx = indexBySha.get(drift.sha);
    if (idx === undefined) continue;
    const point = ctx.timeline[idx];
    if (!point) continue;
    const before = ctx.timeline.slice(Math.max(0, idx - 3), idx);
    const after = ctx.timeline.slice(idx + 1, idx + 4);
    const diff = scrubSecrets(
      fetchDiffSnippet(ctx.repoRoot, point.sha, ctx.surfacePath, 8 * 1024),
    );
    if (canCallLlm && useModelFn) {
      try {
        const result = await callModel(useModelFn, buildPrompt(ctx.surfacePath, point, before, after, diff));
        llmCalls += 1;
        const parsed = parseRotCause(result);
        if (parsed) {
          rotCauses.push({
            shaRange: rangeFor(point, after),
            category: parsed.category,
            evidence: evidenceShas(point, before, after),
            narrative: parsed.narrative,
          });
          continue;
        }
      } catch (err) {
        logger.warn(`${LOG_PREFIX} model call failed for ${point.sha}: ${(err as Error).message}`);
      }
    }
    rotCauses.push(fallbackRotCause(point, before, after));
  }

  return { rotCauses, llmCalls };
}

function rangeFor(point: CommitHealthPoint, after: CommitHealthPoint[]): [string, string] {
  const last = after.length > 0 ? after[after.length - 1] : null;
  return [point.sha, last ? last.sha : point.sha];
}

function evidenceShas(
  point: CommitHealthPoint,
  before: CommitHealthPoint[],
  after: CommitHealthPoint[],
): string[] {
  return [...before.map((p) => p.sha), point.sha, ...after.map((p) => p.sha)];
}

function buildPrompt(
  surface: string,
  point: CommitHealthPoint,
  before: CommitHealthPoint[],
  after: CommitHealthPoint[],
  diff: string,
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
  prompt: string,
): Promise<string> {
  const result = await useModelFn(ModelType.TEXT_SMALL, {
    prompt,
    temperature: 0.2,
    stream: false,
  });
  if (typeof result !== "string") return "";
  return result;
}

function parseRotCause(
  raw: string,
): { category: RotCategory; narrative: string } | null {
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

function fallbackRotCause(
  point: CommitHealthPoint,
  before: CommitHealthPoint[],
  after: CommitHealthPoint[],
): RotCause {
  const category = categoryFromFlags(point);
  const churn = point.churn;
  const flagSummary = point.riskFlags.length > 0 ? point.riskFlags.join(", ") : "no specific flags";
  const narrative =
    `Heuristic match (no LLM). Commit ${point.sha.slice(0, 7)} (${point.type}) ` +
    `touched ${point.files.length} files with ${churn} lines of churn and triggered ${flagSummary}. ` +
    `Following ${after.length} commits drifted toward lower health, suggesting ${category}.`;
  return {
    shaRange: rangeFor(point, after),
    category,
    evidence: evidenceShas(point, before, after),
    narrative,
  };
}

function categoryFromFlags(point: CommitHealthPoint): RotCategory {
  if (point.riskFlags.includes("later-reverted")) return "revert-cycle";
  if (point.type === "merge" && point.churn >= 200) return "bad-merge";
  if (point.riskFlags.includes("wip-message")) return "rushed-fix";
  if (point.riskFlags.includes("wide-blast")) return "scope-creep";
  if (point.riskFlags.includes("large-churn")) return "churn-spiral";
  return "other";
}
