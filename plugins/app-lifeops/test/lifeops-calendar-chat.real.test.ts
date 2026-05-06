/**
 * LifeOps calendar data layer integration tests.
 *
 * Tests the calendar repository against seeded DB events. Verifies that
 * event storage, time-window queries, and connector grants work correctly
 * with real PGLite-backed data.
 *
 * The calendar action handler requires a real Google connector, so these
 * tests exercise the repository layer directly rather than calling the handler.
 * Full handler-level tests with real Google OAuth are in the live E2E suite.
 *
 * No mocks, no regex, no hardcoded LLM responses.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveEnv } from "../../../test/helpers/test-utils";
import {
  createLifeOpsCalendarSyncState,
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../src/lifeops/time.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

const AGENT_ID = "lifeops-calendar-integration-agent";
const TEST_TIME_ZONE = "America/Los_Angeles";

function localDayAtOffset(daysFromToday: number) {
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

function allDayStart(daysFromToday: number): string {
  return localIso(daysFromToday, 0, 0);
}

function allDayEnd(daysFromToday: number): string {
  return localIso(daysFromToday + 1, 0, 0);
}

async function seedCalendarEvents(
  runtime: AgentRuntime,
  stateDir: string,
): Promise<void> {
  const repository = new LifeOpsRepository(runtime);
  const tokenRef = `${AGENT_ID}/owner/local.json`;
  const tokenPath = path.join(
    resolveOAuthDir(process.env, stateDir),
    "lifeops",
    "google",
    tokenRef,
  );
  await fs.promises.mkdir(path.dirname(tokenPath), {
    recursive: true,
    mode: 0o700,
  });
  const nowIso = new Date().toISOString();
  await fs.promises.writeFile(
    tokenPath,
    JSON.stringify({
      provider: "google",
      agentId: AGENT_ID,
      side: "owner",
      mode: "local",
      clientId: "test-client",
      redirectUri: "http://127.0.0.1/callback",
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      tokenType: "Bearer",
      grantedScopes: [
        "openid",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
      expiresAt: Date.now() + 3600_000,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    { encoding: "utf-8", mode: 0o600 },
  );

  await repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId: AGENT_ID,
      provider: "google",
      side: "owner",
      identity: { email: "test@example.com", name: "Test" },
      grantedScopes: [
        "openid",
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
      agentId: AGENT_ID,
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
      agentId: AGENT_ID,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Stay at Boulder Hotel",
      description: "",
      location: "Boulder, CO",
      status: "confirmed",
      startAt: allDayStart(1),
      endAt: allDayEnd(1),
      isAllDay: true,
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
      id: "evt-flight",
      externalId: "flight-ext",
      agentId: AGENT_ID,
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
      attendees: [],
      metadata: {},
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "evt-meeting",
      externalId: "meeting-ext",
      agentId: AGENT_ID,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Team standup",
      description: "",
      location: "Office",
      status: "confirmed",
      startAt: localIso(1, 15, 0),
      endAt: localIso(1, 15, 30),
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
  ];

  for (const event of events) {
    await repository.upsertCalendarEvent(event);
  }
  await repository.upsertCalendarSyncState(
    createLifeOpsCalendarSyncState({
      agentId: AGENT_ID,
      provider: "google",
      side: "owner",
      calendarId: "primary",
      windowStartAt: allDayStart(0),
      windowEndAt: allDayEnd(90),
      syncedAt: nowIso,
    }),
  );
}

describe("life-ops calendar data layer (real PGLite)", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult | null = null;
  let repository: LifeOpsRepository;
  let stateDir = "";
  let envBackup: { restore: () => void } | null = null;

  beforeAll(async () => {
    envBackup = saveEnv(
      "ELIZA_STATE_DIR",
      "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    );
    stateDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "lifeops-cal-data-"),
    );
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID = "test-client";

    testResult = await createLifeOpsTestRuntime({ characterName: AGENT_ID });
    runtime = testResult.runtime;
    repository = new LifeOpsRepository(runtime);

    await seedCalendarEvents(runtime, stateDir);
  }, 360_000);

  afterAll(async () => {
    try {
      await testResult?.cleanup();
    } finally {
      if (stateDir) {
        await fs.promises.rm(stateDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
      envBackup?.restore();
    }
  }, 120_000);

  it("lists events within a time window (tomorrow only)", async () => {
    const tomorrowStart = allDayStart(1);
    const tomorrowEnd = allDayEnd(1);
    const events = await repository.listCalendarEvents(
      AGENT_ID,
      "google",
      tomorrowStart,
      tomorrowEnd,
    );

    const titles = events.map((e) => e.title);
    expect(titles).toContain("Stay at Boulder Hotel");
    expect(titles).toContain("Flight to Denver (WN 3677)");
    expect(titles).toContain("Team standup");
    expect(titles).not.toContain("Dentist appointment");
  });

  it("lists today's events separately", async () => {
    const todayStart = allDayStart(0);
    const todayEnd = allDayEnd(0);
    const events = await repository.listCalendarEvents(
      AGENT_ID,
      "google",
      todayStart,
      todayEnd,
    );

    const titles = events.map((e) => e.title);
    expect(titles).toContain("Dentist appointment");
    expect(titles).not.toContain("Flight to Denver (WN 3677)");
  });

  it("returns the connector grant for the seeded account", async () => {
    const grants = await repository.listConnectorGrants(AGENT_ID);

    expect(grants.length).toBeGreaterThan(0);
    const googleGrant = grants.find((g) => g.provider === "google");
    expect(googleGrant).toBeTruthy();
    expect(googleGrant?.capabilities).toContain("google.calendar.read");
  });

  it("returns empty for events outside the seeded time range", async () => {
    const farFuture = allDayStart(365);
    const farFutureEnd = allDayEnd(365);
    const events = await repository.listCalendarEvents(
      AGENT_ID,
      "google",
      farFuture,
      farFutureEnd,
    );

    expect(events).toEqual([]);
  });
});
