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

  it("reserves the meeting synchronously so concurrent same-URL joins launch ONE bot (MJ-4 TOCTOU)", async () => {
    const { service, adapters } = makeService();
    // Fire two joins for the SAME meeting concurrently. The reservation is
    // taken synchronously before the first await, so exactly one wins and the
    // other is rejected with `already_joined` — no double bot.
    const results = await Promise.allSettled([
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
      service.requestJoin({
        platform: "google_meet",
        meetingUrl: "https://meet.google.com/abcdefghij",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "already_joined",
    });
    // Only one live session and one bot was actually launched.
    expect(service.listSessions({ active: true })).toHaveLength(1);
    await adapters[0].started;
    expect(adapters[0].session).not.toBeNull();
  });

  it("releases the reservation when join setup throws, so a retry succeeds (BL-5)", async () => {
    const { fake, service } = makeService();
    // Make the transcript writer's initial row write (createMemory) fail once.
    const realCreateMemory = fake.runtime.createMemory.bind(fake.runtime);
    let calls = 0;
    (
      fake.runtime as {
        createMemory: (m: unknown, t: string) => Promise<unknown>;
      }
    ).createMemory = async (memory, table) => {
      calls += 1;
      if (calls === 1) throw new Error("db write failed");
      return realCreateMemory(memory as never, table);
    };

    await expect(
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
    ).rejects.toThrow("db write failed");
    // The failed session did NOT strand a non-terminal reservation.
    expect(service.listSessions()).toHaveLength(0);

    // A second join for the same meeting is no longer blocked by `already_joined`.
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    expect(dto.status).toBe("requested");
    expect(service.listSessions({ active: true })).toHaveLength(1);
    expect(calls).toBe(2);
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

  it("evicts the finished session to a lightweight terminal record but keeps it readable (BL-4)", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { service, pipelines } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await adapter.started;
    adapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));

    // Terminal status still readable (routes/actions read status + history)…
    const session = service.getSession(dto.id as never);
    expect(session?.status).toBe("ended");
    expect(session?.endReason).toBe("normal_completion");
    // …and it still appears in the full (non-active) listing.
    expect(service.listSessions().map((s) => s.id)).toContain(dto.id);
    expect(service.listSessions({ active: true })).toHaveLength(0);

    // The heavy pipeline (which accumulates session PCM) was finalized and its
    // audio buffers released — the pipeline is no longer referenced by the map.
    expect(pipelines[0].finalized).toBe(true);
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

  it("keeps confirmedSegments when pipeline.finalize throws (fallback, not empty)", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service, pipelines } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await adapter.started;
    // A confirmed segment arrived live, then finalize blows up: the writer must
    // persist the fallback (already-confirmed) segments, not an empty transcript.
    const s1 = segment("s1", "Speaker 1", "partial but real", 0, 1_000);
    pipelines[0].emit({ confirmed: [s1], pending: [] });
    pipelines[0].finalizeError = new Error("asr backend gone");
    adapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));

    const session = service.getSession(dto.id as never);
    expect(session?.status).toBe("failed");
    const row = fake.memories.get(dto.transcriptId as string);
    const transcript = row ? readTranscriptRow(row) : null;
    expect(transcript?.segments).toHaveLength(1);
    expect(transcript?.segments[0].text).toBe("partial but real");
  });

  it("fails the session when transcript finalize (row write) throws", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await adapter.started;
    // Make the finalize row-update fail (writer throws "row vanished").
    (
      fake.runtime as { updateMemory: (p: unknown) => Promise<boolean> }
    ).updateMemory = async () => false;
    adapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));
    const session = service.getSession(dto.id as never);
    expect(session?.status).toBe("failed");
    expect(session?.endReason).toBe("error");
    expect(session?.errorMessage).toContain("vanished");
  });

  it("resets worldReady after a transient ensureWorld failure so a later join succeeds", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service } = makeService([adapter]);
    let calls = 0;
    (
      fake.runtime as { ensureWorldExists: (w: unknown) => Promise<void> }
    ).ensureWorldExists = async (world) => {
      calls += 1;
      if (calls === 1) throw new Error("db down");
      fake.worlds.push(world as Record<string, unknown>);
    };

    await expect(
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
    ).rejects.toThrow("db down");
    expect(fake.worlds).toHaveLength(0);

    // worldReady was reset on the rejection — a second join now succeeds.
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    expect(dto.status).toBe("requested");
    expect(fake.worlds).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("stop() aborts active sessions and awaits their done promise", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { service } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    const botSession = await adapter.started;
    adapter.report("active");
    expect(botSession.signal.aborted).toBe(false);

    // The adapter resolves once it observes the abort (graceful leave).
    botSession.signal.addEventListener("abort", () =>
      adapter.end("requested_stop"),
    );
    await service.stop();
    expect(botSession.signal.aborted).toBe(true);
    // stop() awaited done → the session reached a terminal state.
    const session = service.getSession(dto.id as never);
    expect(["ended", "failed"]).toContain(session?.status);
  });

  it("runs concurrent joins of DIFFERENT meetings independently", async () => {
    const meet = new ScriptedAdapter("google_meet");
    const zoom = new ScriptedAdapter("zoom");
    const { service, pipelines } = makeService([meet, zoom]);
    const [a, b] = await Promise.all([
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
      service.requestJoin({
        platform: "zoom",
        meetingUrl: "https://zoom.us/j/1234567890",
      }),
    ]);
    await Promise.all([meet.started, zoom.started]);
    expect(a.id).not.toBe(b.id);
    // Both sessions active + each got its own pipeline instance.
    expect(service.listSessions({ active: true })).toHaveLength(2);
    expect(pipelines).toHaveLength(2);

    // Ending one leaves the other running.
    meet.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));
    const active = service.listSessions({ active: true });
    expect(active).toHaveLength(1);
    expect(active[0].platform).toBe("zoom");
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
