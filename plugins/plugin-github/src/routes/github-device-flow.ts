/**
 * Server-side GitHub OAuth device-flow state for the guided credential
 * onboarding routes (#15796). Same custody model as the LifeOps HITL
 * credential dashboard's device-login primitive (#15749,
 * `scripts/lifeops/github-device-login.mjs`): the browser only ever sees the
 * short `user_code` and an opaque local `flowId`; the GitHub `device_code`
 * (and later the access token, until the route layer persists it) stays in
 * server memory until GitHub issues a token or the flow expires.
 *
 * GitHub is polled lazily — only when a client asks for the flow's status —
 * so there is no background scheduler to leak; `nextPollAtMs` enforces
 * GitHub's minimum poll interval (including `slow_down` back-off) no matter
 * how aggressively a client polls. Network access is injectable so protocol
 * behavior is covered by tests that stub GitHub at the HTTP boundary without
 * touching github.com.
 */

import { randomBytes } from "node:crypto";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** Matches the PAT card's guidance and the #15749 primitive. */
const DEVICE_FLOW_SCOPE = "repo read:user";

/** Failure classes a device flow can end in — drives the route's HTTP status. */
export type DeviceFlowErrorCode =
  | "unknown_flow"
  | "authorization_declined"
  | "flow_expired"
  | "upstream_error";

/**
 * Typed terminal failure for a device flow. `httpStatus` is the status the
 * route boundary should respond with; the route must not collapse
 * user-caused ends (declined / expired) into upstream faults.
 */
export class DeviceFlowError extends Error {
  constructor(
    message: string,
    readonly code: DeviceFlowErrorCode,
    readonly httpStatus: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DeviceFlowError";
  }
}

export interface DeviceFlowStart {
  /** Opaque local handle the client polls with. Never GitHub's device_code. */
  flowId: string;
  /** Short code the user types at the verification URI. */
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type DeviceFlowPoll =
  | { status: "pending"; retryAfterSeconds: number }
  | { status: "complete"; token: string; tokenType: string; scope: string };

interface PendingFlow {
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  nextPollAtMs: number;
  expiresAtMs: number;
}

interface FlowIo {
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomBytesImpl?: typeof randomBytes;
}

const pendingFlows = new Map<string, PendingFlow>();

function sweepExpired(nowMs: number): void {
  for (const [flowId, flow] of pendingFlows) {
    if (nowMs >= flow.expiresAtMs) pendingFlows.delete(flowId);
  }
}

function upstreamError(label: string, cause?: unknown): DeviceFlowError {
  return new DeviceFlowError(
    `${label}. Try again.`,
    "upstream_error",
    502,
    cause === undefined ? undefined : { cause },
  );
}

async function postForm(
  url: string,
  form: Record<string, string>,
  label: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    // error-policy:J2 context-adding rethrow — a thrown fetch is GitHub being
    // unreachable, an upstream fault the route reports as 502 with the cause.
    throw upstreamError(`Could not reach GitHub (${label})`, err);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    // error-policy:J2 context-adding rethrow — an unparseable body from GitHub
    // is the same upstream fault class as an unreachable host.
    throw upstreamError(`GitHub returned a non-JSON ${label} response`, err);
  }
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  // GitHub's OAuth endpoints report protocol errors either as a non-2xx or as
  // a 200 with an `error` field; a non-2xx is always terminal here (the 200 +
  // `error` case is interpreted per-endpoint by the callers).
  if (!response.ok) {
    const providerError =
      typeof record.error === "string" ? ` (${record.error})` : "";
    throw upstreamError(
      `GitHub ${label} request failed: HTTP ${response.status}${providerError}`,
    );
  }
  return record;
}

function requireString(
  payload: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw upstreamError(`GitHub ${label} response is missing ${key}`);
  }
  return value.trim();
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Ask GitHub for a device code and register a pending flow. Returns only the
 * user-facing fields; the `device_code` never leaves this module.
 */
export async function startDeviceFlow(
  clientId: string,
  io: FlowIo = {},
): Promise<DeviceFlowStart> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const now = io.now ?? Date.now;
  const randomBytesImpl = io.randomBytesImpl ?? randomBytes;

  const payload = await postForm(
    DEVICE_CODE_URL,
    { client_id: clientId, scope: DEVICE_FLOW_SCOPE },
    "device-code",
    fetchImpl,
  );
  if (typeof payload.error === "string") {
    throw upstreamError(`GitHub device-code request failed (${payload.error})`);
  }
  const deviceCode = requireString(payload, "device_code", "device-code");
  const userCode = requireString(payload, "user_code", "device-code");
  const verificationUri = requireString(
    payload,
    "verification_uri",
    "device-code",
  );
  const intervalSeconds = positiveNumber(payload.interval, 5);
  const expiresInSeconds = positiveNumber(payload.expires_in, 900);

  const nowMs = now();
  sweepExpired(nowMs);
  const flowId = randomBytesImpl(24).toString("base64url");
  pendingFlows.set(flowId, {
    clientId,
    deviceCode,
    intervalSeconds,
    nextPollAtMs: nowMs,
    expiresAtMs: nowMs + expiresInSeconds * 1_000,
  });
  return {
    flowId,
    userCode,
    verificationUri,
    intervalSeconds,
    expiresInSeconds,
  };
}

/**
 * Poll GitHub for the flow's token, respecting the poll interval GitHub set
 * (a too-early call returns `pending` locally without contacting GitHub).
 * Terminal outcomes — declined, expired, upstream fault — throw a
 * {@link DeviceFlowError} and drop the flow; `complete` also drops it and
 * hands the token to the caller exactly once.
 */
export async function pollDeviceFlow(
  flowId: string,
  io: FlowIo = {},
): Promise<DeviceFlowPoll> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const now = io.now ?? Date.now;

  const nowMs = now();
  sweepExpired(nowMs);
  const flow = pendingFlows.get(flowId);
  if (!flow) {
    throw new DeviceFlowError(
      "This sign-in attempt is unknown or has expired. Start again.",
      "unknown_flow",
      404,
    );
  }
  if (nowMs < flow.nextPollAtMs) {
    return {
      status: "pending",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((flow.nextPollAtMs - nowMs) / 1_000),
      ),
    };
  }
  flow.nextPollAtMs = nowMs + flow.intervalSeconds * 1_000;

  let payload: Record<string, unknown>;
  try {
    payload = await postForm(
      ACCESS_TOKEN_URL,
      {
        client_id: flow.clientId,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      "device-token",
      fetchImpl,
    );
  } catch (err) {
    // error-policy:J2 context-adding rethrow — an upstream fault is
    // retryable: keep the flow alive so the next poll can succeed once
    // GitHub recovers, but still surface this poll's failure to the caller.
    if (err instanceof DeviceFlowError && err.code === "upstream_error") {
      throw err;
    }
    throw upstreamError("GitHub device-token request failed", err);
  }

  if (
    typeof payload.access_token === "string" &&
    payload.access_token.length > 0
  ) {
    pendingFlows.delete(flowId);
    return {
      status: "complete",
      token: payload.access_token,
      tokenType:
        typeof payload.token_type === "string" ? payload.token_type : "bearer",
      scope: typeof payload.scope === "string" ? payload.scope : "",
    };
  }
  if (payload.error === "authorization_pending") {
    return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
  }
  if (payload.error === "slow_down") {
    // GitHub's protocol: add 5 seconds to the interval for the rest of the flow.
    flow.intervalSeconds += 5;
    flow.nextPollAtMs = nowMs + flow.intervalSeconds * 1_000;
    return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
  }

  pendingFlows.delete(flowId);
  if (payload.error === "access_denied") {
    throw new DeviceFlowError(
      "GitHub sign-in was declined on github.com.",
      "authorization_declined",
      403,
    );
  }
  if (payload.error === "expired_token") {
    throw new DeviceFlowError(
      "The sign-in code expired before it was entered on github.com. Start again.",
      "flow_expired",
      410,
    );
  }
  const code =
    typeof payload.error === "string" ? payload.error : "unknown_error";
  throw upstreamError(`GitHub device login failed (${code})`);
}

/** Test-only: drop all pending flows so suites do not leak state. */
export function clearDeviceFlowsForTest(): void {
  pendingFlows.clear();
}
