/**
 * Unit tests for voice-meeting audio conversion helpers — PCM16↔float32,
 * linear resampling, and Discord-PCM-to-pipeline-frame mapping. Pure-function
 * assertions over synthetic buffers.
 */
import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import { ChannelType, createUniqueUuid, type UUID } from "@elizaos/core";
import type { TranscriptSegment } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ICompatRuntime } from "../compat";
import { AudioMonitor, VoiceManager } from "../voice";
import {
	DISCORD_VOICE_TRANSCRIPTS_SETTING,
	DiscordVoiceMeetingSession,
	discordPcmToPipelineFrame,
	isVoiceTranscriptsSettingEnabled,
	MEETING_PIPELINE_SAMPLE_RATE,
	pcm16ToFloat32,
	resampleLinear,
	type VoiceMeetingDeps,
	type VoiceMeetingEmitter,
	type VoiceMeetingPipeline,
	type VoiceMeetingPipelineUpdate,
	type VoiceMeetingWriter,
	type VoiceMeetingWriterFinalizeInput,
	type VoiceMeetingWriterStartInput,
} from "../voice-meetings";

// ── PCM conversion ───────────────────────────────────────────────

function s16leBuffer(samples: number[]): Buffer {
	const buf = Buffer.alloc(samples.length * 2);
	samples.forEach((s, i) => {
		buf.writeInt16LE(s, i * 2);
	});
	return buf;
}

describe("pcm16ToFloat32", () => {
	it("maps s16le samples into [-1, 1) floats", () => {
		const out = pcm16ToFloat32(s16leBuffer([0, 16384, -16384, 32767, -32768]));
		expect(out).toHaveLength(5);
		expect(out[0]).toBe(0);
		expect(out[1]).toBeCloseTo(0.5, 5);
		expect(out[2]).toBeCloseTo(-0.5, 5);
		expect(out[3]).toBeCloseTo(32767 / 32768, 6);
		expect(out[4]).toBe(-1);
	});

	it("ignores a trailing odd byte instead of misreading it", () => {
		const buf = Buffer.concat([s16leBuffer([1000]), Buffer.from([0x7f])]);
		expect(pcm16ToFloat32(buf)).toHaveLength(1);
	});

	it("returns an empty frame for an empty buffer", () => {
		expect(pcm16ToFloat32(Buffer.alloc(0))).toHaveLength(0);
	});
});

describe("resampleLinear", () => {
	it("is identity when rates match", () => {
		const input = new Float32Array([0.1, 0.2, 0.3]);
		expect(resampleLinear(input, 16000, 16000)).toBe(input);
	});

	it("downsamples 48 kHz to 16 kHz at a 3:1 ratio", () => {
		const input = new Float32Array(4800).fill(0.25);
		const out = resampleLinear(input, 48000, 16000);
		expect(out).toHaveLength(1600);
		for (const v of out) expect(v).toBeCloseTo(0.25, 6);
	});

	it("interpolates between neighbouring samples when upsampling", () => {
		const out = resampleLinear(new Float32Array([0, 1]), 8000, 16000);
		expect(out).toHaveLength(4);
		expect(out[0]).toBe(0);
		expect(out[out.length - 1]).toBeCloseTo(1, 6);
		// Strictly increasing ramp between the endpoints.
		for (let i = 1; i < out.length; i++)
			expect(out[i]).toBeGreaterThan(out[i - 1]);
	});

	it("rejects a non-positive source rate", () => {
		expect(() => resampleLinear(new Float32Array(4), 0, 16000)).toThrow(
			/Invalid source sample rate/,
		);
	});
});

describe("discordPcmToPipelineFrame", () => {
	it("converts decoder output (s16 mono 16 kHz) without resampling", () => {
		const out = discordPcmToPipelineFrame(s16leBuffer([16384, -16384]));
		expect(out).toHaveLength(2);
		expect(out[0]).toBeCloseTo(0.5, 5);
	});

	it("resamples when the source rate differs from the pipeline rate", () => {
		const buf = s16leBuffer(new Array(480).fill(8192));
		const out = discordPcmToPipelineFrame(buf, 48000);
		expect(out).toHaveLength(480 / 3);
		expect(MEETING_PIPELINE_SAMPLE_RATE).toBe(16000);
	});
});

// ── Settings gating ──────────────────────────────────────────────

describe("isVoiceTranscriptsSettingEnabled", () => {
	const withSetting = (value: unknown) => ({
		getSetting: (key: string) =>
			key === DISCORD_VOICE_TRANSCRIPTS_SETTING ? value : undefined,
	});

	it("is off by default", () => {
		expect(isVoiceTranscriptsSettingEnabled(withSetting(undefined))).toBe(
			false,
		);
		expect(isVoiceTranscriptsSettingEnabled(withSetting(null))).toBe(false);
		expect(isVoiceTranscriptsSettingEnabled(withSetting(""))).toBe(false);
		expect(isVoiceTranscriptsSettingEnabled(withSetting("off"))).toBe(false);
		expect(isVoiceTranscriptsSettingEnabled(withSetting("false"))).toBe(false);
	});

	it("accepts the documented on values", () => {
		for (const value of ["on", "true", "1", 1, true]) {
			expect(isVoiceTranscriptsSettingEnabled(withSetting(value))).toBe(true);
		}
	});
});

// ── Scripted seams ───────────────────────────────────────────────

class ScriptedPipeline implements VoiceMeetingPipeline {
	pushed: Array<{ speakerKey: string; samples: Float32Array }> = [];
	names = new Map<string, string>();
	flushed: string[] = [];
	joined: string[] = [];
	left: Array<{ id: string; atMs: number }> = [];
	finalized = false;
	finalSegments: TranscriptSegment[] = [];
	wav: Buffer | null = Buffer.from("RIFF-fake");
	private listeners = new Set<(u: VoiceMeetingPipelineUpdate) => void>();

	pushSpeakerAudio(speakerKey: string, samples: Float32Array): void {
		this.pushed.push({ speakerKey, samples });
	}
	setSpeakerName(speakerKey: string, displayName: string): void {
		this.names.set(speakerKey, displayName);
	}
	flushSpeaker(speakerKey: string): void {
		this.flushed.push(speakerKey);
	}
	participantJoined(participant: { id: string }): void {
		this.joined.push(participant.id);
	}
	participantLeft(participantId: string, atMs: number): void {
		this.left.push({ id: participantId, atMs });
	}
	onUpdate(listener: (u: VoiceMeetingPipelineUpdate) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(update: VoiceMeetingPipelineUpdate): void {
		for (const l of this.listeners) l(update);
	}
	get listenerCount(): number {
		return this.listeners.size;
	}
	async finalize(): Promise<TranscriptSegment[]> {
		this.finalized = true;
		return this.finalSegments;
	}
	speakerNames(): string[] {
		return [...this.names.values()];
	}
	sessionAudioWav(): Buffer | null {
		return this.wav;
	}
}

class ScriptedWriter implements VoiceMeetingWriter {
	readonly transcriptId = crypto.randomUUID() as UUID;
	startInput: VoiceMeetingWriterStartInput | null = null;
	updates: TranscriptSegment[][] = [];
	finalizeInput: VoiceMeetingWriterFinalizeInput | null = null;

	async start(input: VoiceMeetingWriterStartInput): Promise<unknown> {
		this.startInput = input;
		return {};
	}
	updateSegments(segments: TranscriptSegment[]): void {
		this.updates.push(segments);
	}
	async finalize(input: VoiceMeetingWriterFinalizeInput): Promise<unknown> {
		this.finalizeInput = input;
		return {};
	}
}

class ScriptedEmitter implements VoiceMeetingEmitter {
	statuses: Parameters<VoiceMeetingEmitter["emitStatus"]>[0][] = [];
	transcripts: Parameters<VoiceMeetingEmitter["emitTranscript"]>[0][] = [];
	disposed: string[] = [];

	emitStatus(session: Parameters<VoiceMeetingEmitter["emitStatus"]>[0]): void {
		this.statuses.push(session);
	}
	emitTranscript(
		event: Parameters<VoiceMeetingEmitter["emitTranscript"]>[0],
	): void {
		this.transcripts.push(event);
	}
	dispose(sessionId: string): void {
		this.disposed.push(sessionId);
	}
}

function segment(id: string, text: string): TranscriptSegment {
	return {
		id,
		speakerLabel: "Alice",
		startMs: 0,
		endMs: 1000,
		text,
		words: [],
	};
}

function makeRuntime() {
	const ensureWorldExists = vi.fn(async () => {});
	const ensureRoomExists = vi.fn(async () => {});
	const runtime = {
		agentId: "00000000-0000-0000-0000-00000000abcd" as UUID,
		character: { name: "Eliza" },
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		getSetting: vi.fn(() => undefined),
		ensureWorldExists,
		ensureRoomExists,
	} as unknown as ICompatRuntime;
	return { runtime, ensureWorldExists, ensureRoomExists };
}

function makeSession(overrides?: { now?: () => number }) {
	const pipeline = new ScriptedPipeline();
	const writer = new ScriptedWriter();
	const emitter = new ScriptedEmitter();
	const deps: VoiceMeetingDeps = {
		createPipeline: () => pipeline,
		createWriter: () => writer,
		createEmitter: () => emitter,
	};
	const { runtime, ensureWorldExists, ensureRoomExists } = makeRuntime();
	const session = new DiscordVoiceMeetingSession({
		runtime,
		channel: {
			channelId: "111222333",
			channelName: "war-room",
			guildId: "999888777",
			guildName: "Test Guild",
			members: [
				{ id: "u-alice", displayName: "Alice" },
				{ id: "u-bob", displayName: "Bob" },
			],
		},
		deps,
		now: overrides?.now,
	});
	return {
		session,
		pipeline,
		writer,
		emitter,
		runtime,
		ensureWorldExists,
		ensureRoomExists,
	};
}

// ── Session lifecycle ────────────────────────────────────────────

describe("DiscordVoiceMeetingSession", () => {
	let ctx: ReturnType<typeof makeSession>;

	beforeEach(() => {
		ctx = makeSession();
	});

	it("start() ensures the connector's world/room and creates the recording record", async () => {
		await ctx.session.start();

		const worldId = createUniqueUuid(ctx.runtime, "999888777");
		const roomId = createUniqueUuid(ctx.runtime, "111222333");
		expect(ctx.ensureWorldExists).toHaveBeenCalledWith(
			expect.objectContaining({ id: worldId, name: "Test Guild" }),
		);
		expect(ctx.ensureRoomExists).toHaveBeenCalledWith(
			expect.objectContaining({
				id: roomId,
				worldId,
				source: "discord",
				type: ChannelType.VOICE_GROUP,
				channelId: "111222333",
			}),
		);

		const start = ctx.writer.startInput;
		expect(start).not.toBeNull();
		expect(start?.platform).toBe("discord");
		expect(start?.roomId).toBe(roomId);
		expect(start?.worldId).toBe(worldId);
		expect(start?.nativeMeetingId).toBe("111222333");
		expect(start?.meetingUrl).toBe(
			"https://discord.com/channels/999888777/111222333",
		);
		expect(start?.title).toMatch(/^war-room — \d{4}-\d{2}-\d{2}$/);

		// Roster seeded from present members, names attributed for diarization.
		expect(ctx.pipeline.joined).toEqual(["u-alice", "u-bob"]);
		expect(ctx.pipeline.names.get("u-alice")).toBe("Alice");

		// Live status envelope emitted for the dashboard.
		expect(ctx.emitter.statuses).toHaveLength(1);
		expect(ctx.emitter.statuses[0]).toMatchObject({
			platform: "discord",
			status: "active",
			transcriptId: ctx.writer.transcriptId,
			botName: "Eliza",
		});
		expect(ctx.session.active).toBe(true);
	});

	it("start() is not reentrant", async () => {
		await ctx.session.start();
		await expect(ctx.session.start()).rejects.toThrow(/already started/);
	});

	it("pushPcm converts s16 PCM to Float32 and names the speaker once", async () => {
		await ctx.session.start();
		ctx.session.pushPcm("u-carol", s16leBuffer([16384, -16384]), "Carol");
		ctx.session.pushPcm("u-carol", s16leBuffer([0]), "Carol Renamed");

		expect(ctx.pipeline.pushed).toHaveLength(2);
		expect(ctx.pipeline.pushed[0].speakerKey).toBe("u-carol");
		expect(ctx.pipeline.pushed[0].samples[0]).toBeCloseTo(0.5, 5);
		expect(ctx.pipeline.pushed[0].samples[1]).toBeCloseTo(-0.5, 5);
		// Name is vote-and-locked on first sight; later chunks don't rename.
		expect(ctx.pipeline.names.get("u-carol")).toBe("Carol");
		expect(ctx.pipeline.joined).toContain("u-carol");
	});

	it("pushPcm before start or after stop is dropped", async () => {
		ctx.session.pushPcm("u-alice", s16leBuffer([100]));
		expect(ctx.pipeline.pushed).toHaveLength(0);

		await ctx.session.start();
		await ctx.session.stop("requested_stop");
		ctx.session.pushPcm("u-alice", s16leBuffer([100]));
		expect(ctx.pipeline.pushed).toHaveLength(0);
	});

	it("pipeline updates flow to the writer (cumulative) and the WS emitter (delta)", async () => {
		await ctx.session.start();

		const s1 = segment("s1", "hello");
		const s2 = segment("s2", "world");
		const pendingTail = segment("p", "pend…");

		ctx.pipeline.emit({ confirmed: [s1], pending: [pendingTail] });
		ctx.pipeline.emit({ confirmed: [s2], pending: [] });

		// Writer receives the full segment set every time (confirmed + pending).
		expect(ctx.writer.updates[0]).toEqual([s1, pendingTail]);
		expect(ctx.writer.updates[1]).toEqual([s1, s2]);

		// Emitter receives only the delta + current pending tail.
		expect(ctx.emitter.transcripts[0]).toMatchObject({
			type: "meeting-transcript",
			sessionId: ctx.session.sessionId,
			transcriptId: ctx.writer.transcriptId,
			confirmed: [s1],
			pending: [pendingTail],
		});
		expect(ctx.emitter.transcripts[1].confirmed).toEqual([s2]);
	});

	it("participantLeft records leftAtMs and flushes the speaker buffer", async () => {
		let nowMs = 1_000_000;
		ctx = makeSession({ now: () => nowMs });
		await ctx.session.start();

		nowMs += 42_000;
		ctx.session.participantLeft("u-bob");
		expect(ctx.pipeline.left).toEqual([{ id: "u-bob", atMs: 42_000 }]);
		expect(ctx.pipeline.flushed).toContain("u-bob");

		// Unknown participant is a no-op.
		ctx.session.participantLeft("u-stranger");
		expect(ctx.pipeline.left).toHaveLength(1);
	});

	it("stop() finalizes pipeline + writer, emits terminal status, and is idempotent", async () => {
		await ctx.session.start();
		ctx.pipeline.finalSegments = [segment("s1", "final text")];
		ctx.session.participantLeft("u-bob");

		await Promise.all([
			ctx.session.stop("requested_stop"),
			ctx.session.stop("requested_stop"),
		]);
		await ctx.session.stop("error"); // late duplicate shares the same finalize

		expect(ctx.pipeline.finalized).toBe(true);
		const fin = ctx.writer.finalizeInput;
		expect(fin?.endReason).toBe("requested_stop");
		expect(fin?.segments).toEqual(ctx.pipeline.finalSegments);
		expect(fin?.audioWav).toBe(ctx.pipeline.wav);
		expect(fin?.participants.map((p) => p.id).sort()).toEqual([
			"u-alice",
			"u-bob",
		]);
		expect(
			fin?.participants.find((p) => p.id === "u-bob")?.leftAtMs,
		).toBeTypeOf("number");

		// One "active" + exactly one terminal status despite three stop calls.
		expect(ctx.emitter.statuses.map((s) => s.status)).toEqual([
			"active",
			"ended",
		]);
		expect(ctx.emitter.statuses[1].endReason).toBe("requested_stop");
		expect(ctx.emitter.disposed).toEqual([ctx.session.sessionId]);
		// The live-update subscription is torn down.
		expect(ctx.pipeline.listenerCount).toBe(0);
		expect(ctx.session.active).toBe(false);
	});
});

// ── VoiceManager gating ──────────────────────────────────────────

describe("VoiceManager transcription gating", () => {
	function makeManager(globalSetting: unknown) {
		const { runtime } = makeRuntime();
		(runtime.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
			(key: string) =>
				key === DISCORD_VOICE_TRANSCRIPTS_SETTING ? globalSetting : undefined,
		);
		return new VoiceManager(
			{ accountId: "default", client: null },
			runtime as never,
		);
	}

	it("defaults to the global DISCORD_VOICE_TRANSCRIPTS setting", () => {
		expect(makeManager(undefined).isVoiceTranscriptionEnabled("c1")).toBe(
			false,
		);
		expect(makeManager("on").isVoiceTranscriptionEnabled("c1")).toBe(true);
	});

	it("per-channel override beats the global setting in both directions", () => {
		const offGlobal = makeManager(undefined);
		offGlobal.setVoiceTranscriptionOverride("c1", true);
		expect(offGlobal.isVoiceTranscriptionEnabled("c1")).toBe(true);
		expect(offGlobal.isVoiceTranscriptionEnabled("c2")).toBe(false);

		const onGlobal = makeManager("on");
		onGlobal.setVoiceTranscriptionOverride("c1", false);
		expect(onGlobal.isVoiceTranscriptionEnabled("c1")).toBe(false);
		expect(onGlobal.isVoiceTranscriptionEnabled("c2")).toBe(true);
	});

	it("stopVoiceTranscription is a safe no-op when no session is running", async () => {
		await expect(
			makeManager(undefined).stopVoiceTranscription("c1", "requested_stop"),
		).resolves.toBeUndefined();
	});
});

// ── Tee correctness ──────────────────────────────────────────────

describe("decoded-PCM tee", () => {
	it("both consumers (AudioMonitor reply path + meeting session) see every frame", async () => {
		// Production topology: ONE decoded PCM stream, two "data" listeners —
		// the AudioMonitor (utterance→agent-reply) and the meeting-session tee.
		const decoded = new PassThrough();

		const monitorChunks: Buffer[] = [];
		new AudioMonitor(
			decoded,
			10_000_000,
			() => {},
			(buffer) => monitorChunks.push(buffer),
		);

		const { session, pipeline } = makeSession();
		await session.start();
		decoded.on("data", (pcm: Buffer) =>
			session.pushPcm("u-alice", pcm, "Alice"),
		);

		const frames = [
			s16leBuffer([100, 200, 300]),
			s16leBuffer([-100, -200]),
			s16leBuffer([32767]),
		];
		decoded.emit("speakingStarted");
		for (const frame of frames) decoded.write(frame);
		await new Promise((resolve) => setImmediate(resolve));
		decoded.emit("speakingStopped");

		// Meeting path: every frame, converted, same total sample count.
		const teeSamples = pipeline.pushed.reduce(
			(acc, p) => acc + p.samples.length,
			0,
		);
		expect(pipeline.pushed).toHaveLength(frames.length);
		expect(teeSamples).toBe(6);

		// Reply path: speakingStopped flushed the same bytes to the callback.
		expect(Buffer.concat(monitorChunks)).toEqual(Buffer.concat(frames));
	});
});
