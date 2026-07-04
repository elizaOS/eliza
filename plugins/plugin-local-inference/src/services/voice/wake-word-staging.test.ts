/** Covers the wake-word staging plan (#9880). Deterministic. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { latestVoiceModelVersion } from "@elizaos/shared/local-inference";
import { describe, expect, it } from "vitest";
import {
	downloadedAssetName,
	planWakeWordStaging,
	stageWakeWordModel,
} from "./wake-word-staging";

describe("wake-word staging plan (#9880)", () => {
	const wake = latestVoiceModelVersion("wakeword");

	it("maps each downloaded GGUF onto the loader's wake/<head>.<kind>.gguf layout", () => {
		if (!wake) throw new Error("wakeword version missing");
		const plan = planWakeWordStaging(
			wake,
			"/state/models/voice",
			"/state/local-inference/wake",
		);
		expect(plan).toHaveLength(3);

		// The downloaded name is version-prefixed; the destination is the canonical
		// basename the runtime resolves.
		const byDest = Object.fromEntries(plan.map((c) => [c.to, c.from]));
		expect(byDest["/state/local-inference/wake/hey-eliza.melspec.gguf"]).toBe(
			"/state/models/voice/wakeword-0.3.0-hey-eliza.melspec.gguf",
		);
		expect(byDest["/state/local-inference/wake/hey-eliza.embedding.gguf"]).toBe(
			"/state/models/voice/wakeword-0.3.0-hey-eliza.embedding.gguf",
		);
		expect(
			byDest["/state/local-inference/wake/hey-eliza.classifier.gguf"],
		).toBe("/state/models/voice/wakeword-0.3.0-hey-eliza.classifier.gguf");
	});

	it("returns no copies for a non-wakeword model", () => {
		const vad = latestVoiceModelVersion("vad");
		if (!vad) throw new Error("vad version missing");
		expect(planWakeWordStaging(vad, "/x", "/y")).toEqual([]);
	});

	it("stageWakeWordModel copies the downloaded GGUFs into the wake dir", async () => {
		if (!wake) throw new Error("wakeword version missing");
		const root = await mkdtemp(path.join(tmpdir(), "wake-stage-"));
		const bundleVoiceDir = path.join(root, "models", "voice");
		const wakeDir = path.join(root, "local-inference", "wake");
		await mkdir(bundleVoiceDir, { recursive: true });
		// Lay down the downloaded (version-prefixed) files the downloader writes.
		for (const asset of wake.ggufAssets) {
			await writeFile(
				path.join(bundleVoiceDir, downloadedAssetName(wake, asset.filename)),
				"GGUF",
			);
		}

		const staged = await stageWakeWordModel(wake, bundleVoiceDir, wakeDir);

		expect(staged.sort()).toEqual(
			[
				path.join(wakeDir, "hey-eliza.classifier.gguf"),
				path.join(wakeDir, "hey-eliza.embedding.gguf"),
				path.join(wakeDir, "hey-eliza.melspec.gguf"),
			].sort(),
		);
		for (const p of staged) expect(existsSync(p)).toBe(true);
	});

	it("downloadedAssetName prefixes id + version", () => {
		expect(
			downloadedAssetName(
				{ id: "wakeword", version: "0.3.0" },
				"voice/wakeword/hey-eliza.melspec.gguf",
			),
		).toBe("wakeword-0.3.0-hey-eliza.melspec.gguf");
	});
});
