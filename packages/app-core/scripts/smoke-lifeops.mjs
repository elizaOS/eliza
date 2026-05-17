#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;

function parseTruthy(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolveLifeOpsBaseUrls(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const argvBases = argv.map((value) => value.trim()).filter(Boolean);
  const envLists = [env.ELIZA_LIFEOPS_BASE_URLS, env.ELIZA_DEPLOY_BASE_URLS]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const singleBase =
    env.ELIZA_LIFEOPS_BASE_URL?.trim() ||
    env.ELIZA_DEPLOY_BASE_URL?.trim() ||
    env.ELIZA_DEPLOY_BASE_URL?.trim();
  if (singleBase) {
    envLists.push(singleBase);
  }
  return argvBases.length > 0 ? argvBases : envLists;
}

export function resolveLifeOpsAuthHeaders(env = process.env) {
  const token =
    env.ELIZA_SMOKE_API_TOKEN?.trim() ||
    env.ELIZA_API_TOKEN?.trim() ||
    env.ELIZA_API_TOKEN?.trim();
  if (!token) {
    return { Accept: "application/json" };
  }
  return {
    Accept: "application/json",
    Authorization: /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`,
  };
}

async function fetchJson(fetchImpl, url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    return { res, body: await res.json().catch(() => null), timedOut: false };
  } catch (error) {
    return { res: null, body: error, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

function fail(error, message) {
  error(message);
  return 1;
}

function hasOverviewShape(body) {
  return Boolean(
    body &&
      typeof body === "object" &&
      body.summary &&
      typeof body.summary.activeOccurrenceCount === "number" &&
      typeof body.summary.activeReminderCount === "number",
  );
}

function hasBrowserSessionsShape(body) {
  return Boolean(
    body && typeof body === "object" && Array.isArray(body.sessions),
  );
}

function hasGoogleStatusShape(body) {
  return Boolean(
    body &&
      typeof body === "object" &&
      body.provider === "google" &&
      typeof body.connected === "boolean" &&
      typeof body.reason === "string" &&
      Array.isArray(body.grantedCapabilities),
  );
}

function hasNextContextShape(body) {
  return Boolean(
    body &&
      typeof body === "object" &&
      Array.isArray(body.preparationChecklist) &&
      Array.isArray(body.linkedMail) &&
      typeof body.linkedMailState === "string",
  );
}

function hasGmailTriageShape(body) {
  return Boolean(
    body &&
      typeof body === "object" &&
      Array.isArray(body.messages) &&
      body.summary &&
      typeof body.summary.unreadCount === "number" &&
      typeof body.summary.importantNewCount === "number" &&
      typeof body.summary.likelyReplyNeededCount === "number",
  );
}

export async function runSmokeLifeOps(options = {}) {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = console.log,
    error = console.error,
  } = options;

  const bases = resolveLifeOpsBaseUrls(argv, env);
  if (bases.length === 0) {
    error(
      "[smoke-lifeops] Missing base URLs. Pass args or set ELIZA_LIFEOPS_BASE_URLS.",
    );
    return 2;
  }

  const headers = resolveLifeOpsAuthHeaders(env);
  const expectGoogleConnected = parseTruthy(
    env.ELIZA_LIFEOPS_EXPECT_GOOGLE_CONNECTED ||
      env.ELIZA_LIFEOPS_EXPECT_GOOGLE_CONNECTED,
  );
  const expectGmailTriage = parseTruthy(
    env.ELIZA_LIFEOPS_EXPECT_GMAIL_TRIAGE ||
      env.ELIZA_LIFEOPS_EXPECT_GMAIL_TRIAGE,
  );

  let hasFailure = false;

  for (const base of bases) {
    const overviewUrl = new URL("/api/lifeops/overview", base).toString();
    const overview = await fetchJson(
      fetchImpl,
      overviewUrl,
      headers,
      timeoutMs,
    );
    if (!overview.res) {
      hasFailure = true;
      if (
        fail(
          error,
          overview.timedOut
            ? `[smoke-lifeops] FAIL ${overviewUrl} timed out after ${timeoutMs}ms`
            : `[smoke-lifeops] FAIL ${overviewUrl} ${String(overview.body)}`,
        )
      ) {
        continue;
      }
    }
    if (!overview.res?.ok || !hasOverviewShape(overview.body)) {
      hasFailure = true;
      error(
        `[smoke-lifeops] FAIL ${overviewUrl} did not return a valid overview payload.`,
      );
      continue;
    }
    log(
      `[smoke-lifeops] OK ${overviewUrl} occurrences=${overview.body.summary.activeOccurrenceCount} reminders=${overview.body.summary.activeReminderCount}`,
    );

    const browserUrl = new URL("/api/browser-bridge/sessions", base).toString();
    const browserSessions = await fetchJson(
      fetchImpl,
      browserUrl,
      headers,
      timeoutMs,
    );
    if (
      !browserSessions.res?.ok ||
      !hasBrowserSessionsShape(browserSessions.body)
    ) {
      hasFailure = true;
      error(
        `[smoke-lifeops] FAIL ${browserUrl} did not return a valid browser-session payload.`,
      );
      continue;
    }
    log(
      `[smoke-lifeops] OK ${browserUrl} sessions=${browserSessions.body.sessions.length}`,
    );

    const googleStatusUrl = new URL(
      "/api/lifeops/connectors/google/status",
      base,
    ).toString();
    const googleStatus = await fetchJson(
      fetchImpl,
      googleStatusUrl,
      headers,
      timeoutMs,
    );
    if (!googleStatus.res?.ok || !hasGoogleStatusShape(googleStatus.body)) {
      hasFailure = true;
      error(
        `[smoke-lifeops] FAIL ${googleStatusUrl} did not return a valid Google connector payload.`,
      );
      continue;
    }
    log(
      `[smoke-lifeops] OK ${googleStatusUrl} connected=${googleStatus.body.connected} reason=${googleStatus.body.reason}`,
    );
    if (expectGoogleConnected && !googleStatus.body.connected) {
      hasFailure = true;
      error(
        `[smoke-lifeops] FAIL ${googleStatusUrl} expected an active Google connection.`,
      );
      continue;
    }

    const grantedCapabilities = Array.isArray(
      googleStatus.body.grantedCapabilities,
    )
      ? googleStatus.body.grantedCapabilities.filter(
          (value) => typeof value === "string",
        )
      : [];
    const hasCalendarCapability =
      grantedCapabilities.includes("google.calendar.read") ||
      grantedCapabilities.includes("google.calendar.write");
    const hasGmailCapability =
      grantedCapabilities.includes("google.gmail.triage") ||
      grantedCapabilities.includes("google.gmail.send");

    if (googleStatus.body.connected && hasCalendarCapability) {
      const nextContextUrl = new URL(
        "/api/lifeops/calendar/next-context?timeZone=UTC",
        base,
      ).toString();
      const nextContext = await fetchJson(
        fetchImpl,
        nextContextUrl,
        headers,
        timeoutMs,
      );
      if (!nextContext.res?.ok || !hasNextContextShape(nextContext.body)) {
        hasFailure = true;
        error(
          `[smoke-lifeops] FAIL ${nextContextUrl} did not return a valid next-context payload.`,
        );
        continue;
      }
      log(
        `[smoke-lifeops] OK ${nextContextUrl} linkedMailState=${nextContext.body.linkedMailState}`,
      );
    }

    if (
      googleStatus.body.connected &&
      (expectGmailTriage || hasGmailCapability)
    ) {
      const gmailTriageUrl = new URL(
        "/api/lifeops/gmail/triage?maxResults=5",
        base,
      ).toString();
      const gmailTriage = await fetchJson(
        fetchImpl,
        gmailTriageUrl,
        headers,
        timeoutMs,
      );
      if (!gmailTriage.res?.ok || !hasGmailTriageShape(gmailTriage.body)) {
        hasFailure = true;
        error(
          `[smoke-lifeops] FAIL ${gmailTriageUrl} did not return a valid Gmail triage payload.`,
        );
        continue;
      }
      log(
        `[smoke-lifeops] OK ${gmailTriageUrl} unread=${gmailTriage.body.summary.unreadCount} replyNeeded=${gmailTriage.body.summary.likelyReplyNeededCount}`,
      );
    }
  }

  return hasFailure ? 1 : 0;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
})();

if (isMain) {
  const exitCode = await runSmokeLifeOps();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
