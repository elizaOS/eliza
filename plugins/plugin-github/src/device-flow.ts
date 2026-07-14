/**
 * Server-owned GitHub OAuth device-flow state for guided agent connection.
 * Each flow is bound to one agent, only the newest flow for that agent remains
 * active, and the browser sees an opaque local handle rather than GitHub's
 * device code. Terminal outcomes consume the flow so grants cannot be replayed.
 */

import { randomBytes } from "node:crypto";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const OAUTH_REQUEST_TIMEOUT_MS = 10_000;
/** Matches the scopes the PAT card asks the user to grant a generated token. */
const DEFAULT_SCOPE = "repo read:user";

/** Error taxonomy for the routes: each code maps to one HTTP status. */
export type DeviceFlowErrorCode =
  /** flowId is not pending for this agent (never started, expired + swept, or another agent's). */
  | "unknown_flow"
  /** The OAuth app registration itself is wrong or device flow is disabled — owner setup. */
  | "owner_setup"
  /** A newer start request superseded this one before GitHub replied. */
  | "superseded"
  /** GitHub was unreachable or returned a malformed/unexpected response. */
  | "upstream";

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    readonly code: DeviceFlowErrorCode,
    /** HTTP status the route surfaces for this failure class. */
    readonly status: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DeviceFlowError";
  }
}

export interface DeviceFlowStart {
  /** Opaque server-local flow handle — NOT the GitHub device_code. */
  flowId: string;
  /** Short code the user types at the verification URI. */
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type DeviceFlowPollResult =
  /** User has not approved yet (or the server-owned interval hasn't elapsed). */
  | { status: "pending"; retryAfterSeconds: number }
  /** User approved; token granted. Flow is consumed. */
  | { status: "complete"; token: string; scope: string }
  /** User explicitly denied the request. Flow is consumed. */
  | { status: "denied" }
  /** The device code expired before the user approved. Flow is consumed. */
  | { status: "expired" };

export interface DeviceFlowCancelResult {
  status: "cancelled";
}

interface PendingFlow {
  agentKey: string;
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  nextPollAtMs: number;
  expiresAtMs: number;
}

const pendingFlows = new Map<string, PendingFlow>();
const activeFlowByAgent = new Map<string, string>();
const latestStartByAgent = new Map<string, number>();
let startSequence = 0;

interface FlowDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomBytesImpl?: typeof randomBytes;
  requestTimeoutMs?: number;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function requireString(
  payload: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DeviceFlowError(
      `${label} response is missing ${key}`,
      "upstream",
      502,
    );
  }
  return value.trim();
}

async function postForm(
  url: string,
  form: Record<string, string>,
  label: string,
  fetchImpl: typeof fetch,
  requestTimeoutMs: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    // error-policy:J2 context-adding rethrow — a network failure reaching
    // GitHub is an upstream-reachability problem, typed 502 with the cause.
    throw new DeviceFlowError(
      `${label} failed: could not reach GitHub`,
      "upstream",
      502,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new DeviceFlowError(
      `${label} returned invalid JSON (HTTP ${response.status})`,
      "upstream",
      502,
      { cause: err },
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DeviceFlowError(
      `${label} returned a non-object body (HTTP ${response.status})`,
      "upstream",
      502,
    );
  }
  const record = payload as Record<string, unknown>;
  if (!response.ok) {
    const providerError =
      typeof record.error === "string" ? ` (${record.error})` : "";
    throw new DeviceFlowError(
      `${label} failed: HTTP ${response.status}${providerError}`,
      "upstream",
      502,
    );
  }
  return record;
}

function sweepExpired(nowMs: number): void {
  for (const [flowId, flow] of pendingFlows) {
    if (nowMs >= flow.expiresAtMs) removeFlow(flowId, flow);
  }
}

function removeFlow(flowId: string, flow: PendingFlow): void {
  pendingFlows.delete(flowId);
  if (activeFlowByAgent.get(flow.agentKey) === flowId) {
    activeFlowByAgent.delete(flow.agentKey);
  }
}

function requireAgentKey(agentKey: string): string {
  const normalized = agentKey.trim();
  if (!normalized) {
    throw new DeviceFlowError(
      "GitHub device sign-in requires an agent id.",
      "unknown_flow",
      400,
    );
  }
  return normalized;
}

function ownedFlow(flowId: string, agentKey: string): PendingFlow {
  const flow = pendingFlows.get(flowId);
  // Deliberately use the same response for absent and foreign flows so this
  // endpoint cannot be used as an oracle for another agent's active sign-in.
  if (!flow || flow.agentKey !== agentKey) {
    throw new DeviceFlowError(
      "GitHub sign-in flow is unknown or expired. Start a new sign-in.",
      "unknown_flow",
      404,
    );
  }
  return flow;
}

/**
 * Start a device flow: ask GitHub for a device+user code pair, keep the
 * device code server-side, and hand back the user-visible half.
 */
export async function startDeviceFlow(options: {
  clientId: string;
  /** Identity of the agent runtime that owns this flow (agentId). */
  agentKey: string;
  deps?: FlowDeps;
}): Promise<DeviceFlowStart> {
  const { clientId, deps } = options;
  const agentKey = requireAgentKey(options.agentKey);
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const now = deps?.now ?? Date.now;
  const randomBytesImpl = deps?.randomBytesImpl ?? randomBytes;
  const requestTimeoutMs = deps?.requestTimeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS;
  const sequence = ++startSequence;
  latestStartByAgent.set(agentKey, sequence);

  const payload = await postForm(
    DEVICE_CODE_URL,
    { client_id: clientId.trim(), scope: DEFAULT_SCOPE },
    "GitHub device-code request",
    fetchImpl,
    requestTimeoutMs,
  );
  // GitHub returns 200 for a bad/unregistered client id with an error body.
  if (typeof payload.error === "string") {
    throw new DeviceFlowError(
      `GitHub rejected the device-flow client registration (${payload.error}). ` +
        "Check GITHUB_OAUTH_CLIENT_ID and that the OAuth app has device flow enabled.",
      "owner_setup",
      409,
    );
  }
  const deviceCode = requireString(
    payload,
    "device_code",
    "GitHub device-code",
  );
  const userCode = requireString(payload, "user_code", "GitHub device-code");
  const verificationUri = requireString(
    payload,
    "verification_uri",
    "GitHub device-code",
  );
  const intervalSeconds = positiveNumber(payload.interval, 5);
  const expiresInSeconds = positiveNumber(payload.expires_in, 900);

  if (latestStartByAgent.get(agentKey) !== sequence) {
    throw new DeviceFlowError(
      "A newer GitHub sign-in replaced this request.",
      "superseded",
      409,
    );
  }

  const nowMs = now();
  sweepExpired(nowMs);
  const flowId = randomBytesImpl(24).toString("base64url");
  const priorFlowId = activeFlowByAgent.get(agentKey);
  if (priorFlowId) {
    const priorFlow = pendingFlows.get(priorFlowId);
    if (priorFlow) removeFlow(priorFlowId, priorFlow);
  }
  pendingFlows.set(flowId, {
    agentKey,
    clientId: clientId.trim(),
    deviceCode,
    intervalSeconds,
    nextPollAtMs: nowMs,
    expiresAtMs: nowMs + expiresInSeconds * 1_000,
  });
  activeFlowByAgent.set(agentKey, flowId);
  return {
    flowId,
    userCode,
    verificationUri,
    intervalSeconds,
    expiresInSeconds,
  };
}

/**
 * Poll a pending flow once. Honors GitHub's server-owned polling interval
 * (early polls return `pending` without touching the network) and the
 * `slow_down` back-off. Terminal outcomes (`complete`, `denied`, `expired`)
 * consume the flow.
 */
export async function pollDeviceFlow(options: {
  flowId: string;
  /** Must match the agentKey the flow was started with. */
  agentKey: string;
  deps?: FlowDeps;
}): Promise<DeviceFlowPollResult> {
  const { flowId, deps } = options;
  const agentKey = requireAgentKey(options.agentKey);
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const now = deps?.now ?? Date.now;
  const requestTimeoutMs = deps?.requestTimeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS;

  const nowMs = now();
  const flow = ownedFlow(flowId, agentKey);
  if (nowMs >= flow.expiresAtMs) {
    removeFlow(flowId, flow);
    return { status: "expired" };
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

  const payload = await postForm(
    ACCESS_TOKEN_URL,
    {
      client_id: flow.clientId,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    "GitHub device-token request",
    fetchImpl,
    requestTimeoutMs,
  );

  // A cancellation or newer start can run while the token request is in
  // flight. Re-check the exact flow object before accepting GitHub's response;
  // otherwise a cancelled request could revive itself and persist a token.
  if (pendingFlows.get(flowId) !== flow) {
    throw new DeviceFlowError(
      "GitHub sign-in flow is unknown or expired. Start a new sign-in.",
      "unknown_flow",
      404,
    );
  }

  if (
    typeof payload.access_token === "string" &&
    payload.access_token.length > 0
  ) {
    removeFlow(flowId, flow);
    return {
      status: "complete",
      token: payload.access_token,
      scope: typeof payload.scope === "string" ? payload.scope : "",
    };
  }
  const errorCode = typeof payload.error === "string" ? payload.error : "";
  if (errorCode === "authorization_pending") {
    return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
  }
  if (errorCode === "slow_down") {
    flow.intervalSeconds += 5;
    flow.nextPollAtMs = nowMs + flow.intervalSeconds * 1_000;
    return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
  }
  // Every remaining GitHub error is terminal for this flow.
  removeFlow(flowId, flow);
  if (errorCode === "access_denied") {
    return { status: "denied" };
  }
  if (errorCode === "expired_token") {
    return { status: "expired" };
  }
  if (
    errorCode === "incorrect_client_credentials" ||
    errorCode === "device_flow_disabled" ||
    errorCode === "unsupported_grant_type"
  ) {
    throw new DeviceFlowError(
      `GitHub rejected the device-flow client registration (${errorCode}). ` +
        "Check GITHUB_OAUTH_CLIENT_ID and that the OAuth app has device flow enabled.",
      "owner_setup",
      409,
    );
  }
  throw new DeviceFlowError(
    `GitHub device sign-in failed: ${errorCode || "unknown_error"}`,
    "upstream",
    502,
  );
}

/** Cancel an owned flow immediately; a later poll cannot revive it. */
export function cancelDeviceFlow(options: {
  flowId: string;
  agentKey: string;
}): DeviceFlowCancelResult {
  const agentKey = requireAgentKey(options.agentKey);
  const flow = ownedFlow(options.flowId, agentKey);
  removeFlow(options.flowId, flow);
  return { status: "cancelled" };
}

/** Test hook: drop all pending flows so suites are order-independent. */
export function clearDeviceFlowsForTest(): void {
  pendingFlows.clear();
  activeFlowByAgent.clear();
  latestStartByAgent.clear();
  startSequence = 0;
}
