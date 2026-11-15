/**
 * Concurrent MP4 audio extractions through AttachmentManager must not share
 * temp files. Extraction temp names used to derive only from Date.now(),
 * so two extractions that start in the same millisecond overwrote each
 * other's input and deleted each other's output: one side transcribed the
 * other's audio or failed on a cleanup-deleted file. This runs two real
 * extractions (ffmpeg/ffprobe) concurrently with a pinned clock and checks
 * each side returns its own audio.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentManager } from "../attachments.ts";

function makeMp4(frequency: number, dir: string, name: string): Buffer {
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
		"aac",
		out,
	]);
	return readFileSync(out);
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("attachment video temp isolation", () => {
	it("two concurrent extractions return their own audio", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "mp4-repro-"));
		dirs.push(dir);
		const bufA = makeMp4(440, dir, "a.mp4");
		const bufB = makeMp4(880, dir, "b.mp4");
		expect(bufA.equals(bufB)).toBe(false);

		const runtime = {
			agentId: "test-agent",
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		};
		const manager = new AttachmentManager(runtime as never);
		const extract = (
			manager as unknown as {
				extractAudioFromMP4: (data: Uint8Array) => Promise<Buffer>;
			}
		).extractAudioFromMP4.bind(manager);

		// Pin the clock: pre-fix, both calls derive identical temp paths.
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		let interference = 0;
		for (let round = 0; round < 5; round++) {
			const [a, b] = await Promise.allSettled([extract(bufA), extract(bufB)]);
			if (a.status === "rejected" || b.status === "rejected") {
				interference++;
				continue;
			}
			if (a.value.equals(b.value)) interference++;
		}
		expect(interference).toBe(0);
	});
});
