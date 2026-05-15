import { describe, expect, it } from "vitest";

import { assessKokoroDelegateReadiness } from "../src/kokoro-tts-delegate-readiness";

describe("assessKokoroDelegateReadiness", () => {
  it("blocks delegate work until the AOSP CPU Kokoro TTS prerequisite exists", () => {
    const result = assessKokoroDelegateReadiness({
      cpuKokoroTtsPresent: false,
      androidApiLevel: 35,
      modelFormat: "onnx",
      realTensorTpuDevice: true,
      powerTelemetryAvailable: true,
      qualityCorpusAvailable: true,
    });

    expect(result.status).toBe("blocked");
    expect(result.recommendedPath).toBe("ort-nnapi");
    expect(result.blockers.join("\n")).toMatch(/#7666/);
  });

  it("keeps ONNX NNAPI blocked on old Android API levels", () => {
    const result = assessKokoroDelegateReadiness({
      cpuKokoroTtsPresent: true,
      androidApiLevel: 26,
      modelFormat: "onnx",
      realTensorTpuDevice: true,
      powerTelemetryAvailable: true,
      qualityCorpusAvailable: true,
    });

    expect(result.status).toBe("blocked");
    expect(result.recommendedPath).toBe("ort-nnapi");
    expect(result.blockers).toContain(
      "ORT NNAPI execution provider requires Android API 27+.",
    );
  });

  it("allows a prototype before real Tensor TPU hardware is available", () => {
    const result = assessKokoroDelegateReadiness({
      cpuKokoroTtsPresent: true,
      androidApiLevel: 35,
      modelFormat: "onnx",
      realTensorTpuDevice: false,
      powerTelemetryAvailable: false,
      qualityCorpusAvailable: true,
    });

    expect(result.status).toBe("ready-for-prototype");
    expect(result.recommendedPath).toBe("ort-nnapi");
    expect(result.blockers.join("\n")).toMatch(/Real Tensor TPU/);
    expect(result.blockers.join("\n")).toMatch(/Power telemetry/);
  });

  it("marks TFLite artifacts ready for hardware validation when all gates are present", () => {
    const result = assessKokoroDelegateReadiness({
      cpuKokoroTtsPresent: true,
      androidApiLevel: 35,
      modelFormat: "tflite",
      realTensorTpuDevice: true,
      powerTelemetryAvailable: true,
      qualityCorpusAvailable: true,
    });

    expect(result.status).toBe("ready-for-hardware-validation");
    expect(result.recommendedPath).toBe("tflite-delegate");
    expect(result.blockers).toEqual([]);
  });

  it("blocks when no ONNX or TFLite Kokoro artifact is selectable", () => {
    const result = assessKokoroDelegateReadiness({
      cpuKokoroTtsPresent: true,
      androidApiLevel: 35,
      modelFormat: "unknown",
      realTensorTpuDevice: true,
      powerTelemetryAvailable: true,
      qualityCorpusAvailable: true,
    });

    expect(result.status).toBe("blocked");
    expect(result.recommendedPath).toBeNull();
    expect(result.blockers.join("\n")).toMatch(/No delegate prototype path/);
  });
});
