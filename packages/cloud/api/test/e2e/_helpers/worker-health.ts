import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_INTERVAL_MS = 250;
const MAX_BODY_PREVIEW_BYTES = 256;

export interface WorkerHealthAttempt {
  attempt: number;
  status: number | null;
  contentType: string | null;
  server: string | null;
  bodyBytes: number;
  bodySha256: string | null;
  bodyPreview: string | null;
  receipt: string | null;
  error: string | null;
}

export interface WaitForWorkerHealthOptions {
  baseUrl: string;
  expectedReceipt?: string;
  serverPid?: number;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  retryIntervalMs?: number;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  isProcessAlive?: (pid: number) => boolean;
  onAttempt?: (attempt: WorkerHealthAttempt) => void;
}

export interface WorkerHealthReceipt {
  attempts: WorkerHealthAttempt[];
  response: Response;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeBodyPreview(
  body: string,
  contentType: string | null,
): string | null {
  if (!body) return "";
  const normalized = body.replace(/[\r\n\t]+/g, " ").trim();
  if (
    contentType?.includes("application/json") ||
    contentType?.startsWith("text/plain")
  ) {
    return normalized.slice(0, MAX_BODY_PREVIEW_BYTES);
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function receiptFromBody(
  body: string,
  contentType: string | null,
): string | null {
  if (!contentType?.includes("application/json")) return null;
  try {
    const parsed = JSON.parse(body) as { e2eRunReceipt?: unknown };
    return typeof parsed.e2eRunReceipt === "string"
      ? parsed.e2eRunReceipt
      : null;
  } catch {
    return null;
  }
}

function formatAttempt(attempt: WorkerHealthAttempt): string {
  const fields = [
    `attempt=${attempt.attempt}`,
    `status=${attempt.status ?? "none"}`,
    `content-type=${attempt.contentType ?? "none"}`,
    `server=${attempt.server ?? "none"}`,
    `body-bytes=${attempt.bodyBytes}`,
    `body-sha256=${attempt.bodySha256 ?? "none"}`,
    `receipt=${attempt.receipt ?? "none"}`,
  ];
  if (attempt.bodyPreview !== null) {
    fields.push(`body=${JSON.stringify(attempt.bodyPreview)}`);
  }
  if (attempt.error) fields.push(`error=${JSON.stringify(attempt.error)}`);
  return fields.join(" ");
}

function formatAttempts(attempts: WorkerHealthAttempt[]): string {
  if (attempts.length <= 6) return attempts.map(formatAttempt).join(" | ");
  const omitted = attempts.length - 5;
  return [
    ...attempts.slice(0, 2).map(formatAttempt),
    `... ${omitted} repeated attempt(s) omitted ...`,
    ...attempts.slice(-3).map(formatAttempt),
  ].join(" | ");
}

/**
 * Wait for the exact Worker owned by the current E2E run.
 *
 * A transient non-2xx response may recover inside the bounded window, but a
 * response is accepted only when it is healthy and carries the caller's unique
 * run receipt. A dead wrapper process, wrong listener, or persistent unhealthy
 * response remains a hard failure with a compact diagnostic receipt.
 */
export async function waitForWorkerHealth({
  baseUrl,
  expectedReceipt,
  serverPid,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  fetchImpl = fetch,
  isProcessAlive = defaultIsProcessAlive,
  onAttempt,
}: WaitForWorkerHealthOptions): Promise<WorkerHealthReceipt> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${normalizeBaseUrl(baseUrl)}/api/health`;
  const attempts: WorkerHealthAttempt[] = [];

  while (Date.now() < deadline) {
    if (serverPid && !isProcessAlive(serverPid)) {
      throw new Error(
        `Worker e2e target process ${serverPid} exited before ${healthUrl} became healthy`,
      );
    }

    let attempt: WorkerHealthAttempt;
    let response: Response | null = null;
    try {
      response = await fetchImpl(healthUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      const body = await response.clone().text();
      const contentType = response.headers.get("content-type");
      const receipt = receiptFromBody(body, contentType);
      attempt = {
        attempt: attempts.length + 1,
        status: response.status,
        contentType,
        server: response.headers.get("server"),
        bodyBytes: Buffer.byteLength(body),
        bodySha256: createHash("sha256").update(body).digest("hex"),
        bodyPreview: safeBodyPreview(body, contentType),
        receipt,
        error: null,
      };
      attempts.push(attempt);
      onAttempt?.(attempt);

      const receiptMatches = expectedReceipt
        ? receipt === expectedReceipt
        : true;
      if (response.ok && receiptMatches) {
        return { attempts, response };
      }
    } catch (error) {
      attempt = {
        attempt: attempts.length + 1,
        status: null,
        contentType: null,
        server: null,
        bodyBytes: 0,
        bodySha256: null,
        bodyPreview: null,
        receipt: null,
        error: errorMessage(error),
      };
      attempts.push(attempt);
      onAttempt?.(attempt);
    }

    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
  }

  const identity = expectedReceipt
    ? ` carrying receipt ${expectedReceipt}`
    : "";
  throw new Error(
    `Worker e2e target did not become healthy at ${healthUrl}${identity}: ${formatAttempts(attempts)}`,
  );
}
