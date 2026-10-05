// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-local-inference";

afterEach(() => vi.restoreAllMocks());

const assessment = {
  tier: "GOOD",
  reasons: ["The runtime assessment"],
  canRunLocalLm: true,
  canRunLocalVoice: true,
  recommendedMode: "local",
  recommendedFit: null,
  numericContext: { vramGb: null, appleSilicon: true, mobile: false },
};

describe("authoritative local-inference assessment", () => {
  it("renders the runtime decision without reclassifying hardware", async () => {
    const client = new ElizaClient("http://127.0.0.1:31337");
    const fetch = vi
      .spyOn(client, "fetch")
      .mockResolvedValue({ tier: assessment });
    expect(await client.getLocalInferenceDeviceTier()).toMatchObject({
      tier: "GOOD",
      reason: "The runtime assessment",
      cpuOnly: false,
      mobile: false,
      canRunLocalLm: true,
      recommendedMode: "local",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/local-inference/device-tier",
    );
  });

  it("preserves transport failures without substituting an estimate", async () => {
    const client = new ElizaClient("http://127.0.0.1:31337");
    const error = new Error("agent unavailable");
    const fetch = vi.spyOn(client, "fetch").mockRejectedValue(error);
    await expect(client.getLocalInferenceDeviceTier()).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...assessment, tier: "unknown" },
    { ...assessment, tier: ["GOOD"] },
    { ...assessment, numericContext: {} },
    { ...assessment, recommendedFit: { contextLength: -1 } },
  ])("rejects malformed assessments", async (tier) => {
    const client = new ElizaClient("http://127.0.0.1:31337");
    const fetch = vi.spyOn(client, "fetch").mockResolvedValue({ tier });
    await expect(client.getLocalInferenceDeviceTier()).rejects.toMatchObject({
      code: "LOCAL_INFERENCE_DEVICE_TIER_RESPONSE_INVALID",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
