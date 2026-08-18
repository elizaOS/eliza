/** Verifies local-inference hardware / device-tier hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  LOCAL_INFERENCE_DEVICE_TIER_FETCH_TIMEOUT_MS,
  LOCAL_INFERENCE_HARDWARE_FETCH_TIMEOUT_MS,
} from "./client-local-inference";
import "./client-local-inference";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const hardwareProbe = {
  totalRamGb: 16,
  freeRamGb: 8,
  gpu: null,
  cpuCores: 8,
  platform: "linux",
  arch: "x64",
  appleSilicon: false,
  recommendedBucket: "mid",
  source: "os-fallback",
};

const deviceTierPayload = {
  tier: {
    tier: "GOOD",
    reasons: ["16 GB RAM"],
    canRunLocalLm: true,
    canRunLocalVoice: true,
    recommendedMode: "local",
    recommendedFit: null,
    numericContext: { vramGb: null, appleSilicon: false, mobile: false },
  },
};

describe("ElizaClient local-inference hardware native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(LOCAL_INFERENCE_HARDWARE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(LOCAL_INFERENCE_DEVICE_TIER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes hardware timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(hardwareProbe),
    );
    await makeClient(request).getLocalInferenceHardware();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/hardware",
      expect.any(Object),
      { timeoutMs: LOCAL_INFERENCE_HARDWARE_FETCH_TIMEOUT_MS },
    );
  });

  it("passes device-tier timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(deviceTierPayload),
    );
    await makeClient(request).getLocalInferenceDeviceTier();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/device-tier",
      expect.any(Object),
      { timeoutMs: LOCAL_INFERENCE_DEVICE_TIER_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled hardware hop as TimeoutError", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        await new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              Object.assign(new Error(`Request timed out after ${ms}ms`), {
                name: "TimeoutError",
              }),
            );
          }, ms);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      },
    );
    await expect(
      makeClient(request).getLocalInferenceHardware(10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
  });

  it("surfaces a provider error from a completed hardware GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      makeClient(request).getLocalInferenceHardware(),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
