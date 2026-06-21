/**
 * Transcript audio persistence (#8789).
 *
 * The transcript create route runs in plugin-local-inference, which cannot
 * import the agent-internal media store (`packages/agent/src/api/media-store.ts`
 * is not exported). But that store is just a content-addressed write under
 * `<stateDir>/media/<sha256>.<ext>`, served by the agent's `serveMediaFile` at
 * `/api/media/<sha256>.<ext>` (with HTTP Range, so `<audio>` scrubbing works).
 * Writing the session WAV the same way — via core's `resolveStateDir` — lands it
 * in the exact dir the agent already serves, so transcript audio plays back
 * with zero extra wiring. Idempotent (sha256 filename).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "@elizaos/core";

/** Persist mono PCM16 WAV bytes; returns the served `/api/media/<hash>.wav` URL. */
export function persistTranscriptAudioWav(wav: Buffer): string {
	const hash = createHash("sha256").update(wav).digest("hex");
	const dir = join(resolveStateDir(), "media");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${hash}.wav`);
	if (!existsSync(file)) writeFileSync(file, wav);
	return `/api/media/${hash}.wav`;
}
