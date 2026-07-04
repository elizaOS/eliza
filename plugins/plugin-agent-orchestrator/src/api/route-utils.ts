/**
 * Shared HTTP plumbing for the orchestrator route modules: the `RouteContext`
 * bundle (runtime plus the ACP and workspace services), request-body parsing,
 * typed value coercers for untrusted JSON fields, and the JSON / error /
 * service-unavailable response senders.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import type { AcpActionService } from "../actions/common.js";
import type { CodingWorkspaceService } from "../services/workspace-service.js";

export interface RouteContext {
  runtime: IAgentRuntime;
  acpService: AcpActionService | null;
  workspaceService: CodingWorkspaceService | null;
}

// Max request body size (1 MB)
const MAX_BODY_SIZE = 1024 * 1024;

/**
 * Parse the JSON request body.
 *
 * The elizaOS runtime route dispatcher parses JSON bodies and attaches the
 * result to `req.body` before invoking `rawPath` handlers (see
 * `@elizaos/core` `readJsonBody`), draining the request stream in the process.
 * Re-reading that already-ended stream would hang forever, so we return the
 * pre-parsed body when present and only fall back to reading the stream for
 * direct callers (e.g. unit tests) that pass an unconsumed request.
 */
export async function parseBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (preParsed != null) {
    if (typeof preParsed === "object" && !Array.isArray(preParsed)) {
      return preParsed as Record<string, unknown>;
    }
    throw new Error("Invalid JSON body");
  }

  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      size += typeof chunk === "string" ? chunk.length : chunk.byteLength;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        // error-policy:J3 untrusted-input sanitizing; malformed JSON rejects with
        // a typed invalid-body error, never a fabricated empty object.
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Boundary coercion helpers for JSON request bodies. Route handlers receive
 * untyped `parseBody` output, so casting `body.x as string` lets a client send
 * `{repo: 123}` straight through to a service call. These validate first and
 * return `undefined` on a type mismatch, so a handler can reject cleanly.
 */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** A boolean, never a truthy string ("false"/"no"/"0" must not become `true`). */
export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Trimmed non-empty strings from an array; undefined if not an array, [] if the
 *  array holds no usable strings. */
export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return items.length > 0 ? items.map((s) => s.trim()) : [];
}

/** A finite number from a number or numeric string; rejects NaN/Infinity. */
export function asFiniteNumber(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

// Helper to send JSON response
export function sendJson(
  res: ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Helper to send error
export function sendError(
  res: ServerResponse,
  message: string,
  status = 400,
): void {
  sendJson(res, { error: message }, status);
}

/**
 * Default backoff hint for clients polling a route whose backing service is
 * still starting. The orchestrator's services (`ACP_SUBPROCESS_SERVICE`,
 * `ORCHESTRATOR_TASK_SERVICE`) register lazily and finish `start()` a short
 * time after the runtime's routes go live, so there is a brief window where a
 * matched route has no service to serve. One second is long enough to avoid a
 * tight retry loop and short enough that the UI recovers promptly.
 */
const SERVICE_INITIALIZING_RETRY_AFTER_MS = 1000;

/**
 * Send a 503 that honestly reports the backing service is still initializing,
 * with a quiet-backoff signal for polling clients. This is NOT an empty-data
 * fallback — the request genuinely cannot be served yet, so the status stays
 * 503/unavailable. The `Retry-After` header (HTTP spec: integer seconds) plus
 * the machine-readable `{ status: "initializing", retryAfterMs }` body let the
 * dashboard back off instead of hammering the endpoint during the startup
 * window. Callers pass the same human-readable message they would give
 * `sendError(..., 503)`.
 */
export function sendServiceUnavailable(
  res: ServerResponse,
  message: string,
  retryAfterMs = SERVICE_INITIALIZING_RETRY_AFTER_MS,
): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.writeHead(503, {
    "Content-Type": "application/json",
    "Retry-After": String(retryAfterSeconds),
  });
  res.end(
    JSON.stringify({ error: message, status: "initializing", retryAfterMs }),
  );
}
