/**
 * Authenticated, bounded HTTP client for the agent capture-v2 framed stream.
 * It owns transport validation only; provider provenance and durable backup
 * authority remain control-plane concerns.
 */

import { createHash } from "node:crypto";
import {
  AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  type AgentBackupCaptureV2Frame,
  type AgentBackupCaptureV2Request,
  parseAgentBackupCaptureV2Frames,
  parseAgentBackupCaptureV2Request,
} from "@elizaos/shared";

const MAX_ERROR_BODY_BYTES = 4 * 1024;
const REMOTE_CAPTURE_FAILURE_STATUS = Object.freeze({
  AGENT_BACKUP_V2_INVALID_REQUEST: [400],
  AGENT_BACKUP_V2_AGENT_MISMATCH: [409],
  AGENT_BACKUP_V2_FILE_CHANGED: [409],
  AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED: [409],
  AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED: [408],
  AGENT_BACKUP_V2_INVALID_DEADLINE: [408],
  AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT: [413],
  AGENT_BACKUP_V2_PGLITE_PREFLIGHT_ENTRY_LIMIT: [413],
  AGENT_BACKUP_V2_PGLITE_DUMP_EXCEEDS_PREFLIGHT: [413],
  AGENT_BACKUP_V2_CAPTURE_BUSY: [429],
  AGENT_BACKUP_V2_PGLITE_DUMP_BUSY: [429],
  AGENT_BACKUP_V2_CAPTURE_ABORTED: [499],
  AGENT_BACKUP_V2_CLIENT_DISCONNECTED: [499],
  AGENT_BACKUP_V2_POSTGRES_UNSUPPORTED: [501],
  AGENT_BACKUP_V2_PGLITE_NOT_FILESYSTEM: [501],
  AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE: [501],
  AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED: [503],
  AGENT_BACKUP_V2_CAPTURE_FAILED: [500],
  AGENT_BACKUP_V2_DIRECTORY_IDENTITY_INVALID: [500],
  AGENT_BACKUP_V2_PGLITE_COMPONENT_OVERLAP: [500],
  AGENT_BACKUP_V2_PGLITE_DIRECTORY_MISMATCH: [500],
  AGENT_BACKUP_V2_PGLITE_DIRECTORY_UNATTESTED: [500],
  AGENT_BACKUP_V2_PGLITE_DUMP_ALREADY_CONSUMED: [500],
  AGENT_BACKUP_V2_PGLITE_DUMP_FAILED: [500],
  AGENT_BACKUP_V2_PGLITE_DUMP_NOT_STREAMABLE: [500],
  AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN: [500],
  AGENT_BACKUP_V2_PGLITE_STATE_OVERLAP: [500],
} satisfies Record<string, readonly number[]>);

export class AgentBackupCaptureV2HttpError extends Error {
  override readonly name = "AgentBackupCaptureV2HttpError";

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown; status?: number; remoteCode?: string },
  ) {
    super(message, { cause: options?.cause });
    this.status = options?.status;
    this.remoteCode = options?.remoteCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  readonly status: number | undefined;
  readonly remoteCode: string | undefined;
}

export interface OpenAgentBackupCaptureV2Input {
  /** Already-authorized, SSRF-checked agent API base URL. */
  agentApiBaseUrl: string;
  apiToken: string;
  request: AgentBackupCaptureV2Request;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
}

function clientError(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupCaptureV2HttpError(code, message, { cause });
}

function sha256Digest(bytes: Uint8Array): Uint8Array {
  return createHash("sha256").update(bytes).digest();
}

function sha256StreamFactory(): {
  update(bytes: Uint8Array): void;
  digestHex(): string;
} {
  const hash = createHash("sha256");
  return {
    update(bytes): void {
      hash.update(bytes);
    },
    digestHex(): string {
      return hash.digest("hex");
    },
  };
}

function resolveCaptureUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (cause) {
    clientError("AGENT_BACKUP_V2_INVALID_ENDPOINT", "Agent capture-v2 base URL is invalid", cause);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    clientError(
      "AGENT_BACKUP_V2_INVALID_ENDPOINT",
      "Agent capture-v2 requires an HTTP(S) endpoint",
    );
  }
  parsed.username = "";
  parsed.password = "";
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${normalizedPath}/api/snapshot/v2`.replace(/^\/\//, "/");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function abortError(signal: AbortSignal): AgentBackupCaptureV2HttpError {
  return new AgentBackupCaptureV2HttpError(
    "AGENT_BACKUP_V2_HTTP_ABORTED",
    "Agent capture-v2 HTTP request was cancelled",
    { cause: signal.reason },
  );
}

function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  deadlineEpochMs: number,
  now: () => number,
): { signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const remainingMs = deadlineEpochMs - now();
  if (remainingMs <= 0) {
    clientError("AGENT_BACKUP_V2_HTTP_DEADLINE_EXCEEDED", "Agent capture-v2 deadline has expired");
  }
  const deadlineTimer = setTimeout(
    () =>
      controller.abort(
        new AgentBackupCaptureV2HttpError(
          "AGENT_BACKUP_V2_HTTP_DEADLINE_EXCEEDED",
          "Agent capture-v2 HTTP deadline exceeded",
        ),
      ),
    Math.min(remainingMs, 2_147_483_647),
  );
  const onAbort = (): void => {
    if (!controller.signal.aborted && callerSignal) {
      controller.abort(abortError(callerSignal));
    }
  };
  callerSignal?.addEventListener("abort", onAbort, { once: true });
  if (callerSignal?.aborted) onAbort();
  return {
    signal: controller.signal,
    close(): void {
      clearTimeout(deadlineTimer);
      callerSignal?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBoundedErrorBody(
  response: Response,
): Promise<{ excerpt: string; remoteCode?: string }> {
  if (!response.body) return { excerpt: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let result = "";
  let complete = false;
  try {
    while (received <= MAX_ERROR_BODY_BYTES) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      if (next.value.byteLength === 0) continue;
      const take = Math.min(next.value.byteLength, MAX_ERROR_BODY_BYTES - received);
      result += decoder.decode(next.value.subarray(0, take), { stream: true });
      received += take;
      if (take !== next.value.byteLength || received === MAX_ERROR_BODY_BYTES) break;
    }
    result += decoder.decode();
  } catch {
    return { excerpt: "" };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const excerpt = result.replace(/[\r\n\t]+/g, " ").trim();
  if (
    !complete ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
  ) {
    return { excerpt };
  }
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { excerpt };
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "code,error" ||
      typeof record.code !== "string" ||
      typeof record.error !== "string" ||
      record.error.length > 2_048
    ) {
      return { excerpt };
    }
    const expectedStatuses = Reflect.get(REMOTE_CAPTURE_FAILURE_STATUS, record.code) as
      | readonly number[]
      | undefined;
    if (!expectedStatuses?.includes(response.status)) return { excerpt };
    return { excerpt, remoteCode: record.code };
  } catch {
    return { excerpt };
  }
}

async function* responseBytes(response: Response, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!response.body) {
    clientError("AGENT_BACKUP_V2_HTTP_BODY_MISSING", "Agent capture-v2 response has no body");
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      if (signal.aborted) throw abortError(signal);
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) {
        clientError(
          "AGENT_BACKUP_V2_HTTP_ZERO_PROGRESS",
          "Agent capture-v2 response yielded an empty transport chunk",
        );
      }
      if (next.value.byteLength > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxIngressChunkBytes) {
        clientError(
          "AGENT_BACKUP_V2_HTTP_CHUNK_TOO_LARGE",
          "Agent capture-v2 response exceeded its ingress chunk bound",
        );
      }
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Open and parse one capture-v2 response. The generator pulls at most one
 * transport frame ahead, preserving response-stream backpressure.
 */
export async function* openAgentBackupCaptureV2(
  input: Readonly<OpenAgentBackupCaptureV2Input>,
): AsyncGenerator<AgentBackupCaptureV2Frame> {
  const request = parseAgentBackupCaptureV2Request(input.request);
  const token = input.apiToken.trim();
  if (!token) {
    clientError("AGENT_BACKUP_V2_HTTP_AUTH_MISSING", "Agent capture-v2 requires an API token");
  }
  const now = input.now ?? Date.now;
  if (request.deadlineEpochMs - now() > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs) {
    clientError(
      "AGENT_BACKUP_V2_HTTP_INVALID_DEADLINE",
      "Agent capture-v2 deadline is too far in the future",
    );
  }
  const control = combineAbortSignals(input.signal, request.deadlineEpochMs, now);
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(resolveCaptureUrl(input.agentApiBaseUrl), {
      method: "POST",
      redirect: "manual",
      signal: control.signal,
      headers: {
        Accept: AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Api-Key": token,
        "X-Eliza-Token": token,
      },
      body: JSON.stringify(request),
    });
  } catch (cause) {
    control.close();
    if (control.signal.aborted) throw abortError(control.signal);
    clientError(
      "AGENT_BACKUP_V2_HTTP_REQUEST_FAILED",
      "Agent capture-v2 HTTP request failed",
      cause,
    );
  }

  try {
    if (response.status >= 300 && response.status < 400) {
      clientError(
        "AGENT_BACKUP_V2_HTTP_REDIRECT_REJECTED",
        "Agent capture-v2 refused an HTTP redirect",
      );
    }
    if (!response.ok) {
      const failure = await readBoundedErrorBody(response);
      throw new AgentBackupCaptureV2HttpError(
        "AGENT_BACKUP_V2_HTTP_STATUS",
        `Agent capture-v2 returned HTTP ${response.status}${failure.excerpt ? `: ${failure.excerpt}` : ""}`,
        { status: response.status, remoteCode: failure.remoteCode },
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE) {
      clientError(
        "AGENT_BACKUP_V2_HTTP_CONTENT_TYPE",
        "Agent capture-v2 returned an unexpected content type",
      );
    }
    if (response.headers.get("x-eliza-backup-operation-id") !== request.operationId) {
      clientError(
        "AGENT_BACKUP_V2_HTTP_OPERATION_MISMATCH",
        "Agent capture-v2 response operation fence does not match",
      );
    }

    let first = true;
    for await (const frame of parseAgentBackupCaptureV2Frames(
      responseBytes(response, control.signal),
      { digest: sha256Digest, sha256StreamFactory },
    )) {
      if (first) {
        first = false;
        if (
          frame.header.kind !== "capture-start" ||
          frame.header.operationId !== request.operationId ||
          frame.header.agentId !== request.agentId ||
          frame.header.activationGeneration !== request.activationGeneration ||
          frame.header.lifecycleRevision !== request.lifecycleRevision
        ) {
          clientError(
            "AGENT_BACKUP_V2_HTTP_FENCE_MISMATCH",
            "Agent capture-v2 stream identity fences do not match the request",
          );
        }
      }
      yield frame;
    }
    if (first) {
      clientError("AGENT_BACKUP_V2_HTTP_EMPTY_STREAM", "Agent capture-v2 returned no frames");
    }
  } finally {
    control.close();
  }
}
