/**
 * Main-process handler for the desktop local-agent IPC transport (#12180 phase
 * 2 / #12355). The renderer's `desktop-local-agent-transport` calls the
 * `localAgentRequest` Electrobun RPC method with an agent-relative path; this
 * module normalizes that request and forwards it to the on-device runtime over a
 * `LocalAgentDispatcher` seam — never a loopback socket. In local-agent IPC mode
 * the agent binds no TCP listener (`ELIZA_DESKTOP_LOCAL_AGENT_IPC=1` →
 * `localAgentMode`), so the dispatcher rides the child's NDJSON stdio bridge.
 *
 * The path is validated to be agent-relative (`/api/...`), NOT an absolute URL:
 * IPC mode has no HTTP origin, so an absolute or non-relative path is a
 * programming error and rejected loudly rather than silently coerced. The
 * dispatcher is injected so the framing/normalization logic is exercised in unit
 * tests without a spawned child, and so a future streaming dispatcher plugs into
 * the same seam.
 */

import type {
  LocalAgentRequestOptions,
  LocalAgentRequestResult,
} from "./rpc-schema";

/**
 * Buffered local-agent request the main process forwards to the on-device
 * runtime. `path` is agent-relative and already validated; the dispatcher joins
 * it to the in-process route kernel over whichever transport it owns (child
 * stdio bridge today).
 */
export interface NormalizedLocalAgentRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs?: number;
}

/**
 * Transport seam between the `localAgentRequest` RPC handler and the on-device
 * runtime. Implementations own the actual bytes (NDJSON stdio frames to the
 * agent child, an in-process `dispatchRoute` call in tests, etc.). A rejected
 * promise surfaces to the renderer as a thrown RPC error — the handler never
 * swallows a dispatch failure into a synthetic success response, because that
 * would hide a broken pipeline behind a fake 200.
 */
export interface LocalAgentDispatcher {
  request(
    request: NormalizedLocalAgentRequest,
  ): Promise<LocalAgentRequestResult>;
}

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

/**
 * Validate and normalize raw `localAgentRequest` params. Throws on a missing or
 * non-relative path, or a body sent with a method that forbids one — an IPC
 * request that assumes an HTTP origin is a bug, not something to paper over.
 */
export function normalizeLocalAgentRequest(
  params: unknown,
): NormalizedLocalAgentRequest {
  if (!params || typeof params !== "object") {
    throw new Error("localAgentRequest params must be an object.");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error("localAgentRequest path must be a non-empty string.");
  }
  if (!record.path.startsWith("/")) {
    throw new Error(
      `localAgentRequest path must be agent-relative (start with "/"); got "${record.path}". Local-agent IPC mode has no HTTP origin.`,
    );
  }

  const method =
    typeof record.method === "string" && record.method.length > 0
      ? record.method.toUpperCase()
      : "GET";

  const headers =
    record.headers && typeof record.headers === "object"
      ? Object.fromEntries(
          Object.entries(record.headers as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};

  const rawBody = typeof record.body === "string" ? record.body : null;
  if (rawBody !== null && METHODS_WITHOUT_BODY.has(method)) {
    throw new Error(
      `localAgentRequest method ${method} must not carry a body.`,
    );
  }
  const body = METHODS_WITHOUT_BODY.has(method) ? null : rawBody;

  const timeoutMs =
    typeof record.timeoutMs === "number" &&
    Number.isFinite(record.timeoutMs) &&
    record.timeoutMs > 0
      ? record.timeoutMs
      : undefined;

  return { path: record.path, method, headers, body, timeoutMs };
}

/**
 * Build the `localAgentRequest` RPC handler bound to `dispatcher`. Registered in
 * the Electrobun main-process RPC map; the renderer never reaches it unless the
 * api base is the `eliza-local-agent://ipc` scheme (local-agent IPC mode).
 */
export function createLocalAgentRequestHandler(
  dispatcher: LocalAgentDispatcher,
): (params: LocalAgentRequestOptions) => Promise<LocalAgentRequestResult> {
  return async (params) => {
    const normalized = normalizeLocalAgentRequest(params);
    return dispatcher.request(normalized);
  };
}
