/**
 * One shared, initialized `VoiceProfileStore` per state dir — the single
 * identity registry both voice pipelines resolve against.
 *
 * Pipeline A (the Android live-frames path, `live-diarization-session.ts`) and
 * Pipeline B (the desktop speak-back loop, `engine.ts` → `engine-bridge.ts`)
 * must attribute the *same* person to the *same* profile regardless of which
 * path heard them. If each were free to `new VoiceProfileStore(...)` at its own
 * `$ELIZA_STATE_DIR/voice-profiles/` root, two stores over one dir would race on
 * the shared `index.json` + `vp_*.json` records. This factory memoizes one
 * initialized store per resolved root so the two consumers share centroids,
 * Welford refinement, LRU state, and entity bindings.
 *
 * Handle contract (issue #12257) — how the downstream sub-issues obtain the
 * store #12257 wires into the speak-back loop:
 *   - #12256 (echo / self-voice imprint) and #12255 (speaker-gated barge-in)
 *     both call `getSharedVoiceProfileStore()` (no args) to get the exact same
 *     initialized instance the engine threaded into `startVoice(...)`. It is
 *     already `init()`-ed and rooted at the canonical dir — callers never
 *     construct their own store or call `init()` again.
 */

import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import { VoiceProfileStore } from "../profile-store";

/** Canonical on-disk root for voice profiles under the resolved state dir. */
export function resolveVoiceProfilesDir(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return path.join(resolveStateDir(env), "voice-profiles");
}

/** Memoized initialized stores, keyed by resolved root dir. */
const stores = new Map<string, Promise<VoiceProfileStore>>();

/**
 * Resolve the one shared, initialized `VoiceProfileStore` for `rootDir`
 * (default: the canonical `$ELIZA_STATE_DIR/voice-profiles/`). Concurrent
 * callers await the same in-flight `init()`; a failed init is not cached, so a
 * transient disk error can be retried on the next call.
 */
export function getSharedVoiceProfileStore(
	rootDir: string = resolveVoiceProfilesDir(),
): Promise<VoiceProfileStore> {
	const existing = stores.get(rootDir);
	if (existing) return existing;
	const pending = (async () => {
		const store = new VoiceProfileStore({ rootDir });
		await store.init();
		return store;
	})();
	pending.catch(() => stores.delete(rootDir));
	stores.set(rootDir, pending);
	return pending;
}

/** Drop all memoized stores. Test-only: lets a suite pin a fresh temp root. */
export function __resetSharedVoiceProfileStoresForTest(): void {
	stores.clear();
}
