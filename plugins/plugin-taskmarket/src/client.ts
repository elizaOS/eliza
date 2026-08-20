/** Validates Taskmarket's public task-list boundary and exposes bounded discovery results. */

import { fetchWithSsrfGuard } from "@elizaos/core";

export const DEFAULT_TASKMARKET_API_URL = "https://api.taskmarket.dev";

export type TaskmarketMode =
  | "bounty"
  | "claim"
  | "pitch"
  | "benchmark"
  | "auction";
export type TaskmarketSort =
  | "newest"
  | "reward_desc"
  | "reward_asc"
  | "deadline_asc";

export interface TaskmarketTask {
  id: string;
  description: string;
  rewardBaseUnits: string;
  rewardUsdc: string;
  netRewardBaseUnits: string;
  netRewardUsdc: string;
  status: string;
  mode: string;
  expiryTime: string;
  tags: string[];
  submissionCount: number;
}

export interface ListTasksOptions {
  mode?: TaskmarketMode;
  sort?: TaskmarketSort;
  limit?: number;
  minRewardBaseUnits?: string;
  deadlineHours?: number;
}

export interface TaskmarketTaskPage {
  tasks: TaskmarketTask[];
  hasMore: boolean;
  nextCursor: string | null;
}

type FetchLike = typeof fetch;

const TASKMARKET_REQUEST_TIMEOUT_MS = 10_000;
const TASKMARKET_MAX_RESPONSE_BYTES = 512 * 1024;
const TASKMARKET_MODES = new Set<TaskmarketMode>([
  "bounty",
  "claim",
  "pitch",
  "benchmark",
  "auction",
]);
const TASKMARKET_SORTS = new Set<TaskmarketSort>([
  "newest",
  "reward_desc",
  "reward_asc",
  "deadline_asc",
]);
const TASK_TEXT_LIMITS = {
  id: 128,
  description: 180,
  status: 32,
  mode: 32,
  expiryTime: 64,
  tag: 64,
  cursor: 256,
} as const;
const MAX_TASK_TAGS = 10;
const REMOTE_TEXT_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Taskmarket returned an invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Taskmarket task is missing ${key}`);
  }
  return value;
}

function sanitizeRemoteText(value: string, maxLength: number): string {
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "\uFFFD";
    return codePoint < 32 || codePoint === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  let result = "";
  let codePointCount = 0;
  // Keep the hard code-point budget, but never spend a partial grapheme: a
  // combining or ZWJ cluster that does not fit is omitted as one unit.
  for (const { segment } of REMOTE_TEXT_SEGMENTER.segment(normalized)) {
    const segmentLength = Array.from(segment).length;
    if (codePointCount + segmentLength > maxLength) break;
    result += segment;
    codePointCount += segmentLength;
  }
  return result;
}

function requireSanitizedString(
  record: Record<string, unknown>,
  key: keyof typeof TASK_TEXT_LIMITS,
): string {
  const sanitized = sanitizeRemoteText(
    requireString(record, key),
    TASK_TEXT_LIMITS[key],
  );
  if (!sanitized) throw new TypeError(`Taskmarket task is missing ${key}`);
  return sanitized;
}

function requireNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`Taskmarket task has invalid ${key}`);
  }
  return value;
}

export function formatUsdc(baseUnits: string): string {
  if (!/^\d+$/.test(baseUnits))
    throw new TypeError("USDC amount must contain only digits");
  const padded = baseUnits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  const fractional = padded.slice(-6).replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > TASKMARKET_MAX_RESPONSE_BYTES
  ) {
    throw new RangeError("Taskmarket response exceeds the 512 KiB limit");
  }

  if (!response.body) return await response.json();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > TASKMARKET_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RangeError("Taskmarket response exceeds the 512 KiB limit");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function parseTask(value: unknown): TaskmarketTask {
  const task = requireRecord(value, "task");
  const rewardBaseUnits = requireString(task, "reward");
  const netRewardBaseUnits = requireString(task, "netReward");
  const tags = task.tags;
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    throw new TypeError("Taskmarket task has invalid tags");
  }
  return {
    id: requireSanitizedString(task, "id"),
    description: requireSanitizedString(task, "description"),
    rewardBaseUnits,
    rewardUsdc: formatUsdc(rewardBaseUnits),
    netRewardBaseUnits,
    netRewardUsdc: formatUsdc(netRewardBaseUnits),
    status: requireSanitizedString(task, "status"),
    mode: requireSanitizedString(task, "mode"),
    expiryTime: requireSanitizedString(task, "expiryTime"),
    tags: tags
      .slice(0, MAX_TASK_TAGS)
      .map((tag) => sanitizeRemoteText(tag, TASK_TEXT_LIMITS.tag))
      .filter(Boolean),
    submissionCount: requireNonNegativeInteger(task, "submissionCount"),
  };
}

export class TaskmarketClient {
  constructor(
    private readonly baseUrl = DEFAULT_TASKMARKET_API_URL,
    private readonly fetcher?: FetchLike,
  ) {}

  async listTasks(options: ListTasksOptions = {}): Promise<TaskmarketTaskPage> {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("Taskmarket result limit must be between 1 and 50");
    }
    if (options.mode !== undefined && !TASKMARKET_MODES.has(options.mode)) {
      throw new RangeError("Taskmarket mode is not supported");
    }
    if (options.sort !== undefined && !TASKMARKET_SORTS.has(options.sort)) {
      throw new RangeError("Taskmarket sort order is not supported");
    }
    if (
      options.minRewardBaseUnits !== undefined &&
      !/^\d+$/.test(options.minRewardBaseUnits)
    ) {
      throw new RangeError(
        "Taskmarket minimum reward must use integer USDC base units",
      );
    }
    const requestedStatus = "open";
    const baseUrl = new URL(this.baseUrl);
    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
    const url = new URL("api/tasks", baseUrl);
    url.searchParams.set("status", requestedStatus);
    url.searchParams.set("sort", options.sort ?? "reward_desc");
    url.searchParams.set("limit", String(limit));
    if (options.mode) url.searchParams.set("mode", options.mode);
    if (options.minRewardBaseUnits)
      url.searchParams.set("minReward", options.minRewardBaseUnits);
    if (options.deadlineHours !== undefined) {
      if (
        !Number.isFinite(options.deadlineHours) ||
        options.deadlineHours <= 0
      ) {
        throw new RangeError("Taskmarket deadline hours must be positive");
      }
      url.searchParams.set("deadlineHours", String(options.deadlineHours));
    }

    const guarded = await fetchWithSsrfGuard({
      url: url.toString(),
      ...(this.fetcher ? { fetchImpl: this.fetcher } : {}),
      init: { headers: { accept: "application/json" } },
      timeoutMs: TASKMARKET_REQUEST_TIMEOUT_MS,
    });
    try {
      if (!guarded.response.ok) {
        throw new Error(
          `Taskmarket request failed with HTTP ${guarded.response.status}`,
        );
      }
      const payload = requireRecord(
        await readBoundedJson(guarded.response),
        "task page",
      );
      if (
        !Array.isArray(payload.tasks) ||
        typeof payload.hasMore !== "boolean"
      ) {
        throw new TypeError("Taskmarket returned an invalid task page");
      }
      if (
        payload.nextCursor !== null &&
        typeof payload.nextCursor !== "string"
      ) {
        throw new TypeError("Taskmarket returned an invalid cursor");
      }
      const tasks = payload.tasks.map(parseTask);
      if (tasks.some((task) => task.status !== requestedStatus)) {
        throw new TypeError(
          `Taskmarket returned tasks outside requested status ${requestedStatus}`,
        );
      }
      if (options.mode && tasks.some((task) => task.mode !== options.mode)) {
        throw new TypeError(
          `Taskmarket returned tasks outside requested mode ${options.mode}`,
        );
      }
      return {
        tasks,
        hasMore: payload.hasMore,
        nextCursor:
          typeof payload.nextCursor === "string"
            ? sanitizeRemoteText(payload.nextCursor, TASK_TEXT_LIMITS.cursor)
            : null,
      };
    } finally {
      await guarded.release();
    }
  }
}
