/**
 * Discord voice-channel meeting transcription.
 *
 * When transcription is enabled for a voice connection, every decoded
 * per-user Opus stream (already one decode per speaker, owned by
 * `VoiceManager.monitorMember`) is teed into a meeting transcription session:
 * per-user SSRC gives exact diarization, so each Discord user id becomes a
 * pipeline speaker key. The session composes the landed plugin-meetings
 * infrastructure directly (composition "A"):
 *
 *  - `createPipeline` → @elizaos/plugin-meetings transcription pipeline
 *    (per-speaker buffering, ASR via `useModel(TRANSCRIPTION)`, LocalAgreement
 *    confirmation, hallucination filtering).
 *  - `MeetingTranscriptWriter` → lifecycle record in the `"transcripts"`
 *    memories partition ("recording" → throttled updates → "ready"), rendered
 *    by the Transcripts view with zero extra wiring.
 *  - `MeetingEventEmitter` → live `meeting-status` / `meeting-transcript`
 *    WebSocket envelopes for the dashboard live pane.
 *
 * The seams are structural (`VoiceMeetingDeps`) so unit tests script them;
 * the production wiring (`loadDefaultVoiceMeetingDeps`) dynamically imports
 * `@elizaos/plugin-meetings` only when a session actually starts, keeping the
 * heavy browser-bot module graph out of the connector's boot path.
 */

import type { Buffer } from "node:buffer";
import {
	ChannelType,
	createUniqueUuid,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import type {
	MeetingEndReason,
	MeetingParticipant,
	MeetingSession,
	MeetingTranscriptEvent,
	TranscriptSegment,
} from "@elizaos/shared";
import type { ICompatRuntime } from "./compat";

/** Sample rate the meeting pipeline consumes (matches plugin-meetings). */
export const MEETING_PIPELINE_SAMPLE_RATE = 16_000;

/** Setting key gating voice-channel transcription (off unless enabled). */
export const DISCORD_VOICE_TRANSCRIPTS_SETTING = "DISCORD_VOICE_TRANSCRIPTS";

type MeetingsModule = typeof import("@elizaos/plugin-meetings");

// ── PCM conversion ───────────────────────────────────────────────

/** Interpret a Buffer as little-endian signed 16-bit mono PCM → Float32 [-1,1]. */
export function pcm16ToFloat32(pcm: Buffer): Float32Array {
	const sampleCount = Math.floor(pcm.length / 2);
	const out = new Float32Array(sampleCount);
	for (let i = 0; i < sampleCount; i++) {
		out[i] = pcm.readInt16LE(i * 2) / 32768;
	}
	return out;
}

/** Linear resampler for mono Float32 PCM. Identity when rates match. */
export function resampleLinear(
	input: Float32Array,
	sourceRate: number,
	targetRate: number,
): Float32Array {
	if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
		throw new Error(`Invalid source sample rate: ${sourceRate}`);
	}
	if (sourceRate === targetRate || input.length === 0) {
		return input;
	}
	const outLength = Math.max(
		1,
		Math.round((input.length * targetRate) / sourceRate),
	);
	const out = new Float32Array(outLength);
	const step = (input.length - 1) / Math.max(1, outLength - 1);
	for (let i = 0; i < outLength; i++) {
		const pos = i * step;
		const lo = Math.floor(pos);
		const hi = Math.min(input.length - 1, lo + 1);
		const frac = pos - lo;
		out[i] = input[lo] * (1 - frac) + input[hi] * frac;
	}
	return out;
}

/**
 * Convert a decoded Discord voice chunk (s16le mono PCM at `sourceRate`) into
 * the 16 kHz mono Float32 frame the meeting pipeline consumes.
 */
export function discordPcmToPipelineFrame(
	pcm: Buffer,
	sourceRate: number = MEETING_PIPELINE_SAMPLE_RATE,
): Float32Array {
	return resampleLinear(
		pcm16ToFloat32(pcm),
		sourceRate,
		MEETING_PIPELINE_SAMPLE_RATE,
	);
}

// ── Settings gate ────────────────────────────────────────────────

/** Global DISCORD_VOICE_TRANSCRIPTS setting: off unless explicitly enabled. */
export function isVoiceTranscriptsSettingEnabled(
	runtime: Pick<ICompatRuntime, "getSetting">,
): boolean {
	const raw = runtime.getSetting(DISCORD_VOICE_TRANSCRIPTS_SETTING);
	return (
		raw === true || raw === "true" || raw === "on" || raw === "1" || raw === 1
	);
}

// ── Structural seams over plugin-meetings ────────────────────────

export interface VoiceMeetingPipelineUpdate {
	confirmed: TranscriptSegment[];
	pending: TranscriptSegment[];
}

/** The pipeline surface the session drives (satisfied by plugin-meetings). */
export interface VoiceMeetingPipeline {
	pushSpeakerAudio(speakerKey: string, samples: Float32Array): void;
	setSpeakerName(speakerKey: string, displayName: string): void;
	flushSpeaker(speakerKey: string): void;
	participantJoined(participant: MeetingParticipant): void;
	participantLeft(participantId: string, atMs: number): void;
	onUpdate(listener: (update: VoiceMeetingPipelineUpdate) => void): () => void;
	finalize(): Promise<TranscriptSegment[]>;
	speakerNames(): string[];
	/** Optional on the plugin-meetings pipeline surface; null when absent. */
	sessionAudioWav?(): Buffer | null;
}

export interface VoiceMeetingWriterStartInput {
	sessionId: UUID;
	worldId: UUID;
	roomId: UUID;
	entityId: UUID;
	title: string;
	platform: "discord";
	meetingUrl: string;
	nativeMeetingId: string;
}

export interface VoiceMeetingWriterFinalizeInput {
	segments: TranscriptSegment[];
	endReason: MeetingEndReason;
	participants: MeetingParticipant[];
	audioWav?: Buffer | null;
}

/** The transcript-record writer surface (satisfied by MeetingTranscriptWriter). */
export interface VoiceMeetingWriter {
	readonly transcriptId: UUID;
	start(input: VoiceMeetingWriterStartInput): Promise<unknown>;
	updateSegments(segments: TranscriptSegment[]): void;
	finalize(input: VoiceMeetingWriterFinalizeInput): Promise<unknown>;
}

/** The live WS fan-out surface (satisfied by MeetingEventEmitter). */
export interface VoiceMeetingEmitter {
	emitStatus(session: MeetingSession): void;
	emitTranscript(event: MeetingTranscriptEvent): void;
	dispose(sessionId: string): void;
}

export interface VoiceMeetingDeps {
	createPipeline(options: {
		sessionId: UUID;
		retainAudio: boolean;
	}): VoiceMeetingPipeline;
	createWriter(): VoiceMeetingWriter;
	createEmitter(): VoiceMeetingEmitter;
}

/**
 * Production wiring: dynamically import @elizaos/plugin-meetings (deferred so
 * the connector never pays the browser-bot module graph unless a voice
 * transcription session actually starts) and bind its exported seams.
 */
export async function loadDefaultVoiceMeetingDeps(
	runtime: ICompatRuntime,
): Promise<VoiceMeetingDeps> {
	const meetings: MeetingsModule = await import("@elizaos/plugin-meetings");
	// ICompatRuntime only widens serverId/messageServerId on the ensure*
	// methods (type-only shim, see compat.ts); it is the same runtime object.
	const coreRuntime = runtime as unknown as Parameters<
		NonNullable<typeof meetings.MeetingService.dependencyFactory>
	>[0];
	const factory = meetings.MeetingService.dependencyFactory;
	if (!factory) {
		throw new Error(
			"[DiscordVoiceMeetings] plugin-meetings dependencyFactory is not wired",
		);
	}
	const { createPipeline } = factory(coreRuntime);
	return {
		createPipeline: ({ sessionId, retainAudio }) =>
			createPipeline({ runtime: coreRuntime, sessionId, retainAudio }),
		createWriter: () => new meetings.MeetingTranscriptWriter(coreRuntime),
		createEmitter: () => new meetings.MeetingEventEmitter(coreRuntime),
	};
}

// ── Session ──────────────────────────────────────────────────────

export interface VoiceMeetingChannelInfo {
	channelId: string;
	channelName: string;
	guildId: string;
	guildName: string;
	/** Discord users present at session start (bot excluded). */
	members: Array<{ id: string; displayName: string }>;
}

export interface DiscordVoiceMeetingSessionOptions {
	runtime: ICompatRuntime;
	channel: VoiceMeetingChannelInfo;
	deps: VoiceMeetingDeps;
	now?: () => number;
}

/**
 * One live voice-channel transcription session: pipeline + transcript writer
 * + live WS emitter for a single Discord voice connection.
 */
export class DiscordVoiceMeetingSession {
	readonly sessionId: UUID;
	private readonly runtime: ICompatRuntime;
	private readonly channel: VoiceMeetingChannelInfo;
	private readonly deps: VoiceMeetingDeps;
	private readonly now: () => number;

	private pipeline: VoiceMeetingPipeline | null = null;
	private writer: VoiceMeetingWriter | null = null;
	private emitter: VoiceMeetingEmitter | null = null;
	private unsubscribe: (() => void) | null = null;

	private readonly confirmedSegments: TranscriptSegment[] = [];
	private readonly participants = new Map<string, MeetingParticipant>();
	private readonly namedSpeakers = new Set<string>();
	private startedAt = 0;
	private stopPromise: Promise<void> | null = null;

	constructor(options: DiscordVoiceMeetingSessionOptions) {
		this.runtime = options.runtime;
		this.channel = options.channel;
		this.deps = options.deps;
		this.now = options.now ?? Date.now;
		this.sessionId = crypto.randomUUID() as UUID;
	}

	get channelId(): string {
		return this.channel.channelId;
	}

	get transcriptId(): UUID | null {
		return this.writer?.transcriptId ?? null;
	}

	get active(): boolean {
		return this.pipeline !== null && this.stopPromise === null;
	}

	private get meetingUrl(): string {
		return `https://discord.com/channels/${this.channel.guildId}/${this.channel.channelId}`;
	}

	/** Follow the connector's existing room mapping (see voice.ts handleMessage). */
	private get roomId(): UUID {
		return createUniqueUuid(this.runtime, this.channel.channelId);
	}

	private get worldId(): UUID {
		return createUniqueUuid(this.runtime, this.channel.guildId) as UUID;
	}

	async start(): Promise<void> {
		if (this.pipeline) {
			throw new Error(
				`[DiscordVoiceMeetings] session for channel ${this.channel.channelId} already started`,
			);
		}
		this.startedAt = this.now();

		// The transcript record is created before any utterance lands, so the
		// world/room must exist up front (voice.ts only ensures them lazily on
		// the first spoken message).
		await this.runtime.ensureWorldExists({
			id: this.worldId,
			name: this.channel.guildName,
			agentId: this.runtime.agentId,
			serverId: this.channel.guildId,
			messageServerId: stringToUuid(this.channel.guildId),
		});
		await this.runtime.ensureRoomExists({
			id: this.roomId,
			name: this.channel.channelName,
			source: "discord",
			type: ChannelType.VOICE_GROUP,
			channelId: this.channel.channelId,
			serverId: this.channel.guildId,
			messageServerId: stringToUuid(this.channel.guildId),
			worldId: this.worldId,
		});

		this.pipeline = this.deps.createPipeline({
			sessionId: this.sessionId,
			retainAudio: true,
		});
		this.writer = this.deps.createWriter();
		this.emitter = this.deps.createEmitter();

		const startedDate = new Date(this.startedAt);
		await this.writer.start({
			sessionId: this.sessionId,
			worldId: this.worldId,
			roomId: this.roomId,
			entityId: this.runtime.agentId,
			title: `${this.channel.channelName} — ${startedDate.toISOString().slice(0, 10)}`,
			platform: "discord",
			meetingUrl: this.meetingUrl,
			nativeMeetingId: this.channel.channelId,
		});

		for (const member of this.channel.members) {
			this.participantJoined(member.id, member.displayName);
		}

		this.unsubscribe = this.pipeline.onUpdate((update) => {
			this.confirmedSegments.push(...update.confirmed);
			const writer = this.writer;
			const emitter = this.emitter;
			if (!writer || !emitter) return;
			writer.updateSegments([...this.confirmedSegments, ...update.pending]);
			emitter.emitTranscript({
				type: "meeting-transcript",
				sessionId: this.sessionId,
				transcriptId: writer.transcriptId,
				confirmed: update.confirmed,
				pending: update.pending,
			});
		});

		this.emitter.emitStatus(this.sessionDto("active"));
		this.runtime.logger.info(
			{
				src: "plugin:discord:voice:meetings",
				agentId: this.runtime.agentId,
				sessionId: this.sessionId,
				transcriptId: this.writer.transcriptId,
				channelId: this.channel.channelId,
				channelName: this.channel.channelName,
			},
			"[DiscordVoiceMeetings] voice transcription session started",
		);
	}

	/**
	 * Feed one decoded PCM chunk (s16le mono at `sourceRate`, default 16 kHz —
	 * the Discord opus decoder output) for one speaker (Discord user id).
	 */
	pushPcm(
		userId: string,
		pcm: Buffer,
		displayName?: string,
		sourceRate: number = MEETING_PIPELINE_SAMPLE_RATE,
	): void {
		const pipeline = this.pipeline;
		if (!pipeline || this.stopPromise) return;
		if (displayName && !this.namedSpeakers.has(userId)) {
			this.participantJoined(userId, displayName);
		}
		pipeline.pushSpeakerAudio(
			userId,
			discordPcmToPipelineFrame(pcm, sourceRate),
		);
	}

	/** Speaking-end event: force-finalize the speaker's pending buffer. */
	flushSpeaker(userId: string): void {
		this.pipeline?.flushSpeaker(userId);
	}

	participantJoined(userId: string, displayName: string): void {
		const pipeline = this.pipeline;
		if (!pipeline) return;
		if (!this.namedSpeakers.has(userId)) {
			this.namedSpeakers.add(userId);
			pipeline.setSpeakerName(userId, displayName);
		}
		if (!this.participants.has(userId)) {
			const participant: MeetingParticipant = {
				id: userId,
				displayName,
				joinedAtMs: Math.max(0, this.now() - this.startedAt),
			};
			this.participants.set(userId, participant);
			pipeline.participantJoined(participant);
		}
	}

	participantLeft(userId: string): void {
		const pipeline = this.pipeline;
		const participant = this.participants.get(userId);
		if (!pipeline || !participant) return;
		const atMs = Math.max(0, this.now() - this.startedAt);
		this.participants.set(userId, { ...participant, leftAtMs: atMs });
		pipeline.participantLeft(userId, atMs);
		pipeline.flushSpeaker(userId);
	}

	/**
	 * Finalize the session: flush + drain the pipeline, write the "ready"
	 * transcript record (with retained session audio), and emit the terminal
	 * status. Idempotent — concurrent/duplicate stops share one finalize.
	 */
	stop(endReason: MeetingEndReason): Promise<void> {
		if (!this.stopPromise) {
			this.stopPromise = this.finalizeSession(endReason);
		}
		return this.stopPromise;
	}

	private async finalizeSession(endReason: MeetingEndReason): Promise<void> {
		const pipeline = this.pipeline;
		const writer = this.writer;
		const emitter = this.emitter;
		if (!pipeline || !writer || !emitter) return;
		this.unsubscribe?.();
		this.unsubscribe = null;

		const segments = await pipeline.finalize();
		await writer.finalize({
			segments,
			endReason,
			participants: [...this.participants.values()],
			audioWav: pipeline.sessionAudioWav?.() ?? null,
		});
		emitter.emitStatus(this.sessionDto("ended", endReason));
		emitter.dispose(this.sessionId);
		this.runtime.logger.info(
			{
				src: "plugin:discord:voice:meetings",
				agentId: this.runtime.agentId,
				sessionId: this.sessionId,
				transcriptId: writer.transcriptId,
				channelId: this.channel.channelId,
				segments: segments.length,
				endReason,
			},
			"[DiscordVoiceMeetings] voice transcription session finalized",
		);
	}

	private sessionDto(
		status: "active" | "ended",
		endReason?: MeetingEndReason,
	): MeetingSession {
		return {
			id: this.sessionId,
			platform: "discord",
			meetingUrl: this.meetingUrl,
			nativeMeetingId: this.channel.channelId,
			botName: this.runtime.character.name ?? this.runtime.agentId,
			status,
			...(endReason ? { endReason } : {}),
			requestedAt: this.startedAt,
			activeAt: this.startedAt,
			...(status === "ended" ? { endedAt: this.now() } : {}),
			roomId: this.roomId,
			...(this.writer ? { transcriptId: this.writer.transcriptId } : {}),
			participants: [...this.participants.values()],
			metadata: {
				guildId: this.channel.guildId,
				guildName: this.channel.guildName,
				channelName: this.channel.channelName,
			},
		};
	}
}
