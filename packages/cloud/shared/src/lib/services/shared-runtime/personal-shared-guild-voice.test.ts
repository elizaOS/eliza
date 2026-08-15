/** Verifies the deterministic public-room boundary for managed guild voice. */
import { describe, expect, test } from "bun:test";
import { personalSharedGuildVoiceRoomId } from "./personal-shared-agent";

describe("personalSharedGuildVoiceRoomId", () => {
  const base = {
    agentId: "personal:10000000-0000-5000-8000-000000000001",
    discordUserId: "111111111111111",
    guildId: "222222222222222",
    channelId: "333333333333333",
  };

  test("is stable but cannot collide with the private personal room", () => {
    const first = personalSharedGuildVoiceRoomId(base);
    expect(personalSharedGuildVoiceRoomId(base)).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(base.agentId);
  });

  test("isolates guilds, channels, and owners", () => {
    const room = personalSharedGuildVoiceRoomId(base);
    expect(personalSharedGuildVoiceRoomId({ ...base, guildId: "444444444444444" })).not.toBe(room);
    expect(personalSharedGuildVoiceRoomId({ ...base, channelId: "555555555555555" })).not.toBe(
      room,
    );
    expect(personalSharedGuildVoiceRoomId({ ...base, discordUserId: "666666666666666" })).not.toBe(
      room,
    );
  });
});
