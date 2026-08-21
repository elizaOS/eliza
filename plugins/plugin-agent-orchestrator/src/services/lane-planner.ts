/**
 * Lane planner for splitting a single orchestrator coding request into
 * independent Smithers runs. The pure planner is intentionally conservative:
 * it only emits multiple lanes when scopes can be made mutually exclusive, and
 * the integration layer falls back to the legacy one-task path on any boundary
 * failure.
 */

import { ElizaError, type IAgentRuntime, ModelType } from "@elizaos/core";
import { staticAcceptanceCriteria } from "./acceptance-criteria.js";
import { parseJsonObjectResponse } from "./json-model-output.js";
import { assertSafeGitRef } from "./repo-input.js";

export const LANE_PLANNER_SETTING = "ELIZA_ORCHESTRATOR_LANE_PLANNER";
const LANE_PLANNER_REFINE_SETTING = "ELIZA_ORCHESTRATOR_LANE_PLANNER_REFINE";
const MAX_LANES = 6;
const DEFAULT_MAX_PARALLEL_LANES = 2;
const MAX_BRANCH_NAME_CHARS = 80;

export interface LaneCollision {
  source: "open-pr" | "sibling";
  id: string;
  paths: string[];
  title?: string;
  url?: string;
}

export interface LaneSpec {
  id: string;
  title: string;
  branchName: string;
  dependencies: string[];
  scopePaths: string[];
  forbiddenPaths: string[];
  collisions: LaneCollision[];
  difficultyTag: string;
  acceptanceCriteria: string[];
  initialPrompt: string;
}

export interface LanePlan {
  waveId: string;
  maxParallel: number;
  lanes: LaneSpec[];
}

export interface ExternalCollision {
  id: string;
  paths: string[];
  title?: string;
  url?: string;
}

export interface LaneCollisionProvider {
  listOpenPrCollisions(input: {
    workdir?: string;
    repo?: string;
  }): Promise<ExternalCollision[]>;
}

type WorkspaceCollisionReader = {
  listOpenPrCollisions?: LaneCollisionProvider["listOpenPrCollisions"];
  listOpenPullRequestChangedFiles?: (input: {
    workdir?: string;
    repo?: string;
  }) => Promise<ExternalCollision[]>;
};

export interface LanePlannerInput {
  task: string;
  tasks?: string[];
  dependencies?: Record<string, string[]>;
  maxParallel?: number;
  title?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  difficultyTag?: string;
  waveId?: string;
}

export interface LaneReadiness {
  ready: boolean;
  blockers: string[];
}

function isEnabledValue(value: unknown): boolean {
  if (typeof value !== "string") return value === true;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readSetting(runtime: IAgentRuntime | undefined, key: string): unknown {
  return runtime?.getSetting?.(key) ?? process.env[key];
}

export function shouldUseLanePlanner(runtime?: IAgentRuntime): boolean {
  return isEnabledValue(readSetting(runtime, LANE_PLANNER_SETTING));
}

export function collisionProviderFromWorkspaceService(
  service: unknown,
): LaneCollisionProvider | undefined {
  if (!service || typeof service !== "object") return undefined;
  const reader = service as WorkspaceCollisionReader;
  if (typeof reader.listOpenPrCollisions === "function") {
    return { listOpenPrCollisions: reader.listOpenPrCollisions.bind(reader) };
  }
  if (typeof reader.listOpenPullRequestChangedFiles === "function") {
    return {
      listOpenPrCollisions: reader.listOpenPullRequestChangedFiles.bind(reader),
    };
  }
  return undefined;
}

function normalizePath(raw: string): string | undefined {
  const value = raw.trim();
  const leading = "'\"`([{<";
  const trailing = "'\"`)]}>.,;:";
  let start = 0;
  let end = value.length;
  while (start < end && leading.includes(value[start] ?? "")) start += 1;
  while (end > start && trailing.includes(value[end - 1] ?? "")) end -= 1;
  const trimmed = value.slice(start, end);
  if (!trimmed || trimmed === "." || trimmed === "/") return undefined;
  if (trimmed.includes("..")) return undefined;
  if (/^(?:https?:|file:)/i.test(trimmed)) return undefined;
  const cleaned = trimmed.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  if (!/[/.]/.test(cleaned)) return undefined;
  return cleaned.replace(/\/$/, "");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** Clone a plan for callers so exported planner data cannot be mutated through
 * object references and later reused as if it were authoritative state. */
export function cloneLanePlan(plan: LanePlan): LanePlan {
  return {
    waveId: plan.waveId,
    maxParallel: plan.maxParallel,
    lanes: plan.lanes.map((lane) => ({
      ...lane,
      dependencies: [...lane.dependencies],
      scopePaths: [...lane.scopePaths],
      forbiddenPaths: [...lane.forbiddenPaths],
      collisions: lane.collisions.map((collision) => ({
        ...collision,
        paths: [...collision.paths],
      })),
      acceptanceCriteria: [...lane.acceptanceCriteria],
    })),
  };
}

export function extractScopePaths(text: string): string[] {
  const matches = text.match(
    /(?:^|[\s(["'`])((?:packages|plugins|src|scripts|docs|tests|test|app|apps|public|server|client|components|lib|services|api|\.\/)[A-Za-z0-9_./-]*|[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)/g,
  );
  if (!matches) return [];
  return uniqueSorted(
    matches
      .map((match) => normalizePath(match.trim()))
      .filter((path): path is string => Boolean(path)),
  );
}

function pathOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const left = a.endsWith("/") ? a : `${a}/`;
  const right = b.endsWith("/") ? b : `${b}/`;
  return left.startsWith(right) || right.startsWith(left);
}

export function scopeSetsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((a) => right.some((b) => pathOverlaps(a, b)));
}

function splitTaskText(task: string): string[] {
  return task
    .split(
      /\n+|(?:^|\s)(?:and|then|also)\s+(?=(?:update|fix|add|build|create|refactor|test|document|wire|implement)\b)/i,
    )
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function difficultyFor(task: string, explicit: string | undefined): string {
  const tag = explicit?.trim().toLowerCase();
  if (tag === "simple" || tag === "moderate" || tag === "hard") return tag;
  if (tag === "standard") return "moderate";
  if (tag === "complex") return "hard";
  const text = task.toLowerCase();
  if (
    /\b(schema|migration|auth|security|cross-package|architecture)\b/.test(text)
  ) {
    return "hard";
  }
  if (/\b(test|docs?|copy|style|lint)\b/.test(text)) return "simple";
  return "moderate";
}

/** Convert a lane title into a bounded git branch ref segment, leaving only the
 * conservative character set accepted by the workspace git-ref validator. */
export function sanitizeLaneBranchName(
  title: string,
  used: ReadonlySet<string> = new Set(),
  prefix = "eliza/lane",
): string {
  const baseSlug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      .replace(/\/{2,}/g, "/")
      .replace(/^[^a-z0-9]+/g, "")
      .replace(/[^a-z0-9]+$/g, "")
      .slice(0, MAX_BRANCH_NAME_CHARS) || "task";
  const cleanPrefix = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[^a-z0-9]+/g, "")
    .replace(/[^a-z0-9]+$/g, "");
  const root = `${cleanPrefix || "eliza/lane"}/${baseSlug}`;
  let candidate = root.slice(0, MAX_BRANCH_NAME_CHARS);
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${root.slice(0, MAX_BRANCH_NAME_CHARS - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return assertSafeGitRef(candidate, "lane branchName");
}

/** Bound planner concurrency to the number of planned lanes, with a conservative
 * default that still allows independent lanes to overlap. */
function normalizeMaxParallel(
  value: number | undefined,
  laneCount: number,
): number {
  if (!Number.isFinite(value) || value === undefined) {
    return Math.min(DEFAULT_MAX_PARALLEL_LANES, Math.max(1, laneCount));
  }
  return Math.max(1, Math.min(Math.floor(value), Math.max(1, laneCount)));
}

/** Normalize user/planner dependency input into stable lane-id edges before
 * graph validation. */
function normalizeDependencies(
  raw: Record<string, string[]> | undefined,
): Map<string, string[]> {
  const normalized = new Map<string, string[]>();
  if (!raw) return normalized;
  for (const [id, deps] of Object.entries(raw)) {
    normalized.set(
      id.trim(),
      uniqueSorted(
        deps.map((dep) => dep.trim()).filter((dep) => dep.length > 0),
      ),
    );
  }
  return normalized;
}

/** Validate lane dependency edges as a graph before any sub-agent launches.
 * Unknown references and cycles are rejected explicitly instead of being read
 * later as "not ready" forever. */
export function validateLaneDependencyGraph(
  laneIds: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): void {
  const known = new Set(laneIds);
  for (const [id, deps] of dependencies) {
    if (!known.has(id)) {
      throw new ElizaError(`Lane dependency references unknown lane ${id}`, {
        code: "LANE_DEPENDENCY_UNKNOWN_LANE",
        context: { laneId: id },
        severity: "ephemeral",
      });
    }
    for (const dep of deps) {
      if (!known.has(dep)) {
        throw new ElizaError(`Lane ${id} depends on unknown lane ${dep}`, {
          code: "LANE_DEPENDENCY_UNKNOWN_REF",
          context: { laneId: id, dependencyId: dep },
          severity: "ephemeral",
        });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new ElizaError(
        `Lane dependency cycle: ${[...path, id].join(" -> ")}`,
        {
          code: "LANE_DEPENDENCY_CYCLE",
          context: { laneId: id, path: [...path, id] },
          severity: "ephemeral",
        },
      );
    }
    visiting.add(id);
    for (const dep of dependencies.get(id) ?? []) visit(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of laneIds) visit(id, []);
}

/** Semantic readiness for a lane: dependencies must be completed, while
 * externally blocked or failed dependencies surface as named blockers instead
 * of being inferred from a coarse task status string. */
export function laneReadiness(
  lane: Pick<LaneSpec, "id" | "dependencies">,
  completed: ReadonlySet<string>,
  failed: ReadonlySet<string> = new Set(),
  blocked: ReadonlyMap<string, string> = new Map(),
): LaneReadiness {
  const blockers: string[] = [];
  for (const dep of lane.dependencies) {
    const blockReason = blocked.get(dep);
    if (blockReason) blockers.push(`${dep}: ${blockReason}`);
    else if (failed.has(dep)) blockers.push(`${dep}: failed`);
    else if (!completed.has(dep)) blockers.push(`${dep}: dependency pending`);
  }
  return { ready: blockers.length === 0, blockers };
}

function lanePrompt(args: {
  parentTask: string;
  laneTask: string;
  scopes: string[];
  forbidden: string[];
  collisions: LaneCollision[];
  criteria: string[];
  branchName: string;
}): string {
  const lines = [
    args.laneTask,
    "",
    `Suggested branch: ${args.branchName}`,
    "",
    "Lane scope:",
    ...args.scopes.map((path) => `- ${path}`),
    "",
    "Do not edit outside this lane's scope. Forbidden sibling paths:",
    ...(args.forbidden.length > 0
      ? args.forbidden.map((path) => `- ${path}`)
      : ["- none"]),
  ];
  if (args.collisions.length > 0) {
    lines.push(
      "",
      "Potential open PR or sibling lane collisions to inspect before editing:",
      ...args.collisions.map(
        (collision) =>
          `- ${collision.id}: ${collision.paths.join(", ")}${
            collision.url ? ` (${collision.url})` : ""
          }`,
      ),
    );
  }
  if (args.criteria.length > 0) {
    lines.push(
      "",
      "Acceptance criteria seed:",
      ...args.criteria.map((criterion) => `- ${criterion}`),
    );
  }
  lines.push("", "Parent request:", args.parentTask);
  return lines.join("\n");
}

function buildLane(
  input: LanePlannerInput,
  laneTask: string,
  index: number,
  siblingScopes: readonly string[][],
  externalCollisions: readonly ExternalCollision[],
  dependencies: readonly string[],
  branchName: string,
): LaneSpec {
  const scopes = extractScopePaths(laneTask);
  const forbidden = uniqueSorted(
    siblingScopes.filter((_, siblingIndex) => siblingIndex !== index).flat(),
  );
  const collisions: LaneCollision[] = [
    ...externalCollisions
      .filter((collision) => scopeSetsOverlap(scopes, collision.paths))
      .map((collision) => ({
        source: "open-pr" as const,
        id: collision.id,
        paths: uniqueSorted(collision.paths),
        ...(collision.title ? { title: collision.title } : {}),
        ...(collision.url ? { url: collision.url } : {}),
      })),
    ...forbidden.map((path) => ({
      source: "sibling" as const,
      id: `sibling-${index + 1}`,
      paths: [path],
    })),
  ];
  const criteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : staticAcceptanceCriteria(laneTask);
  return {
    id: `lane-${index + 1}`,
    title: (input.title ?? laneTask).slice(0, 80),
    branchName,
    dependencies: [...dependencies],
    scopePaths: scopes,
    forbiddenPaths: forbidden,
    collisions,
    difficultyTag: difficultyFor(laneTask, input.difficultyTag),
    acceptanceCriteria: criteria,
    initialPrompt: lanePrompt({
      parentTask: input.task,
      laneTask,
      scopes,
      forbidden,
      collisions,
      criteria,
      branchName,
    }),
  };
}

export function createDeterministicLanePlan(
  input: LanePlannerInput,
  externalCollisions: readonly ExternalCollision[] = [],
): LanePlan {
  const requestedTasks = input.tasks?.length
    ? input.tasks
    : splitTaskText(input.task);
  const candidates = requestedTasks
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
  if (candidates.length > MAX_LANES) {
    throw new Error(
      `Lane planner accepts at most ${MAX_LANES} lanes; received ${candidates.length}`,
    );
  }
  const tasks = candidates.length > 0 ? candidates : [input.task];
  const scopeSets = tasks.map((task) => extractScopePaths(task));
  const laneIds = tasks.map((_, index) => `lane-${index + 1}`);
  const dependencies = normalizeDependencies(input.dependencies);
  validateLaneDependencyGraph(laneIds, dependencies);
  if (tasks.length > 1) {
    if (scopeSets.some((scopes) => scopes.length === 0)) {
      throw new Error(
        "Cannot split lanes without explicit non-overlapping scopes",
      );
    }
    for (let i = 0; i < scopeSets.length; i += 1) {
      for (let j = i + 1; j < scopeSets.length; j += 1) {
        if (scopeSetsOverlap(scopeSets[i], scopeSets[j])) {
          throw new Error("Lane scopes overlap");
        }
      }
    }
  }
  const usedBranches = new Set<string>();
  return {
    waveId: input.waveId ?? "wave",
    maxParallel: normalizeMaxParallel(input.maxParallel, tasks.length),
    lanes: tasks.map((task, index) => {
      const branchName = sanitizeLaneBranchName(
        input.title ?? task,
        usedBranches,
      );
      usedBranches.add(branchName);
      return buildLane(
        input,
        task,
        index,
        scopeSets,
        externalCollisions,
        dependencies.get(laneIds[index] ?? "") ?? [],
        branchName,
      );
    }),
  };
}

function refinePrompt(plan: LanePlan): string {
  return [
    "Refine these coding-agent lanes without changing scopePaths or lane count.",
    'Return JSON only: {"lanes":[{"id":"lane-1","title":"...","initialPrompt":"...","acceptanceCriteria":["..."]}]}',
    JSON.stringify(plan),
  ].join("\n\n");
}

function applyRefinement(plan: LanePlan, raw: string): LanePlan {
  const parsed = parseJsonObjectResponse<{ lanes?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.lanes)) return plan;
  const byId = new Map<string, Record<string, unknown>>();
  for (const lane of parsed.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const record = lane as Record<string, unknown>;
    if (typeof record.id === "string") byId.set(record.id, record);
  }
  return cloneLanePlan({
    ...plan,
    lanes: plan.lanes.map((lane) => {
      const refined = byId.get(lane.id);
      if (!refined) return lane;
      const criteria = Array.isArray(refined.acceptanceCriteria)
        ? refined.acceptanceCriteria.filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          )
        : lane.acceptanceCriteria;
      return {
        ...lane,
        title:
          typeof refined.title === "string" && refined.title.trim()
            ? refined.title.trim().slice(0, 80)
            : lane.title,
        initialPrompt:
          typeof refined.initialPrompt === "string" &&
          refined.initialPrompt.trim()
            ? refined.initialPrompt.trim()
            : lane.initialPrompt,
        acceptanceCriteria:
          criteria.length > 0 ? criteria : lane.acceptanceCriteria,
      };
    }),
  });
}

export class LanePlannerService {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly collisionProvider?: LaneCollisionProvider,
  ) {}

  async plan(
    input: LanePlannerInput & { workdir?: string; repo?: string },
  ): Promise<LanePlan> {
    let collisions: ExternalCollision[] = [];
    if (this.collisionProvider) {
      try {
        collisions = await this.collisionProvider.listOpenPrCollisions({
          workdir: input.workdir,
          repo: input.repo,
        });
      } catch (error) {
        // error-policy:J4 optional collision annotation degrades to no external
        // collisions; lane execution still carries sibling forbidden paths. The
        // remote input failure is still reported as an ElizaError at the
        // boundary so operators can observe the degraded planner context.
        this.runtime.reportError?.(
          "LanePlannerService.collisionProvider",
          new ElizaError("Lane collision provider failed", {
            code: "LANE_COLLISION_PROVIDER_FAILED",
            context: {
              workdir: input.workdir,
              repo: input.repo,
            },
            cause: error,
            severity: "ephemeral",
          }),
        );
        collisions = [];
      }
    }
    const deterministic = createDeterministicLanePlan(input, collisions);
    if (
      !isEnabledValue(readSetting(this.runtime, LANE_PLANNER_REFINE_SETTING))
    ) {
      return cloneLanePlan(deterministic);
    }
    try {
      if (typeof this.runtime.useModel !== "function") return deterministic;
      const result = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: refinePrompt(deterministic),
        stopSequences: [],
      });
      return cloneLanePlan(
        applyRefinement(deterministic, String(result ?? "")),
      );
    } catch {
      // error-policy:J4 optional TEXT_SMALL refinement is advisory only; the
      // deterministic plan is the designed fallback.
      return cloneLanePlan(deterministic);
    }
  }
}
