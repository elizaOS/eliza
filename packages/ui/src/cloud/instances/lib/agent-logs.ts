/**
 * Validates and executes the browser-side agent-log enqueue and polling
 * protocol. Untrusted response bodies are narrowed here once so dashboard
 * components never infer success from partial job envelopes.
 */

const MIN_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const AGENT_LOGS_TIMEOUT_MS = 30_000;

export interface AgentLogsResult {
  logs: string;
  notice: string | null;
}

export interface LoadAgentLogsOptions {
  agentId: string;
  tail: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

type AgentLogsStart =
  | { kind: "complete"; result: AgentLogsResult }
  | { kind: "job"; jobId: string; intervalMs: number };

type AgentLogsJobState =
  | { kind: "pending"; intervalMs: number }
  | { kind: "complete"; result: AgentLogsResult }
  | { kind: "failed"; message: string };

export class AgentLogsProtocolError extends Error {
  readonly name = "AgentLogsProtocolError";
}

export class AgentLogsTimeoutError extends Error {
  readonly name = "AgentLogsTimeoutError";
}

const LOG_COLLECTION_FAILED_MESSAGE =
  "Log collection failed on the server. Try again in a moment.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  })
    .join("")
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function clampInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(
    Math.max(Math.trunc(value), MIN_POLL_INTERVAL_MS),
    MAX_POLL_INTERVAL_MS,
  );
}

function readHttpFailureMessage(
  context: "request" | "job",
  status: number,
): string {
  if (status === 401 || status === 403) {
    return "You do not have permission to read this agent's logs.";
  }
  if (status === 404) {
    return context === "request"
      ? "This agent is no longer available."
      : "This log collection job is no longer available.";
  }
  if (status === 429) {
    return "Log requests are temporarily limited. Try again in a moment.";
  }
  return context === "request"
    ? `Log request failed (HTTP ${status}).`
    : `Log job failed (HTTP ${status}).`;
}

export function parseAgentLogsStart(value: unknown): AgentLogsStart {
  if (!isRecord(value) || value.success !== true) {
    throw new AgentLogsProtocolError(
      isRecord(value)
        ? "The log request failed."
        : "The log service returned an unreadable response.",
    );
  }

  if (typeof value.data === "string") {
    return {
      kind: "complete",
      result: { logs: value.data, notice: null },
    };
  }

  if (!isRecord(value.data)) {
    throw new AgentLogsProtocolError(
      "The log service did not return log data or a job to follow.",
    );
  }

  const jobId = readBoundedText(value.data.jobId, 256);
  if (!jobId) {
    throw new AgentLogsProtocolError(
      "The log service did not return a valid job identifier.",
    );
  }

  const polling = isRecord(value.data.polling) ? value.data.polling : null;
  return {
    kind: "job",
    jobId,
    intervalMs: clampInterval(polling?.intervalMs, DEFAULT_POLL_INTERVAL_MS),
  };
}

export function parseAgentLogsJob(value: unknown): AgentLogsJobState {
  if (!isRecord(value) || value.success !== true) {
    throw new AgentLogsProtocolError(
      isRecord(value)
        ? LOG_COLLECTION_FAILED_MESSAGE
        : "The log job returned an unreadable response.",
    );
  }
  if (!isRecord(value.data)) {
    throw new AgentLogsProtocolError(
      "The log job response is missing its data.",
    );
  }

  const status = readBoundedText(value.data.status, 64);
  const polling = isRecord(value.polling) ? value.polling : null;
  if (value.data.type !== "agent_logs") {
    throw new AgentLogsProtocolError("The job response is not for agent logs.");
  }
  if (status === "pending" || status === "in_progress") {
    if (polling?.shouldContinue === false) {
      throw new AgentLogsProtocolError(
        "The log job stopped polling before it reached a final state.",
      );
    }
    return {
      kind: "pending",
      intervalMs: clampInterval(polling?.intervalMs, DEFAULT_POLL_INTERVAL_MS),
    };
  }

  const result = isRecord(value.data.result) ? value.data.result : null;
  if (status === "failed") {
    return {
      kind: "failed",
      message: LOG_COLLECTION_FAILED_MESSAGE,
    };
  }
  if (status !== "completed") {
    throw new AgentLogsProtocolError("The log job returned an unknown status.");
  }
  if (!result) {
    throw new AgentLogsProtocolError(
      "The completed log job did not include a result.",
    );
  }
  if (readBoundedText(value.data.error)) {
    return { kind: "failed", message: LOG_COLLECTION_FAILED_MESSAGE };
  }
  const resultError = readBoundedText(result.error);
  if (resultError) {
    return { kind: "failed", message: LOG_COLLECTION_FAILED_MESSAGE };
  }
  if (result.logs !== undefined && typeof result.logs !== "string") {
    throw new AgentLogsProtocolError(
      "The completed log job returned invalid log data.",
    );
  }

  return {
    kind: "complete",
    result: {
      logs: typeof result.logs === "string" ? result.logs : "",
      notice: readBoundedText(result.message),
    },
  };
}

async function readJson(response: Response, context: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // error-policy:J1 browser transport boundary converts malformed JSON into a visible protocol error.
    throw new AgentLogsProtocolError(`${context} returned unreadable JSON.`);
  }
}

function waitWithAbort(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export async function loadAgentLogs({
  agentId,
  tail,
  signal,
  fetchImpl = fetch,
  timeoutMs = AGENT_LOGS_TIMEOUT_MS,
  now = Date.now,
  wait = waitWithAbort,
}: LoadAgentLogsOptions): Promise<AgentLogsResult> {
  const query = new URLSearchParams({ tail: String(tail) });
  const startResponse = await fetchImpl(
    `/api/compat/agents/${encodeURIComponent(agentId)}/logs?${query}`,
    { cache: "no-store", signal },
  );
  const startBody = await readJson(startResponse, "The log request");
  if (!startResponse.ok) {
    throw new AgentLogsProtocolError(
      readHttpFailureMessage("request", startResponse.status),
    );
  }

  const start = parseAgentLogsStart(startBody);
  if (start.kind === "complete") return start.result;

  const deadline = now() + timeoutMs;
  let intervalMs = start.intervalMs;
  while (now() <= deadline) {
    const response = await fetchImpl(
      `/api/v1/jobs/${encodeURIComponent(start.jobId)}`,
      { cache: "no-store", signal },
    );
    const body = await readJson(response, "The log job");
    if (!response.ok) {
      throw new AgentLogsProtocolError(
        readHttpFailureMessage("job", response.status),
      );
    }

    const job = parseAgentLogsJob(body);
    if (job.kind === "complete") return job.result;
    if (job.kind === "failed") throw new AgentLogsProtocolError(job.message);
    intervalMs = job.intervalMs;

    if (now() + intervalMs > deadline) break;
    await wait(intervalMs, signal);
  }

  throw new AgentLogsTimeoutError(
    "Log collection is taking longer than expected. Try again in a moment.",
  );
}
