/**
 * Lane planner for splitting a single orchestrator coding request into
 * independent Smithers runs. The pure planner is intentionally conservative:
 * it only emits multiple lanes when scopes can be made mutually exclusive, and
 * the integration layer falls back to the legacy one-task path on any boundary
 * failure.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { staticAcceptanceCriteria } from "./acceptance-criteria.js";
import { parseJsonObjectResponse } from "./json-model-output.js";

export const LANE_PLANNER_SETTING = "ELIZA_ORCHESTRATOR_LANE_PLANNER";
const LANE_PLANNER_REFINE_SETTING = "ELIZA_ORCHESTRATOR_LANE_PLANNER_REFINE";
const MAX_LANES = 6;

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
  scopePaths: string[];
  forbiddenPaths: string[];
  collisions: LaneCollision[];
  difficultyTag: string;
  acceptanceCriteria: string[];
  initialPrompt: string;
}

export interface LanePlan {
  waveId: string;
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
  title?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  difficultyTag?: string;
  waveId?: string;
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
  const trimmed = raw
    .trim()
    .replace(/^['"`([{<]+/, "")
    .replace(/['"`)\]}>.,;:]+$/, "");
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

function lanePrompt(args: {
  parentTask: string;
  laneTask: string;
  scopes: string[];
  forbidden: string[];
  collisions: LaneCollision[];
  criteria: string[];
}): string {
  const lines = [
    args.laneTask,
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
  return {
    waveId: input.waveId ?? "wave",
    lanes: tasks.map((task, index) =>
      buildLane(input, task, index, scopeSets, externalCollisions),
    ),
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
  return {
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
  };
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
      } catch {
        // error-policy:J4 optional collision annotation degrades to no external
        // collisions; lane execution still carries sibling forbidden paths.
        collisions = [];
      }
    }
    const deterministic = createDeterministicLanePlan(input, collisions);
    if (
      !isEnabledValue(readSetting(this.runtime, LANE_PLANNER_REFINE_SETTING))
    ) {
      return deterministic;
    }
    try {
      if (typeof this.runtime.useModel !== "function") return deterministic;
      const result = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: refinePrompt(deterministic),
        stopSequences: [],
      });
      return applyRefinement(deterministic, String(result ?? ""));
    } catch {
      // error-policy:J4 optional TEXT_SMALL refinement is advisory only; the
      // deterministic plan is the designed fallback.
      return deterministic;
    }
  }
}
