import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { URL } from "node:url";
import type { AgentRuntime } from "@elizaos/core";
import { ethers } from "ethers";
import { getDiscoveryConfig } from "./config";
import { buildDistributionPlan } from "./distribution";
import { executeDistributionLane } from "./distribution-execution";
// ElizaCloud v1 calls live in ./elizacloud-api.ts (auth header rules, parsers, 429 retry) — why: testability
// and alignment with Cloud’s requireAuthOrApiKey order; see docs/elizacloud-integration.md.
import {
  elizaCloudAuthHeaders,
  fetchElizaCloudPrimaryAgentConfig,
  fetchElizaCloudCreditsBalance,
  fetchElizaCloudCreditsSummary,
  fetchElizaCloudUser,
  type ElizaCloudSummaryFields,
} from "./elizacloud-api";
import { persistDistributionExecutionState } from "./persist";
import { getLatestSnapshot } from "./store";
import type {
  CandidateDetail,
  DashboardSnapshot,
  PortfolioPositionDetail,
} from "./types";

const ELIZAOK_LOGO_ASSET_PATHS = [
  path.resolve(process.cwd(), "apps/elizaokbsc/assets/elizaok-logo.png"),
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-92579f8c-32e9-492a-b56b-cdefdd4c6858.png",
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-6b4ab8e2-1062-4421-a562-c21be524f0e5.png",
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-d9d36740-5e03-42ff-93d1-d93cb2e471ef.png",
];

const ELIZAOK_BANNER_ASSET_PATHS = [
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/1500x500-8f387aee-fe62-46d8-8506-4aa8e185618b.png",
];

async function loadSnapshotFromDisk(
  reportsDir: string,
): Promise<DashboardSnapshot | null> {
  const snapshotPath = path.join(process.cwd(), reportsDir, "latest.json");
  try {
    const content = await readFile(snapshotPath, "utf8");
    return JSON.parse(content) as DashboardSnapshot;
  } catch {
    return null;
  }
}

async function loadCandidateHistoryFromDisk(
  reportsDir: string,
): Promise<CandidateDetail[]> {
  const historyPath = path.join(
    process.cwd(),
    reportsDir,
    "candidate-history.json",
  );
  try {
    const content = await readFile(historyPath, "utf8");
    return JSON.parse(content) as CandidateDetail[];
  } catch {
    return [];
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendBinary(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  payload: Buffer | Uint8Array,
): void {
  res.writeHead(statusCode, { "content-type": contentType });
  res.end(payload);
}

function sendHtml(
  res: ServerResponse,
  statusCode: number,
  html: string,
  cookieHeaders?: string[],
): void {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    ...(cookieHeaders && cookieHeaders.length > 0
      ? { "set-cookie": cookieHeaders }
      : {}),
  });
  res.end(html);
}

function sendRedirect(
  res: ServerResponse,
  location: string,
  cookieHeaders?: string[],
): void {
  res.writeHead(302, {
    location,
    ...(cookieHeaders && cookieHeaders.length > 0
      ? { "set-cookie": cookieHeaders }
      : {}),
  });
  res.end();
}

function renderCloudPopupResultHtml(
  status: "success" | "error",
  message: string,
): string {
  const escapedMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ElizaOK | ElizaCloud</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #090909;
      color: #f4ecd2;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .panel {
      width: min(420px, calc(100vw - 32px));
      padding: 24px;
      border-radius: 20px;
      border: 1px solid rgba(255,214,10,0.16);
      background: rgba(255,214,10,0.05);
      box-shadow: 0 24px 64px rgba(0,0,0,0.4);
    }
    .eyebrow {
      color: #ffd60a;
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; line-height: 1.6; color: rgba(244,236,210,0.82); }
  </style>
</head>
<body>
  <div class="panel">
    <div class="eyebrow">ElizaCloud</div>
    <h1>${status === "success" ? "Authentication Complete" : "Authentication Error"}</h1>
    <p>${escapedMessage}</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage(
          { type: "eliza-cloud-auth-complete", status: "${status}", message: ${JSON.stringify(message)} },
          "*"
        );
      }
    } catch {}
    window.setTimeout(function () { window.close(); }, 350);
  </script>
</body>
</html>`;
}

function renderCloudCallbackBridgeHtml(popupMode: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ElizaOK | ElizaCloud Callback</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #090909;
      color: #f4ecd2;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .panel {
      width: min(440px, calc(100vw - 32px));
      padding: 24px;
      border-radius: 20px;
      border: 1px solid rgba(255,214,10,0.16);
      background: rgba(255,214,10,0.05);
      box-shadow: 0 24px 64px rgba(0,0,0,0.4);
    }
    .eyebrow {
      color: #ffd60a;
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; line-height: 1.6; color: rgba(244,236,210,0.82); }
  </style>
</head>
<body>
  <div class="panel">
    <div class="eyebrow">ElizaCloud</div>
    <h1>Completing Sign-In</h1>
    <p>Finalizing hosted app authentication for ElizaOK...</p>
  </div>
  <script>
    (function () {
      function toObject(params) {
        var result = {};
        params.forEach(function (value, key) {
          result[key] = value;
        });
        return result;
      }
      var search = new URLSearchParams(window.location.search);
      var hash = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
      var payload = Object.assign({}, toObject(search), toObject(hash), {
        popup: ${popupMode ? '"1"' : '"0"'}
      });
      fetch("/api/eliza-cloud/app-auth/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload)
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) {
              throw new Error(data && data.error ? data.error : "ElizaCloud app auth failed.");
            }
            return data;
          });
        })
        .then(function () {
          if (${popupMode ? "true" : "false"}) {
            try {
              if (window.opener) {
                window.opener.postMessage(
                  { type: "eliza-cloud-auth-complete", status: "success", message: "ElizaCloud connected." },
                  "*"
                );
              }
            } catch {}
            window.close();
            return;
          }
          window.location.href = "/?cloud_connected=1";
        })
        .catch(function (error) {
          var message = error && error.message ? error.message : String(error);
          if (${popupMode ? "true" : "false"}) {
            try {
              if (window.opener) {
                window.opener.postMessage(
                  { type: "eliza-cloud-auth-complete", status: "error", message: message },
                  "*"
                );
              }
            } catch {}
            document.body.innerHTML =
              '<div class="panel"><div class="eyebrow">ElizaCloud</div><h1>Authentication Error</h1><p>' +
              message.replace(/[<>&]/g, "") +
              "</p></div>";
            return;
          }
          window.location.href = "/?cloud_error=" + encodeURIComponent(message);
        });
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function recommendationTone(value: string): string {
  if (value.includes("buy") || value.includes("candidate")) return "tone-hot";
  if (value.includes("watch") || value.includes("priority")) return "tone-warm";
  return "tone-cool";
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

function formatBnb(value: number): string {
  return `${value.toFixed(4)} BNB`;
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toFixed(2);
}

function getElizaCloudDashboardUrl(): string {
  return `${getElizaCloudBaseUrl().replace(/\/$/, "")}/dashboard`;
}

async function fetchWalletNativeBalanceLabel(
  rpcUrl: string | null,
  walletAddress: string,
): Promise<string> {
  if (!rpcUrl || !walletAddress) return "n/a";
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const balance = await provider.getBalance(walletAddress);
    return `${Number(ethers.formatEther(balance)).toFixed(4)} BNB`;
  } catch {
    return "n/a";
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

interface ElizaCloudSession {
  provider: "eliza-cloud";
  authMode: "demo" | "siwe" | "app-auth";
  displayName: string;
  email: string;
  credits: string;
  model: string;
  agentId: string;
  agentName: string;
  apiKey: string;
  apiKeyHint: string;
  plan: string;
  avatarUrl: string | null;
  walletAddress: string;
  organizationName: string;
  organizationSlug: string;
  appId: string;
}

const ELIZAOK_CLOUD_COOKIE = "elizaok_cloud_session";
const ELIZAOK_CLOUD_STATE_COOKIE = "elizaok_cloud_state";

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex === -1) return null;
        return [
          entry.slice(0, separatorIndex).trim(),
          decodeURIComponent(entry.slice(separatorIndex + 1).trim()),
        ] as const;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );
}

function readElizaCloudSession(
  header: string | undefined,
): ElizaCloudSession | null {
  const raw = parseCookies(header)[ELIZAOK_CLOUD_COOKIE];
  if (!raw) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as ElizaCloudSession;
    return parsed?.provider === "eliza-cloud" ? parsed : null;
  } catch {
    return null;
  }
}

function serializeElizaCloudSession(session: ElizaCloudSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${ELIZAOK_CLOUD_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

function clearElizaCloudSession(): string {
  return `${ELIZAOK_CLOUD_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readElizaCloudAuthState(header: string | undefined): string | null {
  return parseCookies(header)[ELIZAOK_CLOUD_STATE_COOKIE] || null;
}

function serializeElizaCloudAuthState(state: string): string {
  return `${ELIZAOK_CLOUD_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`;
}

function clearElizaCloudAuthState(): string {
  return `${ELIZAOK_CLOUD_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function isElizaCloudDemoEnabled(): boolean {
  return process.env.ELIZAOK_ELIZA_CLOUD_DEMO_ENABLED?.trim() === "true";
}

function inferOrigin(req: IncomingMessage): string {
  const protocol =
    (req.headers["x-forwarded-proto"] as string | undefined)
      ?.split(",")[0]
      ?.trim() || "http";
  const host = req.headers.host || "localhost";
  return `${protocol}://${host}`;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host || "").toLowerCase();
  return host.includes("localhost") || host.includes("127.0.0.1");
}

function buildElizaCloudDemoUrl(req: IncomingMessage): string {
  const callbackUrl = new URL(`${inferOrigin(req)}/auth/eliza-cloud/callback`);
  callbackUrl.searchParams.set("name", "Baoger");
  callbackUrl.searchParams.set("email", "baoger@elizacloud.local");
  callbackUrl.searchParams.set("credits", "10,000");
  callbackUrl.searchParams.set("model", "gpt-4o-mini");
  callbackUrl.searchParams.set("api_key", "eliza_demo_7H3K9A");
  callbackUrl.searchParams.set("plan", "ElizaCloud Alpha");
  callbackUrl.searchParams.set("avatar", "/assets/elizaok-logo.png");
  callbackUrl.searchParams.set("mode", "demo");
  return callbackUrl.toString();
}

function getElizaCloudAppId(): string {
  return process.env.ELIZAOK_ELIZA_CLOUD_APP_ID?.trim() || "";
}

function getElizaCloudAuthorizeUrl(): string {
  return (
    process.env.ELIZAOK_ELIZA_CLOUD_AUTHORIZE_URL?.trim() ||
    `${getElizaCloudBaseUrl().replace(/\/$/, "")}/app-auth/authorize`
  );
}

function buildElizaCloudCliLoginUrl(sessionId: string): string {
  return `${getElizaCloudBaseUrl().replace(/\/$/, "")}/auth/cli-login?session=${encodeURIComponent(sessionId)}`;
}

function getElizaCloudCallbackUrl(req: IncomingMessage, popup = false): string {
  const callbackUrl = new URL(
    process.env.ELIZAOK_ELIZA_CLOUD_CALLBACK_URL?.trim() ||
      `${inferOrigin(req)}/auth/eliza-cloud/callback`,
  );
  if (popup) {
    callbackUrl.searchParams.set("popup", "1");
  }
  return callbackUrl.toString();
}

function hasElizaCloudAppAuthConfig(): boolean {
  return Boolean(getElizaCloudAppId() && getElizaCloudAuthorizeUrl());
}

function buildElizaCloudLoginUrl(
  req: IncomingMessage,
  state?: string,
  popup = false,
): string | null {
  if (hasElizaCloudAppAuthConfig()) {
    const loginUrl = new URL(getElizaCloudAuthorizeUrl());
    const callbackUrl = getElizaCloudCallbackUrl(req, popup);
    const appId = getElizaCloudAppId();
    loginUrl.searchParams.set("appId", appId);
    loginUrl.searchParams.set("app_id", appId);
    loginUrl.searchParams.set("redirect_uri", callbackUrl);
    loginUrl.searchParams.set("return_to", callbackUrl);
    loginUrl.searchParams.set("callback_url", callbackUrl);
    loginUrl.searchParams.set("client", "elizaok");
    if (state) {
      loginUrl.searchParams.set("state", state);
    }
    return loginUrl.toString();
  }

  const configured = process.env.ELIZAOK_ELIZA_CLOUD_LOGIN_URL?.trim() || "";
  if (configured) {
    const loginUrl = new URL(configured);
    const callbackUrl = getElizaCloudCallbackUrl(req, popup);
    loginUrl.searchParams.set("return_to", callbackUrl);
    loginUrl.searchParams.set("redirect_uri", callbackUrl);
    loginUrl.searchParams.set("client", "elizaok");
    if (state) {
      loginUrl.searchParams.set("state", state);
    }
    return loginUrl.toString();
  }

  return isLocalRequest(req) && isElizaCloudDemoEnabled()
    ? buildElizaCloudDemoUrl(req)
    : null;
}

function buildElizaCloudSessionFromQuery(
  requestUrl: URL,
): ElizaCloudSession | null {
  const displayName = requestUrl.searchParams.get("name")?.trim() || "";
  const email = requestUrl.searchParams.get("email")?.trim() || "";
  const credits = requestUrl.searchParams.get("credits")?.trim() || "n/a";
  const apiKeyHint =
    requestUrl.searchParams.get("api_key")?.trim() ||
    requestUrl.searchParams.get("apiKey")?.trim() ||
    "n/a";
  const plan = requestUrl.searchParams.get("plan")?.trim() || "ElizaCloud";
  const avatarUrl =
    requestUrl.searchParams.get("avatar_url")?.trim() ||
    requestUrl.searchParams.get("avatar")?.trim() ||
    null;
  const apiKey =
    requestUrl.searchParams.get("api_key_full")?.trim() ||
    requestUrl.searchParams.get("api_key")?.trim() ||
    requestUrl.searchParams.get("apiKey")?.trim() ||
    "";
  const walletAddress = requestUrl.searchParams.get("wallet")?.trim() || "";
  const organizationName =
    requestUrl.searchParams.get("org_name")?.trim() || "ElizaCloud";
  const organizationSlug =
    requestUrl.searchParams.get("org_slug")?.trim() || "elizacloud";

  if (
    !displayName &&
    !email &&
    credits === "n/a" &&
    apiKeyHint === "n/a"
  ) {
    return null;
  }

  return {
    provider: "eliza-cloud",
    authMode:
      requestUrl.searchParams.get("mode")?.trim() === "demo" ? "demo" : "siwe",
    displayName: displayName || email || "ElizaCloud User",
    email: email || "connected-via-elizacloud",
    credits,
    model: "n/a",
    agentId: "",
    agentName: "Eliza",
    apiKey,
    apiKeyHint,
    plan,
    avatarUrl,
    walletAddress,
    organizationName,
    organizationSlug,
    appId:
      requestUrl.searchParams.get("app_id")?.trim() ||
      requestUrl.searchParams.get("appId")?.trim() ||
      "",
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readRequestJson<T>(req: IncomingMessage): Promise<T | null> {
  const body = await readRequestBody(req);
  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function getElizaCloudBaseUrl(): string {
  return process.env.ELIZAOK_ELIZA_CLOUD_URL?.trim() || "https://elizacloud.ai";
}

function getElizaCloudApiBaseUrl(): string {
  return (
    process.env.ELIZAOK_ELIZA_CLOUD_API_URL?.trim() || "https://cloud.milady.ai"
  );
}

function getElizaOkDocsUrl(): string {
  return process.env.ELIZAOK_DOCS_URL?.trim() || "#";
}

function getElizaOkPrivyUrl(): string {
  return process.env.ELIZAOK_PRIVY_URL?.trim() || "https://privy.io/";
}

function getElizaOkPrivyAppId(): string {
  return process.env.ELIZAOK_PRIVY_APP_ID?.trim() || "";
}

function getElizaOkPrivyClientId(): string {
  return process.env.ELIZAOK_PRIVY_CLIENT_ID?.trim() || "";
}

async function connectElizaCloudAppAuth(
  authToken: string,
  appId: string,
): Promise<Response> {
  const url = `${getElizaCloudApiBaseUrl().replace(/\/$/, "")}/api/v1/app-auth/connect`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ appId }),
  });
}

async function fetchElizaCloudAppAuthSession(
  authToken: string,
  appId: string,
): Promise<Response> {
  const url = `${getElizaCloudApiBaseUrl().replace(/\/$/, "")}/api/v1/app-auth/session`;
  return fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${authToken}`,
      "x-app-id": appId,
    },
  });
}

async function createElizaCloudCliSession(
  sessionId: string,
): Promise<Response> {
  const url = `${getElizaCloudBaseUrl().replace(/\/$/, "")}/api/auth/cli-session`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ sessionId }),
  });
}

async function fetchElizaCloudCliSession(sessionId: string): Promise<Response> {
  const url = `${getElizaCloudBaseUrl().replace(/\/$/, "")}/api/auth/cli-session/${encodeURIComponent(
    sessionId,
  )}`;
  return fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
}

async function fetchElizaCloudNonce(req: IncomingMessage): Promise<Response> {
  const url = `${getElizaCloudBaseUrl().replace(/\/$/, "")}/api/auth/siwe/nonce`;
  return fetch(url, {
    headers: {
      accept: "application/json",
      ...(req.headers["user-agent"]
        ? { "user-agent": String(req.headers["user-agent"]) }
        : {}),
    },
  });
}

interface ElizaCloudVerifyResponse {
  apiKey: string;
  address: string;
  isNewAccount: boolean;
  user: {
    id: string;
    wallet_address: string | null;
    organization_id: string | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  } | null;
}

async function verifyElizaCloudSiwe(payload: {
  message: string;
  signature: string;
}): Promise<Response> {
  const url = `${getElizaCloudBaseUrl().replace(/\/$/, "")}/api/auth/siwe/verify`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function createElizaCloudAgent(
  apiKey: string,
  payload: { name: string; bio?: string },
): Promise<Response> {
  const url = `${elizaCloudApiBase()}/api/v1/app/agents`;
  return fetch(url, {
    method: "POST",
    headers: {
      ...elizaCloudAuthHeaders(apiKey),
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

/** Trailing-slash-normalized `ELIZAOK_ELIZA_CLOUD_API_URL` — why: v1 paths must hit the API host, not SIWE host. */
function elizaCloudApiBase(): string {
  return getElizaCloudApiBaseUrl().replace(/\/$/, "");
}

/** Persists dashboard Cloud identity; apiKeyHint uses "Browser session" when key empty — why: app-auth has no key. */
function buildElizaCloudApiSession(
  apiKey: string,
  profile: Partial<ElizaCloudSession> | null,
  authMode: ElizaCloudSession["authMode"] = "siwe",
  appId = "",
): ElizaCloudSession {
  return {
    provider: "eliza-cloud",
    authMode,
    displayName:
      profile?.displayName || profile?.organizationName || "ElizaCloud User",
    email: profile?.email || "connected-via-elizacloud",
    credits: profile?.credits || "linked",
    model: "n/a",
    agentId: profile?.agentId || "",
    agentName: profile?.agentName || "Eliza",
    apiKey,
    apiKeyHint:
      !apiKey || apiKey.length < 4
        ? "Browser session"
        : `${apiKey.slice(0, 10)}...`,
    plan: profile?.plan || "ElizaCloud",
    avatarUrl: profile?.avatarUrl || "/assets/elizaok-logo.png",
    walletAddress: profile?.walletAddress || "",
    organizationName: profile?.organizationName || "ElizaCloud",
    organizationSlug: profile?.organizationSlug || "elizacloud",
    appId,
  };
}

async function buildElizaCloudSessionFromAppAuth(
  authToken: string,
  appId: string,
): Promise<{ session: ElizaCloudSession | null; error: string | null }> {
  if (!authToken.trim()) {
    return { session: null, error: "Missing ElizaCloud auth token." };
  }
  if (!appId.trim()) {
    return { session: null, error: "Missing ElizaCloud app ID." };
  }

  const connectResponse = await connectElizaCloudAppAuth(authToken, appId);
  const connectPayload = (await connectResponse.json().catch(() => null)) as {
    error?: string;
  } | null;
  if (!connectResponse.ok) {
    return {
      session: null,
      error:
        connectPayload?.error || "Failed to connect ElizaCloud app session.",
    };
  }

  const apiBase = elizaCloudApiBase();
  const [appSessionResponse, primaryAgent, profile, credits, creditSummary] =
    await Promise.all([
      fetchElizaCloudAppAuthSession(authToken, appId),
      fetchElizaCloudPrimaryAgentConfig(apiBase, authToken),
      fetchElizaCloudUser(apiBase, authToken),
      fetchElizaCloudCreditsBalance(apiBase, authToken),
      fetchElizaCloudCreditsSummary(apiBase, authToken),
    ]);

  const appSessionPayload = (await appSessionResponse
    .json()
    .catch(() => null)) as {
    success?: boolean;
    error?: string;
    user?: {
      email?: string | null;
      name?: string | null;
      avatar?: string | null;
    };
    app?: { id?: string | null; name?: string | null };
  } | null;

  if (!appSessionResponse.ok || !appSessionPayload?.success) {
    return {
      session: null,
      error:
        appSessionPayload?.error || "Failed to verify ElizaCloud app session.",
    };
  }

  const session = buildElizaCloudApiSession(
    "",
    {
      ...creditSummary,
      ...profile,
      displayName:
        profile?.displayName ||
        appSessionPayload.user?.name ||
        creditSummary?.displayName ||
        profile?.organizationName ||
        "ElizaCloud User",
      email:
        profile?.email ||
        appSessionPayload.user?.email ||
        "connected-via-elizacloud",
      avatarUrl:
        profile?.avatarUrl ||
        appSessionPayload.user?.avatar ||
        "/assets/elizaok-logo.png",
      organizationName:
        profile?.organizationName ||
        creditSummary?.organizationName ||
        appSessionPayload.app?.name ||
        "ElizaCloud",
      // Balance first, then summary, then user placeholder "linked" — why: profile spread can carry credits: "linked".
      credits:
        credits || creditSummary?.credits || profile?.credits || "linked",
      agentId: primaryAgent?.id || "",
      agentName: primaryAgent?.name || "Eliza",
      model: primaryAgent
        ? primaryAgent.modelProvider
          ? `${primaryAgent.modelProvider}/${primaryAgent.model}`
          : primaryAgent.model
        : "n/a",
    },
    "app-auth",
    appId,
  );
  session.apiKeyHint = "Browser session";
  session.plan = profile?.plan || "ElizaCloud App Auth";
  return { session, error: null };
}

async function refreshElizaCloudSession(
  session: ElizaCloudSession | null,
): Promise<{ session: ElizaCloudSession | null; summary: ElizaCloudSummaryFields | null }> {
  if (!session) {
    return { session: null, summary: null };
  }
  if (!session.apiKey) {
    return { session, summary: null };
  }

  const apiBase = elizaCloudApiBase();
  const [primaryAgent, profile, credits, creditSummary] = await Promise.all([
    fetchElizaCloudPrimaryAgentConfig(apiBase, session.apiKey),
    fetchElizaCloudUser(apiBase, session.apiKey),
    fetchElizaCloudCreditsBalance(apiBase, session.apiKey),
    fetchElizaCloudCreditsSummary(apiBase, session.apiKey),
  ]);

  const refreshed = buildElizaCloudApiSession(
    session.apiKey,
    {
      ...creditSummary,
      ...profile,
      displayName:
        profile?.displayName ||
        creditSummary?.displayName ||
        session.displayName ||
        session.organizationName ||
        "ElizaCloud User",
      email: profile?.email || session.email || "connected-via-elizacloud",
      avatarUrl:
        profile?.avatarUrl || session.avatarUrl || "/assets/elizaok-logo.png",
      walletAddress: profile?.walletAddress || session.walletAddress || "",
      organizationName:
        profile?.organizationName ||
        creditSummary?.organizationName ||
        session.organizationName ||
        "ElizaCloud",
      organizationSlug:
        profile?.organizationSlug || session.organizationSlug || "elizacloud",
      // Same precedence as app-auth: real balance/summary beats profile "linked" and stale session.credits.
      credits:
        credits ||
        creditSummary?.credits ||
        profile?.credits ||
        session.credits ||
        "linked",
      plan: profile?.plan || session.plan || "ElizaCloud",
      agentId: primaryAgent?.id || session.agentId || "",
      agentName: primaryAgent?.name || session.agentName || "Eliza",
      model: primaryAgent
        ? primaryAgent.modelProvider
          ? `${primaryAgent.modelProvider}/${primaryAgent.model}`
          : primaryAgent.model
        : session.model || "n/a",
    },
    session.authMode,
    session.appId,
  );
  refreshed.apiKeyHint = session.apiKeyHint || refreshed.apiKeyHint;
  return { session: refreshed, summary: creditSummary };
}

function shortAddress(value: string): string {
  if (value.length < 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function candidateHref(tokenAddress: string): string {
  return `/candidate?token=${encodeURIComponent(tokenAddress)}`;
}

function portfolioHref(tokenAddress: string): string {
  return `/api/elizaok/portfolio/positions?token=${encodeURIComponent(tokenAddress)}`;
}

function gooCandidateHref(agentId: string): string {
  return `/goo-candidate?agent=${encodeURIComponent(agentId)}`;
}

function formatSeconds(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 60) return `${value}s`;
  if (value < 3_600) return `${Math.round(value / 60)}m`;
  if (value < 86_400) return `${Math.round(value / 3_600)}h`;
  return `${Math.round(value / 86_400)}d`;
}

function buildGooReadiness(config: ReturnType<typeof getDiscoveryConfig>) {
  const checklist = [
    {
      label: "Module enabled",
      done: config.goo.enabled,
      detail: config.goo.enabled
        ? "Goo scan loop is enabled."
        : "Enable ELIZAOK_GOO_SCAN_ENABLED.",
    },
    {
      label: "RPC configured",
      done: Boolean(config.goo.rpcUrl),
      detail: config.goo.rpcUrl
        ? "RPC endpoint is configured."
        : "Add ELIZAOK_GOO_RPC_URL.",
    },
    {
      label: "Registry configured",
      done: Boolean(config.goo.registryAddress),
      detail: config.goo.registryAddress
        ? "Registry address is configured."
        : "Add ELIZAOK_GOO_REGISTRY_ADDRESS.",
    },
  ];
  const score = checklist.filter((item) => item.done).length;

  return {
    checklist,
    score,
    total: checklist.length,
    configured: score === checklist.length,
    nextAction:
      score === checklist.length
        ? "Live Goo scanning is ready. The operator layer can now be judged on candidate quality."
        : checklist.find((item) => !item.done)?.detail ||
          "Complete remaining Goo configuration checks.",
  };
}

function buildGooCandidateDetail(
  candidate: DashboardSnapshot["topGooCandidates"][number],
  config: ReturnType<typeof getDiscoveryConfig>,
) {
  const readiness = buildGooReadiness(config);
  const treasuryStressGapBnb = Math.max(
    0,
    candidate.starvingThresholdBnb - candidate.treasuryBnb,
  );
  const urgency =
    candidate.status === "DYING"
      ? "critical"
      : candidate.status === "STARVING"
        ? "high"
        : candidate.secondsUntilPulseTimeout !== null &&
            candidate.secondsUntilPulseTimeout < 3_600
          ? "high"
          : candidate.recommendation === "priority_due_diligence"
            ? "medium"
            : "low";
  const operatorAction =
    candidate.recommendation === "cto_candidate"
      ? "Prepare claimCTO parameters, capital guardrails, and post-acquisition genome fusion plan."
      : candidate.recommendation === "priority_due_diligence"
        ? "Run full due diligence on skill overlap, treasury ROI, and rescue timing before any CTO attempt."
        : candidate.recommendation === "monitor"
          ? "Keep the agent in the operator queue and wait for stronger distress or clearer synergy."
          : "Ignore for now and focus operator attention on stronger turnaround targets.";
  const acquisitionFit =
    candidate.minimumCtoBnb <= 0.2
      ? "Low-friction experimental CTO size."
      : candidate.minimumCtoBnb <= 1
        ? "Manageable CTO size with caution."
        : "High CTO floor for MVP treasury deployment.";

  return {
    candidate,
    readiness,
    urgency,
    treasuryStressGapBnb,
    operatorAction,
    acquisitionFit,
    pulseWindowLabel: formatSeconds(candidate.secondsUntilPulseTimeout),
  };
}

function buildPortfolioPositionDetail(
  snapshot: DashboardSnapshot | null,
  tokenAddress: string,
): PortfolioPositionDetail {
  const allPositions = [
    ...(snapshot?.portfolioLifecycle.activePositions ?? []),
    ...(snapshot?.portfolioLifecycle.watchPositions ?? []),
    ...(snapshot?.portfolioLifecycle.exitedPositions ?? []),
  ];
  const position =
    allPositions.find(
      (item) => item.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
    ) ?? null;
  const timeline = (snapshot?.portfolioLifecycle.timeline ?? []).filter(
    (event) => event.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
  );

  return {
    tokenAddress,
    tokenSymbol: position?.tokenSymbol ?? "Unknown",
    position,
    timeline,
  };
}

function renderBrandLogoImage(className = "brand-image"): string {
  return `<img class="${className}" src="/assets/elizaok-logo.png" alt="ElizaOK logo" />`;
}

function renderHeadBrandAssets(title: string): string {
  const safeTitle = escapeHtml(title);
  return `
  <title>${safeTitle}</title>
  <link rel="icon" type="image/png" href="/assets/elizaok-logo.png" />
  <link rel="apple-touch-icon" href="/assets/elizaok-logo.png" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:image" content="/assets/elizaok-logo.png" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:image" content="/assets/elizaok-logo.png" />`;
}

function renderGithubIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.12.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.54-1.38-1.34-1.75-1.34-1.75-1.1-.74.08-.73.08-.73 1.22.09 1.86 1.25 1.86 1.25 1.08 1.86 2.84 1.32 3.53 1.01.11-.79.42-1.32.76-1.63-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.24-3.22-.13-.31-.54-1.53.12-3.19 0 0 1.01-.32 3.3 1.23a11.4 11.4 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.19.77.84 1.24 1.91 1.24 3.22 0 4.62-2.8 5.65-5.48 5.95.43.37.81 1.1.81 2.23v3.31c0 .32.21.7.82.58A12 12 0 0 0 12 .5Z"/></svg>`;
}

function renderXIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.77 7.74L23.2 22h-6.26l-4.9-7.4L5.53 22H2.4l7.24-8.28L1.2 2H7.6l4.43 6.73L18.9 2Zm-1.1 18h1.73L6.66 3.9H4.8L17.8 20Z"/></svg>`;
}

function renderDocsIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M7 3.75A2.25 2.25 0 0 0 4.75 6v12A2.25 2.25 0 0 0 7 20.25h10A2.25 2.25 0 0 0 19.25 18V8.56a2.25 2.25 0 0 0-.66-1.59l-2.56-2.56a2.25 2.25 0 0 0-1.59-.66H7Z" stroke="currentColor" stroke-width="1.6"/><path d="M14 3.75V7a1 1 0 0 0 1 1h3.25" stroke="currentColor" stroke-width="1.6"/><path d="M8 11.25h8M8 14.75h8M8 18.25h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

function renderProgress(
  label: string,
  current: number,
  max: number,
  meta: string,
): string {
  const pct = max > 0 ? clampPercent((current / max) * 100) : 0;
  return `
    <div class="progress-card">
      <div class="progress-head">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(meta)}</strong>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function renderMetricCard(
  label: string,
  value: string,
  detail: string,
): string {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>`;
}

function renderFeatureDockCard(
  targetId: string,
  label: string,
  pctLabel: string,
  value: string,
  meta: string,
  pct: number,
  tone: "hot" | "warm" | "cool" = "cool",
): string {
  const safePct = clampPercent(pct);
  return `
    <button
      class="feature-dock-card feature-dock-card--${tone}"
      type="button"
      data-modal-target="${escapeHtml(targetId)}"
      data-modal-title="${escapeHtml(label)}"
    >
      <div class="feature-dock-card__top">
        <span>${escapeHtml(label)}</span>
        <em>${escapeHtml(pctLabel)}</em>
      </div>
      <b class="feature-dock-card__value">${escapeHtml(value)}</b>
      <small class="feature-dock-card__meta">${escapeHtml(meta)}</small>
      <div class="feature-dock-card__track">
        <div class="feature-dock-card__fill" style="width:${safePct}%"></div>
      </div>
    </button>`;
}

function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  return `${Math.round(value)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0 || Number.isNaN(ms)) return "n/a";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "n/a";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return iso;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderUsageRow(label: string, pct: number, value: string): string {
  const blockCount = 10;
  const activeBlocks = Math.max(
    0,
    Math.min(blockCount, Math.round((pct / 100) * blockCount)),
  );
  return `
    <div class="usage-row">
      <span>${escapeHtml(label)}</span>
      <div class="usage-meter">
        ${Array.from({ length: blockCount }, (_, index) => `<i class="${index < activeBlocks ? "is-on" : ""}"></i>`).join("")}
      </div>
      <strong>${escapeHtml(value)}</strong>
    </div>`;
}

function renderCandidateDetail(
  detail: CandidateDetail,
  portfolioDetail: PortfolioPositionDetail | null,
): string {
  const historyRows = detail.history
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(entry.generatedAt)}</td>
          <td>${entry.score}</td>
          <td>${escapeHtml(entry.recommendation)}</td>
          <td>${formatUsd(entry.reserveUsd)}</td>
          <td>${formatUsd(entry.volumeUsdM5)}</td>
        </tr>`,
    )
    .join("");
  const position = portfolioDetail?.position ?? null;
  const treasuryTimelineRows =
    portfolioDetail?.timeline
      .map(
        (event) => `
        <tr>
          <td>${escapeHtml(event.generatedAt)}</td>
          <td>${escapeHtml(event.type)}</td>
          <td>${escapeHtml(event.stateAfter)}</td>
          <td>${escapeHtml(event.detail)}</td>
        </tr>`,
      )
      .join("") || "";
  const backHref = `/?view=discovery`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets(`${detail.tokenSymbol} | ElizaOK`)}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --bg-soft: #242017;
      --panel: rgba(24,21,16,.9);
      --border: rgba(215,164,40,.16);
      --border-strong: rgba(240,198,79,.3);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
      --shadow: rgba(0,0,0,.55);
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:
        radial-gradient(circle at 18% 14%, rgba(215,164,40,.08), transparent 18%),
        radial-gradient(circle at 82% 22%, rgba(215,164,40,.04), transparent 16%),
        linear-gradient(180deg, #040404 0%, #080808 55%, #060606 100%);
      color:var(--text);
      font-family:"Kode Mono", monospace;
      padding:24px;
    }
    body::before {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background-image:
        linear-gradient(rgba(215,164,40,.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(215,164,40,.018) 1px, transparent 1px),
        repeating-linear-gradient(180deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 18px);
      background-size:34px 34px, 34px 34px, 100% 18px;
      mask-image:linear-gradient(180deg, rgba(0,0,0,.82), transparent);
    }
    body::after {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:
        radial-gradient(circle at 18% 20%, rgba(255,255,255,.03), transparent 14%),
        radial-gradient(circle at 72% 24%, rgba(215,164,40,.05), transparent 18%),
        radial-gradient(circle at 60% 76%, rgba(215,164,40,.035), transparent 18%);
      opacity:.7;
    }
    a { color:inherit; text-decoration:none; }
    .shell { max-width:1240px; margin:0 auto; position:relative; z-index:1; }
    .topbar {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
      padding:16px 20px;
      margin-bottom:18px;
      border-radius:24px;
      border:1px solid var(--border);
      background:rgba(20,18,14,.82);
      box-shadow:0 18px 48px rgba(0,0,0,.28);
      backdrop-filter:blur(10px);
    }
    .topbar-left { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .brand-logo {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,214,10,.18);
      box-shadow: 0 0 24px rgba(255,214,10,.12);
      background: rgba(215,164,40,.06);
      display: grid;
      place-items: center;
    }
    .brand-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .live-dot {
      width:12px;
      height:12px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 18px rgba(255,214,10,.72);
    }
    .brand strong { display:block; font-size:14px; text-transform:uppercase; letter-spacing:.08em; }
    .brand small { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
    .top-chip {
      padding:10px 13px;
      border-radius:999px;
      background:rgba(255,214,10,.07);
      border:1px solid rgba(255,214,10,.14);
      font-size:12px;
    }
    .social-actions { display:flex; gap:10px; }
    .social-link, .back-link {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      height:44px;
      padding:0 14px;
      border-radius:14px;
      border:1px solid rgba(255,214,10,.14);
      background:rgba(255,214,10,.04);
      transition:180ms ease;
    }
    .social-link { width:44px; padding:0; }
    .social-link:hover, .back-link:hover {
      color:var(--accent);
      border-color:var(--border-strong);
      box-shadow:0 0 24px rgba(255,214,10,.1);
      transform:translateY(-1px);
    }
    .social-link svg { width:20px; height:20px; }
    .hero, .card {
      border-radius:28px;
      border:1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(255,214,10,.07), rgba(255,214,10,.015)),
        var(--panel);
      box-shadow:0 24px 72px var(--shadow);
      overflow:hidden;
      position:relative;
    }
    .hero {
      padding:28px;
      margin-bottom:18px;
    }
    .hero::before {
      content:"";
      position:absolute;
      inset:-20% auto auto 62%;
      width:300px;
      height:300px;
      border-radius:50%;
      background:radial-gradient(circle, rgba(255,214,10,.18), transparent 68%);
    }
    .eyebrow {
      display:inline-flex;
      align-items:center;
      gap:10px;
      color:var(--accent);
      text-transform:uppercase;
      letter-spacing:.18em;
      font-size:11px;
    }
    .eyebrow::before {
      content:"";
      width:8px;
      height:8px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 14px rgba(255,214,10,.7);
    }
    h1 {
      margin:16px 0 10px;
      font-size:clamp(40px, 6vw, 72px);
      line-height:.95;
      letter-spacing:-.05em;
      max-width:8ch;
    }
    p { color:var(--muted); line-height:1.8; margin:0; }
    .hero-copy { max-width:760px; }
    .hero-meta {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      margin-top:18px;
    }
    .hero-meta .top-chip { color:var(--text); }
    .grid, .split-grid {
      display:grid;
      gap:18px;
      margin-bottom:18px;
    }
    .grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .split-grid { grid-template-columns:1.15fr .85fr; }
    .card { padding:24px; }
    .metric {
      padding:16px;
      border-radius:18px;
      background:rgba(255,214,10,.05);
      border:1px solid rgba(255,214,10,.12);
    }
    .metric span {
      display:block;
      color:var(--muted);
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.14em;
      margin-bottom:8px;
    }
    .metric strong { font-size:22px; line-height:1.35; }
    .stack { display:grid; gap:14px; }
    table { width:100%; border-collapse:collapse; }
    th, td {
      padding:12px 10px;
      border-bottom:1px solid rgba(255,214,10,.08);
      text-align:left;
      font-size:13px;
      vertical-align:top;
    }
    th { color:var(--accent); font-size:11px; text-transform:uppercase; letter-spacing:.14em; }
    .table-shell {
      border-radius:18px;
      overflow:hidden;
      border:1px solid rgba(255,214,10,.08);
      background:rgba(255,214,10,.03);
    }
    .footer-note {
      margin-top:16px;
      font-size:12px;
      color:var(--muted);
      line-height:1.8;
      word-break:break-word;
    }
    @media (max-width: 980px) {
      .grid, .split-grid { grid-template-columns:1fr; }
      .topbar { flex-direction:column; align-items:flex-start; }
      .social-actions { width:100%; justify-content:flex-end; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="topbar-left">
        <div class="live-dot" aria-hidden="true"></div>
        <div class="brand-logo">${renderBrandLogoImage()}</div>
        <div class="brand">
          <strong>Candidate Detail</strong>
          <small></small>
        </div>
        <div class="top-chip">${escapeHtml(shortAddress(detail.tokenAddress))}</div>
        <div class="top-chip">${escapeHtml(detail.latest.recommendation)}</div>
      </div>
      <div class="social-actions">
        <a class="back-link" href="${backHref}">Back</a>
        <a class="social-link" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer" aria-label="GitHub">
          ${renderGithubIconSvg()}
        </a>
        <a class="social-link" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer" aria-label="X">
          ${renderXIconSvg()}
        </a>
      </div>
    </header>
    <section class="hero">
      <div class="eyebrow">elizaok</div>
      <h1>${escapeHtml(detail.tokenSymbol)}</h1>
      <div class="hero-meta">
        <div class="top-chip">Latest score ${detail.latest.score}/100</div>
        <div class="top-chip">Conviction ${escapeHtml(detail.latest.conviction)}</div>
        <div class="top-chip">Appearances ${detail.history.length}</div>
      </div>
    </section>
    <div class="grid">
      <div class="grid">
        <div class="metric"><span>Latest score</span><strong>${detail.latest.score}/100</strong></div>
        <div class="metric"><span>Conviction</span><strong>${escapeHtml(detail.latest.conviction)}</strong></div>
        <div class="metric"><span>Appearances</span><strong>${detail.history.length}</strong></div>
      </div>
    </div>
    <section class="split-grid">
    <div class="card">
      <div class="eyebrow">Treasury Position</div>
      <div class="grid">
        <div class="metric"><span>State</span><strong>${escapeHtml(position?.state || "not_in_portfolio")}</strong></div>
        <div class="metric"><span>Lane</span><strong>${escapeHtml(position?.executionSource || "n/a")}</strong></div>
        <div class="metric"><span>Wallet</span><strong>${escapeHtml(position?.walletVerification || "n/a")}</strong></div>
        <div class="metric"><span>Realized PnL</span><strong>${position ? `${position.realizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.realizedPnlUsd)}` : "n/a"}</strong></div>
        <div class="metric"><span>Unrealized PnL</span><strong>${position ? `${position.unrealizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.unrealizedPnlUsd)}` : "n/a"}</strong></div>
        <div class="metric"><span>Initial allocation</span><strong>${position ? formatUsd(position.initialAllocationUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Current allocation</span><strong>${position ? formatUsd(position.allocationUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Token balance</span><strong>${escapeHtml(position?.walletTokenBalance || "n/a")}</strong></div>
        <div class="metric"><span>Quote route</span><strong>${escapeHtml(position?.walletQuoteRoute || "n/a")}</strong></div>
        <div class="metric"><span>Quote value</span><strong>${position?.walletQuoteUsd !== null && position?.walletQuoteUsd !== undefined ? formatUsd(position.walletQuoteUsd) : "n/a"}</strong></div>
        <div class="metric"><span>TP stages hit</span><strong>${position ? `${position.takeProfitCount} (${escapeHtml(position.takeProfitStagesHit.join(", ") || "none")})` : "n/a"}</strong></div>
      </div>
      <div class="metric"><span>Portfolio</span><strong><a href="${portfolioHref(detail.tokenAddress)}">open api</a></strong></div>
    </div>
    <div class="card">
      <div class="eyebrow">Latest State</div>
      <div class="grid">
        <div class="metric"><span>Recommendation</span><strong>${escapeHtml(detail.latest.recommendation)}</strong></div>
        <div class="metric"><span>Liquidity</span><strong>${formatUsd(detail.latest.reserveUsd)}</strong></div>
        <div class="metric"><span>Volume 5m</span><strong>${formatUsd(detail.latest.volumeUsdM5)}</strong></div>
        <div class="metric"><span>Age</span><strong>${detail.latest.poolAgeMinutes}m</strong></div>
        <div class="metric"><span>FDV</span><strong>${detail.latest.fdvUsd !== null ? formatUsd(detail.latest.fdvUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Market cap</span><strong>${detail.latest.marketCapUsd !== null ? formatUsd(detail.latest.marketCapUsd) : "n/a"}</strong></div>
      </div>
    </div>
    </section>
    <div class="card">
      <div class="eyebrow">Run history</div>
      <div class="table-shell"><table>
        <thead>
          <tr><th>Generated</th><th>Score</th><th>Recommendation</th><th>Liquidity</th><th>Volume 5m</th></tr>
        </thead>
        <tbody>${historyRows}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="eyebrow">Treasury timeline</div>
      <div class="table-shell"><table>
        <thead>
          <tr><th>Generated</th><th>Event</th><th>State after</th><th>Detail</th></tr>
        </thead>
        <tbody>${treasuryTimelineRows || '<tr><td colspan="4">No treasury lifecycle events yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  </main>
</body>
</html>`;
}

function renderGooCandidateDetail(
  detail: ReturnType<typeof buildGooCandidateDetail>,
): string {
  const {
    candidate,
    readiness,
    urgency,
    treasuryStressGapBnb,
    operatorAction,
    acquisitionFit,
    pulseWindowLabel,
  } = detail;
  const backHref = `/?view=goo`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets(`Goo Agent ${candidate.agentId} | ElizaOK`)}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --bg-soft: #242017;
      --panel: rgba(24,21,16,.9);
      --border: rgba(215,164,40,.16);
      --border-strong: rgba(240,198,79,.3);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
      --shadow: rgba(0,0,0,.55);
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:
        radial-gradient(circle at 8% 18%, rgba(244,239,221,.78), rgba(244,239,221,.12) 18%, transparent 42%),
        linear-gradient(90deg, rgba(244,239,221,.06), transparent 28%),
        linear-gradient(180deg, var(--bg) 0%, var(--bg-soft) 100%);
      color:var(--text);
      font-family:"Kode Mono", monospace;
      padding:24px;
    }
    body::before {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background-image:
        linear-gradient(rgba(215,164,40,.022) 1px, transparent 1px),
        linear-gradient(90deg, rgba(215,164,40,.022) 1px, transparent 1px);
      background-size:34px 34px;
      mask-image:linear-gradient(180deg, rgba(0,0,0,.82), transparent);
    }
    body::after {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:
        radial-gradient(circle at 18% 20%, rgba(244,239,221,.08), transparent 14%),
        radial-gradient(circle at 72% 24%, rgba(215,164,40,.05), transparent 18%),
        radial-gradient(circle at 60% 76%, rgba(215,164,40,.04), transparent 18%);
      opacity:.9;
    }
    a { color:inherit; text-decoration:none; }
    .shell { max-width:1240px; margin:0 auto; position:relative; z-index:1; }
    .topbar {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
      padding:16px 20px;
      margin-bottom:18px;
      border-radius:24px;
      border:1px solid var(--border);
      background:rgba(20,18,14,.82);
      box-shadow:0 18px 48px rgba(0,0,0,.28);
      backdrop-filter:blur(10px);
    }
    .topbar-left { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .brand-logo {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,214,10,.18);
      box-shadow: 0 0 24px rgba(215,164,40,.12);
      background: rgba(215,164,40,.06);
      display: grid;
      place-items: center;
    }
    .brand-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .live-dot {
      width:12px;
      height:12px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 18px rgba(255,214,10,.72);
    }
    .brand strong { display:block; font-size:14px; text-transform:uppercase; letter-spacing:.08em; }
    .brand small { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
    .top-chip {
      padding:10px 13px;
      border-radius:999px;
      background:rgba(255,214,10,.07);
      border:1px solid rgba(255,214,10,.14);
      font-size:12px;
    }
    .social-actions { display:flex; gap:10px; }
    .social-link, .back-link {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      height:44px;
      padding:0 14px;
      border-radius:14px;
      border:1px solid rgba(255,214,10,.14);
      background:rgba(255,214,10,.04);
      transition:180ms ease;
    }
    .social-link { width:44px; padding:0; }
    .social-link:hover, .back-link:hover {
      color:var(--accent);
      border-color:var(--border-strong);
      box-shadow:0 0 24px rgba(255,214,10,.1);
      transform:translateY(-1px);
    }
    .social-link svg { width:20px; height:20px; }
    .hero, .card {
      border-radius:28px;
      border:1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(215,164,40,.08), rgba(215,164,40,.02)),
        var(--panel);
      box-shadow:0 24px 72px var(--shadow);
      overflow:hidden;
      position:relative;
    }
    .hero {
      padding:28px;
      margin-bottom:18px;
    }
    .hero::before {
      content:"";
      position:absolute;
      inset:-20% auto auto 62%;
      width:300px;
      height:300px;
      border-radius:50%;
      background:radial-gradient(circle, rgba(215,164,40,.18), transparent 68%);
    }
    .eyebrow {
      display:inline-flex;
      align-items:center;
      gap:10px;
      color:var(--accent);
      text-transform:uppercase;
      letter-spacing:.18em;
      font-size:11px;
    }
    .eyebrow::before {
      content:"";
      width:8px;
      height:8px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 14px rgba(255,214,10,.7);
    }
    h1 {
      margin:16px 0 10px;
      font-size:clamp(40px, 6vw, 72px);
      line-height:.95;
      letter-spacing:-.05em;
      max-width:8ch;
    }
    p { color:var(--muted); line-height:1.8; margin:0; }
    .hero-copy { max-width:760px; }
    .hero-meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .hero-meta .top-chip { color:var(--text); }
    .grid, .split-grid {
      display:grid;
      gap:18px;
      margin-bottom:18px;
    }
    .grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .split-grid { grid-template-columns:1.1fr .9fr; }
    .card { padding:24px; }
    .metric {
      padding:16px;
      border-radius:18px;
      background:rgba(255,214,10,.05);
      border:1px solid rgba(255,214,10,.12);
    }
    .metric span {
      display:block;
      color:var(--muted);
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.14em;
      margin-bottom:8px;
    }
    .metric strong { font-size:22px; line-height:1.35; }
    .progress-track { height:10px; border-radius:999px; background:rgba(255,214,10,.08); overflow:hidden; margin-top:12px; }
    .progress-fill { height:100%; background:linear-gradient(90deg,#9c6a00,#ffd60a); width:${Math.round(
      (readiness.score / readiness.total) * 100,
    )}%; box-shadow:0 0 18px rgba(255,214,10,.45); }
    .table-shell {
      border-radius:18px;
      overflow:hidden;
      border:1px solid rgba(255,214,10,.08);
      background:rgba(255,214,10,.03);
    }
    ul { margin:0; padding-left:18px; }
    li { margin-bottom:10px; color:var(--text); line-height:1.8; }
    @media (max-width:980px) {
      .grid, .split-grid { grid-template-columns:1fr; }
      .topbar { flex-direction:column; align-items:flex-start; }
      .social-actions { width:100%; justify-content:flex-end; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="topbar-left">
        <div class="live-dot" aria-hidden="true"></div>
        <div class="brand-logo">${renderBrandLogoImage()}</div>
        <div class="brand">
          <strong>Goo Operator Detail</strong>
          <small></small>
        </div>
        <div class="top-chip">Agent ${escapeHtml(candidate.agentId)}</div>
        <div class="top-chip">${escapeHtml(candidate.recommendation)}</div>
        <div class="top-chip">${escapeHtml(urgency)} urgency</div>
      </div>
      <div class="social-actions">
        <a class="back-link" href="${backHref}">Back</a>
        <a class="social-link" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer" aria-label="GitHub">
          ${renderGithubIconSvg()}
        </a>
        <a class="social-link" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer" aria-label="X">
          ${renderXIconSvg()}
        </a>
      </div>
    </header>
    <section class="hero">
      <div class="eyebrow">elizaok</div>
      <h1>Agent ${escapeHtml(candidate.agentId)}</h1>
      <div class="hero-meta">
        <div class="top-chip">Score ${candidate.score}/100</div>
        <div class="top-chip">Pulse ${escapeHtml(pulseWindowLabel)}</div>
        <div class="top-chip">CTO floor ${candidate.minimumCtoBnb} BNB</div>
      </div>
    </section>
    <div class="card">
      <div class="grid">
        <div class="metric"><span>Score</span><strong>${candidate.score}/100</strong></div>
        <div class="metric"><span>CTO floor</span><strong>${candidate.minimumCtoBnb} BNB</strong></div>
        <div class="metric"><span>Treasury</span><strong>${candidate.treasuryBnb} BNB</strong></div>
        <div class="metric"><span>Pulse deadline</span><strong>${escapeHtml(pulseWindowLabel)}</strong></div>
        <div class="metric"><span>Treasury gap</span><strong>${candidate.status === "ACTIVE" ? "0 BNB" : `${treasuryStressGapBnb.toFixed(4)} BNB`}</strong></div>
        <div class="metric"><span>Acquisition fit</span><strong>${escapeHtml(acquisitionFit)}</strong></div>
      </div>
    </div>
    <div class="split-grid">
    <div class="card">
      <div class="eyebrow">Readiness</div>
      <div class="progress-track"><div class="progress-fill"></div></div>
      <p>${readiness.score}/${readiness.total}</p>
      <ul>${readiness.checklist.map((item) => `<li>${item.done ? "READY" : "TODO"} · ${escapeHtml(item.label)} · ${escapeHtml(item.detail)}</li>`).join("")}</ul>
    </div>
    <div class="card">
      <div class="eyebrow">Action</div>
      <div class="grid">
        <div class="metric"><span>Urgency</span><strong>${escapeHtml(urgency)}</strong></div>
        <div class="metric"><span>Action</span><strong>${escapeHtml(operatorAction)}</strong></div>
        <div class="metric"><span>Next</span><strong>${escapeHtml(readiness.nextAction)}</strong></div>
        <div class="metric"><span>Status</span><strong>${escapeHtml(candidate.status)}</strong></div>
      </div>
    </div>
    </div>
    <div class="split-grid">
    <div class="card">
      <div class="eyebrow">Links</div>
      <div class="grid">
        <div class="metric"><span>Genome</span><strong><a href="${escapeHtml(candidate.genomeUri)}" target="_blank" rel="noreferrer">open</a></strong></div>
        <div class="metric"><span>Token</span><strong>${escapeHtml(shortAddress(candidate.tokenAddress))}</strong></div>
        <div class="metric"><span>Wallet</span><strong>${escapeHtml(shortAddress(candidate.agentWallet))}</strong></div>
        <div class="metric"><span>Owner</span><strong>${escapeHtml(shortAddress(candidate.ownerAddress))}</strong></div>
      </div>
    </div>
    <div class="card">
      <div class="eyebrow">State</div>
      <div class="grid">
        <div class="metric"><span>Recommendation</span><strong>${escapeHtml(candidate.recommendation)}</strong></div>
        <div class="metric"><span>Registered block</span><strong>${candidate.registeredAtBlock}</strong></div>
        <div class="metric"><span>Threshold</span><strong>${candidate.starvingThresholdBnb} BNB</strong></div>
        <div class="metric"><span>Risks</span><strong>${candidate.risks.length}</strong></div>
      </div>
    </div>
    </div>
  </main>
</body>
</html>`;
}

function pnlTone(value: number): string {
  if (value > 0) return "tone-hot";
  if (value < 0) return "tone-warm";
  return "tone-cool";
}

function renderDashboardCloudSidebar(
  cloudSession: ElizaCloudSession | null,
  cloudSummary: ElizaCloudSummaryFields | null,
): string {
  if (!cloudSession) {
    return `
      <div class="sidebar-panel__title">ElizaCloud</div>
      <div class="status-panel compact-status">
        <button type="button" class="auth-link" data-cloud-hosted-auth>
          Connect ElizaCloud
        </button>
      </div>`;
  }
  const cloudSyncing =
    cloudSession.displayName === "ElizaCloud User" ||
    cloudSession.organizationName === "ElizaCloud" ||
    cloudSession.credits === "linked";
  const cloudModelLabel =
    cloudSession.model && cloudSession.model !== "n/a"
      ? cloudSession.model
      : "Not exposed by ElizaCloud API";
  const agentCount =
    cloudSummary?.agentsSummary?.total ?? cloudSummary?.agents?.length ?? 0;
  return `
      <div class="sidebar-panel__title">ElizaCloud</div>
      <div class="status-panel compact-status" data-cloud-syncing="${cloudSyncing ? "true" : "false"}">
        <div class="status-row"><span>Status</span><strong>${cloudSyncing ? "Linked; profile and credits syncing" : "Connected"}</strong></div>
        <div class="status-row"><span>Account</span><strong>${escapeHtml(cloudSession.displayName)}</strong></div>
        <div class="status-row"><span>Org</span><strong>${escapeHtml(cloudSession.organizationName)}</strong></div>
        <div class="status-row"><span>Credits</span><strong>${escapeHtml(cloudSession.credits)}</strong></div>
        <div class="status-row"><span>Cloud agents</span><strong>${agentCount}</strong></div>
        <div class="status-row"><span>Agent</span><strong>${escapeHtml(cloudSession.agentName || "Eliza")}</strong></div>
        <div class="status-row"><span>Model</span><strong>${escapeHtml(cloudModelLabel)}</strong></div>
        <div class="status-row"><span></span><strong><a class="watchlist-link" href="/auth/eliza-cloud/logout">Disconnect</a></strong></div>
      </div>`;
}

function renderCloudToolbarLinks(cloudSession: ElizaCloudSession | null): string {
  if (!cloudSession) return "";
  return `
    <a class="auth-link" href="/cloud/agents">Agents</a>
    <a class="auth-link" href="/cloud/credits">Credits</a>`;
}

function renderCloudPageShell(
  title: string,
  subtitle: string,
  body: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets(`${escapeHtml(title)} | ElizaOK`)}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #030301;
      --panel: rgba(8,8,7,0.94);
      --panel-border: rgba(246,231,15,0.15);
      --text: #ffffff;
      --muted: rgba(255,255,255,0.66);
      --accent: #f6e70f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(246,231,15,0.08), transparent 30%),
        linear-gradient(180deg, #050504 0%, #020201 100%);
      color: var(--text);
      font-family: "Kode Mono", monospace;
    }
    .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 18px;
    }
    .top {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 12px;
      margin-bottom: 16px;
      padding: 12px 14px;
      border: 1px solid rgba(246,231,15,0.12);
      border-radius: 16px;
      background: rgba(10,10,8,0.88);
      box-shadow: 0 0 0 1px rgba(246,231,15,0.03), 0 18px 40px rgba(0,0,0,0.45);
    }
    .title strong {
      display:block;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .title small {
      color: var(--muted);
      font-size: 11px;
    }
    .actions {
      display:flex;
      align-items:center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      height: 34px;
      padding: 0 12px;
      border-radius: 10px;
      border: 1px solid rgba(246,231,15,0.16);
      background: rgba(255,255,255,0.03);
      color: var(--text);
      text-decoration: none;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .btn--accent {
      background: linear-gradient(135deg, rgba(246,231,15,0.18), rgba(246,231,15,0.06));
    }
    .grid {
      display:grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 12px;
    }
    .card {
      grid-column: span 12;
      border-radius: 16px;
      border: 1px solid var(--panel-border);
      background: var(--panel);
      padding: 14px;
      box-shadow: 0 0 0 1px rgba(246,231,15,0.03), 0 16px 30px rgba(0,0,0,0.35);
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .stats {
      display:grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .stat {
      padding: 12px;
      border-radius: 12px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
    }
    .stat span {
      display:block;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .stat strong {
      font-size: 20px;
      color: var(--text);
    }
    .rows {
      display:grid;
      gap: 8px;
    }
    .row {
      display:flex;
      justify-content:space-between;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
    }
    .row span {
      color: var(--muted);
      font-size: 11px;
    }
    .row strong {
      text-align: right;
      font-size: 11px;
    }
    .subgrid-6 { grid-column: span 6; }
    .subgrid-4 { grid-column: span 4; }
    @media (max-width: 960px) {
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .subgrid-6, .subgrid-4 { grid-column: span 12; }
      .top { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div class="title">
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(subtitle)}</small>
      </div>
      <div class="actions">
        <a class="btn" href="/">Back</a>
        <a class="btn" href="/cloud/agents">Agents</a>
        <a class="btn" href="/cloud/credits">Credits</a>
        <a class="btn" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Open Cloud</a>
      </div>
    </header>
    ${body}
  </div>
</body>
</html>`;
}

function renderCloudCreditsPage(
  cloudSession: ElizaCloudSession | null,
  cloudSummary: ElizaCloudSummaryFields | null,
): string {
  if (!cloudSession || !cloudSummary) {
    return renderCloudPageShell(
      "Cloud Credits",
      "Connect ElizaCloud first",
      `<div class="grid"><article class="card"><h2>Unavailable</h2><div class="rows"><div class="row"><span>Status</span><strong>Connect ElizaCloud from the main dashboard first.</strong></div></div></article></div>`,
    );
  }
  const agentsSummary = cloudSummary.agentsSummary;
  const pricing = cloudSummary.pricing;
  const autoTopUp = cloudSummary.autoTopUp;
  const body = `
    <div class="grid">
      <article class="card">
        <h2>Credits</h2>
        <div class="stats">
          <div class="stat"><span>Current balance</span><strong>${escapeHtml(cloudSession.credits)}</strong></div>
          <div class="stat"><span>Cloud agents</span><strong>${agentsSummary?.total ?? cloudSummary.agents?.length ?? 0}</strong></div>
          <div class="stat"><span>Allocated</span><strong>${formatCompactNumber(agentsSummary?.totalAllocated ?? 0)}</strong></div>
          <div class="stat"><span>Available</span><strong>${formatCompactNumber(agentsSummary?.totalAvailable ?? 0)}</strong></div>
        </div>
      </article>
      <article class="card subgrid-6">
        <h2>Billing</h2>
        <div class="rows">
          <div class="row"><span>Credits / USD</span><strong>${pricing?.creditsPerDollar === null || pricing?.creditsPerDollar === undefined ? "n/a" : formatCompactNumber(pricing.creditsPerDollar)}</strong></div>
          <div class="row"><span>Minimum deposit</span><strong>${pricing?.minimumTopUp === null || pricing?.minimumTopUp === undefined ? "n/a" : `$${formatCompactNumber(pricing.minimumTopUp)}`}</strong></div>
          <div class="row"><span>x402 top-up</span><strong>${pricing?.x402Enabled ? "enabled" : "disabled"}</strong></div>
          <div class="row"><span>Spent</span><strong>${formatCompactNumber(agentsSummary?.totalSpent ?? 0)}</strong></div>
        </div>
      </article>
      <article class="card subgrid-6">
        <h2>Auto Top-up</h2>
        <div class="rows">
          <div class="row"><span>Status</span><strong>${autoTopUp?.enabled ? "enabled" : "disabled"}</strong></div>
          <div class="row"><span>Payment method</span><strong>${autoTopUp?.hasPaymentMethod ? "saved" : "none"}</strong></div>
          <div class="row"><span>Threshold</span><strong>${autoTopUp?.threshold === null || autoTopUp?.threshold === undefined ? "n/a" : formatCompactNumber(autoTopUp.threshold)}</strong></div>
          <div class="row"><span>Amount</span><strong>${autoTopUp?.amount === null || autoTopUp?.amount === undefined ? "n/a" : formatCompactNumber(autoTopUp.amount)}</strong></div>
        </div>
      </article>
      <article class="card">
        <h2>Actions</h2>
        <div class="actions">
          <a class="btn btn--accent" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Top up in ElizaCloud</a>
          <a class="btn" href="/cloud/agents">Open Agents</a>
        </div>
      </article>
    </div>`;
  return renderCloudPageShell(
    "Cloud Credits",
    `${cloudSession.organizationName} billing`,
    body,
  );
}

function renderCloudAgentsPage(
  cloudSession: ElizaCloudSession | null,
  cloudSummary: ElizaCloudSummaryFields | null,
): string {
  if (!cloudSession || !cloudSummary) {
    return renderCloudPageShell(
      "Cloud Agents",
      "Connect ElizaCloud first",
      `<div class="grid"><article class="card"><h2>Unavailable</h2><div class="rows"><div class="row"><span>Status</span><strong>Connect ElizaCloud from the main dashboard first.</strong></div></div></article></div>`,
    );
  }
  const agents = cloudSummary.agents || [];
  const rows = agents.length
    ? agents
        .map(
          (agent) => `
          <div class="row">
            <span>${escapeHtml(agent.name)}</span>
            <strong>${agent.hasBudget ? `${formatCompactNumber(agent.available)} avail · ${formatCompactNumber(agent.allocated)} alloc` : "no budget"}${agent.isPaused ? " · paused" : ""}<br />requests ${agent.totalRequests}${agent.dailyLimit !== null ? ` · daily ${formatCompactNumber(agent.dailyLimit)}` : ""}</strong>
          </div>`,
        )
        .join("")
    : `<div class="row"><span>Agents</span><strong>No agents discovered. Create one in ElizaCloud or from this page.</strong></div>`;
  const body = `
    <div class="grid">
      <article class="card">
        <h2>Agents</h2>
        <div class="stats">
          <div class="stat"><span>Total</span><strong>${cloudSummary.agentsSummary?.total ?? agents.length}</strong></div>
          <div class="stat"><span>With budget</span><strong>${cloudSummary.agentsSummary?.withBudget ?? 0}</strong></div>
          <div class="stat"><span>Paused</span><strong>${cloudSummary.agentsSummary?.paused ?? 0}</strong></div>
          <div class="stat"><span>Selected agent</span><strong>${escapeHtml(cloudSession.agentName || "Eliza")}</strong></div>
        </div>
      </article>
      <article class="card subgrid-6">
        <h2>Cloud Agent List</h2>
        <div class="rows">${rows}</div>
      </article>
      <article class="card subgrid-6">
        <h2>Actions</h2>
        <div class="rows">
          <div class="row"><span>Current agent</span><strong>${escapeHtml(cloudSession.agentName || "Eliza")}</strong></div>
          <div class="row"><span>Agent model</span><strong>${escapeHtml(cloudSession.model && cloudSession.model !== "n/a" ? cloudSession.model : "Not exposed by ElizaCloud API")}</strong></div>
          <div class="row"><span>Org</span><strong>${escapeHtml(cloudSession.organizationName)}</strong></div>
        </div>
        <div class="actions" style="margin-top:12px">
          <button type="button" class="btn btn--accent" data-cloud-create-agent>+ New Agent</button>
          <a class="btn" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Manage in Cloud</a>
        </div>
      </article>
    </div>
    <script>
      (function () {
        var buttons = Array.prototype.slice.call(document.querySelectorAll("[data-cloud-create-agent]"));
        buttons.forEach(function (button) {
          button.addEventListener("click", function () {
            var name = window.prompt("New ElizaCloud agent name", "elizaOK Agent");
            if (!name) return;
            var bio = window.prompt("Agent bio (optional)", "ElizaOK cloud agent") || "";
            button.setAttribute("aria-disabled", "true");
            fetch("/api/eliza-cloud/agents/create", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: name, bio: bio })
            })
              .then(function (response) {
                return response.json().then(function (payload) {
                  if (!response.ok) {
                    throw new Error(payload && payload.error ? payload.error : "Failed to create ElizaCloud agent.");
                  }
                  return payload;
                });
              })
              .then(function () { window.location.reload(); })
              .catch(function (error) {
                button.removeAttribute("aria-disabled");
                window.alert(error && error.message ? error.message : String(error));
              });
          });
        });
      })();
    </script>`;
  return renderCloudPageShell(
    "Cloud Agents",
    `${cloudSession.organizationName} agents`,
    body,
  );
}

function renderHtml(
  snapshot: DashboardSnapshot | null,
  cloudSession: ElizaCloudSession | null,
  cloudSummary: ElizaCloudSummaryFields | null,
  sidebarWalletBalanceLabel = "n/a",
): string {
  if (!snapshot) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets("ElizaOK | elizaOK")}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --panel: rgba(24, 21, 16, 0.88);
      --panel-border: rgba(215, 164, 40, 0.2);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
      background:
        radial-gradient(circle at 8% 18%, rgba(244,239,221,0.78), rgba(244,239,221,0.12) 18%, transparent 42%),
        linear-gradient(90deg, rgba(244,239,221,0.06), transparent 28%),
        linear-gradient(180deg, #16130e 0%, #242017 100%);
      font-family: "Kode Mono", monospace;
      color: var(--text);
    }
    .panel {
      width: min(920px, 100%);
      padding: 32px;
      border: 1px solid var(--panel-border);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
    }
    .eyebrow {
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 12px;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(36px, 5vw, 56px);
      line-height: 1;
    }
    p { color: var(--muted); line-height: 1.65; }
  </style>
</head>
<body>
  <main class="panel">
    <div class="eyebrow">ElizaOK Live System</div>
    <h1>Dashboard warming up</h1>
    <p>No scan snapshot is available yet. The agent is online and waiting for the first discovery cycle to complete.</p>
  </main>
</body>
</html>`;
  }

  const treasurySimulation = snapshot.treasurySimulation ?? {
    paperCapitalUsd: 0,
    deployableCapitalUsd: 0,
    allocatedUsd: 0,
    dryPowderUsd: 0,
    reserveUsd: 0,
    reservePct: 0,
    positionCount: 0,
    averagePositionUsd: 0,
    highestConvictionSymbol: undefined,
    strategyNote:
      "Treasury simulation will appear after the next completed scan.",
    positions: [],
  };
  const portfolioLifecycle = snapshot.portfolioLifecycle ?? {
    activePositions: [],
    watchPositions: [],
    exitedPositions: [],
    timeline: [],
    cashBalanceUsd: 0,
    grossPortfolioValueUsd: 0,
    reservedUsd: 0,
    totalAllocatedUsd: 0,
    totalCurrentValueUsd: 0,
    totalRealizedPnlUsd: 0,
    totalUnrealizedPnlUsd: 0,
    totalUnrealizedPnlPct: 0,
    healthNote:
      "Portfolio lifecycle will appear after the next completed scan.",
  };
  const distributionPlan = snapshot.distributionPlan ?? {
    enabled: false,
    holderTokenAddress: null,
    snapshotPath: ".elizaok/holder-snapshot.json",
    snapshotSource: "none",
    snapshotGeneratedAt: null,
    snapshotBlockNumber: null,
    minEligibleBalance: 0,
    eligibleHolderCount: 0,
    totalQualifiedBalance: 0,
    distributionPoolUsd: 0,
    maxRecipients: 0,
    note: "Distribution state will appear after configuration is enabled.",
    selectedAsset: {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason:
        "Distribution asset selection will appear after configuration is enabled.",
    },
    recipients: [],
    publication: null,
  };
  const distributionExecution = snapshot.distributionExecution ?? {
    enabled: false,
    dryRun: true,
    configured: false,
    liveExecutionArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction:
      "Distribution execution state will appear after the next completed scan.",
    assetTokenAddress: null,
    assetTotalAmount: null,
    walletAddress: null,
    manifestPath: null,
    manifestFingerprint: null,
    maxRecipientsPerRun: 0,
    cycleSummary: {
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Distribution execution is idle.",
    },
  };
  const distributionLedger = snapshot.distributionLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalRecipientsExecuted: 0,
    totalRecipientsDryRun: 0,
  };
  const executionState = snapshot.executionState ?? {
    enabled: false,
    dryRun: true,
    mode: "paper",
    router: "fourmeme",
    configured: false,
    liveTradingArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction: "Execution state will appear after the next completed scan.",
    risk: {
      maxBuyBnb: 0,
      maxDailyDeployBnb: 0,
      maxSlippageBps: 0,
      maxActivePositions: 0,
      minEntryMcapUsd: 0,
      maxEntryMcapUsd: 0,
      minLiquidityUsd: 0,
      minVolumeUsdM5: 0,
      minVolumeUsdH1: 0,
      minBuyersM5: 0,
      minNetBuysM5: 0,
      minPoolAgeMinutes: 0,
      maxPoolAgeMinutes: 0,
      maxPriceChangeH1Pct: 0,
      allowedQuoteOnly: true,
    },
    gooLane: undefined,
    plans: [],
    cycleSummary: {
      consideredCount: 0,
      eligibleCount: 0,
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Execution cycle has not run yet for this snapshot.",
    },
  };
  const tradeLedger = snapshot.tradeLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalExecutedBnb: 0,
    totalDryRunBnb: 0,
  };
  const recentHistory = snapshot.recentHistory ?? [];
  const watchlist = snapshot.watchlist ?? [];
  const eligibleExecutionPlans = executionState.plans.filter(
    (plan) => plan.eligible,
  ).length;
  const gooConfigReadiness = [
    getDiscoveryConfig().goo.enabled ? 1 : 0,
    getDiscoveryConfig().goo.rpcUrl ? 1 : 0,
    getDiscoveryConfig().goo.registryAddress ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
  const gooReadiness = buildGooReadiness(getDiscoveryConfig());
  const treasuryRules = getDiscoveryConfig().treasury;
  const takeProfitSummary = treasuryRules.takeProfitRules
    .map((rule) => `${rule.label} +${rule.gainPct}% -> sell ${rule.sellPct}%`)
    .join(" · ");

  const topCandidates = snapshot.topCandidates
    .slice(0, 5)
    .map(
      (candidate, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${recommendationTone(candidate.recommendation)}">${escapeHtml(candidate.recommendation)}</span>
          </div>
          <h3><a class="candidate-link" href="${candidateHref(candidate.tokenAddress)}">${escapeHtml(candidate.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(candidate.poolName)} · ${escapeHtml(candidate.dexId)}</p>
          <div class="candidate-stats">
            <div><span>Score</span><strong>${candidate.score}/100</strong></div>
            <div><span>Liquidity</span><strong>$${Math.round(candidate.reserveUsd).toLocaleString()}</strong></div>
            <div><span>Volume 5m</span><strong>$${Math.round(candidate.volumeUsdM5).toLocaleString()}</strong></div>
            <div><span>Age</span><strong>${candidate.poolAgeMinutes}m</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const gooCandidates = snapshot.topGooCandidates
    .slice(0, 5)
    .map(
      (candidate, index) => `
        <article class="goo-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${recommendationTone(candidate.recommendation)}">${escapeHtml(candidate.recommendation)}</span>
          </div>
          <h3><a class="candidate-link" href="${gooCandidateHref(candidate.agentId)}">Agent ${escapeHtml(candidate.agentId)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(candidate.status)} lifecycle · CTO floor ${candidate.minimumCtoBnb} BNB · <a class="candidate-link" href="${gooCandidateHref(candidate.agentId)}">operator view</a></p>
          <div class="candidate-stats">
            <div><span>Score</span><strong>${candidate.score}/100</strong></div>
            <div><span>Treasury</span><strong>${candidate.treasuryBnb} BNB</strong></div>
            <div><span>Threshold</span><strong>${candidate.starvingThresholdBnb} BNB</strong></div>
            <div><span>Pulse</span><strong>${candidate.secondsUntilPulseTimeout ?? "n/a"}s</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const gooQueueRows = snapshot.topGooCandidates
    .slice(0, 6)
    .map((candidate) => {
      const detail = buildGooCandidateDetail(candidate, getDiscoveryConfig());
      return `
        <div class="status-row">
          <span><a class="watchlist-link" href="${gooCandidateHref(candidate.agentId)}">Agent ${escapeHtml(candidate.agentId)}</a></span>
          <strong>
            ${escapeHtml(detail.urgency)} · ${escapeHtml(candidate.recommendation)}<br />
            ${escapeHtml(detail.operatorAction)}
          </strong>
        </div>`;
    })
    .join("");

  const treasuryAllocationCards = treasurySimulation.positions
    .slice(0, 5)
    .map(
      (position, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill tone-hot">${escapeHtml(position.recommendation)}</span>
          </div>
          <h3>${escapeHtml(position.tokenSymbol)}</h3>
          <p class="candidate-subtitle">${escapeHtml(position.source)} allocation lane</p>
          <div class="candidate-stats">
            <div><span>Allocation</span><strong>${formatUsd(position.allocationUsd)}</strong></div>
            <div><span>Weight</span><strong>${position.allocationPct}%</strong></div>
            <div><span>Score</span><strong>${position.score}/100</strong></div>
            <div><span>Liquidity</span><strong>${formatUsd(position.reserveUsd)}</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const recentRuns = recentHistory
    .slice(0, 6)
    .map(
      (entry) => `
        <div class="status-row">
          <span>${escapeHtml(entry.generatedAt)}</span>
          <strong>
            ${entry.candidateCount} scans / ${entry.topRecommendationCount} buys<br />
            Avg ${entry.averageScore} / Treasury ${formatUsd(entry.treasuryAllocatedUsd)}
          </strong>
        </div>`,
    )
    .join("");

  const watchlistRows = watchlist
    .slice(0, 8)
    .map(
      (entry) => `
        <div class="status-row">
          <span><a class="watchlist-link" href="${candidateHref(entry.tokenAddress)}">${escapeHtml(entry.tokenSymbol)}</a></span>
          <strong>
            ${entry.currentRecommendation} · ${entry.currentScore}/100<br />
            Seen ${entry.appearances}x · Δ ${entry.scoreChange >= 0 ? "+" : ""}${entry.scoreChange}
          </strong>
        </div>`,
    )
    .join("");

  const closedPositions = portfolioLifecycle.exitedPositions;
  const profitableClosedPositions = closedPositions.filter(
    (position) => position.realizedPnlUsd > 0,
  );
  const winRatePct = closedPositions.length
    ? (profitableClosedPositions.length / closedPositions.length) * 100
    : null;
  const tradeRecords = tradeLedger.records.filter(
    (record) => record.plannedBuyBnb > 0,
  );
  const averageBuyBnb = average(
    tradeRecords.map((record) => record.plannedBuyBnb),
  );
  const holdDurationsMs = (
    closedPositions.length > 0
      ? closedPositions
      : portfolioLifecycle.activePositions
  )
    .map(
      (position) =>
        Date.parse(position.lastUpdatedAt) - Date.parse(position.firstSeenAt),
    )
    .filter((value) => Number.isFinite(value) && value > 0);
  const averageHoldMs = average(holdDurationsMs);
  const timezoneLabel =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const currentModel =
    process.env.OPENAI_MODEL?.trim() ||
    process.env.MOLTBOOK_MODEL?.trim() ||
    "n/a";
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const cloudAccountRows = renderDashboardCloudSidebar(cloudSession, cloudSummary);
  const riskProfile =
    executionState.risk.maxBuyBnb <= 0.02 &&
    executionState.risk.maxDailyDeployBnb <= 0.05
      ? "Conservative"
      : executionState.risk.maxBuyBnb <= 0.05 &&
          executionState.risk.maxDailyDeployBnb <= 0.2
        ? "Balanced"
        : "Aggressive";
  const sidebarWalletAddress = "0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F";
  const sidebarMasterCard = `
    <article class="sidebar-panel sidebar-panel--master">
      <div class="sidebar-panel__head">
        <div class="sidebar-avatar">${renderBrandLogoImage("sidebar-avatar__image")}</div>
        <div>
          <strong>elizaOK</strong>
        </div>
      </div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>Wallet</span><strong>${escapeHtml(shortAddress(sidebarWalletAddress))}</strong></div>
        <div class="status-row"><span>Balance</span><strong>${escapeHtml(sidebarWalletBalanceLabel)}</strong></div>
      </div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>TZ</span><strong>${escapeHtml(timezoneLabel)}</strong></div>
        <div class="status-row"><span>Scan</span><strong>${escapeHtml(formatRelativeTime(snapshot.generatedAt))}</strong></div>
        <div class="status-row"><span>Exec</span><strong>${escapeHtml(executionState.mode)} / ${executionState.dryRun ? "dry-run" : "live"}</strong></div>
      </div>
      <div class="sidebar-panel__title">LLM</div>
      <div class="llm-model-row">
        <span>Runtime model</span>
        <strong>${escapeHtml(currentModel)}</strong>
      </div>
      <div class="usage-stack">
        ${renderUsageRow("API key", hasOpenAiKey ? 100 : 0, hasOpenAiKey ? "100%" : "0%")}
        ${renderUsageRow("Model set", currentModel === "n/a" ? 0 : 100, currentModel === "n/a" ? "0%" : "100%")}
      </div>
      ${cloudAccountRows}
      <div class="sidebar-panel__title">System</div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>Discovery</span><strong>${Math.round(getDiscoveryConfig().intervalMs / 60_000)}m</strong></div>
        <div class="status-row"><span>Buy-ready</span><strong>${eligibleExecutionPlans}</strong></div>
        <div class="status-row"><span>Distribution</span><strong>${distributionExecution.enabled ? "armed" : "standby"}</strong></div>
        <div class="status-row"><span>Goo</span><strong>${getDiscoveryConfig().goo.enabled ? "armed" : "standby"}</strong></div>
      </div>
      <div class="sidebar-panel__title">Runtime</div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>Agent</span><strong>elizaOS</strong></div>
        <div class="status-row"><span>Health</span><strong>Discovery ${snapshot.summary.candidateCount > 0 ? "online" : "warming"} · Goo ${getDiscoveryConfig().goo.enabled ? "armed" : "standby"}</strong></div>
      </div>
    </article>`;
  const snapshotStatTiles = [
    { label: "Win Rate", value: formatPct(winRatePct) },
    { label: "Trades", value: String(tradeRecords.length) },
    { label: "Avg Hold", value: formatDuration(averageHoldMs) },
    {
      label: "Avg Size",
      value: averageBuyBnb === null ? "n/a" : formatBnb(averageBuyBnb),
    },
  ]
    .map(
      (item) => `
        <article class="snapshot-tile">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>`,
    )
    .join("");
  const discoveryPct = snapshot.summary.averageScore;
  const portfolioPct =
    portfolioLifecycle.grossPortfolioValueUsd > 0
      ? (portfolioLifecycle.totalCurrentValueUsd /
          portfolioLifecycle.grossPortfolioValueUsd) *
        100
      : 0;
  const executionPct =
    executionState.readinessTotal > 0
      ? (executionState.readinessScore / executionState.readinessTotal) * 100
      : 0;
  const distributionPct =
    distributionExecution.readinessTotal > 0
      ? (distributionExecution.readinessScore /
          distributionExecution.readinessTotal) *
        100
      : 0;
  const gooPct = (gooConfigReadiness / 3) * 100;
  const featureDockCards = [
    renderFeatureDockCard(
      "discovery-section",
      "Discovery",
      `${clampPercent(discoveryPct)}%`,
      `${snapshot.summary.candidateCount}`,
      `${snapshot.summary.topRecommendationCount} ready`,
      discoveryPct,
      "hot",
    ),
    renderFeatureDockCard(
      "portfolio-section",
      "Portfolio",
      `${clampPercent(portfolioPct)}%`,
      `${portfolioLifecycle.activePositions.length}`,
      `${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}`,
      portfolioPct,
      "cool",
    ),
    renderFeatureDockCard(
      "treasury-section",
      "Execution",
      `${clampPercent(executionPct)}%`,
      `${eligibleExecutionPlans}`,
      `${executionState.mode}`,
      executionPct,
      executionState.dryRun ? "warm" : "hot",
    ),
    renderFeatureDockCard(
      "distribution-section",
      "Distribution",
      `${clampPercent(distributionPct)}%`,
      `${distributionPlan.eligibleHolderCount}`,
      `${distributionPlan.recipients.length} recipients`,
      distributionPct,
      distributionExecution.dryRun ? "warm" : "hot",
    ),
    renderFeatureDockCard(
      "goo-section",
      "Goo",
      `${clampPercent(gooPct)}%`,
      `${snapshot.summary.gooAgentCount}`,
      `${snapshot.summary.gooPriorityCount} priority`,
      gooPct,
      "cool",
    ),
  ].join("");
  const discoveryFoldSummary = `${snapshot.summary.candidateCount} scanned · ${snapshot.summary.topRecommendationCount} buy-ready · avg ${snapshot.summary.averageScore}`;
  const portfolioFoldSummary = `${portfolioLifecycle.activePositions.length} active · ${portfolioLifecycle.watchPositions.length} watch · ${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}`;
  const treasuryFoldSummary = `${formatBnb(executionState.risk.maxBuyBnb)} max buy · ${eligibleExecutionPlans} eligible · ${tradeLedger.records.length} ledger`;
  const distributionFoldSummary = `${distributionPlan.eligibleHolderCount} holders · ${distributionPlan.recipients.length} recipients · ${distributionExecution.dryRun ? "dry-run" : "live"}`;
  const gooFoldSummary = `${snapshot.summary.gooAgentCount} reviewed · ${snapshot.summary.gooPriorityCount} priority · ${gooConfigReadiness}/3 ready`;
  const overviewVisualBars = [
    renderProgress(
      "Discovery",
      snapshot.summary.averageScore,
      100,
      `${snapshot.summary.averageScore}%`,
    ),
    renderProgress("Win rate", winRatePct ?? 0, 100, formatPct(winRatePct)),
    renderProgress(
      "Execution",
      executionPct,
      100,
      `${clampPercent(executionPct)}%`,
    ),
    renderProgress(
      "Distribution",
      distributionPct,
      100,
      `${clampPercent(distributionPct)}%`,
    ),
    renderProgress("Goo", gooPct, 100, `${clampPercent(gooPct)}%`),
    renderProgress(
      "Reserve",
      treasurySimulation.reservePct,
      100,
      `${treasurySimulation.reservePct}%`,
    ),
  ].join("");

  const distributionRecipients = distributionPlan.recipients
    .slice(0, 8)
    .map(
      (recipient, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill tone-cool">${recipient.allocationPct}%</span>
          </div>
          <h3>${escapeHtml(recipient.label || shortAddress(recipient.address))}</h3>
          <p class="candidate-subtitle">${escapeHtml(shortAddress(recipient.address))}</p>
          <div class="candidate-stats">
            <div><span>Balance</span><strong>${Math.round(recipient.balance).toLocaleString()}</strong></div>
            <div><span>Allocation</span><strong>${formatUsd(recipient.allocationUsd)}</strong></div>
            <div><span>Weight</span><strong>${recipient.allocationPct}%</strong></div>
            <div><span>Status</span><strong>Eligible</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const distributionExecutedRecipients = new Set(
    distributionLedger.records
      .filter(
        (record) =>
          record.disposition === "executed" &&
          distributionExecution.manifestFingerprint &&
          record.manifestFingerprint ===
            distributionExecution.manifestFingerprint,
      )
      .map((record) => record.recipientAddress.toLowerCase()),
  );

  const distributionPendingRecipients = distributionPlan.recipients
    .filter(
      (recipient) =>
        !distributionExecutedRecipients.has(recipient.address.toLowerCase()),
    )
    .slice(0, Math.max(1, distributionExecution.maxRecipientsPerRun || 5));

  const distributionPendingRows = distributionPendingRecipients
    .map(
      (recipient) => `
        <div class="status-row">
          <span>${escapeHtml(recipient.label || shortAddress(recipient.address))}</span>
          <strong>
            ${escapeHtml(shortAddress(recipient.address))} · ${recipient.allocationPct}%<br />
            ${formatUsd(recipient.allocationUsd)} current allocation plan
          </strong>
        </div>`,
    )
    .join("");

  const distributionExecutionRows = distributionExecution.readinessChecks
    .map(
      (check) => `
        <div class="status-row">
          <span>${escapeHtml(check.label)}</span>
          <strong>${check.ready ? "READY" : "TODO"}<br />${escapeHtml(check.detail)}</strong>
        </div>`,
    )
    .join("");

  const distributionLedgerRows = distributionLedger.records
    .slice(0, 6)
    .map(
      (record) => `
        <div class="status-row">
          <span>${escapeHtml(shortAddress(record.recipientAddress))}</span>
          <strong>
            ${escapeHtml(record.disposition)} · ${escapeHtml(record.amount)}${record.txHash ? ` · ${escapeHtml(shortAddress(record.txHash))}` : ""}<br />
            ${escapeHtml(record.reason)}
          </strong>
        </div>`,
    )
    .join("");

  const executionPlanRows = executionState.plans
    .slice(0, 6)
    .map(
      (plan) => `
        <div class="status-row">
          <span>${escapeHtml(plan.tokenSymbol)}</span>
          <strong>
            strategy ${plan.eligible ? "eligible" : "blocked"} · route ${escapeHtml(plan.routeTradable)} · ${plan.score}/100 · ${formatBnb(plan.plannedBuyBnb)}<br />
            ${escapeHtml(plan.routeReason || plan.reasons[0] || "No execution note.")}
          </strong>
        </div>`,
    )
    .join("");

  const recentTradeRows = tradeLedger.records
    .slice(0, 6)
    .map(
      (trade) => `
        <div class="status-row">
          <span>${escapeHtml(trade.tokenSymbol)}</span>
          <strong>
            ${escapeHtml(trade.side || "buy")} · ${escapeHtml(trade.disposition)} · ${formatBnb(trade.plannedBuyBnb)}${trade.txHash ? ` · ${escapeHtml(shortAddress(trade.txHash))}` : ""}<br />
            ${escapeHtml(trade.reason)}
          </strong>
        </div>`,
    )
    .join("");

  const activePortfolioCards = portfolioLifecycle.activePositions
    .slice(0, 6)
    .map(
      (position, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${pnlTone(position.unrealizedPnlUsd)}">${position.unrealizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.unrealizedPnlUsd)}</span>
          </div>
          <h3><a class="candidate-link" href="${candidateHref(position.tokenAddress)}">${escapeHtml(position.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(position.executionSource)} · ${escapeHtml(position.walletVerification)} · ${escapeHtml(position.state)} · ${escapeHtml(position.lastRecommendation)}</p>
          <div class="candidate-stats">
            <div><span>Initial</span><strong>${formatUsd(position.initialAllocationUsd)}</strong></div>
            <div><span>Allocated</span><strong>${formatUsd(position.allocationUsd)}</strong></div>
            <div><span>Current value</span><strong>${formatUsd(position.currentValueUsd)}</strong></div>
            <div><span>Wallet quote</span><strong>${position.walletQuoteUsd !== null && position.walletQuoteUsd !== undefined ? formatUsd(position.walletQuoteUsd) : "n/a"}</strong></div>
            <div><span>TP hit</span><strong>${position.takeProfitCount}</strong></div>
            <div><span>Unrealized</span><strong>${position.unrealizedPnlPct}%</strong></div>
            <div><span>Appearances</span><strong>${position.appearanceCount}</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const timelineRows = portfolioLifecycle.timeline
    .slice(0, 8)
    .map(
      (event) => `
        <div class="status-row">
          <span>${escapeHtml(event.generatedAt)}</span>
          <strong>
            ${escapeHtml(event.tokenSymbol)} · ${escapeHtml(event.type)}<br />
            ${escapeHtml(event.detail)}
          </strong>
        </div>`,
    )
    .join("");

  const overviewStateChips = [
    `execution ${escapeHtml(executionState.dryRun ? "dry-run" : "live")} / ${escapeHtml(executionState.mode)}`,
    `distribution ${escapeHtml(distributionExecution.dryRun ? "dry-run" : "live")} / ${escapeHtml(distributionPlan.selectedAsset.mode)}`,
    `goo ${escapeHtml(getDiscoveryConfig().goo.enabled ? (gooConfigReadiness === 3 ? "ready" : "warming") : "disabled")}`,
  ]
    .map((item) => `<div class="state-chip">${item}</div>`)
    .join("");
  const heroActionRow = `
    <div class="action-row">
      <a class="action-button" href="#discovery-section">Discovery Feed</a>
      <a class="action-button" href="/cloud/agents">Cloud Agents</a>
      <a class="action-button" href="/cloud/credits">Credits</a>
      <a class="action-button" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Open Cloud</a>
    </div>`;
  const heroStageRows = [
    {
      label: "Discovery board",
      value: `${snapshot.summary.candidateCount} scanned`,
      meta: `${snapshot.summary.topRecommendationCount} ready · avg ${snapshot.summary.averageScore}`,
    },
    {
      label: "Execution lane",
      value: `${eligibleExecutionPlans} tradable`,
      meta: `${executionState.mode} · ${executionState.dryRun ? "dry-run" : "live"}`,
    },
    {
      label: "Distribution loop",
      value: `${distributionPlan.recipients.length} recipients`,
      meta: `${distributionPlan.eligibleHolderCount} holders · ${distributionExecution.dryRun ? "simulated" : "armed"}`,
    },
    {
      label: "Goo operator",
      value: `${snapshot.summary.gooPriorityCount} priority`,
      meta: `${snapshot.summary.gooAgentCount} reviewed · ${getDiscoveryConfig().goo.enabled ? "enabled" : "standby"}`,
    },
  ]
    .map(
      (item) => `
        <div class="hero-stage__row">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
          <small>${escapeHtml(item.meta)}</small>
        </div>`,
    )
    .join("");
  const heroStage = `
    <div class="hero-stage">
      <div class="hero-stage__glyphs">♬ ★ ♬ ★ ♪ ✦ ♪</div>
      <div class="hero-stage__count">3</div>
      <div class="hero-stage__screen">
        ${renderBrandLogoImage("hero-stage__image")}
      </div>
      <div class="hero-stage__stack">
        ${heroStageRows}
      </div>
    </div>`;
  const summaryRibbon = [
    `${snapshot.summary.strongestCandidate?.tokenSymbol || "n/a"} strongest signal`,
    `${formatBnb(executionState.risk.maxBuyBnb)} max buy`,
    `${tradeLedger.records.length} executions tracked`,
    `${distributionPlan.selectedAsset.tokenSymbol || "distribution asset pending"}`,
  ]
    .map((item) => `<div class="summary-pill">${escapeHtml(item)}</div>`)
    .join("");
  const cloudTopSyncing = cloudSession
    ? cloudSession.displayName === "ElizaCloud User" ||
      cloudSession.organizationName === "ElizaCloud" ||
      cloudSession.credits === "linked"
    : false;
  const cloudToolbarLinks = renderCloudToolbarLinks(cloudSession);
  const cloudAuthButton = cloudSession
    ? `<a class="auth-link auth-link--connected" href="/auth/eliza-cloud/logout" title="${escapeHtml(cloudSession.displayName)}">${cloudTopSyncing ? "ElizaCloud · syncing" : `ElizaCloud · ${escapeHtml(cloudSession.displayName)} · ${escapeHtml(cloudSession.credits)} credits`}</a>`
    : `<button class="auth-link" type="button" data-cloud-hosted-auth>Sign in with ElizaCloud</button>`;
  const treasuryModelCards = [
    renderMetricCard(
      "Capital model",
      formatUsd(treasurySimulation.paperCapitalUsd),
      "Current treasury capital model baseline.",
    ),
    renderMetricCard(
      "Deployable",
      formatUsd(treasurySimulation.deployableCapitalUsd),
      "Capital currently available for new deployment.",
    ),
    renderMetricCard(
      "Allocated",
      formatUsd(treasurySimulation.allocatedUsd),
      "Capital presently assigned inside the treasury model.",
    ),
    renderMetricCard(
      "Dry powder",
      formatUsd(treasurySimulation.dryPowderUsd),
      "Remaining unallocated treasury capacity.",
    ),
    renderMetricCard(
      "Reserve",
      `${formatUsd(treasurySimulation.reserveUsd)} / ${treasurySimulation.reservePct}%`,
      "Capital held back under reserve discipline.",
    ),
    renderMetricCard(
      "Highest conviction",
      treasurySimulation.highestConvictionSymbol || "n/a",
      "Top name by current treasury conviction.",
    ),
  ].join("");
  const executionControlCards = [
    renderMetricCard(
      "Mode",
      executionState.mode,
      `Router ${executionState.router} in ${executionState.dryRun ? "dry-run" : "live"} mode.`,
    ),
    renderMetricCard(
      "Readiness",
      `${executionState.readinessScore}/${executionState.readinessTotal}`,
      "Current live execution readiness checks.",
    ),
    renderMetricCard(
      "Risk cap",
      formatBnb(executionState.risk.maxBuyBnb),
      `Daily cap ${formatBnb(executionState.risk.maxDailyDeployBnb)}.`,
    ),
    renderMetricCard(
      "Eligible lanes",
      String(eligibleExecutionPlans),
      "Candidates currently passing execution gates.",
    ),
    renderMetricCard(
      "Cycle result",
      `${executionState.cycleSummary.executedCount}/${executionState.cycleSummary.dryRunCount}/${executionState.cycleSummary.failedCount}`,
      "Executed / dry-run / failed counts for the latest cycle.",
    ),
  ].join("");
  const distributionStateCards = [
    renderMetricCard(
      "Holder pool",
      String(distributionPlan.eligibleHolderCount),
      `Minimum balance ${distributionPlan.minEligibleBalance}.`,
    ),
    renderMetricCard(
      "Distribution pool",
      formatUsd(distributionPlan.distributionPoolUsd),
      `Snapshot source ${distributionPlan.snapshotSource}.`,
    ),
    renderMetricCard(
      "Asset mode",
      distributionPlan.selectedAsset.mode,
      distributionPlan.selectedAsset.tokenSymbol ||
        shortAddress(distributionPlan.selectedAsset.tokenAddress || "n/a"),
    ),
    renderMetricCard(
      "Execution mode",
      distributionExecution.dryRun ? "dry_run" : "live",
      `${distributionExecution.readinessScore}/${distributionExecution.readinessTotal} readiness.`,
    ),
    renderMetricCard(
      "Batch size",
      String(distributionExecution.maxRecipientsPerRun),
      `Pending ${Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size)} recipients.`,
    ),
    renderMetricCard(
      "Fingerprint",
      shortAddress(distributionExecution.manifestFingerprint || "n/a"),
      "Current distribution campaign identity.",
    ),
  ].join("");
  const distributionRibbon = [
    `mode ${escapeHtml(distributionExecution.dryRun ? "dry_run" : "live")}`,
    `${distributionExecution.cycleSummary.dryRunCount} dry-run`,
    `${distributionExecution.cycleSummary.executedCount} executed`,
    `${Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size)} pending`,
  ]
    .map((item) => `<div class="summary-pill">${item}</div>`)
    .join("");
  const systemPulse = `
    <article class="glass-card section-card">
      <div class="section-title">
        <div>
          <h2>System</h2>
        </div>
      </div>
      <div class="status-panel">
        <div class="status-row"><span>Strongest candidate</span><strong>${escapeHtml(snapshot.summary.strongestCandidate?.tokenSymbol || "n/a")}</strong></div>
        <div class="status-row"><span>Strongest score</span><strong>${snapshot.summary.strongestCandidate?.score ?? "n/a"}</strong></div>
        <div class="status-row"><span>Recommendation</span><strong>${escapeHtml(snapshot.summary.strongestCandidate?.recommendation || "n/a")}</strong></div>
        <div class="status-row"><span>Goo reviewed</span><strong>${snapshot.summary.gooAgentCount}</strong></div>
        <div class="status-row"><span>Memo title</span><strong>${escapeHtml(snapshot.memoTitle)}</strong></div>
      </div>
    </article>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets("ElizaOK | elizaOK")}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #030301;
      --bg-soft: #080805;
      --panel: rgba(5, 5, 4, 0.9);
      --panel-strong: rgba(8, 8, 6, 0.96);
      --border: rgba(246, 231, 15, 0.14);
      --border-strong: rgba(246, 231, 15, 0.34);
      --text: #ffffff;
      --muted: rgba(255, 255, 255, 0.62);
      --accent: #F6E70F;
      --shadow: rgba(0, 0, 0, 0.72);
      --glow: 0 0 0 1px rgba(246, 231, 15, 0.06), 0 0 28px rgba(246, 231, 15, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      background:
        radial-gradient(circle at 18% 14%, rgba(246,231,15,0.07), transparent 18%),
        radial-gradient(circle at 82% 22%, rgba(246,231,15,0.03), transparent 16%),
        linear-gradient(180deg, #030301 0%, #030301 56%, #050503 100%);
      color: var(--text);
      font-family: "Kode Mono", monospace;
      overflow-x: hidden;
      overflow-y: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(246,231,15,0.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(246,231,15,0.018) 1px, transparent 1px),
        repeating-linear-gradient(180deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 18px);
      background-size: 34px 34px, 34px 34px, 100% 18px;
      mask-image: linear-gradient(180deg, rgba(0,0,0,0.85), transparent);
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 18% 20%, rgba(255,255,255,0.03), transparent 14%),
        radial-gradient(circle at 72% 24%, rgba(246,231,15,0.05), transparent 18%),
        radial-gradient(circle at 60% 76%, rgba(246,231,15,0.035), transparent 18%);
      animation: ambient 10s ease-in-out infinite alternate;
      opacity: 0.7;
    }
    @keyframes ambient {
      from { transform: translate3d(0,0,0) scale(1); }
      to { transform: translate3d(0,-8px,0) scale(1.02); }
    }
    .app-shell {
      position: relative;
      z-index: 1;
      display: block;
      min-height: 100vh;
      overflow: hidden;
    }
    .sidebar { display: none; }
    .app-shell::before {
      content: "// ELIZAOK :: SIGNAL_MESH :: 010110";
      position: fixed;
      right: 18px;
      bottom: 14px;
      color: rgba(255,255,255,0.12);
      font-size: 10px;
      letter-spacing: 0.18em;
      pointer-events: none;
      z-index: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 4px 10px;
      border-bottom: 1px solid rgba(255,214,10,0.1);
      position: relative;
    }
    .brand::after {
      content: "";
      position: absolute;
      left: 4px;
      right: 4px;
      bottom: -1px;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,10,0.42), transparent);
      opacity: 0.85;
    }
    .brand-mark {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 30% 30%, rgba(255,214,10,0.85), transparent 38%),
        linear-gradient(135deg, rgba(255,214,10,0.28), rgba(255,214,10,0.05));
      border: 1px solid rgba(255,214,10,0.24);
      box-shadow: 0 0 28px rgba(255,214,10,0.16), inset 0 0 0 1px rgba(255,214,10,0.08);
      overflow: hidden;
    }
    .brand-mark::after {
      content: "";
      position: absolute;
      inset: auto -12px -12px auto;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,214,10,0.22), transparent 72%);
      pointer-events: none;
    }
    .brand-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .brand-copy strong {
      display: block;
      font-size: 15px;
      letter-spacing: 0.08em;
      text-transform: lowercase;
      text-shadow: 0 0 18px rgba(255,214,10,0.14);
    }
    .brand-copy small {
      display: block;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      margin-top: 4px;
      opacity: 0.92;
    }
    .nav { display: none; }
    .nav-button {
      width: 100%;
      border: 1px solid transparent;
      background: rgba(255,214,10,0.02);
      color: var(--text);
      border-radius: 18px;
      padding: 14px 14px 14px 12px;
      display: flex;
      gap: 12px;
      align-items: center;
      text-align: left;
      cursor: pointer;
      transition: 180ms ease;
      position: relative;
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.02);
    }
    .nav-button::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(110deg, transparent 28%, rgba(255,214,10,0.08) 50%, transparent 72%);
      transform: translateX(-120%);
      transition: transform 320ms ease;
      pointer-events: none;
    }
    .nav-button:hover,
    .nav-button.is-active {
      background: linear-gradient(90deg, rgba(255,214,10,0.14), rgba(255,214,10,0.03));
      border-color: var(--border-strong);
      transform: translateX(2px);
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.08), 0 14px 30px rgba(0,0,0,0.3);
    }
    .nav-button:hover::after,
    .nav-button.is-active::after { transform: translateX(120%); }
    .action-row {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .action-button {
      border: 1px solid rgba(255,214,10,0.38);
      background: linear-gradient(135deg, rgba(255,214,10,0.18), rgba(255,214,10,0.05));
      color: var(--text);
      border-radius: 14px;
      padding: 12px 16px;
      font-family: inherit;
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      cursor: pointer;
      transition: 160ms ease;
    }
    .action-button:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
      box-shadow: 0 12px 24px rgba(0,0,0,0.28);
    }
    .action-button:disabled {
      opacity: 0.55;
      cursor: progress;
      transform: none;
    }
    .nav-index {
      color: var(--accent);
      font-size: 11px;
      letter-spacing: 0.18em;
      min-width: 26px;
    }
    .nav-glyph {
      width: 30px;
      height: 30px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      color: var(--accent);
      background: rgba(255,214,10,0.06);
      border: 1px solid rgba(255,214,10,0.1);
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.04);
    }
    .nav-copy strong {
      display: block;
      font-size: 14px;
      margin-bottom: 4px;
    }
    .nav-copy small {
      display: block;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .sidebar-panels {
      display: grid;
      gap: 12px;
      margin: 18px 0 16px;
    }
    .dashboard-top-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
    }
    .sidebar-panel {
      padding: 11px;
      border-radius: 16px;
      border: 1px solid rgba(246,231,15,0.12);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.05), rgba(246,231,15,0.012)),
        rgba(6,6,5,0.92);
      box-shadow: var(--glow), inset 0 0 0 1px rgba(246,231,15,0.035);
      display: grid;
      gap: 8px;
    }
    .sidebar-panel__head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .sidebar-panel--master .sidebar-panel__head {
      justify-items: center;
      justify-content: center;
      text-align: center;
      flex-direction: column;
      gap: 12px;
    }
    .sidebar-panel__head strong,
    .sidebar-panel__title {
      display: block;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .sidebar-panel__head small { display: none; }
    .sidebar-avatar {
      width: 84px;
      height: 84px;
      border-radius: 50%;
      overflow: hidden;
      border: 1px solid rgba(255,214,10,0.18);
      background: rgba(246,231,15,0.05);
      box-shadow: 0 0 24px rgba(246,231,15,0.16);
      flex: 0 0 auto;
      margin: 0 auto;
    }
    .sidebar-avatar__image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .sidebar-action-row { display: none; }
    .sidebar-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      border-radius: 10px;
      border: 1px solid rgba(255,214,10,0.16);
      background: rgba(246,231,15,0.035);
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      transition: 180ms ease;
    }
    .sidebar-action:hover {
      border-color: var(--border-strong);
      color: var(--accent);
      transform: translateY(-1px);
    }
    .sidebar-action.is-busy,
    .sidebar-action[aria-disabled="true"] {
      pointer-events: none;
      opacity: 0.72;
    }
    .sidebar-action--primary {
      border-color: rgba(255,214,10,0.22);
      background: linear-gradient(135deg, rgba(255,214,10,0.18), rgba(255,214,10,0.05));
    }
    .compact-status {
      gap: 8px;
    }
    .llm-model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 11px;
    }
    .llm-model-row strong {
      color: var(--text);
      font-size: 11px;
      line-height: 1.35;
      text-align: right;
    }
    .usage-stack {
      display: grid;
      gap: 7px;
    }
    .usage-row {
      display: grid;
      grid-template-columns: minmax(0, 56px) 1fr auto;
      align-items: center;
      gap: 7px;
      font-size: 10px;
      color: var(--muted);
    }
    .usage-row strong {
      color: var(--text);
      font-size: 11px;
      min-width: 34px;
      text-align: right;
    }
    .usage-meter {
      display: grid;
      grid-template-columns: repeat(10, minmax(0, 1fr));
      gap: 3px;
    }
    .usage-meter i {
      display: block;
      height: 6px;
      border-radius: 999px;
      background: rgba(255,214,10,0.08);
      border: 1px solid rgba(255,214,10,0.06);
    }
    .usage-meter i.is-on {
      background: linear-gradient(90deg, #745519, #d7a428, #f1df9a);
      border-color: rgba(255,214,10,0.18);
      box-shadow: 0 0 14px rgba(255,214,10,0.08);
    }
    .workspace {
      min-width: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 18px 18px 32px;
      overflow: visible;
    }
    .topbar {
      position: static;
      z-index: 4;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 22px;
      border: 1px solid rgba(246,231,15,0.18);
      background:
        radial-gradient(circle at top left, rgba(246,231,15,0.09), transparent 22%),
        linear-gradient(180deg, rgba(246,231,15,0.05), rgba(246,231,15,0.01)),
        rgba(5,5,4,0.74);
      backdrop-filter: blur(10px);
      box-shadow: 0 18px 56px rgba(0,0,0,0.34), inset 0 0 0 1px rgba(246,231,15,0.04);
      width: min(100%, 1220px);
    }
    .topbar::after {
      content: "";
      position: absolute;
      inset: auto 18px 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,10,0.45), transparent);
      opacity: 0.9;
    }
    .topbar-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .live-dot {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 18px rgba(255,214,10,0.72);
      animation: beat 1.6s ease-in-out infinite;
    }
    @keyframes beat {
      0%,100% { transform: scale(1); opacity: 0.7; }
      50% { transform: scale(1.35); opacity: 1; }
    }
    .topbar-title strong {
      display: block;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .topbar-title small {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .meta-chip {
      padding: 6px 9px;
      border-radius: 999px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--text);
      font-size: 10px;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.025);
    }
    .social-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .auth-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 110px;
      height: 34px;
      padding: 0 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,214,10,0.28);
      background:
        linear-gradient(135deg, rgba(255,214,10,0.2), rgba(255,214,10,0.05)),
        rgba(255,255,255,0.02);
      color: var(--text);
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      transition: 180ms ease;
      cursor: pointer;
      appearance: none;
      font-family: inherit;
    }
    .auth-link:hover {
      border-color: var(--border-strong);
      color: var(--text);
      transform: translateY(-1px);
    }
    .auth-link.is-busy,
    .auth-link[aria-disabled="true"] {
      pointer-events: none;
      opacity: 0.72;
    }
    .auth-link--connected {
      min-width: 220px;
      max-width: 520px;
      justify-content: flex-start;
      gap: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      background: rgba(255,214,10,0.08);
    }
    .auth-sheet {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(0,0,0,0.78);
      backdrop-filter: blur(18px);
      z-index: 50;
    }
    .auth-sheet.is-open {
      display: flex;
    }
    .auth-sheet__dialog {
      width: min(440px, 100%);
      border-radius: 22px;
      border: 1px solid rgba(246,231,15,0.18);
      background: linear-gradient(180deg, rgba(9,9,7,0.98), rgba(4,4,3,0.98));
      box-shadow: 0 28px 90px rgba(0,0,0,0.62), 0 0 0 1px rgba(246,231,15,0.06);
      padding: 18px;
      display: grid;
      gap: 14px;
    }
    .auth-sheet__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .auth-sheet__title {
      display: grid;
      gap: 4px;
    }
    .auth-sheet__title strong {
      font-size: 15px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text);
    }
    .auth-sheet__title span {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.5;
    }
    .auth-sheet__close {
      width: 34px;
      height: 34px;
      border-radius: 11px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      font: inherit;
      cursor: pointer;
    }
    .auth-sheet__provider,
    .auth-sheet__submit,
    .auth-sheet__secondary {
      width: 100%;
      min-height: 42px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      font: inherit;
      cursor: pointer;
      transition: 160ms ease;
    }
    .auth-sheet__provider:hover,
    .auth-sheet__submit:hover,
    .auth-sheet__secondary:hover {
      border-color: rgba(246,231,15,0.28);
      transform: translateY(-1px);
    }
    .auth-sheet__provider {
      background: linear-gradient(135deg, rgba(246,231,15,0.14), rgba(255,255,255,0.02));
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 11px;
    }
    .auth-sheet__secondary {
      background: rgba(255,255,255,0.02);
      font-size: 11px;
      color: var(--muted);
    }
    .auth-sheet__divider {
      position: relative;
      text-align: center;
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.4);
    }
    .auth-sheet__divider::before {
      content: "";
      position: absolute;
      inset: 50% 0 auto;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .auth-sheet__divider span {
      position: relative;
      padding: 0 10px;
      background: rgba(7,7,5,0.98);
    }
    .auth-sheet__stack {
      display: grid;
      gap: 10px;
    }
    .auth-sheet__field {
      display: grid;
      gap: 6px;
    }
    .auth-sheet__field label {
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.58);
    }
    .auth-sheet__field input {
      width: 100%;
      min-height: 42px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.03);
      color: var(--text);
      padding: 0 12px;
      font: inherit;
      outline: none;
    }
    .auth-sheet__field input:focus {
      border-color: rgba(246,231,15,0.32);
      box-shadow: 0 0 0 1px rgba(246,231,15,0.08);
    }
    .auth-sheet__status {
      min-height: 18px;
      font-size: 11px;
      color: var(--muted);
      line-height: 1.5;
    }
    .auth-sheet__status.is-error {
      color: #ff8c7a;
    }
    .auth-sheet__status.is-success {
      color: #d8ff88;
    }
    .auth-sheet__account {
      display: grid;
      gap: 6px;
      padding: 12px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
    }
    .auth-sheet__account strong {
      font-size: 12px;
      color: var(--text);
    }
    .auth-sheet__account span {
      font-size: 10px;
      color: var(--muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .auth-sheet__logout[hidden],
    .auth-sheet__otp[hidden] {
      display: none;
    }
    .cloud-model-picker {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .cloud-model-picker select {
      width: 100%;
      min-height: 34px;
      border-radius: 10px;
      border: 1px solid rgba(255,214,10,0.16);
      background: rgba(255,214,10,0.04);
      color: var(--text);
      font-family: inherit;
      font-size: 11px;
      padding: 0 10px;
      outline: none;
    }
    .social-link {
      width: 36px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 12px;
      border: 1px solid rgba(246,231,15,0.16);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.06), rgba(246,231,15,0.02)),
        rgba(255,255,255,0.03);
      color: var(--text);
      transition: 180ms ease;
    }
    .social-link:hover {
      color: var(--text);
      border-color: rgba(246,231,15,0.28);
      box-shadow: 0 0 24px rgba(246,231,15,0.12);
      transform: translateY(-1px);
    }
    .social-link svg { width: 16px; height: 16px; }
    .content-stack {
      width: min(100%, 1220px);
      margin-top: 14px;
      display: grid;
      grid-template-columns: 1fr;
      grid-auto-rows: min-content;
      align-content: start;
      gap: 14px;
      flex: 1;
    }
    .view-panel { display: grid; gap: 10px; }
    .view-panel.is-active { display: grid; animation: fade 180ms ease; }
    @keyframes fade {
      from { opacity: 0; transform: translate3d(0,8px,0); }
      to { opacity: 1; transform: translate3d(0,0,0); }
    }
    .glass-card {
      border-radius: 28px;
      border: 1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.05), rgba(246,231,15,0.012)),
        rgba(5,5,4,0.92);
      box-shadow: var(--glow), 0 24px 72px var(--shadow);
      overflow: hidden;
      position: relative;
      backdrop-filter: blur(10px);
    }
    .glass-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,10,0.4), transparent);
      opacity: 0.8;
      pointer-events: none;
    }
    .hero-card {
      padding: 18px;
      min-height: 0;
    }
    .hero-card::before {
      content: "";
      position: absolute;
      inset: -24% auto auto 64%;
      width: 180px;
      height: 180px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,214,10,0.18), transparent 68%);
      animation: orb 9s ease-in-out infinite alternate;
    }
    .hero-card::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(115deg, transparent 35%, rgba(255,214,10,0.08) 50%, transparent 62%);
      transform: translateX(-100%);
      animation: scan 6s linear infinite;
      opacity: 0.28;
    }
    @keyframes orb { from { transform: translate3d(0,0,0); } to { transform: translate3d(-24px,24px,0); } }
    @keyframes scan { from { transform: translateX(-100%); } to { transform: translateX(120%); } }
    .hero-grid,
    .split-grid,
    .stats-grid,
    .signal-grid {
      display: grid;
      gap: 10px;
    }
    .hero-grid { grid-template-columns: 1.08fr 0.92fr; position: relative; z-index: 1; align-items: stretch; min-height: 520px; }
    .hero-side-stack {
      display: grid;
      gap: 14px;
      margin-top: 16px;
    }
    .signal-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 0; }
    .stats-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .split-grid { grid-template-columns: 1.4fr 1fr; }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
      font-size: 10px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .eyebrow::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 14px rgba(255,214,10,0.7);
    }
    h1 {
      margin: 8px 0 10px;
      font-size: clamp(30px, 4vw, 52px);
      line-height: 0.96;
      letter-spacing: -0.04em;
      max-width: none;
      text-wrap: auto;
    }
    .hero-copy,
    .section-title p,
    .candidate-thesis,
    .footer-note { color: var(--muted); }
    .hero-copy { margin: 0; font-size: 13px; line-height: 1.7; max-width: 58ch; }
    .hero-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .state-chip {
      padding: 6px 9px;
      border-radius: 999px;
      background: rgba(255,214,10,0.09);
      border: 1px solid rgba(255,214,10,0.14);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--text);
    }
    .hero-kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      margin-top: 20px;
    }
    .hero-kpi-card {
      padding: 18px 20px;
      border-radius: 20px;
      border: 1px solid rgba(246,231,15,0.12);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.05), rgba(246,231,15,0.012)),
        rgba(7,7,6,0.92);
      box-shadow: var(--glow), inset 0 0 0 1px rgba(246,231,15,0.03);
      position: relative;
      overflow: hidden;
    }
    .hero-kpi-card::after {
      content: "";
      position: absolute;
      inset: auto -20px -20px auto;
      width: 84px;
      height: 84px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,214,10,0.12), transparent 72%);
      pointer-events: none;
    }
    .hero-kpi-card:first-child {
      background:
        radial-gradient(circle at top right, rgba(255,214,10,0.16), transparent 42%),
        linear-gradient(180deg, rgba(255,214,10,0.1), rgba(255,214,10,0.03));
      border-color: rgba(255,214,10,0.2);
    }
    .hero-kpi-card span,
    .hero-kpi-card small {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
    }
    .hero-kpi-card strong {
      display: block;
      margin: 10px 0 8px;
      font-size: 24px;
      line-height: 1.1;
      color: var(--text);
    }
    .hero-kpi-card small {
      text-transform: none;
      letter-spacing: 0.04em;
      font-size: 12px;
      line-height: 1.6;
    }
    .summary-ribbon {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: -4px;
      padding: 16px 18px;
      border-radius: 20px;
      border: 1px solid rgba(246,231,15,0.12);
      background: linear-gradient(90deg, rgba(246,231,15,0.07), rgba(246,231,15,0.018));
      box-shadow: var(--glow), inset 0 0 0 1px rgba(246,231,15,0.03);
    }
    .summary-pill {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--text);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .section-card--accent {
      background:
        radial-gradient(circle at top right, rgba(255,214,10,0.12), transparent 32%),
        linear-gradient(180deg, rgba(255,214,10,0.08), rgba(255,214,10,0.02)),
        rgba(11,11,11,0.9);
    }
    .section-card--dense .status-panel,
    .section-card--dense .section-stack {
      gap: 10px;
    }
    .section-card--spotlight {
      background:
        radial-gradient(circle at 12% 14%, rgba(255,214,10,0.11), transparent 24%),
        linear-gradient(180deg, rgba(255,214,10,0.07), rgba(255,214,10,0.018)),
        rgba(11,11,11,0.88);
    }
    .snapshot-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-top: 16px;
    }
    .feature-dock-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
    }
    .feature-dock-card {
      display: grid;
      gap: 8px;
      padding: 14px;
      border-radius: 20px;
      border: 1px solid rgba(246,231,15,0.14);
      background:
        radial-gradient(circle at top right, rgba(246,231,15,0.12), transparent 42%),
        linear-gradient(180deg, rgba(246,231,15,0.055), rgba(246,231,15,0.012)),
        rgba(7,7,6,0.92);
      box-shadow: inset 0 0 0 1px rgba(246,231,15,0.03), 0 12px 28px rgba(0,0,0,0.2);
      transition: 180ms ease;
      width: 100%;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
    }
    .feature-dock-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255,214,10,0.18);
      box-shadow: 0 16px 36px rgba(0,0,0,0.22);
    }
    .feature-dock-card--hot {
      background:
        radial-gradient(circle at top right, rgba(255,214,10,0.14), transparent 42%),
        rgba(255,214,10,0.04);
    }
    .feature-dock-card--warm {
      background:
        radial-gradient(circle at top right, rgba(255,214,10,0.08), transparent 38%),
        rgba(255,214,10,0.03);
    }
    .feature-dock-card__top,
    .feature-dock-card span,
    .feature-dock-card small,
    .feature-dock-card em {
      display: block;
    }
    .feature-dock-card__top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .feature-dock-card span {
      color: var(--text);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .feature-dock-card strong,
    .feature-dock-card b {
      display: block;
      color: var(--text);
    }
    .feature-dock-card__value {
      font-size: 28px;
      line-height: 1.02;
      font-weight: 700;
      margin-top: 0;
    }
    .feature-dock-card small {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
    }
    .feature-dock-card em {
      color: #151100;
      font-style: normal;
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,214,10,0.22);
      background: var(--accent);
    }
    .feature-dock-card__track {
      height: 6px;
      border-radius: 999px;
      background: rgba(255,214,10,0.08);
      overflow: hidden;
      margin-top: 4px;
    }
    .feature-dock-card__fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #745519, #d7a428, #f1df9a);
      box-shadow: 0 0 14px rgba(255,214,10,0.28);
    }
    .fold-section { display: none; }
    .fold-summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      cursor: pointer;
    }
    .fold-summary::-webkit-details-marker {
      display: none;
    }
    .fold-summary strong {
      font-size: 13px;
      letter-spacing: 0.04em;
    }
    .fold-summary span {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
      flex: 1;
      text-align: right;
    }
    .fold-summary::after {
      content: "+";
      color: var(--text);
      font-size: 15px;
      line-height: 1;
    }
    .fold-section[open] .fold-summary::after {
      content: "−";
    }
    .fold-body {
      padding: 0 12px 12px;
      border-top: 1px solid rgba(255,214,10,0.08);
    }
    .snapshot-tile {
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid rgba(246,231,15,0.1);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.045), rgba(246,231,15,0.012)),
        rgba(7,7,6,0.9);
      box-shadow: inset 0 0 0 1px rgba(246,231,15,0.025);
    }
    .snapshot-tile span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .snapshot-tile strong {
      display: block;
      margin-top: 8px;
      font-size: 17px;
      line-height: 1.1;
    }
    .profile-label {
      display: inline-flex;
      align-items: center;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.05);
      color: var(--text);
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    .radar-box {
      min-height: 100%;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .radar {
      width: min(240px, 100%);
      aspect-ratio: 1;
      position: relative;
      border-radius: 50%;
      border: 1px solid rgba(255,214,10,0.18);
      background:
        radial-gradient(circle, rgba(255,214,10,0.12), transparent 52%),
        repeating-radial-gradient(circle, rgba(255,214,10,0.08) 0 1px, transparent 1px 34px);
      box-shadow: inset 0 0 42px rgba(255,214,10,0.08);
    }
    .radar::before,
    .radar::after {
      content: "";
      position: absolute;
      inset: 50%;
      transform: translate(-50%, -50%);
      background: rgba(255,214,10,0.12);
    }
    .radar::before { width: 1px; height: 100%; }
    .radar::after { width: 100%; height: 1px; }
    .radar-sweep {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: conic-gradient(from 0deg, rgba(255,214,10,0), rgba(255,214,10,0.2), rgba(255,214,10,0));
      animation: spin 4.8s linear infinite;
      mask-image: radial-gradient(circle at center, transparent 18%, black 64%);
    }
    .radar-core {
      position: absolute;
      inset: 50%;
      width: 18px;
      height: 18px;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 22px rgba(255,214,10,0.75);
    }
    .radar-label {
      position: absolute;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
    }
    @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
    .progress-card,
    .section-card,
    .stat-card,
    .candidate-card,
    .goo-card {
      position: relative;
      overflow: hidden;
      transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
    }
    .progress-card,
    .candidate-card,
    .goo-card {
      border-radius: 18px;
      border: 1px solid rgba(246,231,15,0.12);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.05), rgba(246,231,15,0.012)),
        rgba(7,7,6,0.92);
      box-shadow: var(--glow);
    }
    .progress-card { padding: 12px 14px; }
    .progress-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
    }
    .progress-head strong { color: var(--text); font-size: 11px; }
    .progress-track {
      height: 8px;
      border-radius: 999px;
      background: rgba(255,214,10,0.08);
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #745519, #d7a428, #f1df9a);
      box-shadow: 0 0 18px rgba(255,214,10,0.42);
    }
    .progress-card { padding: 8px 10px; }
    .stat-card { padding: 14px; min-height: 122px; }
    .stat-card:hover,
    .candidate-card:hover,
    .goo-card:hover,
    .section-card:hover {
      transform: translateY(-3px);
      border-color: var(--border-strong);
      box-shadow: 0 0 0 1px rgba(246,231,15,0.08), 0 0 28px rgba(246,231,15,0.12), 0 30px 84px rgba(0,0,0,0.42);
    }
    .stat-card span,
    .candidate-stats span,
    .status-row span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 6px;
    }
    .stat-card strong {
      display: block;
      font-size: 24px;
      line-height: 1;
      margin: 10px 0 12px;
    }
    .stat-card p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .section-card { padding: 12px; }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      position: relative;
    }
    .section-title::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: -6px;
      height: 1px;
      background: linear-gradient(90deg, rgba(255,214,10,0.22), transparent 72%);
      opacity: 0.75;
    }
    .section-heading {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .section-icon {
      width: 26px;
      height: 26px;
      border-radius: 9px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text);
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.025);
      font-size: 11px;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .section-title h2 { margin: 0; font-size: 16px; letter-spacing: -0.02em; }
    .section-title p { margin: 4px 0 0; font-size: 11px; line-height: 1.45; max-width: 68ch; }
    .section-stack { display: grid; gap: 10px; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .metric-card {
      padding: 10px;
      border-radius: 14px;
      border: 1px solid rgba(246,231,15,0.1);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.05), rgba(246,231,15,0.012)),
        rgba(7,7,6,0.9);
      box-shadow: var(--glow), inset 0 0 0 1px rgba(246,231,15,0.03);
      transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
    }
    .metric-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255,214,10,0.18);
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.05), 0 18px 44px rgba(0,0,0,0.22);
    }
    .metric-card span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 7px;
    }
    .metric-card strong {
      display: block;
      font-size: 15px;
      line-height: 1.1;
      margin-bottom: 6px;
      color: var(--text);
    }
    .metric-card p {
      margin: 0;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.4;
    }
    .mini-panel {
      padding: 14px 16px;
      border-radius: 18px;
      border: 1px solid rgba(246,231,15,0.1);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.05), rgba(246,231,15,0.014)),
        rgba(7,7,6,0.92);
      box-shadow: var(--glow), inset 0 0 0 1px rgba(246,231,15,0.03);
    }
    .mini-panel span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 8px;
    }
    .mini-panel strong {
      display: block;
      font-size: 16px;
      line-height: 1.45;
      margin-bottom: 8px;
    }
    .mini-panel p {
      margin: 0;
      font-size: 12px;
      line-height: 1.75;
    }
    .candidate-card,
    .goo-card { padding: 10px; }
    .candidate-card::after,
    .goo-card::after {
      content: "";
      position: absolute;
      inset: auto -40px -40px auto;
      width: 120px;
      height: 120px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,214,10,0.12), transparent 72%);
    }
    .candidate-card::before,
    .goo-card::before,
    .stat-card::before {
      content: "";
      position: absolute;
      left: 18px;
      right: 18px;
      top: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,10,0.5), transparent);
      opacity: 0.85;
    }
    .candidate-card,
    .goo-card {
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.03);
    }
    .candidate-card__meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .candidate-rank {
      color: var(--text);
      font-size: 11px;
      letter-spacing: 0.18em;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 5px 8px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      border: 1px solid transparent;
    }
    .tone-hot { color: #171100; background: var(--accent); }
    .tone-warm { color: #1a1200; background: rgba(255,214,10,0.72); }
    .tone-cool {
      color: var(--text);
      background: rgba(255,214,10,0.08);
      border-color: rgba(255,214,10,0.16);
    }
    .candidate-card h3,
    .goo-card h3 { margin: 0 0 6px; font-size: 15px; letter-spacing: -0.02em; }
    .candidate-link,
    .watchlist-link { color: inherit; }
    .candidate-link:hover,
    .watchlist-link:hover { color: var(--accent); }
    .candidate-subtitle { margin: 0 0 10px; color: var(--muted); font-size: 10px; line-height: 1.45; }
    .candidate-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 6px;
    }
    .candidate-stats div {
      padding: 7px 8px;
      border-radius: 10px;
      background: rgba(246,231,15,0.04);
      border: 1px solid rgba(246,231,15,0.08);
    }
    .candidate-stats strong { font-size: 12px; line-height: 1.35; }
    .candidate-thesis { margin: 0; font-size: 11px; line-height: 1.5; }
    .status-panel { display: grid; gap: 8px; }
    .status-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 9px;
      border-radius: 10px;
      background: rgba(246,231,15,0.04);
      border: 1px solid rgba(246,231,15,0.1);
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
      box-shadow: inset 0 0 0 1px rgba(246,231,15,0.025);
    }
    .status-row:hover {
      transform: translateX(2px);
      border-color: rgba(246,231,15,0.18);
      background: rgba(246,231,15,0.06);
    }
    .status-row strong { text-align: right; font-size: 11px; line-height: 1.35; }
    .footer-note { margin-top: 10px; font-size: 10px; line-height: 1.45; }
    .footer-note code { color: var(--text); word-break: break-all; }
    .content-stack > .view-panel[data-view-panel="overview"] {
      grid-column: 1 / -1;
    }
    .view-panel[data-view-panel="overview"] {
      grid-template-columns: 1fr;
      align-items: start;
    }
    .hero-stage {
      height: 100%;
      min-height: 420px;
      border-radius: 28px;
      border: 1px solid rgba(246,231,15,0.18);
      background:
        radial-gradient(circle at 50% 10%, rgba(246,231,15,0.16), transparent 24%),
        radial-gradient(circle at 50% 84%, rgba(255,255,255,0.03), transparent 26%),
        linear-gradient(180deg, rgba(246,231,15,0.08), rgba(246,231,15,0.02)),
        rgba(10,10,8,0.92);
      padding: 16px;
      position: relative;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 12px;
      box-shadow: inset 0 0 0 1px rgba(246,231,15,0.04), 0 16px 32px rgba(0,0,0,0.24);
    }
    .hero-stage__count {
      position: absolute;
      left: 20px;
      top: 16px;
      font-size: 32px;
      line-height: 1;
      font-weight: 700;
      color: var(--text);
      text-shadow: 0 0 18px rgba(246,231,15,0.18);
    }
    .hero-stage__glyphs {
      color: rgba(246,231,15,0.82);
      font-size: 11px;
      letter-spacing: 0.3em;
      text-align: center;
    }
    .hero-stage__screen {
      position: relative;
      min-height: 190px;
      border-radius: 24px;
      border: 1px solid rgba(246,231,15,0.14);
      background:
        radial-gradient(circle at center, rgba(246,231,15,0.16), transparent 34%),
        linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01)),
        rgba(0,0,0,0.2);
      display: grid;
      place-items: center;
      overflow: hidden;
    }
    .hero-stage__screen::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, transparent, rgba(246,231,15,0.08), transparent);
      opacity: 0.8;
    }
    .hero-stage__image {
      width: 190px;
      height: 190px;
      object-fit: cover;
      border-radius: 28px;
      filter: drop-shadow(0 0 32px rgba(246,231,15,0.2));
      position: relative;
      z-index: 1;
    }
    .stage-decor {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
    }
    .stage-decor span {
      position: absolute;
      color: rgba(246,231,15,0.88);
      text-shadow: 0 0 12px rgba(246,231,15,0.1);
      animation: floatNote 9s ease-in-out infinite alternate;
    }
    .stage-decor span:nth-child(1)  { left:  2%; top: 8%;  font-size: 22px; animation-delay: 0s; }
    .stage-decor span:nth-child(2)  { left:  8%; top: 22%; font-size: 13px; animation-delay: 1s; }
    .stage-decor span:nth-child(3)  { left: 16%; top: 6%;  font-size: 17px; animation-delay: 2s; }
    .stage-decor span:nth-child(4)  { left: 24%; top: 28%; font-size: 11px; animation-delay: 0.5s; }
    .stage-decor span:nth-child(5)  { left: 40%; top: 4%;  font-size: 14px; animation-delay: 3s; }
    .stage-decor span:nth-child(6)  { right: 2%; top: 9%;  font-size: 20px; animation-delay: 1.5s; }
    .stage-decor span:nth-child(7)  { right: 8%; top: 22%; font-size: 12px; animation-delay: 2.5s; }
    .stage-decor span:nth-child(8)  { right: 18%; top: 6%; font-size: 16px; animation-delay: 0.8s; }
    .stage-decor span:nth-child(9)  { right: 30%; top: 30%; font-size: 11px; animation-delay: 3.5s; }
    .stage-decor span:nth-child(10) { left: 5%;  bottom: 12%; font-size: 18px; animation-delay: 1.2s; }
    .stage-decor span:nth-child(11) { right: 5%; bottom: 14%; font-size: 15px; animation-delay: 2.2s; }
    .stage-decor span:nth-child(12) { left: 50%; bottom: 8%;  font-size: 12px; animation-delay: 0.3s; }
    @keyframes floatNote {
      from { transform: translateY(0px) rotate(-2deg); opacity: 0.55; }
      to   { transform: translateY(-10px) rotate(3deg); opacity: 1; }
    }
    .hero-stage__stack {
      display: grid;
      gap: 8px;
    }
    .hero-stage__row {
      padding: 10px 12px;
      border-radius: 14px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(246,231,15,0.08);
    }
    .hero-stage__row span,
    .hero-stage__row small {
      display: block;
      color: var(--muted);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .hero-stage__row strong {
      display: block;
      margin: 6px 0 5px;
      font-size: 16px;
      color: var(--text);
    }
    .detail-modal {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 28px;
      background: rgba(0,0,0,0.66);
      backdrop-filter: blur(10px);
      z-index: 20;
    }
    .detail-modal.is-open { display: flex; }
    .detail-modal__dialog {
      width: min(1500px, 95vw);
      max-height: 92vh;
      border-radius: 22px;
      border: 1px solid rgba(246,231,15,0.14);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.045), rgba(246,231,15,0.012)),
        rgba(5,5,4,0.96);
      box-shadow: var(--glow), 0 28px 80px rgba(0,0,0,0.5);
      overflow: hidden;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .detail-modal__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(246,231,15,0.08);
      background: rgba(255,255,255,0.03);
    }
    .detail-modal__title {
      margin: 0;
      font-size: 17px;
      letter-spacing: 0.02em;
      color: var(--text);
    }
    .detail-modal__close {
      width: 34px;
      height: 34px;
      border-radius: 11px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      font: inherit;
      cursor: pointer;
    }
    .detail-modal__body {
      overflow: auto;
      padding: 14px;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .detail-modal__body::-webkit-scrollbar {
      width: 0;
      height: 0;
      display: none;
    }
    .detail-modal__body .view-panel {
      display: grid;
      gap: 10px;
    }
    .detail-modal__body .glass-card {
      border-radius: 18px;
    }
    .detail-modal__body .section-card,
    .detail-modal__body .hero-card,
    .detail-modal__body .metric-card,
    .detail-modal__body .mini-panel,
    .detail-modal__body .candidate-card,
    .detail-modal__body .goo-card,
    .detail-modal__body .progress-card {
      padding: 10px;
    }
    .detail-modal__body .section-title {
      margin-bottom: 10px;
    }
    .detail-modal__body .section-title h2 {
      font-size: 15px;
    }
    .detail-modal__body .section-title p,
    .detail-modal__body .candidate-subtitle,
    .detail-modal__body .footer-note,
    .detail-modal__body .metric-card p,
    .detail-modal__body .mini-panel p {
      font-size: 10px;
      line-height: 1.45;
    }
    .detail-modal__body .status-panel,
    .detail-modal__body .section-stack,
    .detail-modal__body .split-grid,
    .detail-modal__body .metric-grid {
      gap: 10px;
    }
    .detail-modal__body .status-row {
      padding: 7px 9px;
    }
    .detail-modal__body .status-row span,
    .detail-modal__body .status-row strong,
    .detail-modal__body .metric-card span,
    .detail-modal__body .metric-card strong,
    .detail-modal__body .candidate-stats span,
    .detail-modal__body .candidate-stats strong,
    .detail-modal__body .candidate-card h3,
    .detail-modal__body .goo-card h3 {
      font-size: 11px;
      line-height: 1.3;
    }
    .detail-modal__body .action-row {
      margin-top: 8px;
      gap: 8px;
    }
    .detail-modal__body .action-button {
      padding: 9px 12px;
      font-size: 10px;
    }
    .detail-modal__body .summary-ribbon {
      padding: 10px 12px;
      gap: 8px;
    }
    .detail-modal__body .summary-pill {
      padding: 6px 9px;
      font-size: 10px;
    }
    body.is-modal-open { overflow: hidden; }
    body.is-auth-open { overflow: hidden; }
    .view-panel[data-view-panel="overview"] > .hero-card {
      grid-column: 1;
      grid-row: 1;
    }
    .view-panel[data-view-panel="overview"] > .feature-dock-grid {
      grid-column: 1 / span 2;
      grid-row: 2;
    }
    .view-panel[data-view-panel="overview"] > .section-card {
      grid-column: 2;
      grid-row: 1;
    }
    code {
      transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
    }
    code:hover {
      border-color: rgba(255,214,10,0.18);
      box-shadow: 0 0 18px rgba(255,214,10,0.08);
      background: rgba(255,214,10,0.06);
    }
    @media (max-width: 1200px) {
      .content-stack {
        grid-template-columns: 1fr;
      }
      .view-panel[data-view-panel="overview"] {
        grid-template-columns: 1fr;
      }
      .view-panel[data-view-panel="overview"] > .hero-card,
      .view-panel[data-view-panel="overview"] > .feature-dock-grid,
      .view-panel[data-view-panel="overview"] > .section-card {
        grid-column: auto;
        grid-row: auto;
      }
      .hero-grid,
      .split-grid,
      .signal-grid,
      .stats-grid,
      .hero-kpi-grid,
      .snapshot-grid,
      .feature-dock-grid,
      .metric-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 980px) {
      body { height: auto; overflow-y: auto; }
      .app-shell { height: auto; overflow: visible; }
      .workspace { min-height: auto; overflow: visible; padding-top: 12px; }
      .topbar { position: static; }
    }
    @media (max-width: 720px) {
      .workspace { padding-left: 14px; padding-right: 14px; }
      .topbar { flex-direction: column; align-items: flex-start; }
      .social-actions { width: 100%; justify-content: flex-end; }
    }

    /* ============================================================
       LANDING PAGE REDESIGN — matches mikuelizaos.cloud aesthetic
       ============================================================ */

    /* Reset layout to full-width, no sidebar */
    .app-shell { display: block !important; }
    .sidebar { display: none !important; }
    .workspace {
      min-width: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px 20px 48px;
      overflow-y: auto;
      overflow-x: hidden;
    }
    body { overflow-y: auto; height: auto; }

    /* Topbar */
    .topbar {
      width: min(100%, 1100px) !important;
      border-radius: 18px !important;
      padding: 10px 16px !important;
      background:
        linear-gradient(180deg, rgba(246,231,15,0.04), rgba(246,231,15,0.01)),
        rgba(4,4,3,0.72) !important;
      border: 1px solid rgba(246,231,15,0.14) !important;
      backdrop-filter: blur(14px) !important;
      box-shadow: 0 4px 32px rgba(0,0,0,0.32) !important;
    }
    .topbar-title strong { font-size: 13px; color: var(--text); }
    .topbar-title small { color: var(--muted); font-size: 10px; }
    .meta-chip { display: none; }

    /* Content stack */
    .content-stack {
      width: min(100%, 1100px) !important;
      margin-top: 16px !important;
      display: flex !important;
      flex-direction: column;
      gap: 16px !important;
    }

    /* Hero landing card — centered, like mikuelizaos.cloud */
    .lp-hero {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 64px 32px 48px !important;
      border-radius: 32px !important;
      border: 1px solid rgba(246,231,15,0.16) !important;
      background:
        radial-gradient(circle at 50% 0%, rgba(246,231,15,0.12), transparent 36%),
        radial-gradient(circle at 80% 80%, rgba(246,231,15,0.05), transparent 28%),
        rgba(5,5,4,0.92) !important;
      box-shadow: 0 0 0 1px rgba(246,231,15,0.06), 0 32px 80px rgba(0,0,0,0.5) !important;
      overflow: hidden !important;
    }
    .lp-hero::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(246,231,15,0.5), transparent);
      opacity: 0.7;
      pointer-events: none;
    }
    /* Scan animation */
    .lp-hero::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(115deg, transparent 32%, rgba(246,231,15,0.06) 50%, transparent 68%);
      transform: translateX(-120%);
      animation: lp-scan 7s linear infinite;
      pointer-events: none;
    }
    @keyframes lp-scan {
      from { transform: translateX(-120%); }
      to   { transform: translateX(120%); }
    }

    /* Large background number (like "3" on mikuelizaos) */
    .lp-hero__count {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      font-size: clamp(120px, 18vw, 220px);
      font-weight: 700;
      line-height: 1;
      letter-spacing: -0.06em;
      color: rgba(246,231,15,0.06);
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    }

    /* Eyebrow tag */
    .lp-hero__eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 10px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--muted);
      position: relative;
      z-index: 1;
      margin-bottom: 8px;
    }
    .lp-hero__eyebrow .live-dot {
      width: 8px;
      height: 8px;
      flex-shrink: 0;
    }

    /* Logo / image */
    .lp-hero__logo-wrap {
      position: relative;
      z-index: 1;
      width: 180px;
      height: 180px;
      border-radius: 50%;
      border: 1px solid rgba(246,231,15,0.22);
      background:
        radial-gradient(circle, rgba(246,231,15,0.12), transparent 60%);
      box-shadow: 0 0 60px rgba(246,231,15,0.18), inset 0 0 0 1px rgba(246,231,15,0.08);
      display: grid;
      place-items: center;
      overflow: hidden;
      margin: 12px 0;
      animation: lp-pulse 4s ease-in-out infinite alternate;
    }
    @keyframes lp-pulse {
      from { box-shadow: 0 0 40px rgba(246,231,15,0.14), inset 0 0 0 1px rgba(246,231,15,0.08); }
      to   { box-shadow: 0 0 80px rgba(246,231,15,0.24), inset 0 0 0 1px rgba(246,231,15,0.14); }
    }
    .lp-hero__logo-img {
      width: 140px;
      height: 140px;
      object-fit: cover;
      border-radius: 22px;
      filter: drop-shadow(0 0 24px rgba(246,231,15,0.22));
    }

    /* Title */
    .lp-hero__title {
      position: relative;
      z-index: 1;
      margin: 8px 0 6px;
      font-size: clamp(48px, 7vw, 80px);
      line-height: 1;
      letter-spacing: -0.04em;
      color: var(--text);
      text-shadow: 0 0 40px rgba(246,231,15,0.12);
    }

    /* Sub-headline */
    .lp-hero__sub {
      position: relative;
      z-index: 1;
      margin: 0 0 16px;
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }

    /* State chips row */
    .lp-hero__chips {
      position: relative;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-bottom: 20px;
    }

    /* KPI tiles below logo */
    .lp-hero__kpi {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      width: 100%;
      max-width: 820px;
      margin-bottom: 24px;
    }

    /* Action buttons */
    .lp-hero__actions {
      position: relative;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: center;
    }
    .lp-btn {
      padding: 11px 18px;
      border-radius: 14px;
      border: 1px solid rgba(246,231,15,0.26);
      background: linear-gradient(135deg, rgba(246,231,15,0.14), rgba(246,231,15,0.04));
      color: var(--text);
      font-family: inherit;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      text-decoration: none;
      cursor: pointer;
      transition: 160ms ease;
      display: inline-flex;
      align-items: center;
    }
    .lp-btn:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
      box-shadow: 0 12px 28px rgba(0,0,0,0.28), 0 0 24px rgba(246,231,15,0.1);
      color: var(--text);
    }
    .lp-btn--primary {
      background: linear-gradient(135deg, rgba(246,231,15,0.32), rgba(246,231,15,0.12));
      border-color: rgba(246,231,15,0.44);
      color: #fff;
    }

    /* Stat tiles inside lp-hero__kpi — restyle */
    .lp-hero__kpi .snapshot-tile {
      padding: 14px;
      border-radius: 16px;
      border: 1px solid rgba(246,231,15,0.12);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.05), rgba(246,231,15,0.01)),
        rgba(7,7,6,0.9);
      box-shadow: inset 0 0 0 1px rgba(246,231,15,0.025);
      text-align: left;
    }
    .lp-hero__kpi .snapshot-tile span {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      display: block;
      margin-bottom: 6px;
    }
    .lp-hero__kpi .snapshot-tile strong {
      font-size: 22px;
      display: block;
      color: var(--text);
    }

    /* Summary ribbon */
    .lp-ribbon {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 14px 18px;
      border-radius: 18px;
      border: 1px solid rgba(246,231,15,0.1);
      background: linear-gradient(90deg, rgba(246,231,15,0.06), rgba(246,231,15,0.015));
      box-shadow: var(--glow), inset 0 0 0 1px rgba(246,231,15,0.03);
    }

    /* Feature / market cards grid */
    .lp-cards {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 14px;
    }

    /* Feature dock cards — restyle to match mikuelizaos market card feel */
    .feature-dock-card {
      border-radius: 22px !important;
      border: 1px solid rgba(246,231,15,0.14) !important;
      background:
        radial-gradient(circle at top right, rgba(246,231,15,0.10), transparent 40%),
        linear-gradient(180deg, rgba(246,231,15,0.055), rgba(246,231,15,0.01)),
        rgba(7,7,6,0.92) !important;
      box-shadow: 0 0 0 1px rgba(246,231,15,0.03), 0 12px 28px rgba(0,0,0,0.22) !important;
      padding: 16px !important;
    }
    .feature-dock-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(246,231,15,0.4), transparent);
      opacity: 0.6;
      pointer-events: none;
    }
    .feature-dock-card:hover {
      border-color: rgba(246,231,15,0.24) !important;
      transform: translateY(-3px) !important;
      box-shadow: 0 0 0 1px rgba(246,231,15,0.08), 0 0 32px rgba(246,231,15,0.10), 0 20px 40px rgba(0,0,0,0.28) !important;
    }

    /* Fold sections (Discovery / Portfolio / Treasury / Distribution / Goo) */
    .fold-section {
      border-radius: 22px;
      border: 1px solid rgba(246,231,15,0.1);
      background:
        linear-gradient(180deg, rgba(246,231,15,0.04), rgba(246,231,15,0.01)),
        rgba(6,6,5,0.92);
      box-shadow: var(--glow), inset 0 0 0 1px rgba(246,231,15,0.025);
      overflow: hidden;
      display: block !important;
    }
    .fold-summary {
      padding: 14px 18px;
    }

    /* Floating notes — make more visible */
    .stage-decor span {
      font-size: 22px !important;
      opacity: 1 !important;
    }

    @media (max-width: 900px) {
      .lp-cards { grid-template-columns: repeat(2, 1fr); }
      .lp-hero__kpi { grid-template-columns: repeat(2, 1fr); }
      .lp-hero__title { font-size: 52px; }
    }
    @media (max-width: 600px) {
      .lp-cards { grid-template-columns: 1fr; }
      .lp-hero__kpi { grid-template-columns: 1fr 1fr; }
      .lp-btn { font-size: 10px; padding: 9px 12px; }
    }
  </style>
</head>
<body>
  <div class="stage-decor" aria-hidden="true">
    <span>♩</span>
    <span>♩</span>
    <span>♬</span>
    <span>♩</span>
    <span>♩</span>
    <span>♩</span>
    <span>♩</span>
    <span>✦</span>
    <span>♩</span>
    <span>★</span>
    <span>♩</span>
    <span>♪</span>
  </div>
  <div class="app-shell">
    <aside class="sidebar">
      ${sidebarMasterCard}
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-meta">
          <div class="live-dot" aria-hidden="true"></div>
          <div class="topbar-title">
            <strong id="view-title">Overview</strong>
            <small id="view-subtitle"></small>
          </div>
        </div>
        <div class="social-actions">
          ${cloudToolbarLinks}
          <a class="social-link" href="${escapeHtml(getElizaOkDocsUrl())}" target="_blank" rel="noreferrer" aria-label="Docs">
            ${renderDocsIconSvg()}
          </a>
          <a class="social-link" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer" aria-label="GitHub">
            ${renderGithubIconSvg()}
          </a>
          <a class="social-link" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer" aria-label="X">
            ${renderXIconSvg()}
          </a>
          ${cloudAuthButton}
        </div>
      </header>

      <main class="content-stack">
        <section class="view-panel is-active" data-view-panel="overview" data-view-label="Signal Board" data-view-subtitle="BNB treasury intelligence">
          <article class="glass-card lp-hero">
            <div class="lp-hero__eyebrow">
              <span class="live-dot" aria-hidden="true"></span>
              elizaok · bnb chain intelligence
            </div>
            <div class="lp-hero__count" aria-hidden="true">${snapshot.summary.topRecommendationCount}</div>
            <div class="lp-hero__logo-wrap">
              ${renderBrandLogoImage("lp-hero__logo-img")}
            </div>
            <h1 class="lp-hero__title">elizaOK</h1>
            <p class="lp-hero__sub">BNB Chain memecoin discovery · treasury execution · holder distribution</p>
            <div class="lp-hero__chips">${overviewStateChips}</div>
            <div class="lp-hero__kpi">${snapshotStatTiles}</div>
            <div class="lp-hero__actions">
              <a class="lp-btn lp-btn--primary" href="#discovery-section">Discovery Feed</a>
              <a class="lp-btn" href="/cloud/agents">Cloud Agents</a>
              <a class="lp-btn" href="/cloud/credits">Credits</a>
              <a class="lp-btn" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Open Cloud ↗</a>
            </div>
          </article>
          <div class="lp-ribbon">${summaryRibbon}</div>
          <section class="lp-cards">${featureDockCards}</section>
        </section>

        <details class="fold-section" id="discovery-section">
          <summary class="fold-summary"><strong>Discovery</strong><span>${escapeHtml(discoveryFoldSummary)}</span></summary>
          <div class="fold-body">
            <section class="view-panel" data-view-panel="discovery" data-view-label="Discovery" data-view-subtitle="">
              <section class="split-grid">
                <article class="glass-card section-card">
                  <div class="section-title"><div><h2>Discovery Feed</h2></div></div>
                  <div class="section-stack">${topCandidates || '<p class="candidate-thesis">No data.</p>'}</div>
                </article>
                ${systemPulse}
              </section>
              <article class="glass-card section-card">
                <div class="section-title"><div><h2>Recent Runs</h2></div></div>
                <div class="status-panel">${recentRuns || '<p class="candidate-thesis">No data.</p>'}</div>
              </article>
            </section>
          </div>
        </details>

        <details class="fold-section" id="portfolio-section">
          <summary class="fold-summary"><strong>Portfolio</strong><span>${escapeHtml(portfolioFoldSummary)}</span></summary>
          <div class="fold-body">
        <section class="view-panel" data-view-panel="portfolio" data-view-label="Portfolio" data-view-subtitle="">
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">▣</span><div><h2>Lifecycle</h2></div></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Active positions</span><strong>${portfolioLifecycle.activePositions.length}</strong></div>
                <div class="status-row"><span>Watch positions</span><strong>${portfolioLifecycle.watchPositions.length}</strong></div>
                <div class="status-row"><span>Exited positions</span><strong>${portfolioLifecycle.exitedPositions.length}</strong></div>
                <div class="status-row"><span>Treasury cash</span><strong>${formatUsd(portfolioLifecycle.cashBalanceUsd)}</strong></div>
                <div class="status-row"><span>Reserved</span><strong>${formatUsd(portfolioLifecycle.reservedUsd)}</strong></div>
                <div class="status-row"><span>Gross treasury</span><strong>${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}</strong></div>
                <div class="status-row"><span>Current value</span><strong>${formatUsd(portfolioLifecycle.totalCurrentValueUsd)}</strong></div>
                <div class="status-row"><span>Realized PnL</span><strong>${portfolioLifecycle.totalRealizedPnlUsd >= 0 ? "+" : ""}${formatUsd(portfolioLifecycle.totalRealizedPnlUsd)}</strong></div>
              </div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">≋</span><div><h2>Timeline</h2></div></div></div>
              <div class="status-panel">${timelineRows || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div><h2>Active Positions</h2></div></div>
              <div class="section-stack">${activePortfolioCards || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div><h2>Watchlist</h2></div></div>
              <div class="status-panel">${watchlistRows || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
          </section>
        </section>
          </div>
        </details>

        <details class="fold-section" id="treasury-section">
          <summary class="fold-summary"><strong>Treasury</strong><span>${escapeHtml(treasuryFoldSummary)}</span></summary>
          <div class="fold-body">
        <section class="view-panel" data-view-panel="treasury" data-view-label="Treasury" data-view-subtitle="">
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◌</span><div><h2>Treasury</h2></div></div></div>
              <div class="metric-grid">${treasuryModelCards}</div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">✦</span><div><h2>Rules</h2></div></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Take-profit rule set</span><strong>${escapeHtml(takeProfitSummary)}</strong></div>
                <div class="status-row"><span>Stop loss</span><strong>${treasuryRules.stopLossPct}%</strong></div>
                <div class="status-row"><span>Force-exit score</span><strong>${treasuryRules.exitScoreThreshold}</strong></div>
                <div class="status-row"><span>Max active positions</span><strong>${treasuryRules.maxActivePositions}</strong></div>
              </div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">⌁</span><div><h2>Execution</h2></div></div></div>
              <div class="metric-grid">${executionControlCards}</div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">⊛</span><div><h2>Execution Gates</h2></div></div></div>
              <div class="status-panel">${executionPlanRows || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">⋄</span><div><h2>Trade Ledger</h2></div></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Total executed</span><strong>${formatBnb(tradeLedger.totalExecutedBnb)}</strong></div>
                <div class="status-row"><span>Total dry-run</span><strong>${formatBnb(tradeLedger.totalDryRunBnb)}</strong></div>
                <div class="status-row"><span>Ledger entries</span><strong>${tradeLedger.records.length}</strong></div>
                <div class="status-row"><span>Last updated</span><strong>${escapeHtml(tradeLedger.lastUpdatedAt || "n/a")}</strong></div>
              </div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">≣</span><div><h2>Recent Trades</h2></div></div></div>
              <div class="status-panel">${recentTradeRows || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
          </section>
          <article class="glass-card section-card">
            <div class="section-title"><div><h2>Allocations</h2></div></div>
            <div class="section-stack">${treasuryAllocationCards || '<p class="candidate-thesis">No data.</p>'}</div>
          </article>
        </section>
          </div>
        </details>

        <details class="fold-section" id="distribution-section">
          <summary class="fold-summary"><strong>Distribution</strong><span>${escapeHtml(distributionFoldSummary)}</span></summary>
          <div class="fold-body">
        <section class="view-panel" data-view-panel="distribution" data-view-label="Distribution" data-view-subtitle="">
          <div class="summary-ribbon">${distributionRibbon}</div>
          <section class="split-grid">
            <article class="glass-card section-card section-card--accent">
              <div class="section-title"><div><h2>State</h2></div></div>
              <div class="metric-grid">${distributionStateCards}</div>
            </article>
            <article class="glass-card section-card section-card--spotlight">
              <div class="section-title"><div><h2>Recipients</h2></div></div>
              <div class="section-stack">${distributionRecipients || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Manual Run</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Endpoint</span><strong>/api/elizaok/distribution/run</strong></div>
                <div class="status-row"><span>Method</span><strong>POST</strong></div>
                <div class="status-row"><span>Mode</span><strong>${distributionExecution.dryRun ? "Dry-run safe" : "Live sender armed"}</strong></div>
              </div>
              <div class="action-row">
                <button class="action-button" type="button" data-distribution-run>Run Distribution Now</button>
                <span class="footer-note" data-distribution-run-status>Idle.</span>
              </div>
            </article>
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Manual Trigger</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Rebuilds plan</span><strong>Yes</strong></div>
                <div class="status-row"><span>Writes snapshot</span><strong>Yes</strong></div>
                <div class="status-row"><span>Uses current env</span><strong>Yes</strong></div>
                <div class="status-row"><span>Skips prior live recipients</span><strong>Yes, by campaign fingerprint</strong></div>
              </div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card section-card--spotlight">
              <div class="section-title"><div><h2>Execution</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Enabled</span><strong>${distributionExecution.enabled ? "Yes" : "No"}</strong></div>
                <div class="status-row"><span>Mode</span><strong>${distributionExecution.dryRun ? "dry_run" : "live"}</strong></div>
                <div class="status-row"><span>Readiness</span><strong>${distributionExecution.readinessScore}/${distributionExecution.readinessTotal}</strong></div>
                <div class="status-row"><span>Asset token</span><strong>${escapeHtml(shortAddress(distributionExecution.assetTokenAddress || "n/a"))}</strong></div>
                <div class="status-row"><span>Total amount</span><strong>${escapeHtml(distributionExecution.assetTotalAmount || "n/a")}</strong></div>
                <div class="status-row"><span>Batch size</span><strong>${distributionExecution.maxRecipientsPerRun}</strong></div>
                <div class="status-row"><span>Verified wallet</span><strong>${getDiscoveryConfig().distribution.execution.requireVerifiedWallet ? "required" : "optional"}</strong></div>
                <div class="status-row"><span>Positive PnL</span><strong>${getDiscoveryConfig().distribution.execution.requirePositivePnl ? "required" : "optional"}</strong></div>
                <div class="status-row"><span>Min wallet quote</span><strong>${formatUsd(getDiscoveryConfig().distribution.execution.minWalletQuoteUsd)}</strong></div>
                <div class="status-row"><span>Min portfolio share</span><strong>${getDiscoveryConfig().distribution.execution.minPortfolioSharePct}%</strong></div>
                <div class="status-row"><span>Manifest fingerprint</span><strong>${escapeHtml(shortAddress(distributionExecution.manifestFingerprint || "n/a"))}</strong></div>
                <div class="status-row"><span>Next action</span><strong>${escapeHtml(distributionExecution.nextAction)}</strong></div>
              </div>
            </article>
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Checklist</h2></div></div>
              <div class="status-panel">${distributionExecutionRows || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card section-card--accent">
              <div class="section-title"><div><h2>Ledger</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Total live sent</span><strong>${distributionLedger.totalRecipientsExecuted}</strong></div>
                <div class="status-row"><span>Total dry-run</span><strong>${distributionLedger.totalRecipientsDryRun}</strong></div>
                <div class="status-row"><span>Last updated</span><strong>${escapeHtml(distributionLedger.lastUpdatedAt || "n/a")}</strong></div>
                <div class="status-row"><span>Cycle summary</span><strong>${distributionExecution.cycleSummary.executedCount} executed / ${distributionExecution.cycleSummary.dryRunCount} dry-run / ${distributionExecution.cycleSummary.failedCount} failed</strong></div>
              </div>
            </article>
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Recent Events</h2></div></div>
              <div class="status-panel">${distributionLedgerRows || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card section-card--spotlight">
              <div class="section-title"><div><h2>Next Batch</h2></div></div>
              <div class="status-panel">${distributionPendingRows || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Resume</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Current fingerprint</span><strong>${escapeHtml(shortAddress(distributionExecution.manifestFingerprint || "n/a"))}</strong></div>
                <div class="status-row"><span>Executed recipients</span><strong>${distributionExecutedRecipients.size}</strong></div>
                <div class="status-row"><span>Pending recipients</span><strong>${Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size)}</strong></div>
                <div class="status-row"><span>Resume rule</span><strong>Executed recipients for the current fingerprint are skipped automatically.</strong></div>
              </div>
            </article>
          </section>
        </section>
          </div>
        </details>

        <details class="fold-section" id="goo-section">
          <summary class="fold-summary"><strong>Goo</strong><span>${escapeHtml(gooFoldSummary)}</span></summary>
          <div class="fold-body">
        <section class="view-panel" data-view-panel="goo" data-view-label="Goo Operator" data-view-subtitle="">
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◎</span><div><h2>Goo Status</h2></div></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Enabled</span><strong>${getDiscoveryConfig().goo.enabled ? "Yes" : "No"}</strong></div>
                <div class="status-row"><span>Configured</span><strong>${gooConfigReadiness === 3 ? "Ready for live scan" : "Awaiting RPC + registry"}</strong></div>
                <div class="status-row"><span>Readiness</span><strong>${gooConfigReadiness}/3 checks complete</strong></div>
                <div class="status-row"><span>Next action</span><strong>${escapeHtml(gooReadiness.nextAction)}</strong></div>
                <div class="status-row"><span>Reviewed</span><strong>${snapshot.summary.gooAgentCount}</strong></div>
                <div class="status-row"><span>Priority targets</span><strong>${snapshot.summary.gooPriorityCount}</strong></div>
                <div class="status-row"><span>Best candidate</span><strong>${escapeHtml(snapshot.summary.strongestGooCandidate?.agentId || "n/a")}</strong></div>
              </div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◍</span><div><h2>Readiness</h2></div></div></div>
              <div class="status-panel">
                ${gooReadiness.checklist
                  .map(
                    (item) => `
                      <div class="status-row">
                        <span>${escapeHtml(item.label)}</span>
                        <strong>${item.done ? "READY" : "TODO"}<br />${escapeHtml(item.detail)}</strong>
                      </div>`,
                  )
                  .join("")}
              </div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◈</span><div><h2>Queue</h2></div></div></div>
              <div class="status-panel">${gooQueueRows || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◔</span><div><h2>Candidates</h2></div></div></div>
              <div class="section-stack">${gooCandidates || '<p class="candidate-thesis">No data.</p>'}</div>
            </article>
          </section>
        </section>
          </div>
        </details>

      </main>
    </div>
  </div>
  <div class="detail-modal" id="detail-modal" aria-hidden="true">
    <div class="detail-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="detail-modal-title">
      <div class="detail-modal__header">
        <h2 class="detail-modal__title" id="detail-modal-title">Details</h2>
        <button class="detail-modal__close" type="button" data-modal-close aria-label="Close">×</button>
      </div>
      <div class="detail-modal__body" id="detail-modal-body"></div>
    </div>
  </div>
  <div class="auth-sheet" id="privy-auth-modal" aria-hidden="true">
    <div class="auth-sheet__dialog" role="dialog" aria-modal="true" aria-labelledby="privy-auth-title">
      <div class="auth-sheet__header">
        <div class="auth-sheet__title">
          <strong id="privy-auth-title">Privy Access</strong>
          <span>Use X, Google, or Email to open your ElizaOK personal view.</span>
        </div>
        <button class="auth-sheet__close" type="button" data-privy-auth-close aria-label="Close">×</button>
      </div>
      <div class="auth-sheet__account" data-privy-account-card hidden>
        <span>Connected Account</span>
        <strong data-privy-account-label>Not connected</strong>
      </div>
      <button class="auth-sheet__provider" type="button" data-privy-google>
        Continue with Google
      </button>
      <button class="auth-sheet__provider" type="button" data-privy-twitter>
        Continue with X
      </button>
      <div class="auth-sheet__divider"><span>or</span></div>
      <div class="auth-sheet__stack">
        <div class="auth-sheet__field">
          <label for="privy-email-input">Email</label>
          <input id="privy-email-input" type="email" autocomplete="email" placeholder="you@example.com" />
        </div>
        <button class="auth-sheet__submit" type="button" data-privy-send-email-code>
          Send Email Code
        </button>
        <div class="auth-sheet__otp" data-privy-email-otp hidden>
          <div class="auth-sheet__field">
            <label for="privy-email-code-input">Verification Code</label>
            <input id="privy-email-code-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" />
          </div>
          <button class="auth-sheet__submit" type="button" data-privy-verify-email-code>
            Verify Code
          </button>
        </div>
      </div>
      <div class="auth-sheet__status" data-privy-status></div>
      <div class="auth-sheet__logout" data-privy-logout-wrap hidden>
        <button class="auth-sheet__secondary" type="button" data-privy-logout>
          Sign Out
        </button>
      </div>
    </div>
  </div>
  <script>
    (function () {
      var cloudAuthButtons = Array.prototype.slice.call(
        document.querySelectorAll("[data-cloud-hosted-auth]")
      );
      var cloudCreateAgentButtons = Array.prototype.slice.call(
        document.querySelectorAll("[data-cloud-create-agent]")
      );
      var cloudPollTimer = null;
      var activeCloudFlowMode = null;
      var cloudAuthPopup = null;
      var modal = document.getElementById("detail-modal");
      var modalBody = document.getElementById("detail-modal-body");
      var modalTitle = document.getElementById("detail-modal-title");
      var modalOpenButtons = Array.prototype.slice.call(document.querySelectorAll("[data-modal-target]"));

      function openModal(title, sourceId) {
        var source = document.querySelector("#" + sourceId + " .fold-body");
        if (!modal || !modalBody || !modalTitle || !source) return;
        modalTitle.textContent = title || "Details";
        modalBody.innerHTML = source.innerHTML;
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        document.body.classList.add("is-modal-open");
      }

      function closeModal() {
        if (!modal || !modalBody) return;
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
        modalBody.innerHTML = "";
        document.body.classList.remove("is-modal-open");
      }

      function runDistribution(button) {
        if (!button) return;
        var host = button.parentNode;
        var status = host ? host.querySelector("[data-distribution-run-status]") : null;
        button.disabled = true;
        if (status) status.textContent = "Running manual distribution...";
        fetch("/api/elizaok/distribution/run", { method: "POST" })
          .then(function (response) { return response.json(); })
          .then(function (payload) {
            if (status) {
              status.textContent = payload && payload.message
                ? payload.message
                : "Manual distribution run completed.";
            }
            window.setTimeout(function () { window.location.reload(); }, 800);
          })
          .catch(function (error) {
            if (status) status.textContent = "Manual run failed: " + error;
            button.disabled = false;
          });
      }

      function setCloudButtonsBusy(isBusy) {
        cloudAuthButtons.forEach(function (button) {
          if (isBusy) {
            button.setAttribute("aria-disabled", "true");
            button.classList.add("is-busy");
          } else {
            button.removeAttribute("aria-disabled");
            button.classList.remove("is-busy");
          }
        });
      }

      function clearCloudPoll() {
        if (cloudPollTimer) {
          window.clearTimeout(cloudPollTimer);
          cloudPollTimer = null;
        }
      }

      function pollCloudHostedSession(sessionId, attempt) {
        return fetch("/api/eliza-cloud/hosted/poll?session=" + encodeURIComponent(sessionId))
          .then(function (response) {
            return response.json().then(function (payload) {
              if (!response.ok) {
                throw new Error(
                  payload && payload.error ? payload.error : "Failed to read ElizaCloud session."
                );
              }
              return payload;
            });
          })
          .then(function (payload) {
            if (payload.status === "authenticated") {
              clearCloudPoll();
              setCloudButtonsBusy(false);
              if (cloudAuthPopup && !cloudAuthPopup.closed) {
                try { cloudAuthPopup.close(); } catch {}
              }
              window.location.reload();
              return;
            }
            if (attempt >= 180) {
              throw new Error("ElizaCloud sign-in timed out. Please try again.");
            }
            cloudPollTimer = window.setTimeout(function () {
              pollCloudHostedSession(sessionId, attempt + 1).catch(function (error) {
                clearCloudPoll();
                setCloudButtonsBusy(false);
                window.alert(error && error.message ? error.message : String(error));
              });
            }, 2000);
          });
      }

      if (cloudAuthButtons.length > 0) {
        cloudAuthButtons.forEach(function (cloudAuthButton) {
          cloudAuthButton.addEventListener("click", function (event) {
            event.preventDefault();
            setCloudButtonsBusy(true);
            fetch("/api/eliza-cloud/hosted/start", { method: "POST" })
              .then(function (response) {
                return response.json().then(function (payload) {
                  if (!response.ok) {
                    throw new Error(
                      payload && payload.error
                        ? payload.error
                        : "Failed to start hosted ElizaCloud sign-in."
                    );
                  }
                  return payload;
                });
              })
              .then(function (payload) {
                var popup = window.open(
                  payload.loginUrl,
                  "elizaCloudLogin",
                  "popup=yes,width=540,height=760,menubar=no,toolbar=no,location=yes,resizable=yes,scrollbars=yes"
                );
                activeCloudFlowMode = payload.mode || null;
                cloudAuthPopup = popup;
                if (!popup) {
                  window.location.href = payload.loginUrl;
                  return;
                }
                if (payload.mode === "cli-session" && payload.sessionId) {
                  return pollCloudHostedSession(payload.sessionId, 0);
                }
              })
              .catch(function (error) {
                clearCloudPoll();
                setCloudButtonsBusy(false);
                window.alert(error && error.message ? error.message : String(error));
              });
          });
        });

        window.addEventListener("message", function (event) {
          var data = event && event.data;
          if (!data || data.type !== "eliza-cloud-auth-complete") {
            return;
          }
          if (activeCloudFlowMode === "cli-session") {
            if (data.status === "success") {
              setCloudButtonsBusy(false);
              window.location.reload();
            }
            return;
          }
          setCloudButtonsBusy(false);
          if (data.status === "success") {
            window.location.reload();
            return;
          }
          var message = data && data.message ? data.message : "";
          var syncingState = document.querySelector('[data-cloud-syncing="true"]');
          if (!message || message === "ElizaCloud sign-in failed.") {
            window.alert(
              syncingState
                ? "ElizaCloud connected, but profile, organization, credits, or model data are still syncing."
                : "ElizaCloud sign-in did not complete."
            );
            return;
          }
          window.alert(message);
        });
      }

      if (cloudCreateAgentButtons.length > 0) {
        cloudCreateAgentButtons.forEach(function (cloudCreateAgentButton) {
          cloudCreateAgentButton.addEventListener("click", function () {
            var name = window.prompt("New ElizaCloud agent name", "elizaOK Agent");
            if (!name) return;
            var bio = window.prompt("Agent bio (optional)", "ElizaOK cloud agent") || "";
            cloudCreateAgentButton.setAttribute("aria-disabled", "true");
            fetch("/api/eliza-cloud/agents/create", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: name, bio: bio })
            })
              .then(function (response) {
                return response.json().then(function (payload) {
                  if (!response.ok) {
                    throw new Error(payload && payload.error ? payload.error : "Failed to create ElizaCloud agent.");
                  }
                  return payload;
                });
              })
              .then(function () {
                window.location.reload();
              })
              .catch(function (error) {
                cloudCreateAgentButton.removeAttribute("aria-disabled");
                window.alert(error && error.message ? error.message : String(error));
              });
          });
        });
      }

      modalOpenButtons.forEach(function (button) {
        button.addEventListener("click", function () {
          openModal(button.getAttribute("data-modal-title"), button.getAttribute("data-modal-target"));
        });
      });

      document.addEventListener("click", function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;

        if (target.closest("[data-modal-close]")) {
          closeModal();
          return;
        }

        if (modal && target === modal) {
          closeModal();
          return;
        }

        var runButton = target.closest("[data-distribution-run]");
        if (runButton) {
          runDistribution(runButton);
        }
      });

      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          closeModal();
        }
      });
    })();
  </script>
  <script type="module">
    import Privy, { LocalStorage } from "https://esm.sh/@privy-io/js-sdk-core@0.60.7?bundle";

    (function () {
      var appId = ${JSON.stringify(getElizaOkPrivyAppId())};
      var clientId = ${JSON.stringify(getElizaOkPrivyClientId())};
      var fallbackUrl = ${JSON.stringify(getElizaOkPrivyUrl())};
      var authButton = document.querySelector("[data-privy-auth-open]");
      var authModal = document.getElementById("privy-auth-modal");
      var authCloseButtons = Array.prototype.slice.call(document.querySelectorAll("[data-privy-auth-close]"));
      var googleButton = document.querySelector("[data-privy-google]");
      var twitterButton = document.querySelector("[data-privy-twitter]");
      var emailInput = document.getElementById("privy-email-input");
      var codeInput = document.getElementById("privy-email-code-input");
      var sendCodeButton = document.querySelector("[data-privy-send-email-code]");
      var verifyCodeButton = document.querySelector("[data-privy-verify-email-code]");
      var otpWrap = document.querySelector("[data-privy-email-otp]");
      var statusNode = document.querySelector("[data-privy-status]");
      var accountCard = document.querySelector("[data-privy-account-card]");
      var accountLabel = document.querySelector("[data-privy-account-label]");
      var logoutWrap = document.querySelector("[data-privy-logout-wrap]");
      var logoutButton = document.querySelector("[data-privy-logout]");

      if (!authButton || !authModal) return;

      function setStatus(message, tone) {
        if (!statusNode) return;
        statusNode.textContent = message || "";
        statusNode.classList.remove("is-error", "is-success");
        if (tone === "error") statusNode.classList.add("is-error");
        if (tone === "success") statusNode.classList.add("is-success");
      }

      function setOtpVisible(isVisible) {
        if (!otpWrap) return;
        otpWrap.hidden = !isVisible;
      }

      function openAuthModal() {
        authModal.classList.add("is-open");
        authModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("is-auth-open");
      }

      function closeAuthModal() {
        var activeElement = document.activeElement;
        if (activeElement && typeof activeElement.blur === "function") {
          activeElement.blur();
        }
        authModal.classList.remove("is-open");
        authModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("is-auth-open");
        if (authButton && typeof authButton.focus === "function") {
          authButton.focus();
        }
      }

      function setBusy(isBusy) {
        [authButton, googleButton, twitterButton, sendCodeButton, verifyCodeButton, logoutButton].forEach(function (node) {
          if (!node) return;
          if (isBusy) {
            node.setAttribute("aria-disabled", "true");
            node.disabled = true;
          } else {
            node.removeAttribute("aria-disabled");
            node.disabled = false;
          }
        });
      }

      if (!appId || !clientId) {
        authButton.addEventListener("click", function () {
          if (fallbackUrl && fallbackUrl !== "#") {
            window.open(fallbackUrl, "_blank", "noopener,noreferrer");
            return;
          }
          window.alert("Privy is not configured yet.");
        });
        return;
      }

      var privy = new Privy({
        appId: appId,
        clientId: clientId,
        supportedChains: [],
        storage: new LocalStorage(),
      });

      function firstAccount(user, predicate) {
        var accounts = user && Array.isArray(user.linkedAccounts) ? user.linkedAccounts : [];
        for (var index = 0; index < accounts.length; index += 1) {
          if (predicate(accounts[index])) return accounts[index];
        }
        return null;
      }

      function readAccountValue(account) {
        if (!account || typeof account !== "object") return "";
        return account.email || account.address || account.subject || account.username || "";
      }

      function formatConnectedIdentity(account) {
        if (!account || typeof account !== "object") return "";
        var name = typeof account.name === "string" ? account.name.trim() : "";
        var email = typeof account.email === "string"
          ? account.email.trim()
          : typeof account.address === "string"
            ? account.address.trim()
            : "";
        var username = typeof account.username === "string" ? account.username.trim() : "";

        if (name && email) return name + " · " + email;
        if (name && username) return name + " · @" + username;
        if (email) return email;
        if (username) return "@" + username;
        if (name) return name;
        return readAccountValue(account);
      }

      function getPrimaryLinkedAccount(user) {
        if (!user) return null;
        var twitterAccount = firstAccount(user, function (account) {
          return String((account && account.type) || "") === "twitter_oauth";
        });
        if (twitterAccount) return twitterAccount;

        var googleAccount = firstAccount(user, function (account) {
          return String((account && account.type) || "") === "google_oauth";
        });
        if (googleAccount) return googleAccount;

        var emailAccount = firstAccount(user, function (account) {
          return String((account && account.type) || "") === "email";
        });
        if (emailAccount) return emailAccount;

        return firstAccount(user, function () { return true; });
      }

      function getUserDisplay(user) {
        if (!user) return "Sign in / Sign up";
        var primaryAccount = getPrimaryLinkedAccount(user);
        var value = formatConnectedIdentity(primaryAccount);
        if (value) return value;
        if (user.id && String(user.id).indexOf("did:priv") === 0) return "Privy connected";
        if (user.id) return "Privy " + String(user.id).slice(0, 8);
        return "Privy connected";
      }

      function getUserProvider(user) {
        if (!user) return "";
        var twitterAccount = firstAccount(user, function (account) {
          return String((account && account.type) || "").indexOf("twitter") !== -1;
        });
        if (twitterAccount) return "X";
        var googleAccount = firstAccount(user, function (account) {
          return String((account && account.type) || "").indexOf("google") !== -1;
        });
        if (googleAccount) return "Google";
        var emailAccount = firstAccount(user, function (account) {
          return String((account && account.type) || "") === "email";
        });
        if (emailAccount) return "Email";
        return "Privy";
      }

      async function fetchCurrentUser() {
        try {
          var result = await privy.user.get();
          return result && result.user ? result.user : null;
        } catch (_error) {
          return null;
        }
      }

      async function refreshAuthState(statusMessage, tone) {
        var user = await fetchCurrentUser();
        authButton.textContent = user ? getUserDisplay(user) : "Sign in / Sign up";
        authButton.classList.toggle("auth-link--connected", Boolean(user));
        if (accountCard) accountCard.hidden = !user;
        if (accountLabel) {
          accountLabel.textContent = user
            ? getUserProvider(user) + " · " + getUserDisplay(user)
            : "Not connected";
        }
        if (logoutWrap) logoutWrap.hidden = !user;
        if (statusMessage) setStatus(statusMessage, tone || "success");
        return user;
      }

      async function handleOAuthCallback() {
        var params = new URLSearchParams(window.location.search);
        var oauthCode = params.get("privy_oauth_code");
        var oauthState = params.get("privy_oauth_state");
        var oauthProvider = params.get("privy_oauth_provider");
        if (!oauthCode || !oauthState) return;

        var provider = oauthProvider === "twitter" ? "twitter" : "google";
        var providerLabel = provider === "twitter" ? "X" : "Google";

        openAuthModal();
        setBusy(true);
        setStatus("Completing " + providerLabel + " sign-in...", "");

        try {
          await privy.auth.oauth.loginWithCode(oauthCode, oauthState, provider);
          params.delete("privy_oauth_code");
          params.delete("privy_oauth_state");
          params.delete("privy_oauth_provider");
          var nextQuery = params.toString();
          var nextUrl = window.location.pathname + (nextQuery ? "?" + nextQuery : "") + window.location.hash;
          window.history.replaceState({}, "", nextUrl);
          await refreshAuthState(providerLabel + " connected.", "success");
          window.setTimeout(closeAuthModal, 500);
        } catch (error) {
          setStatus(error && error.message ? error.message : providerLabel + " sign-in failed.", "error");
        } finally {
          setBusy(false);
        }
      }

      authButton.addEventListener("click", function () {
        setStatus("", "");
        openAuthModal();
      });

      authCloseButtons.forEach(function (button) {
        button.addEventListener("click", function () {
          closeAuthModal();
        });
      });

      authModal.addEventListener("click", function (event) {
        if (event.target === authModal) {
          closeAuthModal();
        }
      });

      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          closeAuthModal();
        }
      });

      async function startOAuthLogin(provider, providerLabel) {
        setBusy(true);
        setStatus("Redirecting to " + providerLabel + "...", "");
        try {
          var redirectUrl = window.location.origin + window.location.pathname;
          var oauthInit = await privy.auth.oauth.generateURL(provider, redirectUrl);
          var oauthUrl =
            typeof oauthInit === "string"
              ? oauthInit
              : oauthInit && typeof oauthInit.url === "string"
                ? oauthInit.url
                : "";
          if (!oauthUrl) {
            throw new Error("Privy did not return a valid " + providerLabel + " login URL.");
          }
          window.location.assign(oauthUrl);
        } catch (error) {
          setStatus(
            error && error.message ? error.message : "Unable to start " + providerLabel + " sign-in.",
            "error"
          );
          setBusy(false);
        }
      }

      if (googleButton) {
        googleButton.addEventListener("click", async function () {
          await startOAuthLogin("google", "Google");
        });
      }

      if (twitterButton) {
        twitterButton.addEventListener("click", async function () {
          await startOAuthLogin("twitter", "X");
        });
      }

      if (sendCodeButton) {
        sendCodeButton.addEventListener("click", async function () {
          var email = emailInput && emailInput.value ? emailInput.value.trim() : "";
          if (!email) {
            setStatus("Enter your email first.", "error");
            return;
          }
          setBusy(true);
          setStatus("Sending code...", "");
          try {
            await privy.auth.email.sendCode(email);
            setOtpVisible(true);
            setStatus("Code sent. Check your inbox for the OTP.", "success");
            if (codeInput) codeInput.focus();
          } catch (error) {
            setStatus(error && error.message ? error.message : "Unable to send email code.", "error");
          } finally {
            setBusy(false);
          }
        });
      }

      if (verifyCodeButton) {
        verifyCodeButton.addEventListener("click", async function () {
          var email = emailInput && emailInput.value ? emailInput.value.trim() : "";
          var code = codeInput && codeInput.value ? codeInput.value.trim() : "";
          if (!email || !code) {
            setStatus("Enter both email and verification code.", "error");
            return;
          }
          setBusy(true);
          setStatus("Verifying code...", "");
          try {
            await privy.auth.email.loginWithCode(email, code);
            await refreshAuthState("Email connected.", "success");
            window.setTimeout(closeAuthModal, 500);
          } catch (error) {
            setStatus(error && error.message ? error.message : "Email verification failed.", "error");
          } finally {
            setBusy(false);
          }
        });
      }

      if (logoutButton) {
        logoutButton.addEventListener("click", async function () {
          setBusy(true);
          try {
            await privy.auth.logout();
            if (emailInput) emailInput.value = "";
            if (codeInput) codeInput.value = "";
            setOtpVisible(false);
            await refreshAuthState("Signed out.", "success");
            window.setTimeout(closeAuthModal, 250);
          } catch (error) {
            setStatus(error && error.message ? error.message : "Unable to sign out.", "error");
          } finally {
            setBusy(false);
          }
        });
      }

      Promise.resolve()
        .then(handleOAuthCallback)
        .then(function () {
          return refreshAuthState();
        })
        .catch(function () {
          authButton.textContent = "Sign in / Sign up";
        });
    })();
  </script>
</body>
</html>`;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const config = getDiscoveryConfig();
  const snapshot =
    getLatestSnapshot() || (await loadSnapshotFromDisk(config.reportsDir));
  const recentHistory = snapshot?.recentHistory ?? [];
  const treasurySimulation = snapshot?.treasurySimulation ?? {
    paperCapitalUsd: 0,
    deployableCapitalUsd: 0,
    allocatedUsd: 0,
    dryPowderUsd: 0,
    reserveUsd: 0,
    reservePct: 0,
    positionCount: 0,
    averagePositionUsd: 0,
    highestConvictionSymbol: undefined,
    strategyNote:
      "Treasury simulation will appear after the next completed scan.",
    positions: [],
  };
  const portfolioLifecycle = snapshot?.portfolioLifecycle ?? {
    activePositions: [],
    watchPositions: [],
    exitedPositions: [],
    timeline: [],
    cashBalanceUsd: 0,
    grossPortfolioValueUsd: 0,
    reservedUsd: 0,
    totalAllocatedUsd: 0,
    totalCurrentValueUsd: 0,
    totalRealizedPnlUsd: 0,
    totalUnrealizedPnlUsd: 0,
    totalUnrealizedPnlPct: 0,
    healthNote:
      "Portfolio lifecycle will appear after the next completed scan.",
  };
  const executionState = snapshot?.executionState ?? {
    enabled: false,
    dryRun: true,
    mode: "paper",
    router: "fourmeme",
    configured: false,
    liveTradingArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction: "Execution state will appear after the next completed scan.",
    risk: {
      maxBuyBnb: 0,
      maxDailyDeployBnb: 0,
      maxSlippageBps: 0,
      maxActivePositions: 0,
      minEntryMcapUsd: 0,
      maxEntryMcapUsd: 0,
      minLiquidityUsd: 0,
      minVolumeUsdM5: 0,
      minVolumeUsdH1: 0,
      minBuyersM5: 0,
      minNetBuysM5: 0,
      minPoolAgeMinutes: 0,
      maxPoolAgeMinutes: 0,
      maxPriceChangeH1Pct: 0,
      allowedQuoteOnly: true,
    },
    gooLane: undefined,
    plans: [],
    cycleSummary: {
      consideredCount: 0,
      eligibleCount: 0,
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Execution cycle has not run yet for this snapshot.",
    },
  };
  const tradeLedger = snapshot?.tradeLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalExecutedBnb: 0,
    totalDryRunBnb: 0,
  };
  const distributionPlan = snapshot?.distributionPlan ?? {
    enabled: false,
    holderTokenAddress: null,
    snapshotPath: ".elizaok/holder-snapshot.json",
    snapshotSource: "none",
    snapshotGeneratedAt: null,
    snapshotBlockNumber: null,
    minEligibleBalance: 0,
    eligibleHolderCount: 0,
    totalQualifiedBalance: 0,
    distributionPoolUsd: 0,
    maxRecipients: 0,
    note: "Distribution state will appear after configuration is enabled.",
    selectedAsset: {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason:
        "Distribution asset selection will appear after configuration is enabled.",
    },
    recipients: [],
    publication: null,
  };
  const distributionExecution = snapshot?.distributionExecution ?? {
    enabled: false,
    dryRun: true,
    configured: false,
    liveExecutionArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction:
      "Distribution execution state will appear after the next completed scan.",
    assetTokenAddress: null,
    assetTotalAmount: null,
    walletAddress: null,
    manifestPath: null,
    manifestFingerprint: null,
    maxRecipientsPerRun: 0,
    cycleSummary: {
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Distribution execution is idle.",
    },
  };
  const distributionLedger = snapshot?.distributionLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalRecipientsExecuted: 0,
    totalRecipientsDryRun: 0,
  };
  const distributionExecutedRecipients = new Set(
    distributionLedger.records
      .filter(
        (record) =>
          record.disposition === "executed" &&
          distributionExecution.manifestFingerprint &&
          record.manifestFingerprint ===
            distributionExecution.manifestFingerprint,
      )
      .map((record) => record.recipientAddress.toLowerCase()),
  );
  const distributionPendingRecipients = distributionPlan.recipients
    .filter(
      (recipient) =>
        !distributionExecutedRecipients.has(recipient.address.toLowerCase()),
    )
    .slice(0, Math.max(1, distributionExecution.maxRecipientsPerRun || 5));
  const requestUrl = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );
  const pathname = requestUrl.pathname;
  const storedCloudSession = readElizaCloudSession(req.headers.cookie);
  let cloudSession = storedCloudSession;

  if (pathname === "/assets/elizaok-logo.png") {
    for (const assetPath of ELIZAOK_LOGO_ASSET_PATHS) {
      try {
        const content = await readFile(assetPath);
        sendBinary(res, 200, "image/png", content);
        return;
      } catch {}
    }

    sendJson(res, 404, { error: "Logo asset not found" });
    return;
  }

  if (pathname === "/assets/elizaok-banner.png") {
    for (const assetPath of ELIZAOK_BANNER_ASSET_PATHS) {
      try {
        const content = await readFile(assetPath);
        sendBinary(res, 200, "image/png", content);
        return;
      } catch {}
    }

    sendJson(res, 404, { error: "Banner asset not found" });
    return;
  }

  if (pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      agent: runtime.character.name,
      discoveryEnabled: config.enabled,
      gooEnabled: config.goo.enabled,
      executionEnabled: executionState.enabled,
      executionDryRun: executionState.dryRun,
      executionMode: executionState.mode,
      executionRouter: executionState.router,
      executionLiveTradingArmed: executionState.liveTradingArmed,
      latestRunId: snapshot?.summary.runId ?? null,
    });
    return;
  }

  if (pathname === "/auth/eliza-cloud") {
    const state =
      globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `elizaok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (!hasElizaCloudAppAuthConfig()) {
      const createResponse = await createElizaCloudCliSession(state);
      const createPayload = (await createResponse.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!createResponse.ok) {
        sendRedirect(
          res,
          `/?cloud_error=${encodeURIComponent(createPayload?.error || "failed_to_create_elizacloud_session")}`,
        );
        return;
      }
      sendRedirect(res, buildElizaCloudCliLoginUrl(state));
      return;
    }

    const loginUrl = buildElizaCloudLoginUrl(req, state, false);
    if (!loginUrl) {
      sendRedirect(res, "/?cloud_error=missing_elizacloud_app_auth_config");
      return;
    }
    sendRedirect(res, loginUrl, [serializeElizaCloudAuthState(state)]);
    return;
  }

  if (pathname === "/api/eliza-cloud/hosted/start") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const state =
      globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `elizaok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (!hasElizaCloudAppAuthConfig()) {
      const createResponse = await createElizaCloudCliSession(state);
      const createPayload = (await createResponse.json().catch(() => null)) as
        | { error?: string }
        | { status?: string }
        | null;
      if (!createResponse.ok) {
        sendJson(res, createResponse.status || 500, {
          error:
            (createPayload &&
              "error" in createPayload &&
              createPayload.error) ||
            "Failed to create ElizaCloud session",
        });
        return;
      }
      sendJson(res, 200, {
        loginUrl: buildElizaCloudCliLoginUrl(state),
        sessionId: state,
        mode: "cli-session",
      });
      return;
    }

    const loginUrl = buildElizaCloudLoginUrl(req, state, true);
    if (!loginUrl) {
      sendJson(res, 500, { error: "Missing ElizaCloud hosted app auth URL" });
      return;
    }

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": serializeElizaCloudAuthState(state),
    });
    res.end(JSON.stringify({ loginUrl, state, mode: "app-auth" }, null, 2));
    return;
  }

  if (pathname === "/api/eliza-cloud/hosted/poll") {
    const sessionId = requestUrl.searchParams.get("session")?.trim() || "";
    if (!sessionId) {
      sendJson(res, 400, { error: "session is required" });
      return;
    }

    const statusResponse = await fetchElizaCloudCliSession(sessionId);
    const statusPayload = (await statusResponse.json().catch(() => null)) as {
      error?: string;
      status?: string;
      apiKey?: string;
      keyPrefix?: string;
    } | null;

    if (!statusResponse.ok || !statusPayload) {
      sendJson(
        res,
        statusResponse.status || 500,
        statusPayload || { error: "Failed to poll ElizaCloud" },
      );
      return;
    }

    if (statusPayload.status === "authenticated" && statusPayload.apiKey) {
      const apiBase = elizaCloudApiBase();
      const [primaryAgent, profile, credits, creditSummary] = await Promise.all([
        fetchElizaCloudPrimaryAgentConfig(apiBase, statusPayload.apiKey),
        fetchElizaCloudUser(apiBase, statusPayload.apiKey),
        fetchElizaCloudCreditsBalance(apiBase, statusPayload.apiKey),
        fetchElizaCloudCreditsSummary(apiBase, statusPayload.apiKey),
      ]);
      const session = buildElizaCloudApiSession(
        statusPayload.apiKey,
        {
          ...creditSummary,
          ...profile,
          displayName:
            profile?.displayName ||
            creditSummary?.displayName ||
            profile?.organizationName ||
            "ElizaCloud User",
          organizationName:
            profile?.organizationName ||
            creditSummary?.organizationName ||
            "ElizaCloud",
          credits:
            credits || creditSummary?.credits || profile?.credits || "linked",
          agentId: primaryAgent?.id || "",
          agentName: primaryAgent?.name || "Eliza",
          model: primaryAgent
            ? primaryAgent.modelProvider
              ? `${primaryAgent.modelProvider}/${primaryAgent.model}`
              : primaryAgent.model
            : "n/a",
        },
        "siwe",
      );
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": serializeElizaCloudSession(session),
      });
      res.end(JSON.stringify({ status: "authenticated", session }, null, 2));
      return;
    }

    if (statusPayload.status === "authenticated" && cloudSession) {
      sendJson(res, 200, { status: "authenticated", session: cloudSession });
      return;
    }

    sendJson(res, 200, { status: statusPayload.status || "pending" });
    return;
  }

  if (pathname === "/api/eliza-cloud/siwe/nonce") {
    const response = await fetchElizaCloudNonce(req);
    const body = await response.text();
    res.writeHead(response.status, {
      "content-type":
        response.headers.get("content-type") ||
        "application/json; charset=utf-8",
    });
    res.end(body);
    return;
  }

  if (pathname === "/api/eliza-cloud/siwe/verify") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const payload = await readRequestJson<{
      message?: string;
      signature?: string;
    }>(req);
    if (!payload?.message || !payload?.signature) {
      sendJson(res, 400, { error: "message and signature are required" });
      return;
    }

    const response = await verifyElizaCloudSiwe({
      message: payload.message,
      signature: payload.signature,
    });
    const data = (await response.json().catch(() => null)) as
      | ElizaCloudVerifyResponse
      | { error?: string }
      | null;

    if (!response.ok || !data || !("apiKey" in data)) {
      sendJson(
        res,
        response.status || 500,
        data || { error: "ElizaCloud verification failed" },
      );
      return;
    }

    const apiBase = elizaCloudApiBase();
    const [primaryAgent, profile, credits, creditSummary] = await Promise.all([
      fetchElizaCloudPrimaryAgentConfig(apiBase, data.apiKey),
      fetchElizaCloudUser(apiBase, data.apiKey),
      fetchElizaCloudCreditsBalance(apiBase, data.apiKey),
      fetchElizaCloudCreditsSummary(apiBase, data.apiKey),
    ]);
    const session = buildElizaCloudApiSession(
      data.apiKey,
      {
        ...creditSummary,
        ...profile,
        displayName:
          profile?.displayName ||
          creditSummary?.displayName ||
          data.organization?.name ||
          profile?.email ||
          shortAddress(data.address),
        email: profile?.email || data.user.id,
        walletAddress: profile?.walletAddress || data.address,
        organizationName:
          profile?.organizationName ||
          creditSummary?.organizationName ||
          data.organization?.name ||
          "ElizaCloud",
        organizationSlug:
          profile?.organizationSlug || data.organization?.slug || "elizacloud",
        credits:
          credits || creditSummary?.credits || profile?.credits || "linked",
        agentId: primaryAgent?.id || "",
        agentName: primaryAgent?.name || "Eliza",
        model: primaryAgent
          ? primaryAgent.modelProvider
            ? `${primaryAgent.modelProvider}/${primaryAgent.model}`
            : primaryAgent.model
          : "n/a",
      },
      "siwe",
    );

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": serializeElizaCloudSession(session),
    });
    res.end(JSON.stringify({ success: true, session }, null, 2));
    return;
  }

  if (pathname === "/api/eliza-cloud/app-auth/complete") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const payload = await readRequestJson<{
      state?: string;
      appId?: string;
      app_id?: string;
      access_token?: string;
      token?: string;
      authToken?: string;
      auth_token?: string;
      bearer?: string;
    }>(req);
    const stateFromPayload = payload?.state?.trim() || "";
    const expectedState = readElizaCloudAuthState(req.headers.cookie);
    if (
      stateFromPayload &&
      expectedState &&
      stateFromPayload !== expectedState
    ) {
      res.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": clearElizaCloudAuthState(),
      });
      res.end(
        JSON.stringify(
          { error: "ElizaCloud state verification failed." },
          null,
          2,
        ),
      );
      return;
    }

    const authToken =
      payload?.access_token?.trim() ||
      payload?.token?.trim() ||
      payload?.authToken?.trim() ||
      payload?.auth_token?.trim() ||
      payload?.bearer?.trim() ||
      "";
    const appId =
      payload?.appId?.trim() || payload?.app_id?.trim() || getElizaCloudAppId();
    const result = await buildElizaCloudSessionFromAppAuth(authToken, appId);
    if (!result.session) {
      res.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": clearElizaCloudAuthState(),
      });
      res.end(
        JSON.stringify(
          { error: result.error || "ElizaCloud app auth failed." },
          null,
          2,
        ),
      );
      return;
    }

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": [
        serializeElizaCloudSession(result.session),
        clearElizaCloudAuthState(),
      ],
    });
    res.end(
      JSON.stringify({ success: true, session: result.session }, null, 2),
    );
    return;
  }

  if (pathname === "/auth/eliza-cloud/demo") {
    if (!isLocalRequest(req) || !isElizaCloudDemoEnabled()) {
      sendRedirect(res, "/?cloud_error=eliza_cloud_demo_disabled");
      return;
    }
    sendRedirect(res, buildElizaCloudDemoUrl(req));
    return;
  }

  if (pathname === "/auth/eliza-cloud/callback") {
    const popupMode = requestUrl.searchParams.get("popup") === "1";
    const stateFromQuery = requestUrl.searchParams.get("state")?.trim() || "";
    const expectedState = readElizaCloudAuthState(req.headers.cookie);
    const appAuthToken =
      requestUrl.searchParams.get("access_token")?.trim() ||
      requestUrl.searchParams.get("token")?.trim() ||
      requestUrl.searchParams.get("authToken")?.trim() ||
      requestUrl.searchParams.get("auth_token")?.trim() ||
      requestUrl.searchParams.get("bearer")?.trim() ||
      "";
    const appIdFromQuery =
      requestUrl.searchParams.get("appId")?.trim() ||
      requestUrl.searchParams.get("app_id")?.trim() ||
      getElizaCloudAppId();

    if (requestUrl.searchParams.get("error")) {
      const message =
        requestUrl.searchParams.get("error_description") ||
        requestUrl.searchParams.get("error") ||
        "ElizaCloud authentication failed.";
      const cookieHeaders = [clearElizaCloudAuthState()];
      if (popupMode) {
        sendHtml(
          res,
          200,
          renderCloudPopupResultHtml("error", message),
          cookieHeaders,
        );
        return;
      }
      sendRedirect(
        res,
        `/?cloud_error=${encodeURIComponent(message)}`,
        cookieHeaders,
      );
      return;
    }

    if (stateFromQuery && expectedState && stateFromQuery !== expectedState) {
      const cookieHeaders = [clearElizaCloudAuthState()];
      if (popupMode) {
        sendHtml(
          res,
          200,
          renderCloudPopupResultHtml(
            "error",
            "ElizaCloud state verification failed.",
          ),
          cookieHeaders,
        );
        return;
      }
      sendRedirect(
        res,
        "/?cloud_error=invalid_elizacloud_state",
        cookieHeaders,
      );
      return;
    }

    if (appAuthToken && appIdFromQuery) {
      const result = await buildElizaCloudSessionFromAppAuth(
        appAuthToken,
        appIdFromQuery,
      );
      const cookieHeaders = result.session
        ? [
            serializeElizaCloudSession(result.session),
            clearElizaCloudAuthState(),
          ]
        : [clearElizaCloudAuthState()];
      if (!result.session) {
        const message = result.error || "ElizaCloud app auth failed.";
        if (popupMode) {
          sendHtml(
            res,
            200,
            renderCloudPopupResultHtml("error", message),
            cookieHeaders,
          );
          return;
        }
        sendRedirect(
          res,
          `/?cloud_error=${encodeURIComponent(message)}`,
          cookieHeaders,
        );
        return;
      }
      if (popupMode) {
        sendHtml(
          res,
          200,
          renderCloudPopupResultHtml("success", "ElizaCloud connected."),
          cookieHeaders,
        );
        return;
      }
      sendRedirect(res, "/?cloud_connected=1", cookieHeaders);
      return;
    }

    if (hasElizaCloudAppAuthConfig()) {
      sendHtml(res, 200, renderCloudCallbackBridgeHtml(popupMode));
      return;
    }

    const session = buildElizaCloudSessionFromQuery(requestUrl);
    if (!session) {
      const cookieHeaders = [clearElizaCloudAuthState()];
      if (popupMode) {
        sendHtml(
          res,
          200,
          renderCloudPopupResultHtml(
            "error",
            "ElizaCloud callback did not include a supported app auth token.",
          ),
          cookieHeaders,
        );
        return;
      }
      sendRedirect(
        res,
        "/?cloud_error=missing_callback_payload",
        cookieHeaders,
      );
      return;
    }
    const cookieHeaders = [
      serializeElizaCloudSession(session),
      clearElizaCloudAuthState(),
    ];
    if (popupMode) {
      sendHtml(
        res,
        200,
        renderCloudPopupResultHtml("success", "ElizaCloud connected."),
        cookieHeaders,
      );
      return;
    }
    sendRedirect(res, "/?cloud_connected=1", cookieHeaders);
    return;
  }

  if (pathname === "/auth/eliza-cloud/logout") {
    sendRedirect(res, "/?cloud_disconnected=1", [clearElizaCloudSession()]);
    return;
  }

  if (pathname === "/api/elizaok/latest") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, snapshot);
    return;
  }

  if (pathname === "/api/elizaok/execution") {
    sendJson(res, 200, executionState);
    return;
  }

  if (pathname === "/api/elizaok/trades") {
    sendJson(res, 200, tradeLedger);
    return;
  }

  if (pathname === "/api/elizaok/history") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      history: recentHistory,
    });
    return;
  }

  if (pathname === "/api/elizaok/simulation") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      simulation: treasurySimulation,
    });
    return;
  }

  if (pathname === "/api/elizaok/portfolio") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      portfolio: portfolioLifecycle,
    });
    return;
  }

  if (pathname === "/api/elizaok/portfolio/positions") {
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();
    if (!tokenAddress) {
      sendJson(res, 400, { error: "Missing token query parameter" });
      return;
    }
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    const detail = buildPortfolioPositionDetail(snapshot, tokenAddress);
    if (!detail.position && detail.timeline.length === 0) {
      sendJson(res, 404, { error: "Portfolio position not found" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      detail,
    });
    return;
  }

  if (pathname === "/api/elizaok/timeline") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      timeline: portfolioLifecycle.timeline,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      distribution: distributionPlan,
      execution: distributionExecution,
      ledger: distributionLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/run") {
    if (req.method !== "POST") {
      sendJson(res, 405, {
        error: "Method not allowed",
        detail: "Use POST to trigger a manual distribution run.",
      });
      return;
    }
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    const refreshedDistributionPlan = await buildDistributionPlan(
      config.distribution,
      snapshot.treasurySimulation,
      config.execution.rpcUrl,
      snapshot.portfolioLifecycle,
    );
    const {
      distributionExecution: refreshedExecution,
      distributionLedger: refreshedLedger,
    } = await executeDistributionLane({
      config: config.distribution,
      distributionPlan: refreshedDistributionPlan,
      reportsDir: config.reportsDir,
      rpcUrl: config.execution.rpcUrl,
    });

    await persistDistributionExecutionState(
      snapshot,
      config.reportsDir,
      refreshedDistributionPlan,
      refreshedExecution,
      refreshedLedger,
    );

    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      message: "Manual distribution run completed.",
      distribution: refreshedDistributionPlan,
      execution: refreshedExecution,
      ledger: refreshedLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/execution") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      execution: distributionExecution,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/ledger") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      ledger: distributionLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/pending") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      manifestFingerprint: distributionExecution.manifestFingerprint,
      pendingRecipients: distributionPendingRecipients,
      pendingCount: Math.max(
        0,
        distributionPlan.recipients.length -
          distributionExecutedRecipients.size,
      ),
      maxRecipientsPerRun: distributionExecution.maxRecipientsPerRun,
    });
    return;
  }

  if (pathname === "/api/elizaok/goo") {
    const readiness = buildGooReadiness(config);
    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      enabled: config.goo.enabled,
      configured: readiness.configured,
      readinessChecks: {
        enabled: config.goo.enabled,
        rpcUrlConfigured: Boolean(config.goo.rpcUrl),
        registryConfigured: Boolean(config.goo.registryAddress),
      },
      readinessScore: readiness.score,
      readinessTotal: readiness.total,
      readinessChecklist: readiness.checklist,
      nextAction: readiness.nextAction,
      registryAddress: config.goo.registryAddress,
      rpcUrlConfigured: Boolean(config.goo.rpcUrl),
      lookbackBlocks: config.goo.lookbackBlocks,
      maxAgents: config.goo.maxAgents,
      candidates: snapshot?.topGooCandidates ?? [],
    });
    return;
  }

  if (pathname === "/api/elizaok/goo/candidates") {
    const candidates = snapshot?.topGooCandidates ?? [];
    const agentId = requestUrl.searchParams.get("agent");
    if (agentId) {
      const detail = candidates.find(
        (candidate) => candidate.agentId === agentId,
      );
      if (!detail) {
        sendJson(res, 404, { error: "Goo candidate not found" });
        return;
      }

      sendJson(res, 200, buildGooCandidateDetail(detail, config));
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      candidates: candidates.map((candidate) =>
        buildGooCandidateDetail(candidate, config),
      ),
    });
    return;
  }

  if (pathname === "/api/elizaok/watchlist") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      watchlist: snapshot.watchlist,
    });
    return;
  }

  if (pathname === "/api/elizaok/candidates") {
    const candidateHistory = await loadCandidateHistoryFromDisk(
      config.reportsDir,
    );
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();

    if (tokenAddress) {
      const detail = candidateHistory.find(
        (candidate) => candidate.tokenAddress.toLowerCase() === tokenAddress,
      );
      if (!detail) {
        sendJson(res, 404, { error: "Candidate not found" });
        return;
      }

      sendJson(res, 200, {
        ...detail,
        portfolio: buildPortfolioPositionDetail(snapshot, tokenAddress),
      });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      candidates: candidateHistory.slice(0, 50).map((detail) => detail.latest),
    });
    return;
  }

  if (pathname === "/candidate") {
    const candidateHistory = await loadCandidateHistoryFromDisk(
      config.reportsDir,
    );
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();
    if (!tokenAddress) {
      sendJson(res, 400, { error: "Missing token query parameter" });
      return;
    }

    const detail = candidateHistory.find(
      (candidate) => candidate.tokenAddress.toLowerCase() === tokenAddress,
    );
    if (!detail) {
      sendJson(res, 404, { error: "Candidate not found" });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      renderCandidateDetail(
        detail,
        buildPortfolioPositionDetail(snapshot, tokenAddress),
      ),
    );
    return;
  }

  if (pathname === "/goo-candidate") {
    const agentId = requestUrl.searchParams.get("agent");
    const candidate = snapshot?.topGooCandidates.find(
      (item) => item.agentId === agentId,
    );
    if (!candidate) {
      sendJson(res, 404, { error: "Goo candidate not found" });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      renderGooCandidateDetail(buildGooCandidateDetail(candidate, config)),
    );
    return;
  }

  if (pathname === "/api/eliza-cloud/agents/create") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!cloudSession?.apiKey) {
      sendJson(res, 401, { error: "ElizaCloud API key is required" });
      return;
    }
    const payload = await readRequestJson<{ name?: string; bio?: string }>(req);
    const name = payload?.name?.trim() || "";
    const bio = payload?.bio?.trim() || "";
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }
    const response = await createElizaCloudAgent(cloudSession.apiKey, {
      name,
      bio,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      sendJson(
        res,
        response.status || 500,
        data || { error: "Failed to create ElizaCloud agent" },
      );
      return;
    }
    sendJson(res, 200, data || { success: true });
    return;
  }

  if (pathname === "/cloud/credits") {
    const refreshedCloud = await refreshElizaCloudSession(cloudSession);
    cloudSession = refreshedCloud.session;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(cloudSession
        ? { "set-cookie": serializeElizaCloudSession(cloudSession) }
        : {}),
    });
    res.end(renderCloudCreditsPage(cloudSession, refreshedCloud.summary));
    return;
  }

  if (pathname === "/cloud/agents") {
    const refreshedCloud = await refreshElizaCloudSession(cloudSession);
    cloudSession = refreshedCloud.session;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(cloudSession
        ? { "set-cookie": serializeElizaCloudSession(cloudSession) }
        : {}),
    });
    res.end(renderCloudAgentsPage(cloudSession, refreshedCloud.summary));
    return;
  }

  if (pathname === "/") {
    const refreshedCloud = await refreshElizaCloudSession(cloudSession);
    cloudSession = refreshedCloud.session;
    const sidebarWalletBalanceLabel = await fetchWalletNativeBalanceLabel(
      config.execution.rpcUrl,
      "0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F",
    );
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(cloudSession
        ? { "set-cookie": serializeElizaCloudSession(cloudSession) }
        : {}),
    });
    res.end(
      renderHtml(
        snapshot,
        cloudSession,
        refreshedCloud.summary,
        sidebarWalletBalanceLabel,
      ),
    );
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

export function startDashboardServer(runtime: AgentRuntime) {
  const config = getDiscoveryConfig();
  if (!config.dashboard.enabled) {
    runtime.logger.info("ElizaOK dashboard server disabled");
    return null;
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, runtime).catch((error) => {
      runtime.logger.error(
        { error },
        "ElizaOK dashboard server request failed",
      );
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
    });
  });

  server.listen(config.dashboard.port, () => {
    runtime.logger.info(
      { port: config.dashboard.port },
      "ElizaOK dashboard server started",
    );
  });

  return server;
}
