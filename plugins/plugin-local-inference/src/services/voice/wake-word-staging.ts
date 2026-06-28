/**
 * Wake-word model staging (issue #9880).
 *
 * The voice-model auto-updater downloads each GGUF into the flat bundle voice
 * dir (`<state-dir>/models/voice/`) under a version-prefixed name, e.g.
 * `wakeword-0.3.0-hey-eliza.melspec.gguf`. The wake-word runtime, however,
 * resolves the standalone three-GGUF head from `<bundleRoot>/wake/` or
 * `<state-dir>/local-inference/wake/` under the canonical `<head>.<kind>.gguf`
 * names (see `resolveWakeWordStandalonePaths` in `wake-word.ts`).
 *
 * Those two locations + naming schemes don't match, so a freshly-downloaded
 * wake model was never found by the loader. This module bridges the two: it maps
 * a downloaded `wakeword` version onto the loader's expected layout and stages
 * (copies) the files into place. Pure planning is separated from the I/O so the
 * filename mapping is unit-testable without a filesystem.
 */

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { VoiceModelVersion } from "@elizaos/shared/local-inference";
import { localInferenceRoot } from "../paths";
import { OPENWAKEWORD_DIR_REL_PATH } from "./wake-word";

/** The loader's wake directory: `<state-dir>/local-inference/wake`. */
export function wakeStagingDir(): string {
	return path.join(localInferenceRoot(), OPENWAKEWORD_DIR_REL_PATH);
}

/** The downloader's final name for an asset: `<id>-<version>-<basename>`. */
export function downloadedAssetName(
	version: Pick<VoiceModelVersion, "id" | "version">,
	assetFilename: string,
): string {
	return `${version.id}-${version.version}-${path.basename(assetFilename)}`;
}

export interface WakeStageCopy {
	/** Absolute source path in the bundle voice dir. */
	from: string;
	/** Absolute destination path in the wake dir (`<head>.<kind>.gguf`). */
	to: string;
}

/**
 * Plan the copies that put a downloaded `wakeword` version where the runtime
 * loader resolves it. Returns `[]` for any non-wakeword id (nothing to stage).
 * The destination name is the asset's basename (already `<head>.<kind>.gguf`,
 * e.g. `hey-eliza.melspec.gguf`).
 */
export function planWakeWordStaging(
	version: VoiceModelVersion,
	bundleVoiceDir: string,
	wakeDir: string = wakeStagingDir(),
): WakeStageCopy[] {
	if (version.id !== "wakeword") return [];
	return version.ggufAssets.map((asset) => {
		const base = path.basename(asset.filename);
		return {
			from: path.join(bundleVoiceDir, downloadedAssetName(version, base)),
			to: path.join(wakeDir, base),
		};
	});
}

/**
 * Execute the staging plan: copy each downloaded wake GGUF into the loader's
 * wake dir under its canonical name. No-op for non-wakeword versions. Returns
 * the destination paths it wrote.
 */
export async function stageWakeWordModel(
	version: VoiceModelVersion,
	bundleVoiceDir: string,
	wakeDir: string = wakeStagingDir(),
): Promise<string[]> {
	const plan = planWakeWordStaging(version, bundleVoiceDir, wakeDir);
	if (plan.length === 0) return [];
	await mkdir(wakeDir, { recursive: true });
	for (const copy of plan) {
		await copyFile(copy.from, copy.to);
	}
	return plan.map((c) => c.to);
}
