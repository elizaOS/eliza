/**
 * Single-flight loader for the lazy `@elizaos/ui/voice` chunk on the boot
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

export type VoiceModule = typeof import("@elizaos/ui/voice");

let voiceModuleLoad: Promise<VoiceModule | null> | null = null;

export function startVoiceModuleLoad(
  importer: () => Promise<VoiceModule> = () => import("@elizaos/ui/voice"),
): Promise<VoiceModule | null> {
  voiceModuleLoad ??= importer().catch((error: unknown) => {
    // error-policy:J4 designed degrade — the app mounts without the voice
    // harnesses / fused-wake bridge rather than white-screening on a chunk
    // load failure; the warn is the observable signal.
    console.warn("[boot] @elizaos/ui/voice chunk unavailable", error);
    return null;
  });
  return voiceModuleLoad;
}
