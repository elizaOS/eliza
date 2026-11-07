/**
 * A video file uploaded to Discord is not a YouTube link: the stock video
 * service only claims youtube/vimeo URLs, so a .mov (the format iPhones
 * upload) or .webm attachment fell through to `processVideoAttachment` and
 * came back as "A video attachment" with no text at all, while an .mp4
 * upload is transcribed. The agent could not hear anything in the video.
 * Non-MP4 uploads must get the same audio-extraction + transcription
 * treatment MP4 uploads already get; a linked video the service can handle
 * still goes through the service.
 *
 * The network fetch is stubbed to bytes generated locally (Discord's CDN is
 * not reachable from a test), and the transcription model is stubbed as an
 * external model; the routing, ffmpeg extraction and media shaping under
 * test are real.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Attachment } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentManager } from "../attachments.ts";

const stubbedBytes = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("@elizaos/core", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>;
	return {
		...original,
		resolveAttachmentBytes: async (url: string) => {
			const buffer = stubbedBytes.get(url);
			if (!buffer) {
				throw new Error(`no stubbed bytes for ${url}`);
			}
			return { buffer, contentType: "application/octet-stream" };
		},
	};
});

// Imported after the mock so the test sees the same module graph.
const { ContentType, ModelType, ServiceType } = await import("@elizaos/core");

function makeVideo(
	frequency: number,
	dir: string,
	name: string,
	codec: string,
): Buffer {
	const out = path.join(dir, name);
	execFileSync("ffmpeg", [
		"-y",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=${frequency}:duration=2`,
		"-c:a",
		codec,
		out,
	]);
	return readFileSync(out);
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	stubbedBytes.clear();
	vi.restoreAllMocks();
});

function makeManager(videoService: unknown) {
	const runtime = {
		agentId: "test-agent",
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		getSetting: () => undefined,
		getModel: () => undefined,
		getService: (type: unknown) =>
			type === ServiceType.VIDEO ? videoService : null,
		useModel: async (modelType: unknown) =>
			modelType === ModelType.TRANSCRIPTION ? "hello from the video" : "",
	};
	return new AttachmentManager(runtime as never);
}

function attachment(
	id: string,
	url: string,
	name: string,
	contentType: string,
): Attachment {
	return { id, url, name, contentType } as unknown as Attachment;
}

/** Stock plugin-video behaviour for a Discord CDN URL: not a video URL. */
const cdnOnlyVideoService = { isVideoUrl: () => false };

describe("non-MP4 Discord video attachments", () => {
	it("transcribes a .mov upload instead of dropping its content", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "mov-repro-"));
		dirs.push(dir);
		const bytes = makeVideo(440, dir, "clip.mov", "aac");
		const url = "https://cdn.discordapp.com/attachments/1/clip.mov";
		stubbedBytes.set(url, bytes);

		const media = await makeManager(cdnOnlyVideoService).processAttachment(
			attachment("att-mov", url, "clip.mov", "video/quicktime"),
		);

		expect(media).not.toBeNull();
		expect(media?.contentType).toBe(ContentType.VIDEO);
		expect(media?.source).toBe("Video");
		expect(media?.text).toBe("hello from the video");
		expect(media?.description).toBe("hello from the video");
	});

	it("transcribes a .webm upload instead of dropping its content", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "webm-repro-"));
		dirs.push(dir);
		const bytes = makeVideo(880, dir, "clip.webm", "libopus");
		const url = "https://cdn.discordapp.com/attachments/1/clip.webm";
		stubbedBytes.set(url, bytes);

		const media = await makeManager(cdnOnlyVideoService).processAttachment(
			attachment("att-webm", url, "clip.webm", "video/webm"),
		);

		expect(media).not.toBeNull();
		expect(media?.contentType).toBe(ContentType.VIDEO);
		expect(media?.text).toBe("hello from the video");
	});

	it("extracts real mp3 audio from a non-MP4 container", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "mov-extract-"));
		dirs.push(dir);
		const bytes = makeVideo(440, dir, "clip.mov", "aac");
		const manager = makeManager(cdnOnlyVideoService);
		const extract = (
			manager as unknown as {
				extractAudioFromVideoData: (
					data: Uint8Array,
					extension: string,
				) => Promise<Buffer>;
			}
		).extractAudioFromVideoData.bind(manager);

		const audio = await extract(bytes, ".mov");
		expect(audio.length).toBeGreaterThan(0);
		const probeFile = path.join(dir, "out.mp3");
		writeFileSync(probeFile, audio);
		const probe = execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"stream=codec_type,codec_name",
				"-of",
				"csv=p=0",
				probeFile,
			],
			{ encoding: "utf8" },
		);
		expect(probe).toContain("audio");
		expect(probe).toContain("mp3");
	});

	it("degrades to a transcription-failed fallback for an unextractable video", async () => {
		const url = "https://cdn.discordapp.com/attachments/1/broken.mov";
		stubbedBytes.set(url, Buffer.from("this is not a video file"));

		const media = await makeManager(cdnOnlyVideoService).processAttachment(
			attachment("att-broken", url, "broken.mov", "video/quicktime"),
		);

		expect(media).not.toBeNull();
		expect(media?.contentType).toBe(ContentType.VIDEO);
		expect(media?.description).toBe(
			"An audio/video attachment (transcription failed)",
		);
		expect(media?.text).toBe("");
	});

	it("still routes a service-handled video URL through the video service", async () => {
		const service = {
			isVideoUrl: () => true,
			processVideo: async () => ({
				title: "Linked video",
				description: "A linked video",
				text: "linked video text",
			}),
		};
		const media = await makeManager(service).processAttachment(
			attachment(
				"att-yt",
				"https://www.youtube.com/watch?v=example",
				"video",
				"application/octet-stream",
			),
		);

		expect(media?.title).toBe("Linked video");
		expect(media?.text).toBe("linked video text");
		expect(media?.source).toBe("YouTube");
	});
});
