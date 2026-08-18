/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves hardware and device-tier hops carry timeoutMs into Agent.request.
 */
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

describe("ElizaClient local-inference hardware native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the hardware deadline to Agent.request", async () => {
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

  it("forwards the device-tier deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(deviceTierPayload),
    );
    await makeClient(request).getLocalInferenceDeviceTier();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/device-tier",
      expect.any(Object),
      { timeoutMs: LOCAL_INFERENCE_DEVICE_TIER_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled hardware hop through ElizaClient", async () => {
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
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/hardware",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
