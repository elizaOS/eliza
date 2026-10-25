/**
 * GitHub OAuth device-flow state for the LifeOps credential dashboard.
 *
 * The browser receives only the short user code and an opaque local flow id;
 * the device code stays in server memory until GitHub returns a token or the
 * ten-minute flow expires. Network access is injectable so protocol behavior
 * is covered without contacting GitHub in deterministic tests.
 */
import { randomBytes } from "node:crypto";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_SCOPE = "repo read:user";
const pendingFlows = new Map();

function protocolError(label, response, payload) {
  const providerError =
    typeof payload?.error === "string" ? ` (${payload.error})` : "";
  return new Error(`${label} failed: HTTP ${response.status}${providerError}`);
}

async function jsonResponse(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
  if (!response.ok) throw protocolError(label, response, payload);
  return payload;
}

function requireString(payload, key, label) {
  const value = payload?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} response is missing ${key}`);
  }
  return value.trim();
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function sweepExpired(nowMs) {
  for (const [flowId, flow] of pendingFlows) {
    if (nowMs >= flow.expiresAtMs) pendingFlows.delete(flowId);
  }
}

export async function startGitHubDeviceLogin({
  clientId,
  target,
  fetchFn = fetch,
  now = Date.now,
  randomBytesFn = randomBytes,
}) {
  if (typeof clientId !== "string" || clientId.trim().length === 0) {
    throw new Error(
      "GitHub device login needs owner setup: GITHUB_OAUTH_CLIENT_ID is absent",
    );
  }
  if (target !== "home" && target !== "repo") {
    throw new Error('GitHub device login target must be "home" or "repo"');
  }
  const response = await fetchFn(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId.trim(),
      scope: DEFAULT_SCOPE,
    }).toString(),
  });
  const payload = await jsonResponse(response, "GitHub device-code request");
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
  const nowMs = now();
  sweepExpired(nowMs);
  const flowId = randomBytesFn(24).toString("base64url");
  pendingFlows.set(flowId, {
    clientId: clientId.trim(),
    deviceCode,
    target,
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

export async function pollGitHubDeviceLogin({
  flowId,
  fetchFn = fetch,
  now = Date.now,
}) {
  const nowMs = now();
  sweepExpired(nowMs);
  const flow = pendingFlows.get(flowId);
  if (!flow) {
    throw new Error("GitHub device login is unknown or expired");
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
  const response = await fetchFn(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: flow.clientId,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
  });
  const payload = await jsonResponse(response, "GitHub device-token request");
  if (
    typeof payload.access_token === "string" &&
    payload.access_token.length > 0
  ) {
    pendingFlows.delete(flowId);
    return {
      status: "complete",
      token: payload.access_token,
      target: flow.target,
      tokenType:
        typeof payload.token_type === "string" ? payload.token_type : "bearer",
      scope: typeof payload.scope === "string" ? payload.scope : "",
    };
  }
  if (payload.error === "authorization_pending") {
    return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
  }
  if (payload.error === "slow_down") {
    flow.intervalSeconds += 5;
    flow.nextPollAtMs = nowMs + flow.intervalSeconds * 1_000;
    return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
  }
  pendingFlows.delete(flowId);
  const code =
    typeof payload.error === "string" ? payload.error : "unknown_error";
  throw new Error(`GitHub device login failed: ${code}`);
}

export function clearGitHubDeviceLoginsForTest() {
  pendingFlows.clear();
}
