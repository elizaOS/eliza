/**
 * `PRIORITIZE` umbrella action — LLM-ranked importance × urgency.
 *
 * Subactions:
 *   - `rank_todos`     — todo items in the owner's life domain
 *   - `rank_threads`   — open inbox / messaging threads
 *   - `rank_decisions` — pending approval queue decisions
 *
 * Loads items via the relevant loader hook, then calls
 * `runtime.useModel(ModelType.TEXT_LARGE)` once with a structured prompt that
 * asks for a JSON ranking by urgency × importance, with a short reasoning
 * string per item.
 *
 * Owner-only.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryPurpose } from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";

const ACTION_NAME = "PRIORITIZE";

const SUBACTIONS = ["rank_todos", "rank_threads", "rank_decisions"] as const;

type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "PRIORITIZE",
  "RANK_TODAY",
  "WHAT_MATTERS_MOST",
  "PRIORITIZE_TODAY",
];

type Subject = "todos" | "threads" | "decisions";

const SUBJECT_TO_SUBACTION: Readonly<Record<Subject, Subaction>> = {
  todos: "rank_todos",
  threads: "rank_threads",
  decisions: "rank_decisions",
};

const SUBACTION_TO_SUBJECT: Readonly<Record<Subaction, Subject>> = {
  rank_todos: "todos",
  rank_threads: "threads",
  rank_decisions: "decisions",
};

interface PrioritizeActionParameters {
  subaction?: Subaction | string;
  action?: Subaction | string;
  op?: Subaction | string;
  subject?: Subject | string;
  topN?: number;
  criteria?: string;
}

export interface PrioritizeRankableItem {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly dueAt?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface PrioritizeRankedItem extends PrioritizeRankableItem {
  readonly rank: number;
  readonly score: number;
  readonly reasoning: string;
}

export interface PrioritizeLoaderArgs {
  runtime: IAgentRuntime;
  message: Memory;
}

/**
 * Per-subject loader hooks. Defaults read the production stores and degrade to
 * empty lists when an optional store is not installed.
 */
export interface PrioritizeLoaders {
  loadTodos: (
    args: PrioritizeLoaderArgs,
  ) => Promise<readonly PrioritizeRankableItem[]>;
  loadThreads: (
    args: PrioritizeLoaderArgs,
  ) => Promise<readonly PrioritizeRankableItem[]>;
  loadDecisions: (
    args: PrioritizeLoaderArgs,
  ) => Promise<readonly PrioritizeRankableItem[]>;
}

const MAX_PRIORITIZE_SOURCE_ITEMS = 50;
const TODOS_SERVICE_TYPE = "todos";

type PrioritizeTodoStatus = "pending" | "in_progress";

interface PrioritizeTodoRecord {
  readonly id?: unknown;
  readonly content?: unknown;
  readonly activeForm?: unknown;
  readonly status?: unknown;
  readonly metadata?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

interface PrioritizeTodosService {
  list(filter: {
    entityId: string;
    agentId?: string;
    status?: PrioritizeTodoStatus[];
    includeCompleted?: boolean;
    limit?: number;
  }): Promise<readonly PrioritizeTodoRecord[]>;
}

interface ApprovalRequestLike {
  readonly id: string;
  readonly createdAt: Date;
  readonly state: string;
  readonly requestedBy: string;
  readonly subjectUserId: string;
  readonly action: string;
  readonly payload: unknown;
  readonly channel: string;
  readonly reason: string;
  readonly expiresAt: Date;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function ownerEntityIdFromMessage(message: Memory): string | null {
  return nonEmptyString(message.entityId);
}

function runtimeAgentId(runtime: IAgentRuntime): string | null {
  return nonEmptyString(runtime.agentId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  return nonEmptyString(record[key]);
}

function readFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = readString(record, key);
    if (value) return value;
  }
  return null;
}

function isoish(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function metadata(
  entries: readonly (readonly [string, unknown])[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRuntimeService(
  runtime: IAgentRuntime,
  serviceName: string,
): unknown {
  const getService = (runtime as { getService?: (name: string) => unknown })
    .getService;
  if (typeof getService !== "function") return null;
  return getService.call(runtime, serviceName);
}

function isTodosService(value: unknown): value is PrioritizeTodosService {
  return isRecord(value) && typeof value.list === "function";
}

function mapTodoToRankable(
  todo: PrioritizeTodoRecord,
): PrioritizeRankableItem | null {
  const id = nonEmptyString(todo.id);
  const content = nonEmptyString(todo.content);
  const title = nonEmptyString(todo.activeForm) ?? content;
  if (!id || !title) return null;
  const todoMetadata = isRecord(todo.metadata) ? todo.metadata : {};
  const dueAt = readFirstString(todoMetadata, [
    "dueAt",
    "deadline",
    "scheduledFor",
    "scheduledAt",
  ]);
  return {
    id,
    title,
    ...(content && content !== title ? { summary: content } : {}),
    ...(dueAt ? { dueAt } : {}),
    metadata: metadata([
      ["source", "todos"],
      ["status", nonEmptyString(todo.status)],
      ["createdAt", isoish(todo.createdAt)],
      ["updatedAt", isoish(todo.updatedAt)],
      ["priority", todoMetadata.priority],
    ]),
  };
}

async function loadTodosFromRuntime({
  runtime,
  message,
}: PrioritizeLoaderArgs): Promise<readonly PrioritizeRankableItem[]> {
  const entityId = ownerEntityIdFromMessage(message);
  const agentId = runtimeAgentId(runtime);
  if (!entityId || !agentId) return [];
  const service = getRuntimeService(runtime, TODOS_SERVICE_TYPE);
  if (!isTodosService(service)) return [];
  try {
    const todos = await service.list({
      entityId,
      agentId,
      status: ["pending", "in_progress"],
      includeCompleted: false,
      limit: MAX_PRIORITIZE_SOURCE_ITEMS,
    });
    return todos
      .slice(0, MAX_PRIORITIZE_SOURCE_ITEMS)
      .map(mapTodoToRankable)
      .filter((item): item is PrioritizeRankableItem => item !== null);
  } catch (error) {
    logger.warn(`[PRIORITIZE] rank_todos load failed: ${errorDetail(error)}`);
    return [];
  }
}

async function loadThreadsFromRuntime({
  runtime,
  message,
}: PrioritizeLoaderArgs): Promise<readonly PrioritizeRankableItem[]> {
  const ownerEntityId = ownerEntityIdFromMessage(message);
  if (!ownerEntityId) return [];
  try {
    const { createWorkThreadStore } = await import(
      "../lifeops/work-threads/index.js"
    );
    const threads = await createWorkThreadStore(runtime).list({
      statuses: ["active", "waiting", "paused"],
      ownerEntityId,
      limit: MAX_PRIORITIZE_SOURCE_ITEMS,
    });
    return threads.slice(0, MAX_PRIORITIZE_SOURCE_ITEMS).map((thread) => ({
      id: thread.id,
      title: thread.title,
      summary: thread.currentPlanSummary ?? thread.summary,
      metadata: metadata([
        ["source", "work_threads"],
        ["status", thread.status],
        ["connector", thread.primarySourceRef.connector],
        ["channelName", thread.primarySourceRef.channelName],
        ["lastActivityAt", thread.lastActivityAt],
        ["currentScheduledTaskId", thread.currentScheduledTaskId],
        ["approvalId", thread.approvalId],
      ]),
    }));
  } catch (error) {
    logger.warn(`[PRIORITIZE] rank_threads load failed: ${errorDetail(error)}`);
    return [];
  }
}

function approvalPayloadTitle(request: ApprovalRequestLike): string {
  const payload = isRecord(request.payload) ? request.payload : {};
  switch (request.action) {
    case "send_message":
      return `Send message to ${readString(payload, "recipient") ?? "recipient"}`;
    case "send_email":
      return `Send email: ${readString(payload, "subject") ?? "untitled"}`;
    case "schedule_event":
      return `Schedule event: ${readString(payload, "title") ?? "untitled"}`;
    case "modify_event":
      return `Modify calendar event ${readString(payload, "eventId") ?? request.id}`;
    case "cancel_event":
      return `Cancel calendar event ${readString(payload, "eventId") ?? request.id}`;
    case "book_travel":
      return `Book ${readString(payload, "kind") ?? "travel"} via ${readString(payload, "provider") ?? "provider"}`;
    case "make_call":
      return `Make call to ${readString(payload, "to") ?? "recipient"}`;
    case "sign_document":
      return `Sign document: ${readString(payload, "documentName") ?? "document"}`;
    case "execute_workflow":
      return `Execute workflow ${readString(payload, "workflowId") ?? request.id}`;
    case "spend_money":
      return `Spend money with ${readString(payload, "vendor") ?? "vendor"}`;
    default:
      return `Approve ${request.action}`;
  }
}

async function loadDecisionsFromRuntime({
  runtime,
  message,
}: PrioritizeLoaderArgs): Promise<readonly PrioritizeRankableItem[]> {
  const subjectUserId = ownerEntityIdFromMessage(message);
  const agentId = runtimeAgentId(runtime);
  if (!subjectUserId || !agentId) return [];
  try {
    const { createApprovalQueue } = await import(
      "../lifeops/approval-queue.js"
    );
    const requests = await createApprovalQueue(runtime, { agentId }).list({
      subjectUserId,
      state: "pending",
      action: null,
      limit: MAX_PRIORITIZE_SOURCE_ITEMS,
    });
    return requests
      .slice(0, MAX_PRIORITIZE_SOURCE_ITEMS)
      .map((request): PrioritizeRankableItem => {
        const approval = request as ApprovalRequestLike;
        return {
          id: approval.id,
          title: approvalPayloadTitle(approval),
          summary: approval.reason,
          dueAt: approval.expiresAt.toISOString(),
          metadata: metadata([
            ["source", "approval_queue"],
            ["action", approval.action],
            ["channel", approval.channel],
            ["state", approval.state],
            ["requestedBy", approval.requestedBy],
            ["createdAt", approval.createdAt.toISOString()],
            ["expiresAt", approval.expiresAt.toISOString()],
          ]),
        };
      });
  } catch (error) {
    logger.warn(
      `[PRIORITIZE] rank_decisions load failed: ${errorDetail(error)}`,
    );
    return [];
  }
}

const defaultLoaders: PrioritizeLoaders = {
  loadTodos: loadTodosFromRuntime,
  loadThreads: loadThreadsFromRuntime,
  loadDecisions: loadDecisionsFromRuntime,
};

let activeLoaders: PrioritizeLoaders = defaultLoaders;

export function setPrioritizeLoaders(next: Partial<PrioritizeLoaders>): void {
  activeLoaders = { ...activeLoaders, ...next };
}

export function __resetPrioritizeLoadersForTests(): void {
  activeLoaders = defaultLoaders;
}

function getParams(
  options: HandlerOptions | undefined,
): PrioritizeActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as PrioritizeActionParameters;
  }
  return {};
}

function normalizeSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(lower)
    ? (lower as Subaction)
    : null;
}

function normalizeSubject(value: unknown): Subject | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (lower === "todos" || lower === "threads" || lower === "decisions") {
    return lower;
  }
  return null;
}

function resolveSubaction(
  params: PrioritizeActionParameters,
): Subaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op) ??
    (() => {
      const subject = normalizeSubject(params.subject);
      return subject ? SUBJECT_TO_SUBACTION[subject] : null;
    })()
  );
}

async function loadItemsForSubaction(
  subaction: Subaction,
  runtime: IAgentRuntime,
  message: Memory,
): Promise<readonly PrioritizeRankableItem[]> {
  switch (subaction) {
    case "rank_todos":
      return activeLoaders.loadTodos({ runtime, message });
    case "rank_threads":
      return activeLoaders.loadThreads({ runtime, message });
    case "rank_decisions":
      return activeLoaders.loadDecisions({ runtime, message });
  }
}

function buildRankingPrompt(args: {
  subject: Subject;
  items: readonly PrioritizeRankableItem[];
  topN: number;
  criteria?: string;
}): string {
  const data = JSON.stringify(args.items, null, 2);
  const criteriaLine = args.criteria
    ? `\nAdditional criteria from the owner: ${args.criteria}\n`
    : "";
  return `You are ranking the owner's open ${args.subject} by urgency multiplied by importance.

Return strict JSON only:
{
  "ranked": [
    { "id": "<item id>", "score": <0..1 number>, "reasoning": "<short why>" },
    ...
  ]
}

- Include AT MOST ${args.topN} items.
- Score 1.0 means drop-everything-now; 0.0 means could wait indefinitely.
- Sort by descending score.
- Use only the ids that appear in the input data.
- Keep reasoning under 20 words.${criteriaLine}

Items:
${data}`;
}

interface RawRankingEntry {
  readonly id: string;
  readonly score: number;
  readonly reasoning: string;
}

function parseRanking(raw: unknown): readonly RawRankingEntry[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return [];
  const slice = trimmed.slice(start, end + 1);
  const parsed: unknown = (() => {
    try {
      return JSON.parse(slice);
    } catch {
      // error-policy:J3 parse of untrusted model output; unparseable ranking
      // text is an explicit null (→ empty ranking), never a fabricated ranking.
      return null;
    }
  })();
  if (!parsed || typeof parsed !== "object") return [];
  const rankedRaw = (parsed as { ranked?: unknown }).ranked;
  if (!Array.isArray(rankedRaw)) return [];
  const entries: RawRankingEntry[] = [];
  for (const entry of rankedRaw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    const score = typeof obj.score === "number" ? obj.score : null;
    const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
    if (!id || score === null) continue;
    entries.push({ id, score, reasoning });
  }
  return entries;
}

function applyRanking(
  items: readonly PrioritizeRankableItem[],
  ranking: readonly RawRankingEntry[],
  topN: number,
): readonly PrioritizeRankedItem[] {
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const sorted = [...ranking].sort((a, b) => b.score - a.score);
  const ranked: PrioritizeRankedItem[] = [];
  for (const entry of sorted) {
    const source = itemMap.get(entry.id);
    if (!source) continue;
    ranked.push({
      ...source,
      rank: ranked.length + 1,
      score: entry.score,
      reasoning: entry.reasoning,
    });
    if (ranked.length >= topN) break;
  }
  return ranked;
}

const examples: ActionExample[][] = [
  [
    { name: "{{name1}}", content: { text: "What should I focus on today?" } },
    {
      name: "{{agentName}}",
      content: {
        text: "Ranked your top todos by urgency × importance.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Which threads need my attention first?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Ranked your open threads by priority.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const prioritizeAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: SIMILE_NAMES.slice(),
  tags: [
    "domain:focus",
    "capability:read",
    "capability:rank",
    "surface:internal",
  ],
  description:
    "Rank owner open todos, message threads, pending decisions by urgency × importance. LLM pass. Subactions: rank_todos, rank_threads, rank_decisions.",
  descriptionCompressed:
    "prioritize: rank_todos|rank_threads|rank_decisions; topN ranking by urgency × importance",
  routingHint:
    'prioritization ("focus on", "rank today", "which thread first", "what matters most") -> PRIORITIZE; do not use plain list -> OWNER_TODOS.list / MESSAGE.list_inbox',
  contexts: ["focus", "tasks", "inbox", "approvals"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description: "Prioritize op: rank_todos | rank_threads | rank_decisions.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "subject",
      description:
        "Alt selector: todos | threads | decisions. Maps to subaction.",
      schema: {
        type: "string" as const,
        enum: ["todos", "threads", "decisions"],
      },
    },
    {
      name: "topN",
      description: "Top item count. Default 5.",
      schema: { type: "number" as const },
    },
    {
      name: "criteria",
      description: "Owner weighting criteria.",
      schema: { type: "string" as const },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Prioritization is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      return {
        success: false,
        text: "Tell me what to rank: rank_todos, rank_threads, or rank_decisions.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    const subject = SUBACTION_TO_SUBJECT[subaction];
    const topN =
      typeof params.topN === "number" && params.topN > 0
        ? Math.floor(params.topN)
        : 5;

    const items = await loadItemsForSubaction(subaction, runtime, message);
    if (items.length === 0) {
      const text = `No open ${subject} to rank.`;
      logger.info(`[PRIORITIZE] ${subaction} empty topN=${topN}`);
      await callback?.({ text, source: "action", action: ACTION_NAME });
      return {
        success: true,
        text,
        data: {
          subaction,
          subject,
          ranked: [] as readonly PrioritizeRankedItem[],
        },
      };
    }

    if (typeof runtime.useModel !== "function") {
      logger.warn(
        `[PRIORITIZE] ${subaction} runtime.useModel unavailable, returning natural order`,
      );
      const fallbackRanked = items
        .slice(0, topN)
        .map<PrioritizeRankedItem>((item, index) => ({
          ...item,
          rank: index + 1,
          score: 0,
          reasoning: "model unavailable; preserved input order",
        }));
      const text = `Ranked ${fallbackRanked.length} ${subject} (model unavailable, used input order).`;
      await callback?.({ text, source: "action", action: ACTION_NAME });
      return {
        success: true,
        text,
        data: {
          subaction,
          subject,
          ranked: fallbackRanked,
          warning: "MODEL_UNAVAILABLE",
        },
      };
    }

    const prompt = buildRankingPrompt({
      subject,
      items,
      topN,
      criteria: params.criteria,
    });

    let raw: unknown;
    try {
      raw = await runWithTrajectoryPurpose("lifeops-prioritize", () =>
        runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`[PRIORITIZE] ${subaction} model call failed: ${detail}`);
      return {
        success: false,
        text: `I couldn't rank your ${subject} — the language model call failed.`,
        data: {
          subaction,
          subject,
          error: "MODEL_CALL_FAILED",
          detail,
        },
      };
    }

    const parsed = parseRanking(raw);
    const ranked = applyRanking(items, parsed, topN);

    logger.info(
      `[PRIORITIZE] ${subaction} ranked=${ranked.length} items=${items.length} topN=${topN}`,
    );

    const text =
      ranked.length === 0
        ? `Ranked 0 ${subject} — model produced no valid entries.`
        : `Ranked top ${ranked.length} ${subject} by urgency × importance.`;

    await callback?.({ text, source: "action", action: ACTION_NAME });

    return {
      success: true,
      text,
      data: {
        subaction,
        subject,
        ranked,
        ...(ranked.length === 0 ? { warning: "EMPTY_RANKING" } : {}),
      },
    };
  },
};
