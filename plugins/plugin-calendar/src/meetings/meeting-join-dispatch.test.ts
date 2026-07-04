/**
 * Fire-time `meeting_join` channel handler tests. The calendar row is served
 * through the real `CalendarRepository` SQL path (a stubbed drizzle `execute`
 * returning DB-shaped rows), and every failure mode must come back as a typed
 * `DispatchResult` — never a throw.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { MeetingJoinRequest, MeetingSession } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { writeMeetingAutoJoinPolicy } from "./auto-join-settings.js";
import {
  handleMeetingJoinDispatch,
  readMeetingJoinTarget,
} from "./meeting-join-dispatch.js";

const AGENT_ID = "agent-test";

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    external_event_id: "ext-1",
    agent_id: AGENT_ID,
    provider: "google",
    side: "owner",
    calendar_id: "primary",
    title: "Design sync",
    description: "",
    location: "",
    status: "confirmed",
    start_at: "2026-07-03T15:00:00.000Z",
    end_at: "2026-07-03T15:30:00.000Z",
    is_all_day: false,
    timezone: "UTC",
    html_link: null,
    conference_link: "https://meet.google.com/abc-defg-hij",
    organizer_json: null,
    attendees_json: "[]",
    metadata_json: "{}",
    synced_at: "2026-07-03T10:00:00.000Z",
    updated_at: "2026-07-03T10:00:00.000Z",
    grant_id: "grant-1",
    connector_account_id: null,
    ...overrides,
  };
}

interface RuntimeOptions {
  rows?: Record<string, unknown>[];
  meetings?: {
    requestJoin: (request: MeetingJoinRequest) => Promise<MeetingSession>;
  } | null;
}

function makeRuntime(options: RuntimeOptions = {}): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: AGENT_ID,
    adapter: {
      db: {
        execute: async () => ({ rows: options.rows ?? [] }),
      },
    },
    getService: (type: string) =>
      type === "meetings" ? (options.meetings ?? null) : null,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
  } as unknown as IAgentRuntime;
}

function session(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    id: "sess-1",
    platform: "google_meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    nativeMeetingId: "abc-defg-hij",
    botName: "Eliza",
    status: "joining",
    requestedAt: Date.now(),
    participants: [],
    ...overrides,
  };
}

describe("readMeetingJoinTarget", () => {
  it("reads a bare event id and strips the channel prefix", () => {
    expect(readMeetingJoinTarget({ target: "evt-1" })).toBe("evt-1");
    expect(readMeetingJoinTarget({ target: "meeting_join:evt-1" })).toBe(
      "evt-1",
    );
  });
  it("returns null for missing/blank/non-object payloads", () => {
    expect(readMeetingJoinTarget(null)).toBeNull();
    expect(readMeetingJoinTarget({})).toBeNull();
    expect(readMeetingJoinTarget({ target: "  " })).toBeNull();
    expect(readMeetingJoinTarget("evt-1")).toBeNull();
  });
});

describe("handleMeetingJoinDispatch", () => {
  it("joins the meeting and returns ok with the session id", async () => {
    const requests: MeetingJoinRequest[] = [];
    const runtime = makeRuntime({
      rows: [eventRow()],
      meetings: {
        requestJoin: async (request) => {
          requests.push(request);
          return session();
        },
      },
    });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
      message: "Join the meeting",
      metadata: { taskId: "st_1", firedAtIso: "2026-07-03T14:59:00.000Z" },
    });
    expect(result).toEqual({ ok: true, messageId: "meeting:sess-1" });
    expect(requests).toEqual([
      {
        platform: "google_meet",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        calendarEventId: "evt-1",
      },
    ]);
  });

  it("fails typed when the payload has no target", async () => {
    const runtime = makeRuntime();
    const result = await handleMeetingJoinDispatch(runtime, { message: "x" });
    expect(result).toMatchObject({ ok: false, reason: "unknown_recipient" });
  });

  it("fails typed when the policy was flipped off after scheduling", async () => {
    const runtime = makeRuntime({ rows: [eventRow()] });
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "disconnected",
      userActionable: true,
    });
  });

  it("fails typed when the event no longer exists", async () => {
    const runtime = makeRuntime({ rows: [] });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-gone",
    });
    expect(result).toMatchObject({ ok: false, reason: "unknown_recipient" });
  });

  it("fails typed when the stored link is no longer recognizable", async () => {
    const runtime = makeRuntime({
      rows: [eventRow({ conference_link: "https://example.com/whatever" })],
    });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
    });
    expect(result).toMatchObject({ ok: false, reason: "unknown_recipient" });
  });

  it("fails typed (user-actionable) when the meetings service is missing", async () => {
    const runtime = makeRuntime({ rows: [eventRow()], meetings: null });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "disconnected",
      userActionable: true,
    });
  });

  it("maps a requestJoin failure to transport_error, never a throw", async () => {
    const runtime = makeRuntime({
      rows: [eventRow()],
      meetings: {
        requestJoin: async () => {
          throw new Error("browser bot crashed");
        },
      },
    });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "transport_error",
      message: "browser bot crashed",
    });
  });
});
