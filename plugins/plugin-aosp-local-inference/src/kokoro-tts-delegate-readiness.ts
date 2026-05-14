/**
 * Readiness classifier for Android Kokoro TTS accelerator work.
 *
 * This intentionally does not register a runtime handler. Issue #7667 is
 * blocked until the #7666 CPU Kokoro path exists in the AOSP package; this
 * helper keeps that prerequisite and the hardware validation gates explicit.
 */

export type KokoroDelegatePath = "ort-nnapi" | "tflite-delegate";

export type KokoroDelegateReadinessStatus =
  | "blocked"
  | "ready-for-prototype"
  | "ready-for-hardware-validation";

export interface KokoroDelegateReadinessInput {
  /**
   * #7666 prerequisite: AOSP has a real local Kokoro TEXT_TO_SPEECH path.
   * This means a CPU baseline can synthesize audio on-device before any
   * accelerator delegate is selected.
   */
  cpuKokoroTtsPresent: boolean;
  /** Android API level of the validation target. NNAPI requires API 27+. */
  androidApiLevel?: number;
  /** The staged model format available to the delegate prototype. */
  modelFormat: "onnx" | "tflite" | "unknown";
  /** True only for Pixel 9-class or equivalent Tensor TPU/NPU hardware. */
  realTensorTpuDevice: boolean;
  /** Power telemetry available through batterystats/power rails. */
  powerTelemetryAvailable: boolean;
  /** Golden phrases + reference audio are staged for quality comparison. */
  qualityCorpusAvailable: boolean;
}

export interface KokoroDelegateReadiness {
  status: KokoroDelegateReadinessStatus;
  recommendedPath: KokoroDelegatePath | null;
  blockers: string[];
  validationPlan: string[];
}

export function assessKokoroDelegateReadiness(
  input: KokoroDelegateReadinessInput,
): KokoroDelegateReadiness {
  const blockers: string[] = [];
  const validationPlan: string[] = [];

  if (!input.cpuKokoroTtsPresent) {
    blockers.push(
      "#7666 is not present: AOSP must first register a CPU Kokoro TEXT_TO_SPEECH handler and produce a baseline TTFB/RTF run.",
    );
  }

  if (
    input.modelFormat === "onnx" &&
    input.androidApiLevel !== undefined &&
    input.androidApiLevel < 27
  ) {
    blockers.push("ORT NNAPI execution provider requires Android API 27+.");
  }

  const recommendedPath = recommendDelegatePath(input);
  if (recommendedPath === null) {
    blockers.push(
      "No delegate prototype path is selectable until either ONNX or TFLite Kokoro artifacts are staged.",
    );
  }

  validationPlan.push(
    "Record CPU Kokoro baseline on the same device: TTFB, RTF, peak RSS, and average voice-session power.",
    "Prototype ORT NNAPI first for ONNX artifacts; record per-op fallback to identify CPU-bound ScatterND/ConvTranspose sections.",
    "Prototype TFLite only after conversion quality is checked against the same phrase corpus.",
    "Approve only after sub-100 ms TTFB and sub-1 W average voice-session power are measured on real Tensor TPU/NPU hardware.",
  );

  if (blockers.length > 0) {
    return {
      status: "blocked",
      recommendedPath,
      blockers,
      validationPlan,
    };
  }

  const hardwareBlockers: string[] = [];
  if (!input.realTensorTpuDevice) {
    hardwareBlockers.push(
      "Real Tensor TPU/NPU hardware is required; Cuttlefish and generic ADB targets cannot validate accelerator dispatch or power.",
    );
  }
  if (!input.powerTelemetryAvailable) {
    hardwareBlockers.push(
      "Power telemetry is required for the #7667 acceptance target.",
    );
  }
  if (!input.qualityCorpusAvailable) {
    hardwareBlockers.push(
      "A phrase corpus with reference audio is required to catch delegate/conversion regressions.",
    );
  }

  return {
    status:
      hardwareBlockers.length > 0
        ? "ready-for-prototype"
        : "ready-for-hardware-validation",
    recommendedPath,
    blockers: hardwareBlockers,
    validationPlan,
  };
}

function recommendDelegatePath(
  input: KokoroDelegateReadinessInput,
): KokoroDelegatePath | null {
  if (input.modelFormat === "onnx") return "ort-nnapi";
  if (input.modelFormat === "tflite") return "tflite-delegate";
  return null;
}
