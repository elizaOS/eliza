/**
 * Handler + validate coverage for the three meeting actions, driven against a
 * scripted MeetingService stub (no browser, no pipeline). Asserts the exact
 * user-facing reply strings and ActionResult shapes, plus the adversarial
 * targeting/error paths.
 */

import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import type { MeetingSession } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { MeetingJoinError, type MeetingService } from "../service.js";
import { getMeetingTranscriptAction } from "./get-meeting-transcript.js";
import { joinMeetingAction } from "./join-meeting.js";
import { leaveMeetingAction } from "./leave-meeting.js";

const MEET = "https://meet.google.com/abc-defg-hij";

function msg(text?: string): Memory {
  return { content: text === undefined ? {} : { text } } as Memory;
}

function session(over: Partial<MeetingSession>): MeetingSession {
  return {
    id: "sess-a",
    platform: "google_meet",
    meetingUrl: MEET,
    nativeMeetingId: "abc-defg-hij",
    botName: "Eliza Notetaker",
    status: "active",
    requestedAt: 1,
    roomId: "room-a",
    transcriptId: "trans-a",
    participants: [],
    ...over,
  } as MeetingSession;
}

interface Harness {
  runtime: IAgentRuntime;
  cb: HandlerCallback;
  sent: string[];
}

function harness(opts: {
  service?: Partial<MeetingService> | null;
  memories?: Record<string, Memory>;
}): Harness {
  const sent: string[] = [];
  const cb = (async (content: { text?: string }) => {
    sent.push(content.text ?? "");
    return [];
  }) as unknown as HandlerCallback;
  const runtime = {
    getService: (name: string) =>
      name === "meetings" ? (opts.service ?? null) : null,
    getMemoryById: async (id: UUID) => opts.memories?.[id] ?? null,
  } as unknown as IAgentRuntime;
  return { runtime, cb, sent };
}

const NO_STATE = undefined as unknown as State;

describe("JOIN_MEETING", () => {
  it("is OWNER role-gated — a DM user cannot dispatch the notetaker (MJ-2b)", () => {
    // Sending the bot into a live call is privileged; the runtime's role-gate
    // enforcement blocks non-owner callers before the handler runs.
    expect(joinMeetingAction.roleGate).toEqual({ minRole: "OWNER" });
  });

  it("validate is true only for a real meeting URL", async () => {
    const v = joinMeetingAction.validate;
    expect(await v({} as IAgentRuntime, msg(`join ${MEET}`), NO_STATE)).toBe(
      true,
    );
    expect(
      await v(
        {} as IAgentRuntime,
        msg("join https://example.com/not-a-meeting"),
        NO_STATE,
      ),
    ).toBe(false);
    expect(await v({} as IAgentRuntime, msg("no link"), NO_STATE)).toBe(false);
  });

  it("validate true via explicit option even with no URL in text", async () => {
    expect(
      await joinMeetingAction.validate(
        {} as IAgentRuntime,
        msg("please join"),
        NO_STATE,
        { meetingUrl: MEET },
      ),
    ).toBe(true);
  });

  it("asks for a link when none present", async () => {
    const h = harness({ service: {} });
    const res = await joinMeetingAction.handler(
      h.runtime,
      msg("join please"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toMatchObject({ success: false });
    expect(h.sent[0]).toContain("I need a meeting link");
  });

  it("reports the service being down with the exact string", async () => {
    const h = harness({ service: null });
    const res = await joinMeetingAction.handler(
      h.runtime,
      msg(`join ${MEET}`),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toEqual({
      success: false,
      text: "The meetings service isn't running, so I can't join calls right now.",
    });
    expect(h.sent).toEqual([res.text]);
  });

  it("joins and returns sessionId + transcriptId", async () => {
    const service: Partial<MeetingService> = {
      requestJoin: async () =>
        session({ id: "j1", transcriptId: "t1", botName: "Bot" }),
    };
    const h = harness({ service });
    const res = await joinMeetingAction.handler(
      h.runtime,
      msg(`join ${MEET}`),
      NO_STATE,
      { botName: "Bot" },
      h.cb,
    );
    expect(res).toMatchObject({
      success: true,
      data: { sessionId: "j1", transcriptId: "t1" },
    });
    expect(h.sent[0]).toContain('as "Bot"');
    expect(h.sent[0]).toContain("Google Meet meeting abc-defg-hij");
  });

  it("surfaces a MeetingJoinError message", async () => {
    const service: Partial<MeetingService> = {
      requestJoin: async () => {
        throw new MeetingJoinError("already_joined", "already in this meeting");
      },
    };
    const h = harness({ service });
    const res = await joinMeetingAction.handler(
      h.runtime,
      msg(`join ${MEET}`),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toEqual({
      success: false,
      text: "I can't join that meeting: already in this meeting",
    });
  });

  it("surfaces an unexpected error", async () => {
    const service: Partial<MeetingService> = {
      requestJoin: async () => {
        throw new Error("boom");
      },
    };
    const h = harness({ service });
    const res = await joinMeetingAction.handler(
      h.runtime,
      msg(`join ${MEET}`),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res.text).toBe("Joining the meeting failed: boom");
  });
});

describe("LEAVE_MEETING", () => {
  function svc(active: MeetingSession[]): Partial<MeetingService> {
    const stopped: string[] = [];
    return {
      listSessions: () => active,
      stopSession: ((id: UUID) => {
        stopped.push(id);
        return true;
      }) as MeetingService["stopSession"],
    };
  }

  it("validate false with no service / no active / no keyword", async () => {
    expect(
      await leaveMeetingAction.validate(
        harness({ service: null }).runtime,
        msg("leave"),
        NO_STATE,
      ),
    ).toBe(false);
    const empty = harness({ service: svc([]) });
    expect(
      await leaveMeetingAction.validate(empty.runtime, msg("leave"), NO_STATE),
    ).toBe(false);
    const one = harness({ service: svc([session({})]) });
    expect(
      await leaveMeetingAction.validate(one.runtime, msg("hi there"), NO_STATE),
    ).toBe(false);
    expect(
      await leaveMeetingAction.validate(
        one.runtime,
        msg("please leave"),
        NO_STATE,
      ),
    ).toBe(true);
  });

  it("service down reply", async () => {
    const h = harness({ service: null });
    const res = await leaveMeetingAction.handler(
      h.runtime,
      msg("leave"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toEqual({
      success: false,
      text: "The meetings service isn't running.",
    });
  });

  it("leaves the sole active meeting", async () => {
    const h = harness({ service: svc([session({ id: "only" })]) });
    const res = await leaveMeetingAction.handler(
      h.runtime,
      msg("leave"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toMatchObject({ success: true, data: { sessionId: "only" } });
    expect(h.sent[0]).toContain("Leaving the Google Meet meeting");
  });

  it("nothing to leave when a named target is unknown", async () => {
    const h = harness({ service: svc([session({})]) });
    const res = await leaveMeetingAction.handler(
      h.runtime,
      msg("leave https://meet.google.com/zzz-zzzz-zzz"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toEqual({
      success: false,
      text: "I'm not in that meeting right now — nothing to leave.",
    });
  });

  it("asks to disambiguate with multiple active meetings", async () => {
    const active = [
      session({ id: "a", nativeMeetingId: "abc-defg-hij" }),
      session({ id: "b", platform: "zoom", nativeMeetingId: "1234567890" }),
    ];
    const h = harness({ service: svc(active) });
    const res = await leaveMeetingAction.handler(
      h.runtime,
      msg("leave"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res.success).toBe(false);
    expect(res.text).toContain("I'm in 2 meetings");
    expect(res.text).toContain("Google Meet abc-defg-hij");
    expect(res.text).toContain("Zoom 1234567890");
  });

  it("targets a specific meeting by URL when several are active", async () => {
    const active = [
      session({ id: "a", nativeMeetingId: "abc-defg-hij" }),
      session({ id: "b", platform: "zoom", nativeMeetingId: "1234567890" }),
    ];
    const h = harness({ service: svc(active) });
    const res = await leaveMeetingAction.handler(
      h.runtime,
      msg(`leave ${MEET}`),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toMatchObject({ success: true, data: { sessionId: "a" } });
  });
});

describe("GET_MEETING_TRANSCRIPT", () => {
  function svc(sessions: MeetingSession[]): Partial<MeetingService> {
    return { listSessions: () => sessions };
  }

  it("service down reply", async () => {
    const h = harness({ service: null });
    const res = await getMeetingTranscriptAction.handler(
      h.runtime,
      msg("transcript"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toEqual({
      success: false,
      text: "The meetings service isn't running.",
    });
  });

  it("no attended meeting yet", async () => {
    const h = harness({ service: svc([]) });
    const res = await getMeetingTranscriptAction.handler(
      h.runtime,
      msg("transcript"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res.text).toBe(
      "I haven't attended a meeting with a transcript yet.",
    );
  });

  it("missing transcript row", async () => {
    const h = harness({ service: svc([session({ transcriptId: "gone" })]) });
    const res = await getMeetingTranscriptAction.handler(
      h.runtime,
      msg("transcript"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res.text).toContain(
      "transcript record for that meeting (gone) is missing",
    );
  });

  it("empty transcript reports status", async () => {
    // A row that readTranscriptRow yields with no segments.
    const row = {
      id: "trans-a",
      content: {
        text: "",
        transcript: JSON.stringify({
          id: "trans-a",
          status: "recording",
          segments: [],
        }),
      },
      metadata: { type: "custom", source: "transcript" },
    } as unknown as Memory;
    const h = harness({
      service: svc([session({ transcriptId: "trans-a" })]),
      memories: { "trans-a": row },
    });
    const res = await getMeetingTranscriptAction.handler(
      h.runtime,
      msg("transcript"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res.success).toBe(false);
    expect(res.text).toContain("No speech has been transcribed");
    expect(res.text).toContain("status: recording");
  });

  it("returns transcript text", async () => {
    const row = {
      id: "trans-a",
      content: {
        text: "Alice: hello",
        transcript: JSON.stringify({
          id: "trans-a",
          status: "ready",
          segments: [
            {
              id: "s1",
              speakerLabel: "Alice",
              startMs: 0,
              endMs: 1000,
              text: "hello",
              words: [],
            },
          ],
        }),
      },
      metadata: { type: "custom", source: "transcript" },
    } as unknown as Memory;
    const h = harness({
      service: svc([session({ transcriptId: "trans-a" })]),
      memories: { "trans-a": row },
    });
    const res = await getMeetingTranscriptAction.handler(
      h.runtime,
      msg("show the transcript"),
      NO_STATE,
      {},
      h.cb,
    );
    expect(res).toMatchObject({
      success: true,
      data: { sessionId: "sess-a", transcriptId: "trans-a" },
    });
    expect(res.text).toContain("hello");
  });

  it("validate gated on service + sessions + keyword", async () => {
    const v = getMeetingTranscriptAction.validate;
    expect(
      await v(harness({ service: null }).runtime, msg("transcript"), NO_STATE),
    ).toBe(false);
    const has = harness({ service: svc([session({})]) });
    expect(await v(has.runtime, msg("hello there"), NO_STATE)).toBe(false);
    expect(await v(has.runtime, msg("show me the notes"), NO_STATE)).toBe(true);
  });
});
