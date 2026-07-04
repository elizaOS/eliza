/**
 * Influencer-profile action tests (CREATE_INFLUENCER_PROFILE and related). The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { CreateInfluencerProfileInput } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeMessage,
  resetSdk,
  setCreateInfluencerProfile,
  setListInfluencers,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { createInfluencerProfileAction, listInfluencersAction } = await import(
  "../src/actions/influencer.ts"
);

describe("CREATE_INFLUENCER_PROFILE", () => {
  beforeEach(() => resetSdk());

  it("validate: true with key, false without", async () => {
    expect(
      await createInfluencerProfileAction.validate(
        keyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(true);
    expect(
      await createInfluencerProfileAction.validate(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("no key → no_key", async () => {
    const cb = captureCallback();
    const res = await createInfluencerProfileAction.handler(
      unkeyedRuntime(),
      makeMessage("become an influencer"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_key" });
  });

  it("publishes a profile with the given niche", async () => {
    let captured: CreateInfluencerProfileInput | null = null;
    setCreateInfluencerProfile((input) => {
      captured = input;
      return Promise.resolve({
        success: true,
        profile: {
          id: "inf_x",
          display_name: input.displayName,
          niche: input.niche ?? null,
          bio: null,
          platforms: [],
          status: "active",
        },
      });
    });
    const cb = captureCallback();
    const res = await createInfluencerProfileAction.handler(
      keyedRuntime(),
      makeMessage("list me as a tech influencer"),
      undefined,
      { displayName: "Nova", niche: "tech" },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(captured).toMatchObject({ displayName: "Nova", niche: "tech" });
  });
});

describe("LIST_INFLUENCERS", () => {
  beforeEach(() => resetSdk());

  it("reports empty results", async () => {
    const cb = captureCallback();
    const res = await listInfluencersAction.handler(
      keyedRuntime(),
      makeMessage("find influencers"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(res.userFacingText).toContain("No influencer profiles");
  });

  it("lists profiles with aggregated reach", async () => {
    setListInfluencers(() =>
      Promise.resolve({
        success: true,
        profiles: [
          {
            id: "a",
            display_name: "Nova",
            niche: "tech",
            bio: null,
            status: "active",
            platforms: [
              { platform: "x", handle: "@nova", followers: 40000 },
              { platform: "yt", handle: "nova", followers: 10000 },
            ],
          },
        ],
      }),
    );
    const cb = captureCallback();
    const res = await listInfluencersAction.handler(
      keyedRuntime(),
      makeMessage("find tech influencers"),
      undefined,
      { niche: "tech" },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(res.userFacingText).toContain("Nova");
    expect(res.userFacingText).toContain("50,000");
  });
});
