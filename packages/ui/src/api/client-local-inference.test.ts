/**
 * Covers local-inference client policy helpers: deterministic device-tier
 * classification and the real fetch boundary for atomic text routing.
 */
import { ElizaError } from "@elizaos/core/errors";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HardwareProbe } from "../services/local-inference/types";
import { ElizaClient } from "./client-base";
import {
  classifyDeviceTierFromProbe,
  LOCAL_INFERENCE_HARDWARE_RESPONSE_INVALID_CODE,
} from "./client-local-inference";

afterEach(() => {
  vi.restoreAllMocks();
});

function probe(overrides: Partial<HardwareProbe>): HardwareProbe {
  return {
    totalRamGb: 16,
    freeRamGb: 8,
    gpu: null,
    cpuCores: 8,
    platform: "linux",
    arch: "x64",
    appleSilicon: false,
    recommendedBucket: "mid",
    source: "os-fallback",
    ...overrides,
  };
}

describe("classifyDeviceTierFromProbe", () => {
  it("classifies a high-VRAM dGPU host as MAX", () => {
    const result = classifyDeviceTierFromProbe(
      probe({
        totalRamGb: 64,
        freeRamGb: 32,
        gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 20 },
      }),
    );
    expect(result.tier).toBe("MAX");
    expect(result.cpuOnly).toBe(false);
    expect(result.mobile).toBe(false);
    expect(result.reason).toContain("24 GB VRAM");
  });

  it("classifies a mid dGPU host as GOOD", () => {
    const result = classifyDeviceTierFromProbe(
      probe({
        totalRamGb: 32,
        freeRamGb: 12,
        gpu: { backend: "cuda", totalVramGb: 8, freeVramGb: 6 },
      }),
    );
    expect(result.tier).toBe("GOOD");
  });

  it("classifies a roomy CPU-only x86 host as GOOD", () => {
    const result = classifyDeviceTierFromProbe(
      probe({ totalRamGb: 32, freeRamGb: 12, gpu: null }),
    );
    expect(result.tier).toBe("GOOD");
    expect(result.cpuOnly).toBe(true);
  });

  it("classifies a constrained CPU-only host as OKAY", () => {
    const result = classifyDeviceTierFromProbe(
      probe({ totalRamGb: 16, freeRamGb: 4, gpu: null }),
    );
    expect(result.tier).toBe("OKAY");
  });

  it("classifies a tiny/weak host as POOR", () => {
    const result = classifyDeviceTierFromProbe(
      probe({ totalRamGb: 8, freeRamGb: 1, cpuCores: 2, gpu: null }),
    );
    expect(result.tier).toBe("POOR");
  });

  it("clamps mobile devices to OKAY at best", () => {
    const result = classifyDeviceTierFromProbe(
      probe({
        totalRamGb: 16,
        freeRamGb: 12,
        gpu: { backend: "metal", totalVramGb: 16, freeVramGb: 14 },
        platform: "darwin",
        arch: "arm64",
        appleSilicon: true,
        mobile: { platform: "ios" },
      }),
    );
    expect(result.tier).toBe("OKAY");
    expect(result.mobile).toBe(true);
  });

  it("marks a memory-starved mobile device as POOR", () => {
    const result = classifyDeviceTierFromProbe(
      probe({
        totalRamGb: 4,
        freeRamGb: 1,
        mobile: { platform: "android" },
      }),
    );
    expect(result.tier).toBe("POOR");
    expect(result.mobile).toBe(true);
  });
});

describe("getLocalInferenceHub", () => {
  it("rejects malformed hardware before UI state can render it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          catalog: [],
          installed: [],
          active: { modelId: null, loadedAt: null, status: "idle" },
          downloads: [],
          hardware: { status: "unsupported" },
          assignments: {},
          textReadiness: { updatedAt: new Date(0).toISOString(), slots: {} },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = new ElizaClient("http://127.0.0.1:31337", "token");

    const request = client.getLocalInferenceHub();
    await expect(request).rejects.toBeInstanceOf(ElizaError);
    await expect(request).rejects.toMatchObject({
      message: expect.stringContaining("Hardware details are unavailable"),
      code: LOCAL_INFERENCE_HARDWARE_RESPONSE_INVALID_CODE,
      context: {
        path: "response.hardware.totalRamGb",
        expected: "a finite non-negative number",
      },
    });
  });

  it.each([
    {
      label: "negative RAM",
      override: { totalRamGb: -1 },
      path: "response.hardware.totalRamGb",
    },
    {
      label: "fractional CPU core count",
      override: { cpuCores: 2.5 },
      path: "response.hardware.cpuCores",
    },
    {
      label: "empty platform",
      override: { platform: "" },
      path: "response.hardware.platform",
    },
    {
      label: "non-boolean Apple Silicon flag",
      override: { appleSilicon: "true" },
      path: "response.hardware.appleSilicon",
    },
    {
      label: "missing GPU field",
      override: { gpu: undefined },
      path: "response.hardware.gpu",
    },
    {
      label: "unsupported model bucket string",
      override: { recommendedBucket: "tiny" },
      path: "response.hardware.recommendedBucket",
    },
    {
      label: "array model bucket",
      override: { recommendedBucket: ["small"] },
      path: "response.hardware.recommendedBucket",
    },
    {
      label: "array probe source",
      override: { source: ["os-fallback"] },
      path: "response.hardware.source",
    },
    {
      label: "array GPU backend",
      override: {
        gpu: {
          backend: ["vulkan"],
          totalVramGb: 8,
          freeVramGb: 6,
        },
      },
      path: "response.hardware.gpu.backend",
    },
  ])("rejects a $label instead of coercing it", async ({ override, path }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          catalog: [],
          installed: [],
          active: { modelId: null, loadedAt: null, status: "idle" },
          downloads: [],
          hardware: { ...probe({}), ...override },
          assignments: {},
          textReadiness: { updatedAt: new Date(0).toISOString(), slots: {} },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = new ElizaClient("http://127.0.0.1:31337", "token");

    await expect(client.getLocalInferenceHub()).rejects.toMatchObject({
      code: LOCAL_INFERENCE_HARDWARE_RESPONSE_INVALID_CODE,
      context: { path },
    });
  });

  it("accepts the canonical iOS zero-core fallback", async () => {
    const snapshot = {
      catalog: [],
      installed: [],
      active: { modelId: null, loadedAt: null, status: "idle" },
      downloads: [],
      hardware: probe({
        cpuCores: 0,
        platform: "darwin",
        arch: "arm64",
        appleSilicon: true,
        mobile: { platform: "ios" },
      }),
      assignments: {},
      textReadiness: { updatedAt: new Date(0).toISOString(), slots: {} },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ElizaClient("http://127.0.0.1:31337", "token");

    await expect(client.getLocalInferenceHub()).resolves.toEqual(snapshot);
  });

  it("accepts the canonical hardware probe contract", async () => {
    const snapshot = {
      catalog: [],
      installed: [],
      active: { modelId: null, loadedAt: null, status: "idle" },
      downloads: [],
      hardware: probe({
        gpu: { backend: "vulkan", totalVramGb: 8, freeVramGb: 6 },
      }),
      assignments: {},
      textReadiness: { updatedAt: new Date(0).toISOString(), slots: {} },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ElizaClient("http://127.0.0.1:31337", "token");

    await expect(client.getLocalInferenceHub()).resolves.toEqual(snapshot);
  });
});

describe("getLocalInferenceHardware", () => {
  it("rejects malformed direct hardware before device-tier classification", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "unsupported" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ElizaClient("http://127.0.0.1:31337", "token");

    await expect(client.getLocalInferenceHardware()).rejects.toMatchObject({
      code: LOCAL_INFERENCE_HARDWARE_RESPONSE_INVALID_CODE,
      context: {
        path: "response.hardware.totalRamGb",
        expected: "a finite non-negative number",
      },
    });
  });

  it("accepts the canonical direct iOS zero-core fallback", async () => {
    const hardware = probe({
      cpuCores: 0,
      platform: "darwin",
      arch: "arm64",
      appleSilicon: true,
      mobile: { platform: "ios" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(hardware), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ElizaClient("http://127.0.0.1:31337", "token");

    await expect(client.getLocalInferenceHardware()).resolves.toEqual(hardware);
  });
});

describe("setLocalInferenceTextRouting", () => {
  it("publishes both text slots through one atomic request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ preferences: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ElizaClient("http://127.0.0.1:31337", "token");

    await client.setLocalInferenceTextRouting("elizacloud", "manual");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/local-inference/routing/text");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({
      provider: "elizacloud",
      policy: "manual",
    });
  });
});
