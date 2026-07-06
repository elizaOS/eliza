#!/usr/bin/env node
/**
 * Live credential probes for the LifeOps HITL intake surface (#11632). Each
 * family probe hits the provider's cheapest authenticated read endpoint with
 * whatever credentials are already in process.env and resolves to
 * { family, ok, detail } — detail carries HTTP status plus provider-reported
 * identity (bot username, account status, model count), never a secret: every
 * detail string passes through redactSecrets(), which replaces any env value
 * with a secret-shaped name by its last-4 mask, so even a provider echoing a
 * token back cannot leak it. All probes are plain global fetch with a 10s
 * abort; the single non-HTTP path is the documented signal-cli fallback.
 * Consumed by scripts/lifeops/hitl-credential-dashboard.mjs; also runnable
 * directly: node scripts/lifeops/credential-probes.mjs [family ...].
 */
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

const PROBE_TIMEOUT_MS = 10_000;
const DETAIL_MAX_CHARS = 300;
const SECRET_ENV_NAME_PATTERN =
  /(TOKEN|SECRET|KEY|PASSWORD|AUTH|SID|CLIENT_ID|ACCOUNT_NUMBER|PHONE_NUMBER)/;

/** True when an env var name looks like it holds a credential or PII value. */
export function isSecretEnvName(name) {
  return SECRET_ENV_NAME_PATTERN.test(name);
}

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Mask a sensitive value to its last 4 characters. */
export function maskTail(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= 4 ? "••••" : `…${value.slice(-4)}`;
}

/**
 * Replace every secret-shaped env value occurring in text with its last-4
 * mask. Defense in depth: providers sometimes echo request credentials inside
 * error bodies, and probe details are rendered in a browser and in logs.
 */
export function redactSecrets(text) {
  let out = String(text);
  for (const [name, value] of Object.entries(process.env)) {
    if (!isSecretEnvName(name)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < 6) continue;
    while (out.includes(trimmed)) {
      out = out.replace(trimmed, maskTail(trimmed));
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

// --- Family probes ----------------------------------------------------------

async function probeTelegram() {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return missing("telegram", "TELEGRAM_BOT_TOKEN");
  const r = await fetchJson(`https://api.telegram.org/bot${token}/getMe`);
  return r.httpOk && r.body?.ok
    ? pass("telegram", `getMe ok: @${r.body.result?.username ?? "unknown"}`)
    : fail("telegram", `getMe HTTP ${r.status}: ${errorSnippet(r)}`);
}

async function probeDiscord() {
  const token = env("DISCORD_API_TOKEN") ?? env("DISCORD_BOT_TOKEN");
  if (!token)
    return missing("discord", "DISCORD_API_TOKEN or DISCORD_BOT_TOKEN");
  const r = await fetchJson("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
  });
  return r.httpOk
    ? pass("discord", `users/@me ok: ${r.body?.username ?? "unknown"}`)
    : fail("discord", `users/@me HTTP ${r.status}: ${errorSnippet(r)}`);
}

async function probeSlack() {
  const botToken = env("SLACK_BOT_TOKEN");
  const appToken = env("SLACK_APP_TOKEN");
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

async function probeX() {
  const consumerKey = env("TWITTER_API_KEY");
  const consumerSecret = env("TWITTER_API_SECRET_KEY");
  const accessToken = env("TWITTER_ACCESS_TOKEN");
  const accessSecret = env("TWITTER_ACCESS_TOKEN_SECRET");
  const bearer = env("TWITTER_BEARER_TOKEN");
  const url = "https://api.x.com/2/users/me";
  if (consumerKey && consumerSecret && accessToken && accessSecret) {
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
      ? pass(
          "x",
          `users/me (oauth1) ok: @${r.body?.data?.username ?? "unknown"}`,
        )
      : fail("x", `users/me (oauth1) HTTP ${r.status}: ${errorSnippet(r)}`);
  }
  if (bearer) {
    const r = await fetchJson(url, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    return r.httpOk
      ? pass(
          "x",
          `users/me (bearer) ok: @${r.body?.data?.username ?? "unknown"}`,
        )
      : fail(
          "x",
          `users/me (bearer) HTTP ${r.status}: ${errorSnippet(r)} — app-only bearer cannot read user context; set TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_TOKEN_SECRET for the OAuth1 signed probe`,
        );
  }
  return missing(
    "x",
    "TWITTER_API_KEY + TWITTER_API_SECRET_KEY + TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_TOKEN_SECRET",
  );
}

async function probeWhatsapp() {
  const token =
    env("ELIZA_WHATSAPP_ACCESS_TOKEN") ?? env("WHATSAPP_ACCESS_TOKEN");
  const phoneId =
    env("ELIZA_WHATSAPP_PHONE_NUMBER_ID") ?? env("WHATSAPP_PHONE_NUMBER_ID");
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

async function probeTwilio() {
  const sid = env("TWILIO_ACCOUNT_SID");
  const auth = env("TWILIO_AUTH_TOKEN");
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

async function probeSignal() {
  const httpUrl = env("SIGNAL_HTTP_URL");
  if (httpUrl) {
    const r = await fetchJson(`${httpUrl.replace(/\/+$/, "")}/v1/about`);
    return r.httpOk
      ? pass(
          "signal",
          `signal-cli-rest-api reachable (versions: ${JSON.stringify(r.body?.versions ?? r.body?.version ?? "?")})`,
        )
      : fail("signal", `GET /v1/about HTTP ${r.status}: ${errorSnippet(r)}`);
  }
  const cliPath = env("SIGNAL_CLI_PATH");
  if (!cliPath && !env("SIGNAL_ACCOUNT_NUMBER"))
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

async function probeModel() {
  const providers = [];
  let anyOk = false;
  const openaiKey = env("OPENAI_API_KEY");
  if (openaiKey) {
    const base = (
      env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    const r = await fetchJson(`${base}/models`, {
      headers: { Authorization: `Bearer ${openaiKey}` },
    });
    if (r.httpOk) {
      anyOk = true;
      providers.push(
        `openai(${new URL(base).hostname}): ok (${r.body?.data?.length ?? 0} models)`,
      );
    } else providers.push(`openai: HTTP ${r.status} ${errorSnippet(r)}`);
  } else providers.push("openai: missing OPENAI_API_KEY");
  const cerebrasKey = env("CEREBRAS_API_KEY");
  if (cerebrasKey) {
    const r = await fetchJson("https://api.cerebras.ai/v1/models", {
      headers: { Authorization: `Bearer ${cerebrasKey}` },
    });
    if (r.httpOk) {
      anyOk = true;
      providers.push(`cerebras: ok (${r.body?.data?.length ?? 0} models)`);
    } else providers.push(`cerebras: HTTP ${r.status} ${errorSnippet(r)}`);
  } else providers.push("cerebras: missing CEREBRAS_API_KEY");
  const anthropicKey = env("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    const r = await fetchJson("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
    });
    if (r.httpOk) {
      anyOk = true;
      providers.push(`anthropic: ok (${r.body?.data?.length ?? 0} models)`);
    } else providers.push(`anthropic: HTTP ${r.status} ${errorSnippet(r)}`);
  } else providers.push("anthropic: missing ANTHROPIC_API_KEY");
  const detail = providers.join("; ");
  return anyOk ? pass("model", detail) : fail("model", detail);
}

// One green wearable satisfies the health group — the live run only needs a
// single working data source.
async function probeHealth() {
  const sources = [
    {
      name: "strava",
      token: env("STRAVA_ACCESS_TOKEN"),
      url: "https://www.strava.com/api/v3/athlete",
    },
    {
      name: "oura",
      token: env("OURA_ACCESS_TOKEN"),
      url: "https://api.ouraring.com/v2/usercollection/personal_info",
    },
    {
      name: "fitbit",
      token: env("FITBIT_ACCESS_TOKEN"),
      url: "https://api.fitbit.com/1/user/-/profile.json",
    },
    {
      name: "withings",
      token: env("WITHINGS_ACCESS_TOKEN"),
      url: "https://wbsapi.withings.net/v2/user?action=getdevice",
    },
  ];
  const configured = sources.filter((s) => s.token);
  if (configured.length === 0) {
    return missing(
      "health",
      "STRAVA_ACCESS_TOKEN / OURA_ACCESS_TOKEN / FITBIT_ACCESS_TOKEN / WITHINGS_ACCESS_TOKEN (any one)",
    );
  }
  const parts = [];
  let anyOk = false;
  for (const source of configured) {
    const r = await fetchJson(source.url, {
      headers: { Authorization: `Bearer ${source.token}` },
    });
    // Withings tunnels errors through HTTP 200 with a nonzero body.status.
    const bodyOk = source.name === "withings" ? r.body?.status === 0 : true;
    if (r.httpOk && bodyOk) {
      anyOk = true;
      parts.push(`${source.name}: ok`);
    } else {
      parts.push(
        `${source.name}: HTTP ${r.status}${bodyOk ? "" : ` api-status=${r.body?.status}`} ${errorSnippet(r)}`,
      );
    }
  }
  const detail = parts.join("; ");
  return anyOk ? pass("health", detail) : fail("health", detail);
}

async function probePlaid() {
  const clientId = env("PLAID_CLIENT_ID");
  const secret = env("PLAID_SECRET");
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

async function probePaypal() {
  const clientId = env("PAYPAL_CLIENT_ID");
  const secret = env("PAYPAL_CLIENT_SECRET");
  if (!clientId || !secret)
    return missing("paypal", "PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET");
  const base = (
    env("PAYPAL_API_BASE") ?? "https://api-m.sandbox.paypal.com"
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
async function probeGoogle() {
  const names = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
  ];
  const absent = names.filter((name) => !env(name));
  return absent.length === 0
    ? pass(
        "google",
        "client credentials present (presence-only — validate via in-app OAuth: Settings → Connectors)",
      )
    : missing("google", absent.join(" + "));
}

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

/**
 * Run one family probe. Network/timeout failures become a structured
 * { ok:false } result so a batch never dies on one flaky provider.
 */
export async function probeFamily(family) {
  const probe = PROBES[family];
  if (!probe) {
    throw new Error(
      `Unknown probe family: ${family} (known: ${PROBE_FAMILIES.join(", ")})`,
    );
  }
  const probedAt = new Date().toISOString();
  try {
    return { ...(await probe()), probedAt };
  } catch (error) {
    // error-policy:J1 probe boundary — a transport error IS the probe outcome; it surfaces as a red row, not a crash.
    const cause = error?.cause?.code ?? error?.code;
    const reason =
      error?.name === "TimeoutError"
        ? `timed out after ${PROBE_TIMEOUT_MS / 1000}s`
        : `${error?.message ?? error}${cause ? ` (${cause})` : ""}`;
    return { ...fail(family, `probe error: ${reason}`), probedAt };
  }
}

export async function probeAll(families = PROBE_FAMILIES) {
  return Promise.all(families.map((family) => probeFamily(family)));
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  const results = await probeAll(
    requested.length > 0 ? requested : PROBE_FAMILIES,
  );
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
