/**
 * LifeOps calendar chat integration tests with real LLM.
 *
 * Verifies the calendar action against seeded DB events using real LLM
 * for query planning, event matching, and response generation.
 *
 * No mocks, no regex on prompts, no hardcoded LLM responses.
 * Verifies via structured action results and known seeded event titles.
 *
 * Requires at least one LLM provider API key. Skips when unavailable.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";
import { selectLiveProvider } from "../../../../test/helpers/live-provider";
import { stochasticTest } from "../../../packages/app-core/test/helpers/stochastic-test";
import { saveEnv } from "../../../../test/helpers/test-utils";
import { calendarAction } from "../src/actions/calendar.js";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../src/lifeops/time.js";
import {
  createLifeOpsCalendarSyncState,
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";

const providerConfig = selectLiveProvider();
const describeWithLLM = providerConfig ? describe : describe.skip;

const AGENT_ID = "lifeops-calendar-chat-agent";
const TEST_TIME_ZONE = "America/Los_Angeles";

// ---------------------------------------------------------------------------
// Date helpers (generate dynamic dates relative to "today")
// ---------------------------------------------------------------------------

function localDayAtOffset(daysFromToday: number): {
  year: number;
  month: number;
  day: number;
} {
  const now = getZonedDateParts(new Date(), TEST_TIME_ZONE);
  return addDaysToLocalDate(
    { year: now.year, month: now.month, day: now.day },
    daysFromToday,
  );
}

function localIso(daysFromToday: number, hour: number, minute = 0): string {
  const date = localDayAtOffset(daysFromToday);
  return buildUtcDateFromLocalParts(TEST_TIME_ZONE, {
    year: date.year,
    month: date.month,
    day: date.day,
    hour,
    minute,
    second: 0,
    millisecond: 0,
  }).toISOString();
}

function localMonthDayLabel(daysFromToday: number): string {
  const date = localDayAtOffset(daysFromToday);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
  }).format(
    new Date(
      Date.UTC(date.year, Math.max(0, date.month - 1), date.day, 12, 0, 0),
    ),
  );
}

function allDayStart(daysFromToday: number): string {
  return localIso(daysFromToday, 0, 0);
}

function allDayEnd(daysFromToday: number): string {
  return localIso(daysFromToday + 1, 0, 0);
}

// ---------------------------------------------------------------------------
// Seed calendar events into DB
// ---------------------------------------------------------------------------

async function seedGoogleCalendar(
  runtime: AgentRuntime,
  stateDir: string,
): Promise<void> {
  const repository = new LifeOpsRepository(runtime);
  const agentId = runtime.agentId;
  const tokenRef = `${agentId}/owner/local.json`;
  const tokenPath = path.join(
    resolveOAuthDir(process.env, stateDir),
    "lifeops",
    "google",
    tokenRef,
  );
  const tokenDir = path.dirname(tokenPath);
  await fs.promises.mkdir(tokenDir, { recursive: true, mode: 0o700 });
  const nowIso = new Date().toISOString();
  await fs.promises.writeFile(
    tokenPath,
    JSON.stringify(
      {
        provider: "google",
        agentId: agentId,
        side: "owner",
        mode: "local",
        clientId: "lifeops-calendar-chat-client",
        redirectUri: "http://127.0.0.1/callback",
        accessToken: "calendar-chat-access-token",
        refreshToken: "calendar-chat-refresh-token",
        tokenType: "Bearer",
        grantedScopes: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshTokenExpiresAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      null,
      2,
    ),
    { encoding: "utf-8", mode: 0o600 },
  );

  await repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId: agentId,
      provider: "google",
      side: "owner",
      identity: { email: "shaw@example.com", name: "Shaw" },
      grantedScopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
      capabilities: ["google.basic_identity", "google.calendar.read"],
      tokenRef,
      mode: "local",
      metadata: {},
      lastRefreshAt: nowIso,
    }),
  );

  const events = [
    {
      id: "evt-dentist",
      externalId: "dentist-ext",
      agentId: agentId,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Dentist appointment",
      description: "",
      location: "Main St Dental",
      status: "confirmed",
      startAt: localIso(0, 11, 0),
      endAt: localIso(0, 12, 0),
      isAllDay: false,
      timezone: TEST_TIME_ZONE,
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "evt-hotel",
      externalId: "hotel-ext",
      agentId: agentId,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Stay at Fairfield by Marriott Inn & Suites Boulder",
      description: "",
      location: "Fairfield by Marriott Inn & Suites Boulder, Boulder",
      status: "confirmed",
      startAt: allDayStart(1),
      endAt: allDayEnd(1),
      isAllDay: true,
      timezone: TEST_TIME_ZONE,
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [
        {
          email: "shawmakesmagic@gmail.com",
          displayName: "shawmakesmagic@gmail.com",
          responseStatus: "accepted",
        },
      ],
      metadata: {},
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "evt-outbound-flight",
      externalId: "flight-denver-ext",
      agentId: agentId,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Flight to Denver (WN 3677)",
      description: "",
      location: "San Francisco SFO",
      status: "confirmed",
      startAt: localIso(1, 14, 25),
      endAt: localIso(1, 17, 5),
      isAllDay: false,
      timezone: TEST_TIME_ZONE,
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [
        {
          email: "shawmakesmagic@gmail.com",
          displayName: "shawmakesmagic@gmail.com",
          responseStatus: "accepted",
        },
      ],
      metadata: {},
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "evt-meeting",
      externalId: "meeting-ext",
      agentId: agentId,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Meeting",
      description: "",
      location: "Maikoh Holistics",
      status: "confirmed",
      startAt: localIso(1, 15, 0),
      endAt: localIso(1, 15, 30),
      isAllDay: false,
      timezone: TEST_TIME_ZONE,
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [
        {
          email: "shawmakesmagic@gmail.com",
          displayName: "shawmakesmagic@gmail.com",
          responseStatus: "accepted",
        },
      ],
      metadata: {},
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "evt-return-flight",
      externalId: "flight-sfo-ext",
      agentId: agentId,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Flight to San Francisco (WN 2287)",
      description: "return to SFO",
      location: "Denver DEN",
      status: "confirmed",
      startAt: localIso(9, 13, 10),
      endAt: localIso(9, 15, 55),
      isAllDay: false,
      timezone: TEST_TIME_ZONE,
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [
        {
          email: "shawmakesmagic@gmail.com",
          displayName: "shawmakesmagic@gmail.com",
          responseStatus: "accepted",
        },
      ],
      metadata: {},
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  for (const event of events) {
    await repository.upsertCalendarEvent(event);
  }
  await repository.upsertCalendarSyncState(
    createLifeOpsCalendarSyncState({
      agentId: agentId,
      provider: "google",
      side: "owner",
      calendarId: "primary",
      windowStartAt: allDayStart(0),
      windowEndAt: allDayEnd(90),
      syncedAt: nowIso,
    }),
  );
}

// ---------------------------------------------------------------------------
// Helper to call the calendar action
// ---------------------------------------------------------------------------

function callCalendarAction(
  runtime: AgentRuntime,
  text: string,
  extraParams: Record<string, unknown> = {},
) {
  return calendarAction.handler?.(
    runtime,
    {
      entityId: runtime.agentId,
      content: { text, source: "discord" },
    } as never,
    {} as never,
    {
      parameters: {
        intent: text,
        details: { timeZone: TEST_TIME_ZONE },
        ...extraParams,
      },
    } as never,
  );
}

/**
 * Check that a response's text mentions an expected event title.
 * These titles come from seeded DB data, not from LLM generation,
 * so checking them is stable and language-agnostic.
 */
function responseContainsEvent(
  result: { text?: string; data?: { events?: Array<{ title?: string }> } } | null | undefined,
  eventTitle: string,
): boolean {
  const text = result?.text ?? "";
  if (text.includes(eventTitle)) return true;
  // Also check structured event data in case LLM reformulates titles
  const events = result?.data?.events;
  if (Array.isArray(events)) {
    return events.some((e) => e.title === eventTitle);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithLLM("life-ops calendar chat (real LLM)", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let stateDir: string;
  let envBackup: { restore: () => void };

  beforeAll(async () => {
    envBackup = saveEnv(
      "ELIZA_STATE_DIR",
      "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    );
    stateDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "lifeops-calendar-chat-"),
    );
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID =
      "lifeops-calendar-chat-client";

    testResult = await createLifeOpsTestRuntime({
      withLLM: true,
      characterName: AGENT_ID,
    });
    runtime = testResult.runtime;

    await seedGoogleCalendar(runtime, stateDir);
  }, 180_000);

  afterAll(async () => {
    await testResult.cleanup();
    await fs.promises.rm(stateDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    envBackup.restore();
  });

  stochasticTest("returns tomorrow's events and excludes today's dentist appointment", async () => {
    const result = await callCalendarAction(
      runtime,
      "can you tell me whats on my schedule tomorrow",
    );

    expect(result).toBeTruthy();
    expect(result?.success).toBe(true);

    // Tomorrow's events should be present (titles from DB, not LLM)
    expect(
      responseContainsEvent(
        result,
        "Stay at Fairfield by Marriott Inn & Suites Boulder",
      ),
    ).toBe(true);
    expect(
      responseContainsEvent(result, "Flight to Denver (WN 3677)"),
    ).toBe(true);
    expect(responseContainsEvent(result, "Meeting")).toBe(true);

    // Today's dentist should NOT be in tomorrow's results
    expect(responseContainsEvent(result, "Dentist appointment")).toBe(false);
  }, { perRunTimeoutMs: 120_000 });

  stochasticTest("finds flights matching a search query", async () => {
    const result = await callCalendarAction(
      runtime,
      "can you search my calendar and tell me if i have any flights to denver?",
    );

    expect(result).toBeTruthy();
    expect(result?.success).toBe(true);
    expect(
      responseContainsEvent(result, "Flight to Denver (WN 3677)"),
    ).toBe(true);
    expect(responseContainsEvent(result, "Dentist appointment")).toBe(false);
  }, { perRunTimeoutMs: 120_000 });

  stochasticTest("handles a non-English calendar search question", async () => {
    const result = await callCalendarAction(
      runtime,
      "puedes buscar en mi calendario y decirme si tengo un vuelo a denver",
    );

    expect(result).toBeTruthy();
    expect(result?.success).toBe(true);
    expect(
      responseContainsEvent(result, "Flight to Denver (WN 3677)"),
    ).toBe(true);
    expect(responseContainsEvent(result, "Dentist appointment")).toBe(false);
  }, { perRunTimeoutMs: 120_000 });

  stochasticTest("answers an exact date query with the correct events", async () => {
    const dateLabel = localMonthDayLabel(1);
    const result = await callCalendarAction(
      runtime,
      `what event do i have on ${dateLabel}`,
    );

    expect(result).toBeTruthy();
    expect(result?.success).toBe(true);

    // All tomorrow's events should appear
    expect(
      responseContainsEvent(result, "Flight to Denver (WN 3677)"),
    ).toBe(true);
    expect(responseContainsEvent(result, "Meeting")).toBe(true);
    expect(
      responseContainsEvent(
        result,
        "Stay at Fairfield by Marriott Inn & Suites Boulder",
      ),
    ).toBe(true);

    // Today's event should not
    expect(responseContainsEvent(result, "Dentist appointment")).toBe(false);
  }, { perRunTimeoutMs: 120_000 });
});
