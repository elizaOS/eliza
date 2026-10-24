/**
 * TWITTER_DM_ONLY ("Only process direct messages, ignore public
 * interactions") must keep every public client off while DMs still run.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { TwitterClientInstance } from "./services/x.service";
import type { TwitterClientState } from "./types";

function createInstance(settings: Record<string, string>) {
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000ab" as UUID,
    character: { name: "Agent", templates: {}, topics: ["cats"] },
    getSetting: vi.fn((key: string) => settings[key]),
    reportError: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  return new TwitterClientInstance(runtime, {
    accountId: "default",
  } as unknown as TwitterClientState);
}

const PUBLIC_ON = {
  TWITTER_ENABLE_REPLIES: "true",
  TWITTER_ENABLE_ACTIONS: "true",
  TWITTER_ENABLE_DISCOVERY: "true",
  TWITTER_ENABLE_DMS: "true",
};

describe("TWITTER_DM_ONLY", () => {
  it("starts only the direct-message client", () => {
    const instance = createInstance({ ...PUBLIC_ON, TWITTER_DM_ONLY: "true" });

    expect(instance.directMessages).toBeDefined();
    expect(instance.interaction).toBeUndefined();
    expect(instance.timeline).toBeUndefined();
    expect(instance.discovery).toBeUndefined();
  });

  it("leaves public clients on when it is off", () => {
    const instance = createInstance(PUBLIC_ON);

    expect(instance.interaction).toBeDefined();
    expect(instance.timeline).toBeDefined();
  });
});
