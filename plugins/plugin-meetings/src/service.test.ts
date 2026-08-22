/**
 * MeetingService orchestration — join validation, the session state machine,
 * single-bot-per-meeting enforcement, roster, transcript persistence, and
 * listing. Deterministic: fake runtime plus scripted adapter/pipeline.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMeetingArtifactFixtures,
  DEFAULT_MEETING_MAX_DURATION_MS,
  MEETING_TRANSCRIPT_FINALIZED_EVENT,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { MeetingJoinError, MeetingService } from "./service.js";
import {
  FakeMeetingBillingSession,
  makeFakeRuntime,
  ScriptedAdapter,
  scriptedDeps,
  segment,
} from "./test-support.js";
import { readTranscriptRow } from "./transcripts/meeting-transcript-writer.js";

const MEET_URL = "https://meet.google.com/abc-defg-hij";

function makeService(
  adapters: ScriptedAdapter[] = [new ScriptedAdapter("google_meet")],
  billingSessions: FakeMeetingBillingSession[] = [],
) {
  const fake = makeFakeRuntime();
  const { deps, pipelines, pipelineOptions } = scriptedDeps(
    adapters,
    billingSessions,
  );
  const service = new MeetingService(fake.runtime, deps);
  return { fake, service, pipelines, pipelineOptions, adapters };
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

  it("fails closed on organization-managed runtimes before media setup", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service, pipelines } = makeService([adapter]);
    fake.settings.ELIZAOS_CLOUD_ORG_ID = "org-policy-managed";

    await expect(
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
    ).rejects.toMatchObject({ code: "policy_blocked" });
    expect(pipelines).toHaveLength(0);
    expect(adapter.session).toBeNull();
    expect(fake.memories.size).toBe(0);
  });

  it("honors explicit allow and deny capture policy decisions", async () => {
    const deniedAdapter = new ScriptedAdapter("google_meet");
    const {
      fake: deniedFake,
      service: deniedService,
      pipelines: deniedPipelines,
    } = makeService([deniedAdapter]);
    deniedFake.settings.ELIZA_MEETINGS_CAPTURE_POLICY = "deny";
    await expect(
      deniedService.requestJoin({
        platform: "google_meet",
        meetingUrl: MEET_URL,
      }),
    ).rejects.toMatchObject({ code: "policy_blocked" });
    expect(deniedPipelines).toHaveLength(0);
    expect(deniedAdapter.session).toBeNull();

    const allowedAdapter = new ScriptedAdapter("google_meet");
    const { fake: allowedFake, service: allowedService } = makeService([
      allowedAdapter,
    ]);
    allowedFake.settings.ELIZAOS_CLOUD_ORG_ID = "org-policy-managed";
    allowedFake.settings.ELIZA_MEETINGS_CAPTURE_POLICY = "allow";
    const session = await allowedService.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    expect(session.status).toBe("requested");
    await allowedAdapter.started;
    expect(allowedAdapter.session).not.toBeNull();
  });

  it("does not treat an explicitly disabled cloud runtime as organization-managed", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service } = makeService([adapter]);
    fake.settings.ELIZAOS_CLOUD_ENABLED = "false";

    const session = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    expect(session.status).toBe("requested");
    await adapter.started;
    expect(adapter.session).not.toBeNull();
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

  it("keeps the same-URL reservation atomic while initial billing awaits", async () => {
    const firstBilling = new FakeMeetingBillingSession();
    const unusedBilling = new FakeMeetingBillingSession();
    const { service, adapters } = makeService(undefined, [
      firstBilling,
      unusedBilling,
    ]);

    const results = await Promise.allSettled([
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
      service.requestJoin({
        platform: "google_meet",
        meetingUrl: "https://meet.google.com/abcdefghij",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "already_joined" });
    expect(service.listSessions({ active: true })).toHaveLength(1);
    expect(firstBilling.reserveInitialCalls).toBe(1);
    expect(unusedBilling.reserveInitialCalls).toBe(0);
    await adapters[0].started;
    expect(adapters[0].session).not.toBeNull();
  });

  it("releases a failed initial billing reservation so the same URL can retry", async () => {
    const failedBilling = new FakeMeetingBillingSession();
    failedBilling.initialReserveError = new Error(
      "billing provider unavailable",
    );
    const retryBilling = new FakeMeetingBillingSession();
    const { service } = makeService(undefined, [failedBilling, retryBilling]);

    await expect(
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
    ).rejects.toThrow("billing provider unavailable");
    expect(service.listSessions({ active: true })).toHaveLength(0);
    expect(failedBilling.reserveInitialCalls).toBe(1);
    expect(failedBilling.reconcileCalls).toEqual(["error"]);

    const retried = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abcdefghij",
    });
    expect(retried.status).toBe("requested");
    expect(service.listSessions({ active: true })).toHaveLength(1);
    expect(retryBilling.reserveInitialCalls).toBe(1);
  });

  it("preserves both setup and billing-release failures", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const billing = new FakeMeetingBillingSession();
    const reserveFailure = new Error("billing provider unavailable");
    const releaseFailure = new Error("billing release unavailable");
    billing.initialReserveError = reserveFailure;
    billing.reconcileError = releaseFailure;
    const { service } = makeService([adapter], [billing]);

    const failure = await service
      .requestJoin({ platform: "google_meet", meetingUrl: MEET_URL })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      reserveFailure,
      releaseFailure,
    ]);
    expect(service.listSessions()).toHaveLength(0);
    expect(adapter.session).toBeNull();
    expect(billing.reconcileCalls).toEqual(["error"]);
  });

  it("releases the reservation when join setup throws, so a retry succeeds (BL-5)", async () => {
    const billing = new FakeMeetingBillingSession();
    const retryBilling = new FakeMeetingBillingSession();
    const { fake, service } = makeService(undefined, [billing, retryBilling]);
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
    expect(billing.reconcileCalls).toEqual(["error"]);

    // Because the reservation rolled back, a second join for the same meeting
    // is not blocked by `already_joined`.
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    expect(dto.status).toBe("requested");
    expect(service.listSessions({ active: true })).toHaveLength(1);
    expect(calls).toBe(2);
    expect(retryBilling.reconcileCalls).toEqual([]);
  });

  it("rejects requested duration caps above the configured maximum before launch", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service } = makeService([adapter]);
    fake.settings.ELIZA_MEETINGS_MAX_DURATION_MS = "1000";

    await expect(
      service.requestJoin({
        platform: "google_meet",
        meetingUrl: MEET_URL,
        maxDurationMs: 1001,
      }),
    ).rejects.toMatchObject({ code: "invalid_duration_cap" });
    expect(service.listSessions()).toHaveLength(0);
    expect(adapter.session).toBeNull();
  });

  it("uses the production default 60-minute cap and accepts lower requested caps", async () => {
    const { service } = makeService();

    const defaulted = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    expect(defaulted.maxDurationMs).toBe(60 * 60 * 1000);
    expect(defaulted.maxDurationMs).toBe(DEFAULT_MEETING_MAX_DURATION_MS);

    const lower = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/aaa-bbbb-ccc",
      maxDurationMs: 15 * 60 * 1000,
    });
    expect(lower.maxDurationMs).toBe(15 * 60 * 1000);
  });

  it("uses only strict decimal integers for the configured duration cap", async () => {
    const hexAdapter = new ScriptedAdapter("google_meet");
    const { fake: hexFake, service: hexService } = makeService([hexAdapter]);
    hexFake.settings.ELIZA_MEETINGS_MAX_DURATION_MS = "0x10";

    const hexDto = await hexService.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
      maxDurationMs: 17,
    });
    expect(hexDto.maxDurationMs).toBe(17);
    expect(hexAdapter.session).not.toBeNull();
    await hexAdapter.started;
    hexAdapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));
    expect(hexService.getSession(hexDto.id as never)?.status).toBe("ended");

    const decimalAdapter = new ScriptedAdapter("google_meet");
    const { fake: decimalFake, service: decimalService } = makeService([
      decimalAdapter,
    ]);
    decimalFake.settings.ELIZA_MEETINGS_MAX_DURATION_MS = "1000";

    await expect(
      decimalService.requestJoin({
        platform: "google_meet",
        meetingUrl: MEET_URL,
        maxDurationMs: 1001,
      }),
    ).rejects.toMatchObject({ code: "invalid_duration_cap" });
    expect(decimalAdapter.session).toBeNull();
  });

  it("fails closed before bot launch when initial credit reservation is insufficient", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const billing = new FakeMeetingBillingSession();
    billing.initialReserveError = Object.assign(
      new Error("not enough credits to start meeting transcription"),
      { code: "insufficient_credits" },
    );
    const { service } = makeService([adapter], [billing]);

    await expect(
      service.requestJoin({ platform: "google_meet", meetingUrl: MEET_URL }),
    ).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(adapter.session).toBeNull();
    expect(service.listSessions()).toHaveLength(0);
    expect(billing.reserveInitialCalls).toBe(1);
    expect(billing.reconcileCalls).toEqual(["error"]);
  });
});

describe("MeetingService.importZoomMeeting", () => {
  it("persists imported canonical spans and never stores the OAuth token", async () => {
    const fake = makeFakeRuntime();
    const { deps } = scriptedDeps([]);
    const artifact = buildMeetingArtifactFixtures().zoomPerParticipant;
    if (!artifact) throw new Error("Expected Zoom artifact fixture");
    let receivedToken = "";
    deps.importZoomCloudMeeting = async (input) => {
      receivedToken = input.accessToken;
      return {
        artifact,
        warnings: ["fixture-warning"],
        requestIds: ["zoom-request-1"],
      };
    };
    const service = new MeetingService(fake.runtime, deps);

    const result = await service.importZoomMeeting({
      meetingId: "123456789",
      accessToken: "private-zoom-token",
    });

    expect(receivedToken).toBe("private-zoom-token");
    expect(result.transcript.status).toBe("ready");
    expect(result.transcript.segments).toHaveLength(1);
    expect(result.transcript.metadata).toMatchObject({
      capture: { mode: "platform_import" },
      meetingArtifact: { schemaVersion: "eliza.meeting_artifact.v1" },
      zoomImport: {
        warnings: ["fixture-warning"],
        requestIds: ["zoom-request-1"],
      },
    });
    expect(JSON.stringify([...fake.memories.values()])).not.toContain(
      "private-zoom-token",
    );
    expect(fake.documents).toHaveLength(1);
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

  it("exposes billing state and reconciles it exactly once at normal finish", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const billing = new FakeMeetingBillingSession({ reservedMs: 30_000 });
    const { service } = makeService([adapter], [billing]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    expect(dto.billing).toMatchObject({
      status: "reserved",
      reservedMs: 30_000,
      consumedMs: 0,
    });

    await adapter.started;
    adapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));

    const session = service.getSession(dto.id as never);
    expect(session?.billing).toMatchObject({
      status: "reconciled",
      reservedMs: 30_000,
    });
    expect(billing.reconcileCalls).toEqual(["normal_completion"]);
    expect(service.stopSession(dto.id as never)).toBe(false);
    expect(billing.reconcileCalls).toHaveLength(1);
  });

  it("evicts the finished session to a lightweight terminal record but keeps it readable (BL-4)", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { service, pipelines } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
    });
    await adapter.started;
    expect(service.pendingSessionWorkCount()).toBe(1);
    adapter.end("normal_completion");
    const terminal = await service.waitForSessionTerminal(dto.id as never);

    // Terminal status still readable (routes/actions read status + history)…
    expect(terminal?.status).toBe("ended");
    expect(terminal?.endReason).toBe("normal_completion");
    expect(service.pendingSessionWorkCount()).toBe(0);
    await expect(
      service.waitForSessionTerminal(dto.id as never),
    ).resolves.toEqual(terminal);
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

  it("stops and finalizes the session when the duration cap is reached", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new ScriptedAdapter("google_meet");
      const { service, pipelines } = makeService([adapter]);
      const dto = await service.requestJoin({
        platform: "google_meet",
        meetingUrl: MEET_URL,
        maxDurationMs: 25,
      });
      const botSession = await adapter.started;
      adapter.report("active");
      expect(botSession.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(25);

      const session = service.getSession(dto.id as never);
      expect(botSession.signal.aborted).toBe(true);
      expect(session?.status).toBe("ended");
      expect(session?.endReason).toBe("duration_cap_reached");
      expect(pipelines[0].finalized).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the duration-cap reason when the adapter resolves on abort", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new ScriptedAdapter("google_meet");
      const { service } = makeService([adapter]);
      const dto = await service.requestJoin({
        platform: "google_meet",
        meetingUrl: MEET_URL,
        maxDurationMs: 25,
      });
      const botSession = await adapter.started;
      botSession.signal.addEventListener(
        "abort",
        () => adapter.end("requested_stop"),
        { once: true },
      );

      await vi.advanceTimersByTimeAsync(25);

      const session = service.getSession(dto.id as never);
      expect(session?.status).toBe("ended");
      expect(session?.endReason).toBe("duration_cap_reached");
    } finally {
      vi.useRealTimers();
    }
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
  it("passes calendar attendees into the speaker-name policy input", async () => {
    const { service, pipelineOptions } = makeService();
    await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
      calendarEventId: "event-123",
      ghostAttendance: {
        ownerUserId: "owner-1",
        ownerDisplayName: "Shaw",
        careAbouts: [],
        attendees: [
          { name: "Alice Chen", email: "alice@example.com" },
          { name: "Bob Jones", email: "bob@example.com" },
        ],
      },
    });

    expect(pipelineOptions[0]?.calendarSpeakerEvidence).toEqual([
      {
        source: "calendar_attendee",
        name: "Alice Chen",
        confidence: 0.82,
        evidenceId: "event-123",
      },
      {
        source: "calendar_attendee",
        name: "Bob Jones",
        confidence: 0.82,
        evidenceId: "event-123",
      },
    ]);
  });

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
    expect(transcript).not.toBeNull();
    if (!transcript) throw new Error("Expected a finalized transcript");
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
    const participants = transcript.metadata?.participants as
      | Array<{ displayName: string }>
      | undefined;
    if (!participants) throw new Error("Expected transcript participants");
    const participant = participants[0];
    if (!participant) throw new Error("Expected a transcript participant");
    expect(participant.displayName).toBe("Jill");
    // Knowledge mirror landed with the transcript tag + clientDocumentId link.
    expect(fake.documents).toHaveLength(1);
    expect(fake.documents[0].clientDocumentId).toBe(dto.transcriptId);
    expect((fake.documents[0].metadata as { tags: string[] }).tags).toContain(
      "transcript",
    );
  });

  it("persists real Zoom bot capture as a shared canonical artifact", async () => {
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), "eliza-zoom-bot-artifact-"));
    process.env.ELIZA_STATE_DIR = stateDir;
    try {
      const adapter = new ScriptedAdapter("zoom");
      const { fake, service, pipelines } = makeService([adapter]);
      const dto = await service.requestJoin({
        platform: "zoom",
        meetingUrl: "https://zoom.us/j/1234567890",
      });
      const botSession = await adapter.started;
      botSession.sink.participantJoined({
        id: "zoom-alice",
        displayName: "Alice",
      });
      const speech = segment(
        "zoom-span-1",
        "Alice",
        "Hello from Zoom.",
        0,
        1_000,
      );
      pipelines[0].finalSegments = [speech];
      pipelines[0].audioWav = Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]);

      adapter.end("normal_completion");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const row = fake.memories.get(dto.transcriptId as string);
      const transcript = row ? readTranscriptRow(row) : null;
      if (!transcript) throw new Error("Expected a finalized Zoom transcript");
      expect(transcript.audioUrl).toMatch(/^\/api\/media\/[a-f0-9]{64}\.wav$/);
      expect(transcript.metadata?.meetingArtifact).toMatchObject({
        schemaVersion: "eliza.meeting_artifact.v1",
        meeting: {
          id: "1234567890",
          platform: "zoom",
          captureMode: "platform_bot",
        },
        sourceStreams: [
          expect.objectContaining({
            label: expect.stringContaining("mixed_audio_only"),
          }),
        ],
        transcriptSpans: [
          expect.objectContaining({
            id: "zoom-span-1",
            platformParticipantId: "zoom-alice",
          }),
        ],
      });
      expect(transcript.metadata?.zoomCapture).toMatchObject({
        capturePath: "bot_web_client",
        sourceLoss: ["mixed_audio_only", "per_participant_audio_unavailable"],
      });
    } finally {
      if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("emits the finalized transcript event with ghost-attendance context", async () => {
    const adapter = new ScriptedAdapter("google_meet");
    const { fake, service, pipelines } = makeService([adapter]);
    const dto = await service.requestJoin({
      platform: "google_meet",
      meetingUrl: MEET_URL,
      ghostAttendance: {
        ownerUserId: "owner-1",
        ownerDisplayName: "Shaw",
        requestedBy: "owner-1",
        careAbouts: ["launch date"],
        calendarId: "primary",
        attendees: [{ name: "Ava", email: "ava@example.com" }],
      },
    });
    await adapter.started;

    pipelines[0].finalSegments = [
      segment(
        "s1",
        "Ava",
        "Ava will send the launch-date rollback plan by Friday.",
        0,
        2_000,
      ),
    ];
    pipelines[0].audioWav = null;

    adapter.end("normal_completion");
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.events).toHaveLength(1);
    expect(fake.events[0].event).toBe(MEETING_TRANSCRIPT_FINALIZED_EVENT);
    expect(fake.events[0].payload).toMatchObject({
      source: "plugin-meetings",
      session: {
        id: dto.id,
        status: "ended",
        transcriptId: dto.transcriptId,
      },
      transcript: {
        id: dto.transcriptId,
        status: "ready",
        segments: [
          expect.objectContaining({
            speakerLabel: "Ava",
            text: "Ava will send the launch-date rollback plan by Friday.",
          }),
        ],
      },
      ghostAttendance: {
        ownerUserId: "owner-1",
        careAbouts: ["launch date"],
        attendees: [{ name: "Ava", email: "ava@example.com" }],
      },
    });
    expect(fake.reportedErrors).toHaveLength(0);
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
