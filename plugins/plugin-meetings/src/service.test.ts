import { describe, expect, it } from "vitest";
import { MeetingJoinError, MeetingService } from "./service.js";
import {
  makeFakeRuntime,
  ScriptedAdapter,
  scriptedDeps,
  segment,
} from "./test-support.js";
import { readTranscriptRow } from "./transcripts/meeting-transcript-writer.js";

const MEET_URL = "https://meet.google.com/abc-defg-hij";

function makeService(
  adapters: ScriptedAdapter[] = [new ScriptedAdapter("google_meet")],
) {
  const fake = makeFakeRuntime();
  const { deps, pipelines } = scriptedDeps(adapters);
  const service = new MeetingService(fake.runtime, deps);
  return { fake, service, pipelines, adapters };
}

describe("MeetingService.requestJoin — validation", () => {
  it("rejects unrecognizable URLs", async () => {
    const { service } = makeService();
    await expect(
      service.requestJoin({
        platform: "google_meet",
        meetingUrl: "https://example.com/not-a-meeting",
      }),
    ).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("rejects discord with a clear unsupported error", async () => {
    const { service } = makeService();
    await expect(
      service.requestJoin({ platform: "discord", meetingUrl: MEET_URL }),
    ).rejects.toMatchObject({ code: "unsupported_platform" });
  });

  it("rejects platforms with no adapter wired", async () => {
    const { service } = makeService([new ScriptedAdapter("zoom")]);
    await expect(
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
    ).rejects.toBeInstanceOf(MeetingJoinError);
  });

  it("enforces single-bot-per-meeting across URL spellings", async () => {
    const { service } = makeService();
    await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await expect(
      // Same meeting, dashes stripped — canonicalized to the same native id.
      service.requestJoin({
        platform: "google_meet",
        meetingUrl: "https://meet.google.com/abcdefghij",
      }),
    ).rejects.toMatchObject({ code: "already_joined" });
  });
});

describe("MeetingService — session state machine", () => {
  it("walks join → admission → active → ended with adapter-reported statuses", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    expect(dto.status).toBe("requested");
    expect(dto.nativeMeetingId).toBe("abc-defg-hij");
    expect(dto.botName).toBe("Eliza Notetaker");

    await adapter.started;
    adapter.report("joining");
    adapter.report("awaiting_admission");
    adapter.report("active");
    let session = service.getSession(dto.id as never);
    expect(session?.status).toBe("active");
    expect(session?.activeAt).toBeTypeOf("number");

    adapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));
    session = service.getSession(dto.id as never);
    expect(session?.status).toBe("ended");
    expect(session?.endReason).toBe("normal_completion");
    expect(session?.endedAt).toBeTypeOf("number");

    // Room created (source = platform) in the reused Meetings world.
    expect(fake.rooms).toHaveLength(1);
    expect(fake.rooms[0].source).toBe("google_meet");
    expect(fake.worlds).toHaveLength(1);
    expect(fake.rooms[0].worldId).toBe(fake.worlds[0].id);

    // Status transitions were fanned out over the WS seam.
    const statuses = fake.broadcasts
      .filter((b) => (b as { type?: string }).type === "meeting-status")
      .map((b) => (b as { session: { status: string } }).session.status);
    expect(statuses).toEqual([
      "requested",
      "joining",
      "awaiting_admission",
      "active",
      "ended",
    ]);
  });

  it("maps an adapter throw to failed + errorMessage (never swallowed)", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { service } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await adapter.started;
    adapter.fail(new Error("chromium exploded"));
    await new Promise((r) => setTimeout(r, 10));
    const session = service.getSession(dto.id as never);
    expect(session?.status).toBe("failed");
    expect(session?.endReason).toBe("error");
    expect(session?.errorMessage).toBe("chromium exploded");
  });

  it("stopSession aborts the adapter signal and ends with requested_stop", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { service } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    const botSession = await adapter.started;
    adapter.report("active");
    expect(botSession.signal.aborted).toBe(false);

    expect(service.stopSession(dto.id as never)).toBe(true);
    expect(botSession.signal.aborted).toBe(true);
    expect(service.getSession(dto.id as never)?.status).toBe("leaving");

    adapter.end("requested_stop");
    await new Promise((r) => setTimeout(r, 10));
    expect(service.getSession(dto.id as never)?.status).toBe("ended");
    expect(service.getSession(dto.id as never)?.endReason).toBe(
      "requested_stop",
    );
    // Unknown / already-terminal sessions return false.
    expect(service.stopSession(dto.id as never)).toBe(false);
    expect(service.stopSession(crypto.randomUUID() as never)).toBe(false);
  });

  it("ignores adapter status reports after a terminal state", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { service } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await adapter.started;
    adapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));
    adapter.report("active");
    expect(service.getSession(dto.id as never)?.status).toBe("ended");
  });
});

describe("MeetingService — roster, transcripts, listing", () => {
  it("wires participants to entities and tracks join/leave", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service, pipelines } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    const botSession = await adapter.started;
    botSession.sink.participantJoined({ id: "p1", displayName: "Jill" });
    botSession.sink.participantLeft("p1", 45_000);
    await new Promise((r) => setTimeout(r, 5));

    const session = service.getSession(dto.id as never);
    expect(session?.participants).toHaveLength(1);
    expect(session?.participants[0].displayName).toBe("Jill");
    expect(session?.participants[0].entityId).toBeTypeOf("string");
    expect(session?.participants[0].leftAtMs).toBe(45_000);
    expect(fake.entities).toHaveLength(1);
    expect(fake.entities[0].names).toEqual(["Jill"]);
    // Roster observations still reach the pipeline.
    expect(pipelines[0].joined).toHaveLength(1);
    expect(pipelines[0].left).toEqual([{ participantId: "p1", atMs: 45_000 }]);
  });

  it("persists pipeline updates + finalizes a ready transcript with metadata", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service, pipelines } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    const botSession = await adapter.started;
    botSession.sink.participantJoined({ id: "p1", displayName: "Jill" });

    const s1 = segment("s1", "Jill", "hello world", 0, 2_000);
    pipelines[0].emit({ confirmed: [s1], pending: [] });
    pipelines[0].finalSegments = [s1];
    pipelines[0].audioWav = null;

    adapter.end("left_alone_timeout");
    await new Promise((r) => setTimeout(r, 10));

    const row = fake.memories.get(dto.transcriptId as string);
    expect(row).toBeTruthy();
    expect(fake.tables.get(dto.transcriptId as string)).toBe("transcripts");
    const transcript = row ? readTranscriptRow(row) : null;
    expect(transcript?.status).toBe("ready");
    expect(transcript?.source).toBe("meeting");
    expect(transcript?.segments).toHaveLength(1);
    expect(transcript?.speakerCount).toBe(1);
    expect(transcript?.durationMs).toBe(2_000);
    expect(transcript?.metadata).toMatchObject({
      platform: "google_meet",
      meetingUrl: MEET_URL,
      nativeMeetingId: "abc-defg-hij",
      sessionId: dto.id,
    });
    expect(
      (transcript?.metadata?.participants as Array<{ displayName: string }>)[0]
        .displayName,
    ).toBe("Jill");
    // Knowledge mirror landed with the transcript tag + clientDocumentId link.
    expect(fake.documents).toHaveLength(1);
    expect(fake.documents[0].clientDocumentId).toBe(dto.transcriptId);
    expect((fake.documents[0].metadata as { tags: string[] }).tags).toContain(
      "transcript",
    );
  });

  it("fails the session when pipeline finalize throws", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { service, pipelines } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await adapter.started;
    pipelines[0].finalizeError = new Error("asr backend gone");
    adapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));
    const session = service.getSession(dto.id as never);
    expect(session?.status).toBe("failed");
    expect(session?.errorMessage).toBe("asr backend gone");
  });

  it("lists sessions newest-first and filters active", async () => {
    const meet = new ScriptedAdapter("google_meet");
    const zoom = new ScriptedAdapter("zoom");
    const { service } = makeService([meet, zoom]);
    const first = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await service.requestJoin({
      platform: "zoom",
      meetingUrl: "https://zoom.us/j/1234567890",
    });
    await meet.started;
    meet.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));

    expect(service.listSessions()).toHaveLength(2);
    const active = service.listSessions({ active: true });
    expect(active).toHaveLength(1);
    expect(active[0].platform).toBe("zoom");
    expect(service.listSessions().map((s) => s.id)).toContain(first.id);
  });
});
