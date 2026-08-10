/**
 * Bounded HTTP client for the TaskMarket REST API. Owns the three things that
 * are easy to get wrong against this vendor: the mandatory `/api` base-path
 * prefix, the fact that the bearer token does **not** identify the caller (an
 * explicit `address` query param is required on the account routes), and the
 * atomic 6-decimal USDC units used by every amount field.
 *
 * Every response is size-capped and timeout-bounded before it reaches the
 * planner, and the bearer token is never echoed into an error message.
 */
import {
  TASKMARKET_MAX_RESPONSE_BYTES,
  TASKMARKET_REQUEST_TIMEOUT_MS,
  type TaskMarketConfig,
} from "../types.ts";

export interface TaskMarketTask {
  id: string;
  description?: string;
  reward?: string;
  netReward?: string;
  status?: string;
  mode?: string;
  tags?: string[];
  expiryTime?: string;
  submissionCount?: number;
  submissionWindowOpen?: boolean;
  platformFeeBps?: number;
}

/**
 * Shape verified live against `GET /submissions/mine`. Note the field names are
 * task-prefixed and there is no submission id: the record is keyed by
 * `taskId` + `deliverableHash`, and `rejectedAt` (nullable) is the only
 * outcome marker on the worker side.
 */
export interface TaskMarketSubmission {
  taskId?: string;
  taskStatus?: string;
  taskMode?: string;
  taskReward?: string;
  submittedAt?: string;
  deliverableHash?: string;
  submitTxHash?: string;
  rejectedAt?: string | null;
}

export interface TaskMarketAgentStats {
  address?: string;
  agentId?: string;
  completedTasks?: number;
  ratedTasks?: number;
  averageRating?: number;
  totalEarnings?: string;
  credibility?: number;
}

export class TaskMarketApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TaskMarketApiError";
    this.status = status;
  }
}

/**
 * A 2xx response whose body does not match the documented shape. Distinct from
 * {@link TaskMarketApiError} because the transport succeeded: the vendor
 * answered, the payload is unusable. Surfaced as an explicit unavailable state
 * rather than degraded into an empty board, a zero balance, or a task that was
 * never actually created.
 */
export class TaskMarketResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskMarketResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A task is only usable if it carries the id every other call is keyed on. */
function isTask(value: unknown): value is TaskMarketTask {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

function isSubmission(value: unknown): value is TaskMarketSubmission {
  return isRecord(value);
}

/** Amount fields must parse; a malformed one must not read as a real zero. */
function isAmountLike(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && Number.isFinite(Number(value));
}

function buildUrl(
  config: TaskMarketConfig,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const base = config.apiUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Read at most `TASKMARKET_MAX_RESPONSE_BYTES` from a response body. A hostile
 * or broken endpoint cannot stream unbounded content into the agent process.
 */
async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (bytes < TASKMARKET_MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text + decoder.decode();
}

async function request<T>(
  config: TaskMarketConfig,
  path: string,
  init: {
    method?: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  } = {},
): Promise<T> {
  const url = buildUrl(config, path, init.query);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    TASKMARKET_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    const text = await readBoundedText(response);
    if (!response.ok) {
      // Body only — never the request URL, which carries the caller's address.
      throw new TaskMarketApiError(
        response.status,
        text.slice(0, 500) || response.statusText,
      );
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /tasks` — the open board. Returns `{tasks: [...]}`; note that the
 * sibling `/tasks/{id}/submissions` route returns a bare array instead, so the
 * two cannot share a destructuring path.
 */
export async function listTasks(
  config: TaskMarketConfig,
  params: { status?: string; mode?: string; limit?: number; sort?: string },
): Promise<TaskMarketTask[]> {
  const data = await request<unknown>(config, "/tasks", {
    query: {
      status: params.status,
      mode: params.mode,
      limit: params.limit,
      sort: params.sort,
    },
  });
  // No `?? []` here on purpose: an unreadable board must not look like an empty
  // one, or the planner concludes there is no work when the API broke.
  const tasks = isRecord(data) ? data.tasks : undefined;
  if (!Array.isArray(tasks)) {
    throw new TaskMarketResponseError(
      "GET /tasks did not return a `tasks` array; the board is unavailable, not empty.",
    );
  }
  if (!tasks.every(isTask)) {
    throw new TaskMarketResponseError(
      "GET /tasks returned an entry without a task id; refusing to render a partial board.",
    );
  }
  if (
    !tasks.every(
      (task) => isAmountLike(task.reward) && isAmountLike(task.netReward),
    )
  ) {
    throw new TaskMarketResponseError(
      "GET /tasks returned an unparseable reward amount; refusing to render it as $0.00.",
    );
  }
  return tasks;
}

/** `GET /tasks/{taskId}` — the full brief for one task. */
export async function getTask(
  config: TaskMarketConfig,
  taskId: string,
): Promise<TaskMarketTask> {
  const data = await request<unknown>(
    config,
    `/tasks/${encodeURIComponent(taskId)}`,
  );
  if (!isTask(data)) {
    throw new TaskMarketResponseError(
      `GET /tasks/${taskId} did not return a task with an id.`,
    );
  }
  if (!isAmountLike(data.reward) || !isAmountLike(data.netReward)) {
    throw new TaskMarketResponseError(
      `GET /tasks/${taskId} returned an unparseable reward amount.`,
    );
  }
  return data;
}

/**
 * `GET /submissions/mine` — requires an explicit `workerAddress`; the bearer
 * token alone does not identify the worker.
 */
export async function listMySubmissions(
  config: TaskMarketConfig,
): Promise<TaskMarketSubmission[]> {
  const data = await request<unknown>(config, "/submissions/mine", {
    query: { workerAddress: config.address },
  });
  const submissions = Array.isArray(data)
    ? data
    : isRecord(data)
      ? data.submissions
      : undefined;
  if (!Array.isArray(submissions) || !submissions.every(isSubmission)) {
    throw new TaskMarketResponseError(
      "GET /submissions/mine did not return a submissions array; treating as unavailable rather than 'no submissions'.",
    );
  }
  return submissions as TaskMarketSubmission[];
}

/**
 * `GET /agents/stats` — 500s with "Provide address or agentId" unless the
 * address is passed explicitly, hence the config-level address requirement.
 */
export async function getAgentStats(
  config: TaskMarketConfig,
): Promise<TaskMarketAgentStats> {
  const data = await request<unknown>(config, "/agents/stats", {
    query: { address: config.address },
  });
  if (!isRecord(data)) {
    throw new TaskMarketResponseError(
      "GET /agents/stats did not return an object.",
    );
  }
  if (!isAmountLike(data.totalEarnings)) {
    throw new TaskMarketResponseError(
      "GET /agents/stats returned unparseable earnings; refusing to report them as $0.00.",
    );
  }
  return data as TaskMarketAgentStats;
}

/** `GET /wallet/balance` — returns whole USDC as a string, unlike every other amount field. */
export async function getWalletBalance(
  config: TaskMarketConfig,
): Promise<string> {
  const data = await request<unknown>(config, "/wallet/balance", {
    query: { address: config.address },
  });
  const balance = isRecord(data) ? data.balanceUsdc : undefined;
  // A missing balance is not a zero balance. Reporting "0 USDC" for a failed
  // read would tell the user they are broke when the endpoint simply drifted.
  if (
    (typeof balance !== "string" && typeof balance !== "number") ||
    !Number.isFinite(Number(balance))
  ) {
    throw new TaskMarketResponseError(
      "GET /wallet/balance did not return a numeric balanceUsdc; balance is unavailable, not zero.",
    );
  }
  return String(balance);
}

/**
 * `POST /tasks` — escrows real USDC immediately. Callers must pass the spend
 * guards in `actions/create-task.ts` before reaching this function; `reward` is
 * an atomic 6-decimal string.
 */
export async function createTask(
  config: TaskMarketConfig,
  body: {
    description: string;
    reward: string;
    duration: number;
    tags: string[];
    mode?: string;
  },
): Promise<{ taskId: string }> {
  const data = await request<unknown>(config, "/tasks", {
    method: "POST",
    body,
  });
  // A 2xx is not proof of escrow. Without an explicit success and a task id
  // there is nothing to point the user at, and reporting a created task from
  // `{"success": false}` would fabricate success on a money-moving path.
  if (!isRecord(data) || data.success === false) {
    throw new TaskMarketResponseError(
      "POST /tasks returned a 2xx response that does not confirm the task was created; treating the escrow as NOT performed.",
    );
  }
  const taskId = data.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new TaskMarketResponseError(
      "POST /tasks returned a 2xx response with no taskId; cannot confirm the escrow.",
    );
  }
  return { taskId };
}
