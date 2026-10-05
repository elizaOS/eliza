import { loadVoiceBootstrap } from "@elizaos/ui";
import { cachedDynamicImport } from "./app-module-cache";
/**
 * Single-flight loader for the lazy `voice-bootstrap` chunk on the boot
 * path. main() kicks the download off before the storage-bridge hydration
 * awaits so the chunk fetch overlaps the native Preferences round-trips
 * instead of serializing after them, then awaits the shared promise where the
 * platform actually consumes the module (mobile QA harnesses, the desktop
 * fused-wake registration).
 *
 * Resolves `null` on a load failure: a voice-chunk fetch error (e.g. a stale
 * index.html pointing at a purged hash during a redeploy) must never gate
 * mounting the app — callers skip the voice wiring and boot on.
 */

export type VoiceModule = Awaited<ReturnType<typeof loadVoiceBootstrap>>;

export function startVoiceModuleLoad(
  importer: () => Promise<VoiceModule> = loadVoiceBootstrap,
): Promise<VoiceModule | null> {
  return cachedDynamicImport("voice-bootstrap", importer).catch(
    (error: unknown) => {
      // error-policy:J4 designed degrade — the app mounts without the voice
      // harnesses / fused-wake bridge rather than white-screening on a chunk
      // load failure; the warn is the observable signal.
      console.warn("[boot] voice-bootstrap chunk unavailable", error);
      return null;
    },
  );
}
