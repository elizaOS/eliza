import { describe, expect, test } from "bun:test";
import twitchPlugin, {
  TwitchService,
  channelStateProvider,
  joinChannel,
  leaveChannel,
  listChannels,
  sendMessage,
  userContextProvider,
} from "../src/index.ts";

describe("Twitch plugin exports", () => {
  test("exports plugin metadata", () => {
    expect(twitchPlugin.name).toBe("twitch");
    expect(twitchPlugin.description).toContain("Twitch");
    expect(Array.isArray(twitchPlugin.actions)).toBe(true);
    expect(Array.isArray(twitchPlugin.providers)).toBe(true);
    expect(Array.isArray(twitchPlugin.services)).toBe(true);
  });

  test("exports actions, providers, and service", () => {
    expect(sendMessage).toBeDefined();
    expect(joinChannel).toBeDefined();
    expect(leaveChannel).toBeDefined();
    expect(listChannels).toBeDefined();
    expect(channelStateProvider).toBeDefined();
    expect(userContextProvider).toBeDefined();
    expect(TwitchService).toBeDefined();
  });
});
