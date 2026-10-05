/**
 * Discord user-OAuth authorization-code flow state for the LifeOps credential
 * dashboard (#14792). This is deliberately an HITL identity/probe path — the
 * runtime connector's canonical product flow remains bot installation plus
 * `/eliza-pair` — so the flow acquires a short-lived `identify`-scoped user
 * token over the dashboard's own loopback redirect and nothing more.
 *
 * The browser receives only the authorize URL and an opaque local flow id;
 * the CSRF state, client secret, and access token stay in server memory.
 * The callback exchange runs server-side, the token is handed to the caller
 * exactly once for persistence, and the completed flow retains only a masked
 * tail plus the Discord username. Network access is injectable so protocol
 * behavior is covered without contacting Discord in deterministic tests.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const IDENTITY_URL = "https://discord.com/api/v10/users/@me";
const DEFAULT_SCOPE = "identify";
const FLOW_TTL_MS = 10 * 60 * 1_000;
const pendingFlows = new Map();

function stateMatches(candidate, expected) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sweepExpired(nowMs) {
  for (const [flowId, flow] of pendingFlows) {
    if (nowMs >= flow.expiresAtMs) pendingFlows.delete(flowId);
  }
}

function findFlowByState(state) {
  for (const [flowId, flow] of pendingFlows) {
    if (flow.status === "pending" && stateMatches(state, flow.state)) {
      return { flowId, flow };
    }
  }
  return null;
}

async function jsonResponse(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    // error-policy:J2 provider bodies are untrusted; unparseable JSON becomes a typed protocol error with cause.
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
  if (!response.ok) {
    const providerError =
      typeof payload?.error === "string" ? ` (${payload.error})` : "";
    throw new Error(`${label} failed: HTTP ${response.status}${providerError}`);
  }
  return payload;
}

/**
 * Registers a pending flow and builds the Discord authorize URL. Throws when
 * the OAuth app registration is absent — the dashboard renders that as the
 * designed needs-owner-setup state, never as a broken flow.
 */
export function startDiscordOAuthLogin({
  clientId,
  redirectUri,
  target,
  now = Date.now,
  randomBytesFn = randomBytes,
}) {
  if (typeof clientId !== "string" || clientId.trim().length === 0) {
    throw new Error(
      "Discord user OAuth needs owner setup: DISCORD_CLIENT_ID is absent",
    );
  }
  if (typeof redirectUri !== "string" || !redirectUri.startsWith("http")) {
    throw new Error("Discord user OAuth requires a loopback redirect URI");
  }
  if (target !== "home" && target !== "repo") {
    throw new Error('Discord user OAuth target must be "home" or "repo"');
  }
  const nowMs = now();
  sweepExpired(nowMs);
  const flowId = randomBytesFn(24).toString("base64url");
  const state = randomBytesFn(24).toString("base64url");
  pendingFlows.set(flowId, {
    status: "pending",
    clientId: clientId.trim(),
    redirectUri,
    state,
    target,
    expiresAtMs: nowMs + FLOW_TTL_MS,
  });
  const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: clientId.trim(),
    response_type: "code",
    redirect_uri: redirectUri,
    scope: DEFAULT_SCOPE,
    state,
    prompt: "consent",
  }).toString()}`;
  return { flowId, authorizeUrl, redirectUri };
}

/**
 * Handles the loopback callback leg: matches the CSRF state to a pending
 * flow, exchanges the code server-side, and fetches the Discord identity.
 * Returns `{ outcome: "complete", token, ... }` exactly once — the caller
 * persists the token and reports back via {@link markDiscordFlowSaved} so the
 * poll surface only ever sees masked data. A denial or protocol failure is a
 * typed outcome on the flow, never a thrown-away error.
 */
export async function completeDiscordOAuthCallback({
  state,
  code,
  providerError,
  clientSecret,
  fetchFn = fetch,
  now = Date.now,
}) {
  sweepExpired(now());
  const match = findFlowByState(state);
  if (!match) {
    return { outcome: "unknown-state" };
  }
  const { flow } = match;
  if (typeof providerError === "string" && providerError.length > 0) {
    flow.status = providerError === "access_denied" ? "denied" : "error";
    flow.detail =
      providerError === "access_denied"
        ? "authorization was denied on Discord"
        : `Discord returned error: ${providerError}`;
    return { outcome: flow.status, detail: flow.detail };
  }
  if (typeof code !== "string" || code.length === 0) {
    flow.status = "error";
    flow.detail = "Discord callback carried no authorization code";
    return { outcome: "error", detail: flow.detail };
  }
  if (typeof clientSecret !== "string" || clientSecret.trim().length === 0) {
    flow.status = "error";
    flow.detail = "DISCORD_CLIENT_SECRET is absent; cannot exchange the code";
    return { outcome: "error", detail: flow.detail };
  }
  let token;
  let identity;
  try {
    const tokenPayload = await jsonResponse(
      await fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: flow.clientId,
          client_secret: clientSecret.trim(),
          grant_type: "authorization_code",
          code,
          redirect_uri: flow.redirectUri,
        }).toString(),
      }),
      "Discord token exchange",
    );
    if (
      typeof tokenPayload.access_token !== "string" ||
      tokenPayload.access_token.length === 0
    ) {
      throw new Error("Discord token exchange returned no access_token");
    }
    token = tokenPayload.access_token;
    const identityPayload = await jsonResponse(
      await fetchFn(IDENTITY_URL, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      "Discord identity request",
    );
    identity =
      typeof identityPayload.username === "string"
        ? identityPayload.username
        : "unknown";
  } catch (error) {
    // error-policy:J3 provider exchange failures become a typed flow outcome the poll surface renders; no fake-valid token exists.
    flow.status = "error";
    flow.detail = error instanceof Error ? error.message : String(error);
    return { outcome: "error", detail: flow.detail };
  }
  flow.status = "exchanged";
  flow.username = identity;
  return {
    outcome: "complete",
    token,
    username: identity,
    target: flow.target,
    flowId: match.flowId,
  };
}

/** Records the post-persist masked result so polls never see the token. */
export function markDiscordFlowSaved(flowId, { masked, key, target }) {
  const flow = pendingFlows.get(flowId);
  if (!flow) return;
  flow.status = "complete";
  flow.masked = masked;
  flow.key = key;
  flow.target = target;
}

/** Poll surface for the dashboard page; completed flows are single-read. */
export function pollDiscordOAuthLogin({ flowId, now = Date.now }) {
  sweepExpired(now());
  const flow = pendingFlows.get(flowId);
  if (!flow) {
    return { status: "expired", detail: "flow is unknown or expired" };
  }
  if (flow.status === "pending" || flow.status === "exchanged") {
    return { status: "pending", retryAfterSeconds: 2 };
  }
  pendingFlows.delete(flowId);
  if (flow.status === "complete") {
    return {
      status: "complete",
      key: flow.key,
      masked: flow.masked,
      target: flow.target,
      username: flow.username,
    };
  }
  return { status: flow.status, detail: flow.detail };
}

export function clearDiscordOAuthLoginsForTest() {
  pendingFlows.clear();
}
