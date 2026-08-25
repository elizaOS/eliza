/**
 * Maps remote commands onto a deliberately tiny loopback API allowlist. It
 * never exposes a generic URL, filesystem, process, or shell primitive and
 * rejects every action except the read-only agent status probe.
 */
import type { RemoteJsonValue } from "@elizaos/shared/contracts/remote-control";
import type {
  RemoteTargetCommandExecutor,
  RemoteTargetEffectResult,
} from "./remote-target-runner";
import type { RemoteTargetFetch } from "./remote-target-transport";

const LOCAL_RESPONSE_LIMIT_BYTES = 262_144;
const LOCAL_REQUEST_TIMEOUT_MS = 5_000;

export function normalizeRemoteTargetLoopbackBase(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Remote target local API must be loopback-only HTTP.");
  }
  return url.toString().replace(/\/$/, "");
}

function isEmptyObject(value: RemoteJsonValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function isAllowlistedStatusRequest(value: RemoteJsonValue): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["path", "method", "headers"].includes(key))) {
    return false;
  }
  const path = value.path;
  const method = value.method;
  const headers = value.headers;
  return (
    (path === "/api/health" || path === "/api/status") &&
    method === "GET" &&
    (headers === undefined || isEmptyObject(headers))
  );
}

export class LoopbackRemoteTargetExecutor
  implements RemoteTargetCommandExecutor
{
  private readonly apiBase: string;

  constructor(input: {
    apiBase: string;
    apiToken: string;
    fetchImpl?: RemoteTargetFetch;
    timeoutMs?: number;
  }) {
    this.apiBase = normalizeRemoteTargetLoopbackBase(input.apiBase);
    if (input.apiToken.trim().length < 16) {
      throw new Error("Remote target local API authentication is unavailable.");
    }
    this.apiToken = input.apiToken;
    this.fetchImpl = input.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = input.timeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS;
  }

  private readonly apiToken: string;
  private readonly fetchImpl: RemoteTargetFetch;
  private readonly timeoutMs: number;

  async execute(input: {
    action:
      | "agent.request"
      | "agent.message"
      | "agent.pause"
      | "agent.resume"
      | "agent.stop"
      | "agent.status";
    payload: RemoteJsonValue;
    executionId: string;
  }): Promise<RemoteTargetEffectResult> {
    const statusRequest =
      (input.action === "agent.status" && isEmptyObject(input.payload)) ||
      (input.action === "agent.request" &&
        isAllowlistedStatusRequest(input.payload));
    if (!statusRequest) {
      return {
        status: "rejected",
        errorCode: "REMOTE_ACTION_NOT_ALLOWLISTED",
      };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const path =
        input.action === "agent.request" &&
        typeof input.payload === "object" &&
        input.payload !== null &&
        !Array.isArray(input.payload)
          ? String(input.payload.path)
          : "/api/health";
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "X-Eliza-Remote-Execution-Id": input.executionId,
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > LOCAL_RESPONSE_LIMIT_BYTES) {
        return {
          status: "rejected",
          errorCode: "REMOTE_LOCAL_STATUS_UNAVAILABLE",
        };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            total += item.value.byteLength;
            if (total > LOCAL_RESPONSE_LIMIT_BYTES) {
              await reader.cancel();
              return {
                status: "rejected",
                errorCode: "REMOTE_LOCAL_STATUS_TOO_LARGE",
              };
            }
            chunks.push(item.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        // error-policy:J3 local HTTP bytes still cross an untrusted boundary.
        return {
          status: "rejected",
          errorCode: "REMOTE_LOCAL_STATUS_INVALID",
        };
      }
      const contentType = response.headers.get("content-type");
      const headers: Record<string, string> = {};
      if (contentType && contentType.length <= 256) {
        headers["content-type"] = contentType;
      }
      return {
        status: "completed",
        result: {
          status: response.status,
          body,
          headers,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const remoteTargetExecutorInternals = {
  LOCAL_RESPONSE_LIMIT_BYTES,
  normalizeLoopbackBase: normalizeRemoteTargetLoopbackBase,
  isAllowlistedStatusRequest,
};
