/** Unit tests for `xIdentityProvider`, asserting the identity context rendered from a supplied `TwitterProfile`; no network. */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { TwitterProfile } from "./base";
import { xIdentityProvider } from "./identity-provider";

function makeRuntime(profile: TwitterProfile | null): IAgentRuntime {
  const service = { getActiveProfile: () => profile };
  return {
    getService: (serviceType: string) => (serviceType === "x" ? service : null),
  } as unknown as IAgentRuntime;
}

const EMPTY_MESSAGE = {} as Memory;
const EMPTY_STATE = {} as State;

describe("TWITTER_IDENTITY provider", () => {
  it("surfaces username, screen name, bio, and nicknames", async () => {
    const profile: TwitterProfile = {
      id: "123",
      username: "eliza_os",
      screenName: "Eliza",
      bio: "an autonomous agent that ships",
      nicknames: ["E", "the agent"],
    };
    const result = await xIdentityProvider.get(
      makeRuntime(profile),
      EMPTY_MESSAGE,
      EMPTY_STATE,
    );

    expect(result.text).toContain("@eliza_os");
    expect(result.text).toContain("Eliza");
    expect(result.text).toContain("an autonomous agent that ships");
    expect(result.text).toContain("E, the agent");

    expect(result.values?.twitterUserName).toBe("eliza_os");
    expect(result.values?.twitterScreenName).toBe("Eliza");
    expect(result.values?.twitterBio).toBe("an autonomous agent that ships");
    expect(result.values?.twitterNicknames).toBe("E, the agent");

    expect(result.data?.twitterProfile).toEqual({
      id: "123",
      username: "eliza_os",
      screenName: "Eliza",
      bio: "an autonomous agent that ships",
      nicknames: ["E", "the agent"],
    });
  });

  it("omits empty bio and nickname lines", async () => {
    const profile: TwitterProfile = {
      id: "123",
      username: "eliza_os",
      screenName: "Eliza",
      bio: "",
      nicknames: [],
    };
    const result = await xIdentityProvider.get(
      makeRuntime(profile),
      EMPTY_MESSAGE,
      EMPTY_STATE,
    );

    expect(result.text).toContain("@eliza_os");
    expect(result.text).not.toContain("Bio:");
    expect(result.text).not.toContain("Nicknames:");
  });

  it("returns empty context when the profile is not yet loaded", async () => {
    const result = await xIdentityProvider.get(
      makeRuntime(null),
      EMPTY_MESSAGE,
      EMPTY_STATE,
    );

    expect(result.text).toBe("");
    expect(result.data?.twitterProfile).toBeNull();
  });

  it("returns empty context when the X service is absent", async () => {
    const runtime = {
      getService: () => null,
    } as unknown as IAgentRuntime;
    const result = await xIdentityProvider.get(
      runtime,
      EMPTY_MESSAGE,
      EMPTY_STATE,
    );

    expect(result.text).toBe("");
    expect(result.data?.twitterProfile).toBeNull();
  });
});
