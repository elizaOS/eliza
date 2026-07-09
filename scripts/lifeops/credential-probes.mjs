#!/usr/bin/env node
/**
 * Live credential probes for the LifeOps HITL intake surface (#11632). Each
 * probe hits the provider's cheapest authenticated read endpoint and resolves
 * to { family, ok, detail } — detail carries HTTP status plus
 * provider-reported identity (bot username, account status, model count),
 * never a secret: every detail string passes through redactSecrets(), which
 * replaces any secret-shaped env value by its last-4 mask, so even a provider
 * echoing a token back cannot leak it. All probes are plain global fetch with
 * a 10s abort; the non-HTTP paths are the documented signal-cli fallback and
 * the local iMessage chat.db access check.
 *
 * Two probe granularities coexist. PROBES/probeFamily keep the family-level
 * sweep (one verdict per connector family; CLI:
 * node scripts/lifeops/credential-probes.mjs [family ...]). PATH_PROBES /
 * probeConnectorPath wire one probe per CONNECTOR_PATHS auth-path id
 * (github.pat probes the OWNER and AGENT slots separately; x.bearer-app and
 * x.oauth1-user get distinct verdicts) — this is what the v2 dashboard fires.
 *
 * Probes read credentials through an explicit env map (defaulting to
 * process.env) so the dashboard can pass the merged layered env from
 * env-layers.mjs without mutating the process — mutation would destroy the
 * per-layer source attribution the UI displays. Every env map handed in is
 * also registered into the redaction set, so values that live only in a .env
 * file layer are masked in details exactly like process.env values.
 */
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_TIMEOUT_MS = 10_000;
const DETAIL_MAX_CHARS = 300;
const SECRET_ENV_NAME_PATTERN =
  /(TOKEN|SECRET|KEY|PASSWORD|AUTH|SID|SESSION|CLIENT_ID|ACCOUNT_NUMBER|PHONE_NUMBER)/;
const DEFAULT_CLOUD_BASE = "https://api.elizacloud.ai";

/** True when an env var name looks like it holds a credential or PII value. */
export function isSecretEnvName(name) {
  return SECRET_ENV_NAME_PATTERN.test(name);
}

function readEnv(envMap, name) {
  const value = envMap[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Mask a sensitive value to its last 4 characters. */
export function maskTail(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= 4 ? "••••" : `…${value.slice(-4)}`;
}

// Secret values seen in non-process env layers accumulate here so redaction
// covers them for the rest of the process lifetime — a rotated-away value is
// still a secret worth masking.
const extraSecretValues = new Set();

/** Fold an env map's secret-shaped values into the redaction set. */
export function registerRedactionEnv(envMap) {
  for (const [name, value] of Object.entries(envMap)) {
    if (!isSecretEnvName(name) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length >= 6) extraSecretValues.add(trimmed);
  }
}

/**
 * Replace every secret-shaped env value occurring in text with its last-4
 * mask — from live process.env plus every env map registered via
 * registerRedactionEnv. Defense in depth: providers sometimes echo request
 * credentials inside error bodies, and probe details are rendered in a
 * browser and in logs.
 */
export function redactSecrets(text) {
  let out = String(text);
  const secretValues = new Set(extraSecretValues);
  for (const [name, value] of Object.entries(process.env)) {
    if (!isSecretEnvName(name) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length >= 6) secretValues.add(trimmed);
  }
  for (const secret of secretValues) {
    while (out.includes(secret)) {
      out = out.replace(secret, maskTail(secret));
    }
  }
  return out;
}

function pass(family, detail) {
  return { family, ok: true, detail: clipDetail(detail) };
}

function fail(family, detail) {
  return { family, ok: false, detail: clipDetail(detail) };
}

function missing(family, names) {
  return fail(family, `not configured: missing ${names}`);
}

function clipDetail(detail) {
  const redacted = redactSecrets(detail).replace(/\s+/g, " ").trim();
  return redacted.length > DETAIL_MAX_CHARS
    ? `${redacted.slice(0, DETAIL_MAX_CHARS)}…`
    : redacted;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // error-policy:J3 provider error pages are often non-JSON; body=undefined is the explicit "unparseable" signal, callers fall back to raw text.
    body = undefined;
  }
  return { status: response.status, httpOk: response.ok, body, text };
}

function errorSnippet(r) {
  if (r.body && typeof r.body === "object") {
    const candidate =
      r.body.description ??
      r.body.message ??
      r.body.error_message ??
      r.body.detail ??
      r.body.title ??
      r.body.error ??
      (Array.isArray(r.body.errors) ? r.body.errors[0]?.message : undefined);
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    return JSON.stringify(r.body).slice(0, 160);
  }
  return (r.text ?? "").slice(0, 160);
}

// --- OAuth 1.0a (X user-context) -------------------------------------------

function rfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function oauth1Header(method, url, creds) {
  const oauthParams = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  // The probe URL carries no query string, so the signature base string is
  // built from the oauth_* params alone (sorted after percent-encoding).
  const paramString = Object.entries(oauthParams)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseString = [
    method.toUpperCase(),
    rfc3986(url),
    rfc3986(paramString),
  ].join("&");
  const signingKey = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.accessSecret)}`;
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
  const header = { ...oauthParams, oauth_signature: signature };
  return `OAuth ${Object.entries(header)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`)
    .join(", ")}`;
}

// --- Messaging families -------------------------------------------------------

async function probeTelegram(e) {
  const token = e("TELEGRAM_BOT_TOKEN");
  if (!token) return missing("telegram", "TELEGRAM_BOT_TOKEN");
  const r = await fetchJson(`https://api.telegram.org/bot${token}/getMe`);
  return r.httpOk && r.body?.ok
    ? pass("telegram", `getMe ok: @${r.body.result?.username ?? "unknown"}`)
    : fail("telegram", `getMe HTTP ${r.status}: ${errorSnippet(r)}`);
}

async function probeDiscord(e) {
  const token = e("DISCORD_API_TOKEN") ?? e("DISCORD_BOT_TOKEN");
  if (!token)
    return missing("discord", "DISCORD_API_TOKEN or DISCORD_BOT_TOKEN");
  const r = await fetchJson("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
  });
  return r.httpOk
    ? pass("discord", `users/@me ok: ${r.body?.username ?? "unknown"}`)
    : fail("discord", `users/@me HTTP ${r.status}: ${errorSnippet(r)}`);
}

// Discord user tokens authenticate raw (no "Bot " prefix) — the user-client
// paste path, distinct from the bot path.
async function probeDiscordUserToken(e) {
  const token = e("DISCORD_USER_TOKEN");
  if (!token) return missing("discord", "DISCORD_USER_TOKEN");
  const r = await fetchJson("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: token },
  });
  return r.httpOk
    ? pass(
        "discord",
        `users/@me ok (user context): ${r.body?.username ?? "unknown"}`,
      )
    : fail("discord", `users/@me HTTP ${r.status}: ${errorSnippet(r)}`);
}

async function probeSlack(e) {
  const botToken = e("SLACK_BOT_TOKEN");
  const appToken = e("SLACK_APP_TOKEN");
  if (!botToken && !appToken)
    return missing("slack", "SLACK_BOT_TOKEN and SLACK_APP_TOKEN");
  const parts = [];
  let allOk = true;
  if (botToken) {
    const r = await fetchJson("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (r.httpOk && r.body?.ok) {
      parts.push(`auth.test ok: ${r.body.team ?? "?"}/${r.body.user ?? "?"}`);
    } else {
      allOk = false;
      parts.push(`auth.test failed: ${r.body?.error ?? `HTTP ${r.status}`}`);
    }
  } else {
    allOk = false;
    parts.push("missing SLACK_BOT_TOKEN (xoxb)");
  }
  if (appToken) {
    const r = await fetchJson("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}` },
    });
    if (r.httpOk && r.body?.ok) {
      parts.push("apps.connections.open ok (socket-mode url issued)");
    } else {
      allOk = false;
      parts.push(
        `apps.connections.open failed: ${r.body?.error ?? `HTTP ${r.status}`}`,
      );
    }
  } else {
    allOk = false;
    parts.push("missing SLACK_APP_TOKEN (xapp)");
  }
  const detail = parts.join("; ");
  return allOk ? pass("slack", detail) : fail("slack", detail);
}

async function probeSlackUserToken(e) {
  const token = e("SLACK_USER_TOKEN");
  if (!token) return missing("slack", "SLACK_USER_TOKEN");
  const r = await fetchJson("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.httpOk && r.body?.ok
    ? pass(
        "slack",
        `auth.test ok (user context): ${r.body.team ?? "?"}/${r.body.user ?? "?"}`,
      )
    : fail("slack", `auth.test failed: ${r.body?.error ?? `HTTP ${r.status}`}`);
}

async function probeXOauth1(e) {
  const consumerKey = e("TWITTER_API_KEY");
  const consumerSecret = e("TWITTER_API_SECRET_KEY");
  const accessToken = e("TWITTER_ACCESS_TOKEN");
  const accessSecret = e("TWITTER_ACCESS_TOKEN_SECRET");
  const absent = [
    ["TWITTER_API_KEY", consumerKey],
    ["TWITTER_API_SECRET_KEY", consumerSecret],
    ["TWITTER_ACCESS_TOKEN", accessToken],
    ["TWITTER_ACCESS_TOKEN_SECRET", accessSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (absent.length > 0) {
    return missing("x", absent.join(" + "));
  }
  const url = "https://api.x.com/2/users/me";
  const r = await fetchJson(url, {
    headers: {
      Authorization: oauth1Header("GET", url, {
        consumerKey,
        consumerSecret,
        accessToken,
        accessSecret,
      }),
    },
  });
  return r.httpOk
    ? pass("x", `users/me (oauth1) ok: @${r.body?.data?.username ?? "unknown"}`)
    : fail("x", `users/me (oauth1) HTTP ${r.status}: ${errorSnippet(r)}`);
}

async function probeXBearer(e) {
  const bearer = e("TWITTER_BEARER_TOKEN");
  if (!bearer) return missing("x", "TWITTER_BEARER_TOKEN");
  const r = await fetchJson("https://api.x.com/2/users/me", {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  return r.httpOk
    ? pass("x", `users/me (bearer) ok: @${r.body?.data?.username ?? "unknown"}`)
    : fail(
        "x",
        `users/me (bearer) HTTP ${r.status}: ${errorSnippet(r)} — app-only bearer cannot read user context; set TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_TOKEN_SECRET for the OAuth1 signed probe`,
      );
}

async function probeX(e) {
  if (
    e("TWITTER_API_KEY") &&
    e("TWITTER_API_SECRET_KEY") &&
    e("TWITTER_ACCESS_TOKEN") &&
    e("TWITTER_ACCESS_TOKEN_SECRET")
  ) {
    return probeXOauth1(e);
  }
  if (e("TWITTER_BEARER_TOKEN")) return probeXBearer(e);
  return missing(
    "x",
    "TWITTER_API_KEY + TWITTER_API_SECRET_KEY + TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_TOKEN_SECRET (or TWITTER_BEARER_TOKEN)",
  );
}

async function probeWhatsapp(e) {
  const token = e("ELIZA_WHATSAPP_ACCESS_TOKEN") ?? e("WHATSAPP_ACCESS_TOKEN");
  const phoneId =
    e("ELIZA_WHATSAPP_PHONE_NUMBER_ID") ?? e("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneId) {
    return missing(
      "whatsapp",
      "ELIZA_WHATSAPP_ACCESS_TOKEN + ELIZA_WHATSAPP_PHONE_NUMBER_ID",
    );
  }
  const r = await fetchJson(
    `https://graph.facebook.com/v19.0/${encodeURIComponent(phoneId)}?fields=display_phone_number`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.httpOk)
    return fail(
      "whatsapp",
      `phone-number lookup HTTP ${r.status}: ${errorSnippet(r)}`,
    );
  const digits = String(r.body?.display_phone_number ?? "").replace(/\D/g, "");
  return pass(
    "whatsapp",
    `phone number verified (…${digits.slice(-4) || "????"})`,
  );
}

async function probeTwilio(e) {
  const sid = e("TWILIO_ACCOUNT_SID");
  const auth = e("TWILIO_AUTH_TOKEN");
  if (!sid || !auth)
    return missing("twilio", "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN");
  const r = await fetchJson(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`,
      },
    },
  );
  return r.httpOk
    ? pass(
        "twilio",
        `account ok: ${r.body?.friendly_name ?? "unnamed"} (status=${r.body?.status ?? "?"})`,
      )
    : fail("twilio", `account HTTP ${r.status}: ${errorSnippet(r)}`);
}

async function probeSignal(e) {
  const httpUrl = e("SIGNAL_HTTP_URL");
  if (httpUrl) {
    const r = await fetchJson(`${httpUrl.replace(/\/+$/, "")}/v1/about`);
    return r.httpOk
      ? pass(
          "signal",
          `signal-cli-rest-api reachable (versions: ${JSON.stringify(r.body?.versions ?? r.body?.version ?? "?")})`,
        )
      : fail("signal", `GET /v1/about HTTP ${r.status}: ${errorSnippet(r)}`);
  }
  const cliPath = e("SIGNAL_CLI_PATH");
  if (!cliPath && !e("SIGNAL_ACCOUNT_NUMBER"))
    return missing("signal", "SIGNAL_HTTP_URL or SIGNAL_CLI_PATH");
  const command = cliPath ?? "signal-cli";
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  });
  return result.status === 0
    ? pass(
        "signal",
        `${command} --version ok: ${(result.stdout ?? "").split("\n")[0].trim()}`,
      )
    : fail(
        "signal",
        `${command} --version failed (status=${result.status ?? "spawn-error"}${result.error ? `, ${result.error.code ?? result.error.message}` : ""})`,
      );
}

// --- model providers (per-key path probes + family aggregate) ----------------

// Each provider helper returns null when its key is absent, so the family
// aggregate can report "missing KEY" while the per-path probe reports a
// proper not-configured failure.
async function probeOpenaiModels(e) {
  const key = e("OPENAI_API_KEY");
  if (!key) return null;
  const base = (e("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  const r = await fetchJson(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  return r.httpOk
    ? {
        ok: true,
        part: `openai(${new URL(base).hostname}): ok (${r.body?.data?.length ?? 0} models)`,
      }
    : { ok: false, part: `openai: HTTP ${r.status} ${errorSnippet(r)}` };
}

async function probeCerebrasModels(e) {
  const key = e("CEREBRAS_API_KEY");
  if (!key) return null;
  const r = await fetchJson("https://api.cerebras.ai/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  return r.httpOk
    ? { ok: true, part: `cerebras: ok (${r.body?.data?.length ?? 0} models)` }
    : { ok: false, part: `cerebras: HTTP ${r.status} ${errorSnippet(r)}` };
}

async function probeAnthropicModels(e) {
  const key = e("ANTHROPIC_API_KEY");
  if (!key) return null;
  const r = await fetchJson("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  return r.httpOk
    ? { ok: true, part: `anthropic: ok (${r.body?.data?.length ?? 0} models)` }
    : { ok: false, part: `anthropic: HTTP ${r.status} ${errorSnippet(r)}` };
}

const MODEL_PROVIDERS = [
  ["openai", "OPENAI_API_KEY", probeOpenaiModels],
  ["cerebras", "CEREBRAS_API_KEY", probeCerebrasModels],
  ["anthropic", "ANTHROPIC_API_KEY", probeAnthropicModels],
];

async function probeModel(e) {
  const parts = [];
  let anyOk = false;
  for (const [name, envName, probe] of MODEL_PROVIDERS) {
    const result = await probe(e);
    if (result === null) {
      parts.push(`${name}: missing ${envName}`);
      continue;
    }
    anyOk ||= result.ok;
    parts.push(result.part);
  }
  const detail = parts.join("; ");
  return anyOk ? pass("model", detail) : fail("model", detail);
}

function modelKeyPathProbe(provider) {
  const [, envName, probe] = MODEL_PROVIDERS.find(
    ([name]) => name === provider,
  );
  return async (e) => {
    const result = await probe(e);
    if (result === null) return missing("model", envName);
    return result.ok ? pass("model", result.part) : fail("model", result.part);
  };
}

// --- health (per-source path probes + family aggregate) ----------------------

const HEALTH_SOURCES = {
  strava: {
    envName: "STRAVA_ACCESS_TOKEN",
    url: "https://www.strava.com/api/v3/athlete",
  },
  oura: {
    envName: "OURA_ACCESS_TOKEN",
    url: "https://api.ouraring.com/v2/usercollection/personal_info",
  },
  fitbit: {
    envName: "FITBIT_ACCESS_TOKEN",
    url: "https://api.fitbit.com/1/user/-/profile.json",
  },
  withings: {
    envName: "WITHINGS_ACCESS_TOKEN",
    url: "https://wbsapi.withings.net/v2/user?action=getdevice",
  },
};

async function probeHealthSource(name, e) {
  const source = HEALTH_SOURCES[name];
  const token = e(source.envName);
  if (!token) return null;
  const r = await fetchJson(source.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Withings tunnels errors through HTTP 200 with a nonzero body.status.
  const bodyOk = name === "withings" ? r.body?.status === 0 : true;
  return r.httpOk && bodyOk
    ? { ok: true, part: `${name}: ok` }
    : {
        ok: false,
        part: `${name}: HTTP ${r.status}${bodyOk ? "" : ` api-status=${r.body?.status}`} ${errorSnippet(r)}`,
      };
}

// One green wearable satisfies the health group — the live run only needs a
// single working data source.
async function probeHealth(e) {
  const configured = Object.keys(HEALTH_SOURCES).filter((name) =>
    e(HEALTH_SOURCES[name].envName),
  );
  if (configured.length === 0) {
    return missing(
      "health",
      "STRAVA_ACCESS_TOKEN / OURA_ACCESS_TOKEN / FITBIT_ACCESS_TOKEN / WITHINGS_ACCESS_TOKEN (any one)",
    );
  }
  const parts = [];
  let anyOk = false;
  for (const name of configured) {
    const result = await probeHealthSource(name, e);
    anyOk ||= result.ok;
    parts.push(result.part);
  }
  const detail = parts.join("; ");
  return anyOk ? pass("health", detail) : fail("health", detail);
}

function healthSourcePathProbe(name) {
  return async (e) => {
    const result = await probeHealthSource(name, e);
    if (result === null) return missing("health", HEALTH_SOURCES[name].envName);
    return result.ok
      ? pass("health", result.part)
      : fail("health", result.part);
  };
}

async function probeGoogleFit(e) {
  const token = e("ELIZA_GOOGLE_FIT_ACCESS_TOKEN");
  if (!token) return missing("health", "ELIZA_GOOGLE_FIT_ACCESS_TOKEN");
  const r = await fetchJson(
    "https://www.googleapis.com/fitness/v1/users/me/dataSources",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return r.httpOk
    ? pass(
        "health",
        `google-fit dataSources ok (${r.body?.dataSource?.length ?? 0} sources)`,
      )
    : fail("health", `google-fit HTTP ${r.status}: ${errorSnippet(r)}`);
}

// --- finance ------------------------------------------------------------------

async function probePlaid(e) {
  const clientId = e("PLAID_CLIENT_ID");
  const secret = e("PLAID_SECRET");
  if (!clientId || !secret)
    return missing("plaid", "PLAID_CLIENT_ID + PLAID_SECRET");
  const r = await fetchJson("https://sandbox.plaid.com/institutions/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      secret,
      count: 1,
      offset: 0,
      country_codes: ["US"],
    }),
  });
  return r.httpOk
    ? pass(
        "plaid",
        `institutions/get ok (sandbox, total=${r.body?.total ?? "?"})`,
      )
    : fail(
        "plaid",
        `institutions/get HTTP ${r.status}: ${r.body?.error_code ?? errorSnippet(r)}`,
      );
}

async function probePaypal(e) {
  const clientId = e("PAYPAL_CLIENT_ID");
  const secret = e("PAYPAL_CLIENT_SECRET");
  if (!clientId || !secret)
    return missing("paypal", "PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET");
  const base = (
    e("PAYPAL_API_BASE") ?? "https://api-m.sandbox.paypal.com"
  ).replace(/\/+$/, "");
  const r = await fetchJson(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  return r.httpOk
    ? pass(
        "paypal",
        `oauth2/token ok (${new URL(base).hostname}, expires_in=${r.body?.expires_in ?? "?"}s)`,
      )
    : fail(
        "paypal",
        `oauth2/token HTTP ${r.status}: ${r.body?.error_description ?? errorSnippet(r)}`,
      );
}

// Google credential validation requires the full in-app OAuth consent flow, so
// this probe only confirms the client credentials are present.
async function probeGoogle(e) {
  const names = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
  ];
  const absent = names.filter((name) => !e(name));
  return absent.length === 0
    ? pass(
        "google",
        "client credentials present (presence-only — validate via in-app OAuth: Settings → Connectors)",
      )
    : missing("google", absent.join(" + "));
}

// --- GitHub -------------------------------------------------------------------

// GitHub's REST API rejects requests without a User-Agent, and undici's fetch
// sends none by default.
async function probeGithubToken(token, slot) {
  const r = await fetchJson("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "eliza-hitl-dashboard",
    },
  });
  return r.httpOk
    ? { ok: true, part: `${slot}: @${r.body?.login ?? "unknown"}` }
    : { ok: false, part: `${slot}: HTTP ${r.status} ${errorSnippet(r)}` };
}

async function probeGithubGhCli(e) {
  const token = e("GITHUB_TOKEN");
  if (!token) {
    return missing(
      "github",
      "GITHUB_TOKEN (use the gh CLI one-click to fill it)",
    );
  }
  const result = await probeGithubToken(token, "GITHUB_TOKEN");
  return result.ok
    ? pass("github", `user ok — ${result.part}`)
    : fail("github", result.part);
}

// OWNER maps to plugin-github role 'user', AGENT to 'agent'
// (plugins/plugin-github/src/accounts.ts); each present slot is probed with
// its own token so a bad agent PAT cannot hide behind a good owner PAT.
async function probeGithubPats(e) {
  const slots = [
    ["OWNER", e("GITHUB_USER_PAT") ?? e("ELIZA_E2E_GITHUB_USER_PAT")],
    ["AGENT", e("GITHUB_AGENT_PAT") ?? e("ELIZA_E2E_GITHUB_AGENT_PAT")],
    ["legacy GITHUB_TOKEN", e("GITHUB_TOKEN")],
  ].filter(([, token]) => token);
  if (slots.length === 0) {
    return missing(
      "github",
      "GITHUB_USER_PAT / GITHUB_AGENT_PAT / GITHUB_TOKEN",
    );
  }
  const results = [];
  for (const [slot, token] of slots) {
    results.push(await probeGithubToken(token, slot));
  }
  const detail = results.map((result) => result.part).join("; ");
  return results.every((result) => result.ok)
    ? pass("github", detail)
    : fail("github", detail);
}

async function probeGithubOauthApp(e) {
  const names = [
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "GITHUB_OAUTH_REDIRECT_URI",
  ];
  const absent = names.filter((name) => !e(name));
  return absent.length === 0
    ? pass(
        "github",
        "OAuth app credentials present (presence-only — run the consent flow via POST /api/connectors/github/oauth/start)",
      )
    : missing("github", absent.join(" + "));
}

// --- Eliza Cloud ----------------------------------------------------------------

// The cheapest authenticated read on the real cloud API — the same endpoint
// scripts/cloud/siwe-test-login.mjs uses as its auth proof. There is no
// /api/v1/me.
async function probeElizaCloud(e) {
  const apiKey = e("ELIZAOS_CLOUD_API_KEY") ?? e("ELIZA_CLOUD_API_KEY");
  if (!apiKey) {
    return missing(
      "elizacloud",
      "ELIZAOS_CLOUD_API_KEY (or ELIZA_CLOUD_API_KEY)",
    );
  }
  const base = (e("SIWE_BASE") ?? DEFAULT_CLOUD_BASE).replace(/\/+$/, "");
  const r = await fetchJson(`${base}/api/v1/credits/balance`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return r.httpOk
    ? pass(
        "elizacloud",
        `credits/balance ok (${new URL(base).hostname}, balance=${r.body?.balance ?? "?"})`,
      )
    : fail(
        "elizacloud",
        `credits/balance HTTP ${r.status}: ${errorSnippet(r)}`,
      );
}

// --- iMessage (local-machine checks) ---------------------------------------------

// Filesystem access IS the iMessage credential on macOS: the probe verdict is
// whether this process can read chat.db (Full Disk Access).
async function probeImessageMacos(e) {
  const backend = e("ELIZA_IMESSAGE_BACKEND");
  const dbPath = join(homedir(), "Library/Messages/chat.db");
  try {
    accessSync(dbPath, fsConstants.R_OK);
    return pass(
      "imessage",
      `chat.db readable — Full Disk Access granted to this process${backend ? ` (backend=${backend})` : ""}`,
    );
  } catch {
    // error-policy:J3 the access check IS the probe; unreadable is the explicit fail outcome, not an exception path.
    return fail(
      "imessage",
      "chat.db not readable — grant Full Disk Access to the terminal/app running the agent",
    );
  }
}

async function probeBlueBubbles(e) {
  const password = e("BLUEBUBBLES_PASSWORD");
  if (!password) {
    return missing(
      "imessage",
      "BLUEBUBBLES_PASSWORD (server URL defaults to http://localhost:1234)",
    );
  }
  const base = (e("BLUEBUBBLES_SERVER_URL") ?? "http://localhost:1234").replace(
    /\/+$/,
    "",
  );
  const r = await fetchJson(
    `${base}/api/v1/ping?password=${encodeURIComponent(password)}`,
  );
  return r.httpOk
    ? pass("imessage", `BlueBubbles ping ok (${new URL(base).hostname})`)
    : fail(
        "imessage",
        `BlueBubbles ping HTTP ${r.status}: ${errorSnippet(r)} — if the server app is installed but stopped, launch BlueBubbles.app`,
      );
}

// --- family registry -------------------------------------------------------------

const PROBES = {
  telegram: probeTelegram,
  discord: probeDiscord,
  slack: probeSlack,
  x: probeX,
  whatsapp: probeWhatsapp,
  twilio: probeTwilio,
  signal: probeSignal,
  model: probeModel,
  health: probeHealth,
  plaid: probePlaid,
  paypal: probePaypal,
  google: probeGoogle,
};

export const PROBE_FAMILIES = Object.keys(PROBES);

function toLookup(envMap) {
  registerRedactionEnv(envMap);
  return (name) => readEnv(envMap, name);
}

function probeErrorDetail(error) {
  const cause = error?.cause?.code ?? error?.code;
  const reason =
    error?.name === "TimeoutError"
      ? `timed out after ${PROBE_TIMEOUT_MS / 1000}s`
      : `${error?.message ?? error}${cause ? ` (${cause})` : ""}`;
  return `probe error: ${reason}`;
}

/**
 * Run one family probe against an env map (default process.env).
 * Network/timeout failures become a structured { ok:false } result so a batch
 * never dies on one flaky provider.
 */
export async function probeFamily(family, envMap = process.env) {
  const probe = PROBES[family];
  if (!probe) {
    throw new Error(
      `Unknown probe family: ${family} (known: ${PROBE_FAMILIES.join(", ")})`,
    );
  }
  const e = toLookup(envMap);
  const probedAt = new Date().toISOString();
  try {
    return { ...(await probe(e)), probedAt };
  } catch (error) {
    // error-policy:J1 probe boundary — a transport error IS the probe outcome; it surfaces as a red row, not a crash.
    return { ...fail(family, probeErrorDetail(error)), probedAt };
  }
}

export async function probeAll(
  families = PROBE_FAMILIES,
  envMap = process.env,
) {
  return Promise.all(families.map((family) => probeFamily(family, envMap)));
}

// --- per-auth-path registry (CONNECTOR_PATHS ids) ----------------------------------

/**
 * One probe per CONNECTOR_PATHS auth-path id. Paths absent here have no wired
 * probe; the dashboard reports those as an explicit skip with the path's
 * documented probeEndpoint, never as an error.
 */
export const PATH_PROBES = {
  "model.openai-key": modelKeyPathProbe("openai"),
  "model.cerebras-key": modelKeyPathProbe("cerebras"),
  "model.anthropic-key": modelKeyPathProbe("anthropic"),
  "elizacloud.siwe-session": probeElizaCloud,
  "elizacloud.api-key": probeElizaCloud,
  "github.gh-cli": probeGithubGhCli,
  "github.pat": probeGithubPats,
  "github.device-oauth": probeGithubGhCli,
  "github.user-oauth": probeGithubOauthApp,
  "google.oauth-owner": probeGoogle,
  "google.oauth-agent": probeGoogle,
  "telegram.bot": probeTelegram,
  "discord.bot": probeDiscord,
  "discord.user-token": probeDiscordUserToken,
  "slack.bot": probeSlack,
  "slack.user-token": probeSlackUserToken,
  "signal.cli": probeSignal,
  "whatsapp.cloud-api": probeWhatsapp,
  "imessage.macos": probeImessageMacos,
  "imessage.bluebubbles": probeBlueBubbles,
  "x.oauth1-user": probeXOauth1,
  "x.bearer-app": probeXBearer,
  "twilio.api": probeTwilio,
  "health.strava": healthSourcePathProbe("strava"),
  "health.oura": healthSourcePathProbe("oura"),
  "health.fitbit": healthSourcePathProbe("fitbit"),
  "health.withings": healthSourcePathProbe("withings"),
  "health.google-fit": probeGoogleFit,
  "finance.plaid": probePlaid,
  "finance.paypal": probePaypal,
};

export const PROBEABLE_PATH_IDS = Object.keys(PATH_PROBES);

/**
 * Run the wired probe for one auth path against an env map. Throws on unknown
 * path ids (a caller bug); transport failures resolve to { ok:false } like
 * probeFamily. Availability/skip policy lives with the caller — this function
 * only runs real probes.
 */
export async function probeConnectorPath(pathId, envMap = process.env) {
  const probe = PATH_PROBES[pathId];
  if (!probe) {
    throw new Error(
      `No wired probe for auth path: ${pathId} (wired: ${PROBEABLE_PATH_IDS.join(", ")})`,
    );
  }
  const e = toLookup(envMap);
  const probedAt = new Date().toISOString();
  try {
    const { family, ok, detail } = await probe(e);
    return { pathId, family, ok, detail, probedAt };
  } catch (error) {
    // error-policy:J1 probe boundary — a transport error IS the probe outcome; it surfaces as a red row, not a crash.
    return {
      pathId,
      family: pathId.split(".")[0],
      ok: false,
      detail: clipDetail(probeErrorDetail(error)),
      probedAt,
    };
  }
}

const IS_MAIN =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  const requested = process.argv.slice(2);
  const results = await probeAll(
    requested.length > 0 ? requested : PROBE_FAMILIES,
  );
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
