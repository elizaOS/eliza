/**
 * Structured voice-startup failure.
 *
 * Per `packages/inference/AGENTS.md` §3 + §9 (no defensive code, no
 * log-and-continue), the engine MUST throw one of these when voice mode
 * is requested but cannot start (missing FFI, missing speaker preset,
 * missing fused build, missing required region, manifest mismatch). The
 * runtime then refuses to activate the model — never silently degrades to
 * text-only.
 *
 * Lives in its own module (rather than `engine-bridge.ts`) so the voice
 * sub-modules — `pipeline-impls.ts`, `vad.ts`, `embedding.ts` — can throw
 * it without importing the bridge (which imports them in turn, which
 * would be a cycle).
 */
export class VoiceStartupError extends Error {
  readonly code:
    | "missing-ffi"
    | "missing-speaker-preset"
    | "missing-bundle-root"
    | "missing-fused-build"
    | "already-started"
    | "not-started";

  constructor(code: VoiceStartupError["code"], message: string) {
    super(message);
    this.name = "VoiceStartupError";
    this.code = code;
  }
}
