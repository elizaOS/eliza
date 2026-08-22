/**
 * MeetingService — the orchestration layer of @elizaos/plugin-meetings.
 *
 * Owns the session state machine for every attended meeting: URL validation,
 * single-bot-per-meeting enforcement, room/world/entity wiring, pipeline +
 * platform-adapter lifecycles, transcript persistence (MeetingTranscriptWriter)
 * and live WebSocket fan-out (MeetingEventEmitter). Platform adapters and the
 * transcription pipeline are injected (see `MeetingServiceDependencies`) — the
 * concrete wiring lives in `src/index.ts` so this file stays independently
 * testable with scripted seams.
 */

import {
  ChannelType,
  createUniqueUuid,
  type EventPayload,
  type IAgentRuntime,
  logger,
  Service,
  type UUID,
} from "@elizaos/core";
import {
  DEFAULT_MEETING_AUTO_LEAVE,
  DEFAULT_MEETING_MAX_DURATION_MS,
  MEETING_PLATFORM_LABELS,
  MEETING_TRANSCRIPT_FINALIZED_EVENT,
  type MeetingArtifact,
  type MeetingAutoLeaveConfig,
  type MeetingBillingState,
  type MeetingEndReason,
  type MeetingGhostAttendanceContext,
  type MeetingJoinRequest,
  type MeetingParticipant,
  type MeetingPlatform,
  type MeetingSession,
  type MeetingSessionStatus,
  type MeetingTranscriptFinalizedPayload,
  meetingArtifactToTranscriptSegments,
  parseMeetingUrl,
  parsePositiveInteger,
} from "@elizaos/shared";
import type {
  Transcript,
  TranscriptSegment,
} from "@elizaos/shared/transcripts";
import { MeetingEventEmitter } from "./events.js";
import { resolveMeetingRuntimeSupport } from "./platform-support.js";
import {
  ZoomCloudImportError,
  type ZoomCloudImportInput,
  type ZoomCloudImportResult,
} from "./platforms/zoom/cloud-import.js";
import { buildZoomBotMeetingArtifact } from "./platforms/zoom/shared-artifact.js";
import {
  MeetingTranscriptWriter,
  persistMeetingMedia,
} from "./transcripts/meeting-transcript-writer.js";
import type {
  MeetingAudioSink,
  MeetingBillingError,
  MeetingBillingSession,
  MeetingBillingSessionInput,
  MeetingBotSession,
  MeetingPipelineOptions,
  MeetingPlatformAdapter,
  MeetingTranscriptionPipeline,
  ResolvedMeetingBotConfig,
} from "./types.js";

/** Pipeline instance plus the optional retained-audio accessor. */
export interface MeetingPipelineInstance extends MeetingTranscriptionPipeline {
  /** Full session audio as mono PCM16 WAV, when `retainAudio` was set. */
  sessionAudioWav?(): Buffer | null;
}

/** Concrete adapter + pipeline wiring, injected by `src/index.ts` (or tests). */
export interface MeetingServiceDependencies {
  adapters: ReadonlyMap<MeetingPlatform, MeetingPlatformAdapter>;
  createPipeline(options: MeetingPipelineOptions): MeetingPipelineInstance;
  createBillingSession?(
    input: MeetingBillingSessionInput,
  ): MeetingBillingSession | null;
  importZoomCloudMeeting?(
    input: ZoomCloudImportInput,
  ): Promise<ZoomCloudImportResult>;
}

export interface ZoomMeetingImportRequest {
  meetingId: string;
  accessToken?: string;
  retainRecordings?: boolean;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface ZoomMeetingImportResult {
  artifact: MeetingArtifact;
  transcript: Transcript;
  warnings: string[];
  requestIds: string[];
}

export type MeetingJoinErrorCode =
  | "invalid_url"
  | "unsupported_platform"
  | "unsupported_host"
  | "policy_blocked"
  | "already_joined"
  | "invalid_duration_cap"
  | "insufficient_credits";

/** Validation/conflict failures of `requestJoin` — routes map these to 4xx. */
export class MeetingJoinError extends Error {
  constructor(
    readonly code: MeetingJoinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeetingJoinError";
  }
}

const TERMINAL_STATUSES: ReadonlySet<MeetingSessionStatus> = new Set([
  "ended",
  "failed",
]);

interface InternalSession {
  readonly id: UUID;
  readonly platform: MeetingPlatform;
  readonly meetingUrl: string;
  readonly nativeMeetingId: string;
  readonly botName: string;
  status: MeetingSessionStatus;
  endReason?: MeetingEndReason;
  errorMessage?: string;
  readonly requestedAt: number;
  activeAt?: number;
  endedAt?: number;
  roomId: UUID;
  transcriptId: UUID;
  participants: MeetingParticipant[];
  calendarEventId?: string;
  readonly maxDurationMs: number;
  readonly abort: AbortController;
  readonly pipeline: MeetingPipelineInstance;
  readonly writer: MeetingTranscriptWriter;
  readonly billing?: MeetingBillingSession;
  readonly ghostAttendance?: MeetingGhostAttendanceContext;
  billingFinalized?: Promise<void>;
  /** Confirmed segments accumulated from pipeline updates (live view state). */
  confirmedSegments: TranscriptSegment[];
  /** Resolves when the adapter lifecycle + finalize have fully completed. */
  done: Promise<void>;
}

export class MeetingService extends Service {
  static serviceType = "meetings";
  capabilityDescription =
    "Joins Google Meet / Microsoft Teams / Zoom meetings as a notetaker bot and produces live, diarized transcripts";

  /**
   * Default concrete wiring, assigned at module load by `src/index.ts` (which
   * imports the real platform adapters + pipeline). Tests inject their own
   * dependencies through the constructor instead.
   */
  static dependencyFactory:
    | ((runtime: IAgentRuntime) => MeetingServiceDependencies)
    | null = null;
  private static readonly runtimeDependencyFactories = new WeakMap<
    IAgentRuntime,
    (runtime: IAgentRuntime) => MeetingServiceDependencies
  >();

  /** Install a dependency override for exactly one runtime, primarily for scenario boundaries. */
  static setRuntimeDependencyFactory(
    runtime: IAgentRuntime,
    factory: (runtime: IAgentRuntime) => MeetingServiceDependencies,
  ): void {
    MeetingService.runtimeDependencyFactories.set(runtime, factory);
  }

  /** Remove a runtime-scoped override without changing production defaults or other runtimes. */
  static clearRuntimeDependencyFactory(runtime: IAgentRuntime): void {
    MeetingService.runtimeDependencyFactories.delete(runtime);
  }

  private readonly sessions = new Map<UUID, InternalSession>();
  /**
   * Lightweight terminal snapshots. Once a session finishes it is evicted from
   * `sessions` (dropping its pipeline/writer/audio-buffer references so the
   * accumulated PCM can be GC'd) and only its DTO is retained here for
   * status/history reads by routes and actions.
   */
  private readonly terminated = new Map<UUID, MeetingSession>();
  private readonly emitter: MeetingEventEmitter;
  private readonly deps: MeetingServiceDependencies;
  private worldReady: Promise<UUID> | null = null;

  constructor(runtime?: IAgentRuntime, deps?: MeetingServiceDependencies) {
    if (!runtime) {
      throw new Error("[MeetingService] runtime is required");
    }
    super(runtime);
    const resolved =
      deps ??
      MeetingService.runtimeDependencyFactories.get(runtime)?.(runtime) ??
      MeetingService.dependencyFactory?.(runtime);
    if (!resolved) {
      throw new Error(
        "[MeetingService] no dependencies wired — import the plugin entry (src/index.ts) or inject MeetingServiceDependencies",
      );
    }
    this.deps = resolved;
    this.emitter = new MeetingEventEmitter(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new MeetingService(runtime);
    logger.info("[MeetingService] started");
    return service;
  }

  async stop(): Promise<void> {
    const active = [...this.sessions.values()].filter(
      (s) => !TERMINAL_STATUSES.has(s.status),
    );
    for (const session of active) session.abort.abort();
    await Promise.allSettled(active.map((s) => s.done));
  }

  /** Start a bot for a meeting URL. Resolves once the session is launched. */
  async requestJoin(request: MeetingJoinRequest): Promise<MeetingSession> {
    const parsed = parseMeetingUrl(request.meetingUrl);
    if (!parsed) {
      throw new MeetingJoinError(
        "invalid_url",
        `"${request.meetingUrl}" is not a recognizable Google Meet, Microsoft Teams, or Zoom meeting link`,
      );
    }
    if (request.platform === "discord") {
      throw new MeetingJoinError(
        "unsupported_platform",
        "Discord meetings are voice channels handled by the Discord connector — the browser meeting bot cannot join them",
      );
    }
    const adapter = this.deps.adapters.get(parsed.platform);
    if (!adapter) {
      throw new MeetingJoinError(
        "unsupported_platform",
        `no platform adapter available for ${MEETING_PLATFORM_LABELS[parsed.platform]}`,
      );
    }

    // Refuse cleanly on hosts that cannot run a browser bot (mobile, or no
    // Chromium resolvable) instead of launching and crashing mid-join.
    const support = resolveMeetingRuntimeSupport(this.runtime);
    if (!support.supported) {
      throw new MeetingJoinError(
        "unsupported_host",
        support.reason ??
          "this host cannot run the meeting browser bot (no Chromium available)",
      );
    }

    this.assertCapturePolicyAllowsJoin();

    const duplicate = [...this.sessions.values()].find(
      (s) =>
        !TERMINAL_STATUSES.has(s.status) &&
        s.platform === parsed.platform &&
        s.nativeMeetingId === parsed.nativeMeetingId,
    );
    if (duplicate) {
      throw new MeetingJoinError(
        "already_joined",
        `a bot is already in this meeting (session ${duplicate.id}, status ${duplicate.status})`,
      );
    }

    // Reserve the meeting SYNCHRONOUSLY before the first await. The dup-check
    // above and this insert run in one uninterrupted turn, so two concurrent
    // same-URL joins cannot both slip past the check and launch two bots
    // (TOCTOU). Every construction here (pipeline, writer, room id) is
    // synchronous; the awaited world/room/writer setup follows with the session
    // already claimed. Any failure rolls the reservation back (see catch).
    const sessionId = crypto.randomUUID() as UUID;
    const roomId = createUniqueUuid(this.runtime, `meeting:${sessionId}`);
    const botName =
      request.botName?.trim() ||
      this.settingString("ELIZA_MEETINGS_BOT_NAME") ||
      `${this.runtime.character.name} Notetaker`;
    const autoLeave: MeetingAutoLeaveConfig = {
      ...DEFAULT_MEETING_AUTO_LEAVE,
      ...request.autoLeave,
    };
    const maxDurationMs = this.resolveMaxDurationMs(request.maxDurationMs);
    const retainAudio = request.retainAudio ?? true;
    const billing = this.deps.createBillingSession?.({
      runtime: this.runtime,
      sessionId,
      request,
      maxDurationMs,
    });

    const pipeline = this.deps.createPipeline({
      runtime: this.runtime,
      sessionId,
      language: request.language,
      retainAudio,
      ...(request.ghostAttendance?.attendees?.length
        ? {
            calendarSpeakerEvidence: request.ghostAttendance.attendees.map(
              (attendee, index) => ({
                source: "calendar_attendee" as const,
                name: attendee.name,
                confidence: 0.82,
                evidenceId:
                  request.calendarEventId ??
                  request.ghostAttendance?.calendarId ??
                  `meeting-calendar-attendee:${sessionId}:${index}`,
              }),
            ),
          }
        : {}),
      ...(billing ? { billing } : {}),
      onSpendCapReached: (error: MeetingBillingError) => {
        const live = this.sessions.get(sessionId);
        if (!live || TERMINAL_STATUSES.has(live.status)) return;
        live.endReason = "ended_due_to_spend_cap";
        live.errorMessage = error.message;
        this.applyStatus(live, "leaving");
        live.abort.abort();
      },
    });
    const writer = new MeetingTranscriptWriter(this.runtime);

    const session: InternalSession = {
      id: sessionId,
      platform: parsed.platform,
      meetingUrl: parsed.meetingUrl,
      nativeMeetingId: parsed.nativeMeetingId,
      botName,
      status: "requested",
      requestedAt: Date.now(),
      roomId,
      transcriptId: writer.transcriptId,
      participants: [],
      calendarEventId: request.calendarEventId,
      maxDurationMs,
      abort: new AbortController(),
      pipeline,
      writer,
      ...(billing ? { billing } : {}),
      ...(request.ghostAttendance
        ? { ghostAttendance: request.ghostAttendance }
        : {}),
      confirmedSegments: [],
      done: Promise.resolve(),
    };
    this.sessions.set(sessionId, session);

    // With the reservation held, do every awaited setup step, including the
    // initial billing hold. If any step throws, release the meeting claim and
    // reconcile the billing hold so future joins are not permanently rejected
    // with `already_joined` by a stranded non-terminal session.
    try {
      if (billing) await billing.reserveInitial();
      const worldId = await this.ensureMeetingsWorld();
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: `${MEETING_PLATFORM_LABELS[parsed.platform]} ${parsed.nativeMeetingId}`,
        source: parsed.platform,
        type: ChannelType.GROUP,
        channelId: parsed.nativeMeetingId,
        worldId,
        metadata: { meetingUrl: parsed.meetingUrl, sessionId },
      });
      await writer.start({
        sessionId,
        worldId,
        roomId,
        entityId: this.runtime.agentId,
        title: `${MEETING_PLATFORM_LABELS[parsed.platform]} meeting ${parsed.nativeMeetingId}`,
        platform: parsed.platform,
        meetingUrl: parsed.meetingUrl,
        nativeMeetingId: parsed.nativeMeetingId,
        consentState: "not_required",
      });
    } catch (err) {
      // error-policy:J2 setup and mandatory billing cleanup failures are
      // retained together so an uncertain credit hold cannot be reported as a
      // successfully released reservation.
      let billingReleaseFailure: unknown;
      try {
        await this.reconcileBillingOnce(session, "error");
      } catch (billingErr) {
        billingReleaseFailure = billingErr;
        logger.error(
          {
            sessionId,
            platform: parsed.platform,
            nativeMeetingId: parsed.nativeMeetingId,
            error:
              billingErr instanceof Error
                ? billingErr.message
                : String(billingErr),
          },
          "[MeetingService] join setup billing release failed",
        );
      }
      this.sessions.delete(sessionId);
      logger.error(
        {
          sessionId,
          platform: parsed.platform,
          nativeMeetingId: parsed.nativeMeetingId,
          error: err instanceof Error ? err.message : String(err),
        },
        "[MeetingService] join setup failed — meeting reservation released",
      );
      if (billingReleaseFailure !== undefined) {
        throw new AggregateError(
          [err, billingReleaseFailure],
          "Meeting join setup and billing release both failed",
        );
      }
      if (
        err instanceof Error &&
        "code" in err &&
        err.code === "insufficient_credits"
      ) {
        throw new MeetingJoinError("insufficient_credits", err.message);
      }
      throw err;
    }

    pipeline.onUpdate((update) => {
      session.confirmedSegments.push(...update.confirmed);
      session.writer.updateSegments([
        ...session.confirmedSegments,
        ...update.pending,
      ]);
      this.emitter.emitTranscript({
        type: "meeting-transcript",
        sessionId,
        transcriptId: session.transcriptId,
        confirmed: update.confirmed,
        pending: update.pending,
      });
    });

    const config: ResolvedMeetingBotConfig = {
      platform: parsed.platform,
      meetingUrl: parsed.meetingUrl,
      nativeMeetingId: parsed.nativeMeetingId,
      botName,
      language: request.language,
      autoLeave,
      retainAudio,
    };
    const botSession: MeetingBotSession = {
      id: sessionId,
      config,
      sink: this.rosterTrackingSink(session),
      signal: session.abort.signal,
      reportStatus: (status) => this.applyStatus(session, status),
    };

    this.emitter.emitStatus(this.toDto(session));
    logger.info(
      {
        sessionId,
        platform: parsed.platform,
        nativeMeetingId: parsed.nativeMeetingId,
        botName,
      },
      "[MeetingService] meeting join requested",
    );
    session.done = this.runSession(session, adapter, botSession);
    return this.toDto(session);
  }

  /** Request a graceful leave. Returns false when the session is unknown. */
  stopSession(sessionId: UUID): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || TERMINAL_STATUSES.has(session.status)) return false;
    logger.info({ sessionId }, "[MeetingService] stop requested");
    this.applyStatus(session, "leaving");
    session.abort.abort();
    return true;
  }

  getSession(sessionId: UUID): MeetingSession | null {
    const session = this.sessions.get(sessionId);
    if (session) return this.toDto(session);
    return this.terminated.get(sessionId) ?? null;
  }

  listSessions(options?: { active?: boolean }): MeetingSession[] {
    const live = [...this.sessions.values()].map((s) => this.toDto(s));
    const all = options?.active ? live : [...live, ...this.terminated.values()];
    return all.sort((a, b) => b.requestedAt - a.requestedAt);
  }

  /** Await the complete production lifecycle, including persistence, billing, events, and eviction. */
  async waitForSessionCompletion(sessionId: UUID): Promise<MeetingSession> {
    const completed = this.terminated.get(sessionId);
    if (completed) return completed;
    const live = this.sessions.get(sessionId);
    if (!live) {
      throw new Error(`[MeetingService] unknown session ${sessionId}`);
    }
    await live.done;
    const terminal = this.terminated.get(sessionId);
    if (!terminal) {
      throw new Error(
        `[MeetingService] session ${sessionId} completed without a terminal snapshot`,
      );
    }
    return terminal;
  }

  /** Number of retained internal sessions whose lifecycle work is not fully evicted. */
  pendingSessionWorkCount(): number {
    return this.sessions.size;
  }

  /** Import one completed Zoom cloud meeting into canonical media/transcripts. */
  async importZoomMeeting(
    request: ZoomMeetingImportRequest,
  ): Promise<ZoomMeetingImportResult> {
    const importer = this.deps.importZoomCloudMeeting;
    if (!importer) {
      throw new Error("[MeetingService] Zoom cloud import is not configured");
    }
    const accessToken =
      request.accessToken?.trim() ||
      this.settingString("ELIZA_ZOOM_ACCESS_TOKEN") ||
      this.settingString("ZOOM_ACCESS_TOKEN");
    if (!accessToken) {
      throw new ZoomCloudImportError(
        "invalid_request",
        "Zoom access token is required in the private request or ELIZA_ZOOM_ACCESS_TOKEN.",
        400,
      );
    }
    const imported = await importer({
      meetingId: request.meetingId,
      accessToken,
      retainRecordings: request.retainRecordings,
      maxFileBytes: request.maxFileBytes,
      maxTotalBytes: request.maxTotalBytes,
    });
    const importId = crypto.randomUUID() as UUID;
    const roomId = createUniqueUuid(
      this.runtime,
      `zoom-import:${imported.artifact.meeting.id}`,
    );
    const worldId = await this.ensureMeetingsWorld();
    await this.runtime.ensureRoomExists({
      id: roomId,
      name:
        imported.artifact.meeting.title ??
        `Zoom meeting ${imported.artifact.meeting.id}`,
      source: "zoom",
      type: ChannelType.GROUP,
      channelId: imported.artifact.meeting.id,
      worldId,
      metadata: {
        kind: "zoom-cloud-import",
        meetingArtifactId: imported.artifact.artifactId,
      },
    });
    const writer = new MeetingTranscriptWriter(this.runtime, 0);
    await writer.start({
      sessionId: importId,
      worldId,
      roomId,
      entityId: this.runtime.agentId,
      title:
        imported.artifact.meeting.title ??
        `Zoom meeting ${imported.artifact.meeting.id}`,
      platform: "zoom",
      meetingUrl: `https://zoom.us/j/${encodeURIComponent(request.meetingId)}`,
      nativeMeetingId:
        imported.artifact.meeting.nativeMeetingId ??
        imported.artifact.meeting.id,
      consentState:
        imported.artifact.meeting.consent.state === "redacted"
          ? "unknown"
          : imported.artifact.meeting.consent.state,
    });
    const segments = meetingArtifactToTranscriptSegments(imported.artifact);
    const retainedAudio = imported.artifact.media.find((media) =>
      media.mimeType.startsWith("audio/"),
    );
    const transcript = await writer.finalize({
      segments,
      endReason: "normal_completion",
      participants: imported.artifact.platformParticipants.map(
        (participant) => ({
          id: participant.id,
          displayName: participant.displayName ?? participant.id,
          joinedAtMs: participant.joinedAtMs,
          leftAtMs: participant.leftAtMs,
        }),
      ),
      retainedAudio: retainedAudio
        ? { url: retainedAudio.url, contentType: retainedAudio.mimeType }
        : undefined,
      metadata: {
        capture: { mode: "platform_import" },
        meetingArtifact: imported.artifact,
        zoomImport: {
          warnings: imported.warnings,
          requestIds: imported.requestIds,
        },
      },
    });
    return { ...imported, transcript };
  }

  /** API/UI projection of one internal session (defensive copies). */
  private toDto(session: InternalSession): MeetingSession {
    return {
      id: session.id,
      platform: session.platform,
      meetingUrl: session.meetingUrl,
      nativeMeetingId: session.nativeMeetingId,
      botName: session.botName,
      status: session.status,
      endReason: session.endReason,
      errorMessage: session.errorMessage,
      requestedAt: session.requestedAt,
      activeAt: session.activeAt,
      endedAt: session.endedAt,
      roomId: session.roomId,
      transcriptId: session.transcriptId,
      participants: session.participants.map((p) => ({ ...p })),
      calendarEventId: session.calendarEventId,
      maxDurationMs: session.maxDurationMs,
      billing: this.billingState(session),
    };
  }

  private billingState(session: InternalSession): MeetingBillingState {
    return (
      session.billing?.state ?? {
        status: "unmetered",
        reservedMs: 0,
        consumedMs: 0,
      }
    );
  }

  /** One shared "Meetings" world across sessions (created once, reused). */
  private ensureMeetingsWorld(): Promise<UUID> {
    if (!this.worldReady) {
      const worldId = createUniqueUuid(this.runtime, "meetings-world");
      this.worldReady = this.runtime
        .ensureWorldExists({
          id: worldId,
          name: "Meetings",
          agentId: this.runtime.agentId,
          metadata: { kind: "meetings" },
        })
        .then(() => worldId);
      // Allow a retry after a transient DB failure instead of caching it.
      this.worldReady.catch(() => {
        this.worldReady = null;
      });
    }
    return this.worldReady;
  }

  /**
   * Wrap the pipeline sink so roster observations also maintain the session's
   * participant list + entity graph before reaching the pipeline.
   */
  private rosterTrackingSink(session: InternalSession): MeetingAudioSink {
    const { pipeline } = session;
    return {
      pushSpeakerAudio: (speakerKey, samples) =>
        pipeline.pushSpeakerAudio(speakerKey, samples),
      setSpeakerName: (speakerKey, displayName) =>
        pipeline.setSpeakerName(speakerKey, displayName),
      flushSpeaker: (speakerKey) => pipeline.flushSpeaker(speakerKey),
      participantJoined: (participant) => {
        const enriched = this.trackParticipantJoined(session, participant);
        pipeline.participantJoined(enriched);
      },
      participantLeft: (participantId, atMs) => {
        const participant = session.participants.find(
          (p) => p.id === participantId,
        );
        if (participant && participant.leftAtMs === undefined) {
          participant.leftAtMs = atMs;
          this.emitter.emitStatus(this.toDto(session));
        }
        pipeline.participantLeft(participantId, atMs);
      },
    };
  }

  private trackParticipantJoined(
    session: InternalSession,
    participant: MeetingParticipant,
  ): MeetingParticipant {
    const existing = session.participants.find((p) => p.id === participant.id);
    if (existing) {
      // Rejoin: clear the departure and refresh the display name.
      existing.leftAtMs = undefined;
      existing.displayName = participant.displayName;
      return existing;
    }
    const entityId = createUniqueUuid(
      this.runtime,
      `meeting-participant:${session.platform}:${participant.displayName.toLowerCase()}`,
    );
    const tracked: MeetingParticipant = { ...participant, entityId };
    session.participants.push(tracked);
    // Entity creation is idempotent per (platform, name) via the seeded UUID;
    // failure to write the entity must not interrupt live capture.
    void this.runtime
      .createEntity({
        id: entityId,
        names: [participant.displayName],
        agentId: this.runtime.agentId,
        metadata: {
          meetings: {
            platform: session.platform,
            firstSeenSessionId: session.id,
          },
        },
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            sessionId: session.id,
            displayName: participant.displayName,
            error: err instanceof Error ? err.message : String(err),
          },
          "[MeetingService] participant entity creation failed",
        );
      });
    this.emitter.emitStatus(this.toDto(session));
    return tracked;
  }

  /** Adapter-reported lifecycle transition (ignored after a terminal state). */
  private applyStatus(
    session: InternalSession,
    status: MeetingSessionStatus,
  ): void {
    if (TERMINAL_STATUSES.has(session.status) || session.status === status) {
      return;
    }
    session.status = status;
    if (status === "active" && session.activeAt === undefined) {
      session.activeAt = Date.now();
    }
    logger.info(
      { sessionId: session.id, status },
      "[MeetingService] session status",
    );
    this.emitter.emitStatus(this.toDto(session));
  }

  /** Full adapter lifecycle: run → finalize pipeline + transcript → terminal. */
  private async runSession(
    session: InternalSession,
    adapter: MeetingPlatformAdapter,
    botSession: MeetingBotSession,
  ): Promise<void> {
    let endReason: MeetingEndReason;
    let errorMessage: string | undefined;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    let durationCapReached = false;
    try {
      const capReached = new Promise<MeetingEndReason>((resolve) => {
        capTimer = setTimeout(() => {
          durationCapReached = true;
          logger.warn(
            {
              sessionId: session.id,
              maxDurationMs: session.maxDurationMs,
            },
            "[MeetingService] duration cap reached; stopping meeting",
          );
          this.applyStatus(session, "leaving");
          resolve("duration_cap_reached");
          session.abort.abort();
        }, session.maxDurationMs);
        capTimer.unref?.();
      });
      endReason = await Promise.race([adapter.run(botSession), capReached]);
      if (durationCapReached) {
        endReason = "duration_cap_reached";
      } else if (session.endReason === "ended_due_to_spend_cap") {
        endReason = "ended_due_to_spend_cap";
        errorMessage = session.errorMessage;
      }
    } catch (err) {
      endReason = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { sessionId: session.id, error: errorMessage },
        "[MeetingService] platform adapter failed",
      );
    } finally {
      if (capTimer) clearTimeout(capTimer);
    }
    await this.finishSession(session, endReason, errorMessage);
  }

  private async finishSession(
    session: InternalSession,
    endReason: MeetingEndReason,
    errorMessage: string | undefined,
  ): Promise<void> {
    let segments: TranscriptSegment[];
    let finalizedTranscript: Transcript | null = null;
    try {
      segments = await session.pipeline.finalize();
    } catch (err) {
      segments = session.confirmedSegments;
      endReason = "error";
      errorMessage =
        errorMessage ?? (err instanceof Error ? err.message : String(err));
      logger.error(
        { sessionId: session.id, error: errorMessage },
        "[MeetingService] pipeline finalize failed",
      );
    }

    try {
      const audioWav = session.pipeline.sessionAudioWav?.() ?? null;
      let retainedAudio: { url: string; contentType: string } | undefined;
      let meetingArtifact: MeetingArtifact | undefined;
      if (session.platform === "zoom" && audioWav && audioWav.length > 0) {
        const stored = persistMeetingMedia(audioWav, "wav");
        const endedAt = new Date().toISOString();
        meetingArtifact = buildZoomBotMeetingArtifact({
          artifactId: `zoom-bot:${session.id}`,
          meetingId: session.nativeMeetingId,
          title: `Zoom meeting ${session.nativeMeetingId}`,
          startedAt: session.activeAt
            ? new Date(session.activeAt).toISOString()
            : undefined,
          endedAt,
          participants: session.participants,
          segments,
          audio: { ...stored, mimeType: "audio/wav" },
        });
        retainedAudio = { url: stored.url, contentType: "audio/wav" };
      }
      finalizedTranscript = await session.writer.finalize({
        segments,
        endReason,
        participants: session.participants,
        audioWav: retainedAudio ? null : audioWav,
        retainedAudio,
        metadata: meetingArtifact
          ? {
              capture: { mode: "bot" },
              meetingArtifact,
              zoomCapture: {
                capturePath: "bot_web_client",
                sourceLoss: [
                  "mixed_audio_only",
                  "per_participant_audio_unavailable",
                ],
              },
            }
          : session.platform === "zoom"
            ? {
                zoomCapture: {
                  capturePath: "bot_web_client",
                  artifactStatus: "unavailable",
                  reason: "source_audio_not_retained",
                },
              }
            : undefined,
      });
    } catch (err) {
      endReason = "error";
      errorMessage =
        errorMessage ?? (err instanceof Error ? err.message : String(err));
      logger.error(
        { sessionId: session.id, error: errorMessage },
        "[MeetingService] transcript finalize failed",
      );
    }

    try {
      await this.reconcileBillingOnce(session, endReason);
    } catch (err) {
      endReason = "error";
      errorMessage =
        errorMessage ?? (err instanceof Error ? err.message : String(err));
      logger.error(
        { sessionId: session.id, error: errorMessage },
        "[MeetingService] billing reconciliation failed",
      );
    }

    session.endReason = endReason;
    session.errorMessage = errorMessage;
    session.endedAt = Date.now();
    session.status = endReason === "error" ? "failed" : "ended";
    this.emitter.dispose(session.id);
    const dto = this.toDto(session);
    this.emitter.emitStatus(dto);
    logger.info(
      {
        sessionId: session.id,
        status: session.status,
        endReason,
        segments: session.confirmedSegments.length,
        participants: session.participants.length,
      },
      "[MeetingService] session finished",
    );
    await this.emitTranscriptFinalized(session, dto, finalizedTranscript);

    // Evict the heavy session: dropping the pipeline (retained PCM),
    // writer, and roster arrays lets them be garbage-collected. Only the DTO
    // survives for status/history reads; the persisted transcript record holds
    // the durable data.
    this.sessions.delete(session.id);
    this.terminated.set(session.id, dto);
  }

  private async emitTranscriptFinalized(
    session: InternalSession,
    dto: MeetingSession,
    transcript: Transcript | null,
  ): Promise<void> {
    if (!transcript || session.status !== "ended") return;
    const payload: EventPayload & MeetingTranscriptFinalizedPayload = {
      runtime: this.runtime,
      session: dto,
      transcript,
      ...(session.ghostAttendance
        ? { ghostAttendance: session.ghostAttendance }
        : {}),
      source: "plugin-meetings",
    };
    try {
      await this.runtime.emitEvent(MEETING_TRANSCRIPT_FINALIZED_EVENT, payload);
    } catch (err) {
      this.runtime.reportError("MeetingService.transcriptFinalizedEvent", err, {
        sessionId: session.id,
        transcriptId: transcript.id,
      });
    }
  }

  private async reconcileBillingOnce(
    session: InternalSession,
    endReason: MeetingEndReason,
  ): Promise<void> {
    if (!session.billing) return;
    if (!session.billingFinalized) {
      session.billingFinalized = session.billing
        .reconcile(endReason)
        .then(() => undefined);
    }
    await session.billingFinalized;
  }

  private settingString(key: string): string | null {
    const value = this.runtime.getSetting(key);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  /**
   * Enforce the organization capture policy before billing, pipeline creation,
   * transcript persistence, or adapter launch. Local/self-hosted runtimes keep
   * their current opt-in meeting behavior. Cloud/organization-managed runtimes
   * must carry an explicit `allow`; absence or an unrecognized value fails
   * closed so a policy lookup/configuration failure cannot start media capture.
   */
  private assertCapturePolicyAllowsJoin(): void {
    const configured = this.settingString(
      "ELIZA_MEETINGS_CAPTURE_POLICY",
    )?.toLowerCase();
    const cloudEnabled = this.settingString(
      "ELIZAOS_CLOUD_ENABLED",
    )?.toLowerCase();
    const organizationManaged =
      Boolean(
        this.settingString("ELIZAOS_CLOUD_ORG_ID") ??
          this.settingString("ELIZA_CLOUD_ORGANIZATION_ID"),
      ) ||
      cloudEnabled === "true" ||
      cloudEnabled === "1";

    if (configured === "allow") return;
    if (configured === "deny") {
      throw new MeetingJoinError(
        "policy_blocked",
        "meeting capture is blocked by organization policy",
      );
    }
    if (configured !== undefined || organizationManaged) {
      throw new MeetingJoinError(
        "policy_blocked",
        "meeting capture policy is unavailable; capture was not started",
      );
    }
  }

  private resolveMaxDurationMs(requested: number | undefined): number {
    const configured = this.settingPositiveInteger(
      "ELIZA_MEETINGS_MAX_DURATION_MS",
    );
    const maximum = configured ?? DEFAULT_MEETING_MAX_DURATION_MS;
    if (
      requested !== undefined &&
      (!Number.isSafeInteger(requested) || requested <= 0)
    ) {
      throw new MeetingJoinError(
        "invalid_duration_cap",
        "maxDurationMs must be a positive integer",
      );
    }
    if (requested !== undefined && requested > maximum) {
      throw new MeetingJoinError(
        "invalid_duration_cap",
        `maxDurationMs exceeds the configured maximum (${maximum}ms)`,
      );
    }
    return requested ?? maximum;
  }

  private settingPositiveInteger(key: string): number | null {
    const raw = this.settingString(key);
    return parsePositiveInteger(raw) ?? null;
  }
}
