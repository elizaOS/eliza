/**
 * Voice backend selection — picks between OmniVoice and Kokoro at engine
 * arm time.
 *
 * The scheduler is backend-agnostic — both implementations satisfy
 * `OmniVoiceBackend + StreamingTtsBackend`. This module isolates the
 * decision logic so the engine layer (or a test) can ask "which backend
 * should I instantiate?" and get a single, auditable answer.
 *
 * Decision modes:
 *
 *   - `omnivoice` — force OmniVoice. Used when the caller needs voice
 *      cloning (Kokoro v1.0 has fixed voice packs, no per-user cloning).
 *   - `kokoro`    — force Kokoro. Used when the caller cares about
 *      first-audio latency over voice fidelity (Kokoro ≈ 97ms CPU TTFB,
 *      OmniVoice ≈ 200ms on the fused build).
 *   - `auto`      — apply the documented heuristic below.
 *
 * `auto` heuristic (deterministic, no model probes — those go through the
 * autotune layer in `voice/scheduler.ts`):
 *
 *   1. If `requireVoiceCloning === true` → OmniVoice.
 *   2. If `targetTtfaMs` is set and < 200 → Kokoro.
 *   3. If a Kokoro RTF measurement is available and OmniVoice RTF is not,
 *      or Kokoro RTF beats OmniVoice by ≥ 10% → Kokoro.
 *   4. Else → OmniVoice (the default for the existing fused build).
 *
 * The decision returns a tagged discriminated union, not a backend
 * instance, so the engine layer can instantiate the chosen backend with
 * its own dependencies (FFI handle / Kokoro runtime / etc.). This keeps
 * the selection logic unit-testable without dragging the ORT or FFI
 * surfaces into the test graph.
 */

export type VoiceBackendChoice = "omnivoice" | "kokoro";

export type VoiceBackendMode = VoiceBackendChoice | "auto";

export interface VoiceBackendInputs {
  /** Caller-set mode. Defaults to `auto`. */
  mode?: VoiceBackendMode;
  /** Time-to-first-audio target (ms). Lower → prefer Kokoro. */
  targetTtfaMs?: number;
  /** Whether the caller needs per-user voice cloning. */
  requireVoiceCloning?: boolean;
  /** Latest measured RTF for Kokoro on this device (audio_seconds / wall_seconds). */
  kokoroRtf?: number | null;
  /** Latest measured RTF for OmniVoice on this device. */
  omnivoiceRtf?: number | null;
  /** Whether Kokoro model artifacts are present on disk. The selector
   *  never returns Kokoro when this is `false` — no silent downgrade. */
  kokoroAvailable: boolean;
  /** Whether the OmniVoice FFI library is present on disk. */
  omnivoiceAvailable: boolean;
}

export interface VoiceBackendDecision {
  backend: VoiceBackendChoice;
  /** One-line reason — surfaced to telemetry. */
  reason: string;
}

const TTFA_CUTOFF_MS = 200;
const RTF_MARGIN = 1.1; // Kokoro must beat OmniVoice by 10% to win on RTF.

/** Resolve the env override (`ELIZA_TTS_BACKEND=kokoro|omnivoice|auto`). */
export function readVoiceBackendModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VoiceBackendMode | undefined {
  const raw = env.ELIZA_TTS_BACKEND?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "kokoro" || raw === "omnivoice" || raw === "auto") return raw;
  throw new Error(
    `[voice] ELIZA_TTS_BACKEND must be one of 'kokoro', 'omnivoice', 'auto' (got '${raw}')`,
  );
}

export function selectVoiceBackend(
  inputs: VoiceBackendInputs,
): VoiceBackendDecision {
  const mode = inputs.mode ?? "auto";

  if (mode === "kokoro") {
    if (!inputs.kokoroAvailable) {
      throw new Error(
        "[voice] ELIZA_TTS_BACKEND=kokoro but Kokoro model artifacts are not present on disk",
      );
    }
    return { backend: "kokoro", reason: "forced via mode=kokoro" };
  }

  if (mode === "omnivoice") {
    if (!inputs.omnivoiceAvailable) {
      throw new Error(
        "[voice] ELIZA_TTS_BACKEND=omnivoice but the OmniVoice FFI library is not present",
      );
    }
    return { backend: "omnivoice", reason: "forced via mode=omnivoice" };
  }

  // `auto` — apply heuristics.
  if (inputs.requireVoiceCloning) {
    if (!inputs.omnivoiceAvailable) {
      throw new Error(
        "[voice] voice cloning required but OmniVoice FFI library is not available; Kokoro v1.0 has no per-user cloning",
      );
    }
    return {
      backend: "omnivoice",
      reason: "voice cloning required (Kokoro v1.0 cannot clone)",
    };
  }

  if (
    inputs.targetTtfaMs !== undefined &&
    inputs.targetTtfaMs < TTFA_CUTOFF_MS
  ) {
    if (inputs.kokoroAvailable) {
      return {
        backend: "kokoro",
        reason: `targetTtfaMs=${inputs.targetTtfaMs} < ${TTFA_CUTOFF_MS} → Kokoro (~97ms CPU TTFB)`,
      };
    }
    if (!inputs.omnivoiceAvailable) {
      throw new Error(
        "[voice] no TTS backend available (neither Kokoro model nor OmniVoice FFI library on disk)",
      );
    }
    return {
      backend: "omnivoice",
      reason: "targetTtfaMs requested but Kokoro artifacts missing",
    };
  }

  if (
    inputs.kokoroAvailable &&
    inputs.kokoroRtf !== null &&
    inputs.kokoroRtf !== undefined &&
    inputs.kokoroRtf > 0
  ) {
    if (
      inputs.omnivoiceRtf === null ||
      inputs.omnivoiceRtf === undefined ||
      inputs.omnivoiceRtf <= 0
    ) {
      return {
        backend: "kokoro",
        reason: `Kokoro RTF=${inputs.kokoroRtf.toFixed(2)} measured; OmniVoice RTF unknown`,
      };
    }
    if (inputs.kokoroRtf >= inputs.omnivoiceRtf * RTF_MARGIN) {
      return {
        backend: "kokoro",
        reason: `Kokoro RTF=${inputs.kokoroRtf.toFixed(2)} beats OmniVoice RTF=${inputs.omnivoiceRtf.toFixed(2)} by ≥10%`,
      };
    }
  }

  if (!inputs.omnivoiceAvailable && inputs.kokoroAvailable) {
    return {
      backend: "kokoro",
      reason: "OmniVoice FFI library not available; Kokoro is the only option",
    };
  }
  if (!inputs.omnivoiceAvailable && !inputs.kokoroAvailable) {
    throw new Error(
      "[voice] no TTS backend available (neither Kokoro model nor OmniVoice FFI library on disk)",
    );
  }
  return {
    backend: "omnivoice",
    reason: "default — OmniVoice on the fused build",
  };
}
