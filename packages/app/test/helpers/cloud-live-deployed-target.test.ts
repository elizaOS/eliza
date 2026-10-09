import { describe, expect, it, vi } from "vitest";
import { cloudLiveDeployedRendererOrigin } from "../cloud-live-deployed-target";
import {
  CloudLiveRequiredActionUnavailableError,
  chooseCloudRuntimeUnlessIdentityStarted,
} from "../cloud-live-optional-action";

describe("deployed Cloud smoke target", () => {
  it("pins production and staging to distinct first-party origins", () => {
    expect(cloudLiveDeployedRendererOrigin("production")).toBe(
      "https://cloud.eliza.app",
    );
    expect(cloudLiveDeployedRendererOrigin("staging")).toBe(
      "https://staging.eliza-app.pages.dev",
    );
    expect(() =>
      cloudLiveDeployedRendererOrigin("https://untrusted.example"),
    ).toThrow();
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
