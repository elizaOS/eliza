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
  cursor?: string;
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
    id: requireString(task, "id"),
    description: requireString(task, "description"),
    rewardBaseUnits,
    rewardUsdc: formatUsdc(rewardBaseUnits),
    netRewardBaseUnits,
    netRewardUsdc: formatUsdc(netRewardBaseUnits),
    status: requireString(task, "status"),
    mode: requireString(task, "mode"),
    expiryTime: requireString(task, "expiryTime"),
    tags,
    submissionCount: requireNonNegativeInteger(task, "submissionCount"),
  };
}

export class TaskmarketClient {
  constructor(
    private readonly baseUrl = DEFAULT_TASKMARKET_API_URL,
    private readonly fetcher?: FetchLike,
  ) {}

  async listTasks(options: ListTasksOptions = {}): Promise<TaskmarketTaskPage> {
    const limit = options.limit ?? 50;
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
    if (options.cursor) url.searchParams.set("cursor", options.cursor);
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
      if (payload.hasMore && !payload.nextCursor) {
        throw new TypeError(
          "Taskmarket reported more tasks without a continuation cursor",
        );
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
          typeof payload.nextCursor === "string" ? payload.nextCursor : null,
      };
    } finally {
      await guarded.release();
    }
  }
}
