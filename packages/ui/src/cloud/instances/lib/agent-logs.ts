/**
 * Validates and executes the browser-side agent-log enqueue and polling
 * protocol. Untrusted response bodies are narrowed here once so dashboard
 * components never infer success from partial job envelopes.
 */

import type { AgentSandboxStatus } from "@elizaos/cloud-shared/lib/types/cloud-api";

const MIN_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const AGENT_LOGS_TIMEOUT_MS = 30_000;
const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_SANDBOX_STATUSES = [
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
  "disconnected",
  "error",
  "deletion_pending",
  "deletion_failed",
] as const satisfies readonly AgentSandboxStatus[];

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

interface AgentLogsJobExpectation {
  agentId: string;
  tail: number;
}

export class AgentLogsProtocolError extends Error {
  readonly name: string = "AgentLogsProtocolError";
}

export class AgentLogsUnavailableError extends AgentLogsProtocolError {
  readonly name = "AgentLogsUnavailableError";
  readonly retryable = true;
}

export class AgentLogsTimeoutError extends Error {
  readonly name = "AgentLogsTimeoutError";
}

const LOG_COLLECTION_FAILED_MESSAGE =
  "Log collection failed on the server. Try again in a moment.";
const LOG_COLLECTION_TIMEOUT_MESSAGE =
  "Log collection is taking longer than expected. Try again in a moment.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  let normalized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const safeCharacter =
      codePoint <= 31 || codePoint === 127
        ? " "
        : codePoint >= 0xd800 && codePoint <= 0xdfff
          ? "�"
          : character;
    if (normalized.length + safeCharacter.length > maxLength) break;
    normalized += safeCharacter;
  }
  normalized = normalized.trim();
  if (!normalized) return null;
  return normalized;
}

function isAgentSandboxStatus(value: unknown): value is AgentSandboxStatus {
  return AGENT_SANDBOX_STATUSES.some((status) => status === value);
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

  const jobId = value.data.jobId;
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
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

export function parseAgentLogsJob(
  value: unknown,
  expected: AgentLogsJobExpectation,
): AgentLogsJobState {
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
  if (status === "failed" || status === "cancelled") {
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
  if (
    typeof result.cloudAgentId !== "string" ||
    result.cloudAgentId !== expected.agentId
  ) {
    throw new AgentLogsProtocolError(
      "The completed log job does not match the requested agent.",
    );
  }
  if (result.skipped === true) {
    throw new AgentLogsUnavailableError(
      "This agent is no longer available. Refresh the agent list and try again.",
    );
  }
  if (!Number.isSafeInteger(result.tail) || result.tail !== expected.tail) {
    throw new AgentLogsProtocolError(
      "The completed log job does not match the requested log range.",
    );
  }
  const resultStatus = result.status;
  if (!isAgentSandboxStatus(resultStatus)) {
    throw new AgentLogsProtocolError(
      "The completed log job returned an invalid agent status.",
    );
  }
  const resultMessage = readBoundedText(result.message);
  if (result.logs === undefined && resultMessage) {
    const producerOwnedNotice =
      resultMessage ===
        `Agent is ${resultStatus} — no container assigned yet.` ||
      resultMessage ===
        "Logs unavailable: sandbox provider does not implement fetchLogs.";
    if (!producerOwnedNotice) {
      throw new AgentLogsUnavailableError(
        "The completed log job returned an unsupported log outcome.",
      );
    }
    return {
      kind: "complete",
      result: { logs: "", notice: resultMessage },
    };
  }
  if (typeof result.logs !== "string") {
    throw new AgentLogsUnavailableError(
      result.logs === undefined
        ? "The log collection finished without log data. Try again in a moment."
        : "The completed log job returned invalid log data.",
    );
  }

  return {
    kind: "complete",
    result: {
      logs: result.logs,
      notice: resultMessage,
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
  const deadline = now() + timeoutMs;
  const timeoutError = new AgentLogsTimeoutError(
    LOG_COLLECTION_TIMEOUT_MESSAGE,
  );
  const requestController = new AbortController();
  const requestSignal = requestController.signal;
  let rejectRequestAbort = () => {};
  const requestAborted = new Promise<never>((_resolve, reject) => {
    rejectRequestAbort = () => {
      reject(requestSignal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (requestSignal.aborted) rejectRequestAbort();
    else
      requestSignal.addEventListener("abort", rejectRequestAbort, {
        once: true,
      });
  });
  const withinRequestDeadline = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, requestAborted]);
  const abortFromCaller = () => {
    requestController.abort(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  };
  if (signal.aborted) abortFromCaller();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeoutId = globalThis.setTimeout(() => {
    requestController.abort(timeoutError);
  }, timeoutMs);

  try {
    const query = new URLSearchParams({ tail: String(tail) });
    const startResponse = await withinRequestDeadline(
      fetchImpl(
        `/api/compat/agents/${encodeURIComponent(agentId)}/logs?${query}`,
        {
          cache: "no-store",
          signal: requestSignal,
        },
      ),
    );
    if (!startResponse.ok) {
      throw new AgentLogsProtocolError(
        readHttpFailureMessage("request", startResponse.status),
      );
    }
    const startBody = await withinRequestDeadline(
      readJson(startResponse, "The log request"),
    );

    const start = parseAgentLogsStart(startBody);
    if (start.kind === "complete") return start.result;

    let intervalMs = start.intervalMs;
    while (now() <= deadline) {
      const response = await withinRequestDeadline(
        fetchImpl(`/api/v1/jobs/${encodeURIComponent(start.jobId)}`, {
          cache: "no-store",
          signal: requestSignal,
        }),
      );
      if (!response.ok) {
        throw new AgentLogsProtocolError(
          readHttpFailureMessage("job", response.status),
        );
      }
      const body = await withinRequestDeadline(
        readJson(response, "The log job"),
      );

      const job = parseAgentLogsJob(body, { agentId, tail });
      if (job.kind === "complete") return job.result;
      if (job.kind === "failed") throw new AgentLogsProtocolError(job.message);
      intervalMs = job.intervalMs;

      if (now() + intervalMs > deadline) break;
      await withinRequestDeadline(wait(intervalMs, requestSignal));
    }

    throw timeoutError;
  } catch (error) {
    // error-policy:J1 transport boundary translates the request deadline into a typed timeout.
    if (requestController.signal.aborted && !signal.aborted) {
      throw timeoutError;
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortFromCaller);
    requestSignal.removeEventListener("abort", rejectRequestAbort);
  }
}
