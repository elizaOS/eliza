import { describe, expect, it, vi } from "vitest";
import {
  cloudLiveDeployedRendererOrigin,
  STAGING_PAGES_ALIAS,
} from "../cloud-live-deployed-target";
import {
  CloudLiveRequiredActionUnavailableError,
  chooseCloudRuntimeUnlessIdentityStarted,
} from "../cloud-live-optional-action";
import { waitForRendererCloudApiOrigin } from "../cloud-live-renderer-api-readiness";

describe("deployed Cloud smoke target", () => {
  it("pins production and staging to distinct first-party origins", () => {
    expect(cloudLiveDeployedRendererOrigin("production")).toBe(
      "https://cloud.eliza.app",
    );
    expect(cloudLiveDeployedRendererOrigin("staging")).toBe(
      "https://cloud-staging.eliza.app",
    );
    expect(() =>
      cloudLiveDeployedRendererOrigin("https://untrusted.example"),
    ).toThrow();
  });

  it("observes the staging Pages proxy separately from the direct API", async () => {
    const app = cloudLiveDeployedRendererOrigin("staging");
    const api = "https://api-staging.eliza.app";
    await expect(
      waitForRendererCloudApiOrigin({
        mode: "same-origin",
        readCloudBase: async () => STAGING_PAGES_ALIAS,
        expectedApiOrigin: STAGING_PAGES_ALIAS,
        timeoutMs: 0,
      }),
    ).resolves.toEqual({
      cloudBase: STAGING_PAGES_ALIAS,
      apiOrigin: STAGING_PAGES_ALIAS,
    });
    await expect(
      waitForRendererCloudApiOrigin({
        mode: "direct",
        readCloudBase: async () => app,
        expectedApiOrigin: api,
        timeoutMs: 0,
      }),
    ).resolves.toEqual({ cloudBase: app, apiOrigin: api });
    await expect(
      waitForRendererCloudApiOrigin({
        mode: "same-origin",
        readCloudBase: async () => api,
        expectedApiOrigin: STAGING_PAGES_ALIAS,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(`resolved to ${api}; expected ${STAGING_PAGES_ALIAS}`);
  });
});

describe("automatic Cloud identity resolution", () => {
  it("does not replay a runtime choice after an identity request started", async () => {
    const choose = vi.fn();
    await chooseCloudRuntimeUnlessIdentityStarted(async () => true, choose);
    expect(choose).not.toHaveBeenCalled();
  });

  it("chooses the runtime when no identity request has started", async () => {
    const choose = vi.fn();
    await chooseCloudRuntimeUnlessIdentityStarted(async () => false, choose);
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("accepts a missing choice only when identity resolution started during the wait", async () => {
    const missing = new CloudLiveRequiredActionUnavailableError(
      "pre-identity-runtime-choice",
      "runtime-cloud",
    );
    const choose = vi.fn().mockRejectedValue(missing);
    const started = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await chooseCloudRuntimeUnlessIdentityStarted(started, choose);
    expect(choose).toHaveBeenCalledTimes(1);
    await expect(
      chooseCloudRuntimeUnlessIdentityStarted(async () => false, choose),
    ).rejects.toBe(missing);
  });

  it("preserves action failures even if identity resolution later starts", async () => {
    const failure = new Error("action failed");
    const started = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(
      chooseCloudRuntimeUnlessIdentityStarted(started, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
