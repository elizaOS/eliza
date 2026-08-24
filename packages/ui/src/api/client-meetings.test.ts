/**
 * Unit coverage for the meeting-bot API client methods (#11856) and the
 * WebSocket envelope guards in client-meetings.ts. The HTTP transport is a
 * recording stub at the AgentRequestTransport boundary; URL construction,
 * method, body encoding, and every guard rejection branch are asserted
 * against the real module.
 */
import { describe, expect, it } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-meetings";
import {
  parseMeetingStatusEvent,
  parseMeetingTranscriptEvent,
} from "./client-meetings";

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function clientRecording(body: unknown = { ok: true }): {
  client: ElizaClient;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({
    request: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { client, calls };
}

/** Narrows the single recorded request or fails the test loudly. */
function firstCall(calls: RecordedRequest[]): RecordedRequest {
  const call = calls.at(0);
  if (!call) throw new Error("expected one recorded request");
  return call;
}

function pathname(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

const JOIN_REQUEST = {
  platform: "google_meet",
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  botName: "Eliza",
} as const;

describe("ElizaClient meeting-bot methods (#11856)", () => {
  it("requestMeetingBot POSTs the join request JSON-encoded to /api/meetings and returns the session envelope", async () => {
    const session = {
      id: "sess-1",
      status: "requested",
      participants: [],
    };
    const { client, calls } = clientRecording({ session });

    const result = await client.requestMeetingBot(JOIN_REQUEST);

    expect(result).toEqual({ session });
    expect(calls).toHaveLength(1);
    const req = firstCall(calls);
    expect(pathname(req.url)).toBe("/api/meetings");
    expect(req.init?.method).toBe("POST");
    expect(JSON.parse(String(req.init?.body))).toEqual(JOIN_REQUEST);
  });

  it("listMeetings without options GETs /api/meetings with no query string", async () => {
    const sessions = [
      { id: "s-1", status: "active", participants: [] },
      { id: "s-2", status: "ended", participants: [] },
    ];
    const { client, calls } = clientRecording({ sessions });

    await expect(client.listMeetings()).resolves.toEqual({ sessions });
    const req = firstCall(calls);
    expect(pathname(req.url)).toBe("/api/meetings");
    expect(req.init?.method).toBeUndefined();
  });

  it("listMeetings({ active: true }) appends the ?active=1 filter", async () => {
    const { client, calls } = clientRecording({ sessions: [] });

    await client.listMeetings({ active: true });

    expect(pathname(firstCall(calls).url)).toBe("/api/meetings?active=1");
  });

  it("listMeetings({ active: false }) omits the query like the default", async () => {
    const { client, calls } = clientRecording({ sessions: [] });

    await client.listMeetings({ active: false });

    expect(pathname(firstCall(calls).url)).toBe("/api/meetings");
  });

  it("getMeeting percent-encodes the id into /api/meetings/<id>", async () => {
    const session = { id: "weird id/1&2", status: "active", participants: [] };
    const { client, calls } = clientRecording({ session });

    await expect(client.getMeeting("weird id/1&2")).resolves.toEqual({
      session,
    });

    const rawId = pathname(firstCall(calls).url).slice("/api/meetings/".length);
    expect(rawId).toBe(encodeURIComponent("weird id/1&2"));
  });

  it("stopMeeting DELETEs /api/meetings/<encoded-id> and returns the server body", async () => {
    const { client, calls } = clientRecording({ ok: true });

    await expect(client.stopMeeting("sess 9")).resolves.toEqual({ ok: true });

    const req = firstCall(calls);
    expect(req.init?.method).toBe("DELETE");
    expect(pathname(req.url)).toBe(
      `/api/meetings/${encodeURIComponent("sess 9")}`,
    );
  });
});

describe("parseMeetingTranscriptEvent guard", () => {
  const segment = (id: string, text: string) => ({ id, text });

  it("narrows a well-formed envelope, preserving segments by value", () => {
    const confirmed = [segment("seg-1", "hello"), segment("seg-2", "world")];
    const pending = [segment("seg-3", "wor")];

    const event = parseMeetingTranscriptEvent({
      type: "meeting-transcript",
      sessionId: "sess-1",
      transcriptId: "tr-1",
      confirmed,
      pending,
    });

    expect(event).toEqual({
      type: "meeting-transcript",
      sessionId: "sess-1",
      transcriptId: "tr-1",
      confirmed,
      pending,
    });
  });

  it("accepts empty confirmed and pending arrays", () => {
    const event = parseMeetingTranscriptEvent({
      type: "meeting-transcript",
      sessionId: "sess-1",
      transcriptId: "tr-1",
      confirmed: [],
      pending: [],
    });

    expect(event?.confirmed).toEqual([]);
    expect(event?.pending).toEqual([]);
  });

  it("accepts a single-element array with extra segment fields intact", () => {
    const one = { ...segment("seg-1", "hi"), speakerLabel: "Owner" };

    const event = parseMeetingTranscriptEvent({
      type: "meeting-transcript",
      sessionId: "s",
      transcriptId: "t",
      confirmed: [one],
      pending: [],
    });

    expect(event?.confirmed[0]).toEqual(one);
  });

  it("returns null for a wrong or missing type", () => {
    expect(
      parseMeetingTranscriptEvent({
        type: "meeting-status",
        sessionId: "s",
        transcriptId: "t",
        confirmed: [],
        pending: [],
      }),
    ).toBeNull();
    expect(
      parseMeetingTranscriptEvent({
        sessionId: "s",
        transcriptId: "t",
        confirmed: [],
        pending: [],
      }),
    ).toBeNull();
  });

  it("returns null when sessionId or transcriptId is not a string", () => {
    const base = {
      type: "meeting-transcript",
      transcriptId: "t",
      confirmed: [],
      pending: [],
    };
    expect(parseMeetingTranscriptEvent({ ...base, sessionId: 42 })).toBeNull();
    expect(parseMeetingTranscriptEvent(base)).toBeNull();

    const noTranscriptId = {
      type: "meeting-transcript",
      sessionId: "s",
      confirmed: [],
      pending: [],
    };
    expect(parseMeetingTranscriptEvent(noTranscriptId)).toBeNull();
    expect(
      parseMeetingTranscriptEvent({ ...noTranscriptId, transcriptId: true }),
    ).toBeNull();
  });

  it("returns null when confirmed is missing or not an array", () => {
    const base = {
      type: "meeting-transcript",
      sessionId: "s",
      transcriptId: "t",
      pending: [],
    };
    expect(parseMeetingTranscriptEvent(base)).toBeNull();
    expect(
      parseMeetingTranscriptEvent({ ...base, confirmed: "nope" }),
    ).toBeNull();
  });

  it("returns null when any segment lacks a string id or text", () => {
    const base = {
      type: "meeting-transcript",
      sessionId: "s",
      transcriptId: "t",
      confirmed: [],
    };
    expect(
      parseMeetingTranscriptEvent({ ...base, pending: [{ text: "no id" }] }),
    ).toBeNull();
    expect(
      parseMeetingTranscriptEvent({ ...base, pending: [{ id: "a" }] }),
    ).toBeNull();
    expect(
      parseMeetingTranscriptEvent({ ...base, pending: [null] }),
    ).toBeNull();
    // A non-string text field fails the same guard.
    expect(
      parseMeetingTranscriptEvent({
        ...base,
        pending: [{ id: "a", text: 7 }],
      }),
    ).toBeNull();
  });
});

describe("parseMeetingStatusEvent guard", () => {
  const SESSION = {
    id: "sess-9",
    platform: "zoom",
    meetingUrl: "https://zoom.example/j/123",
    nativeMeetingId: "123",
    botName: "Eliza",
    status: "active",
    requestedAt: 1756000000000,
    participants: [],
  };

  it("narrows a well-formed envelope, passing the session through unchanged", () => {
    const event = parseMeetingStatusEvent({
      type: "meeting-status",
      session: SESSION,
    });

    expect(event).toEqual({ type: "meeting-status", session: SESSION });
  });

  it("returns null for a wrong or missing type", () => {
    expect(parseMeetingStatusEvent({ session: SESSION })).toBeNull();
    expect(
      parseMeetingStatusEvent({ type: "meeting-transcript", session: SESSION }),
    ).toBeNull();
  });

  it("returns null when session is missing, null, or not an object", () => {
    expect(parseMeetingStatusEvent({ type: "meeting-status" })).toBeNull();
    expect(
      parseMeetingStatusEvent({ type: "meeting-status", session: null }),
    ).toBeNull();
    expect(
      parseMeetingStatusEvent({ type: "meeting-status", session: "sess-9" }),
    ).toBeNull();
  });

  it("returns null only when session.id is absent — an empty-string id still passes", () => {
    expect(
      parseMeetingStatusEvent({ type: "meeting-status", session: {} }),
    ).toBeNull();
    // Observed boundary: the guard rejects undefined ids, not falsy ones.
    expect(
      parseMeetingStatusEvent({ type: "meeting-status", session: { id: "" } }),
    ).toEqual({ type: "meeting-status", session: { id: "" } });
  });
});
