import { describe, expect, test } from "bun:test";
import {
  AGENT_CHARACTER_OWNERSHIP_KEY,
  readManagedAgentDiscordBinding,
  readManagedAgentDiscordGateway,
  withManagedAgentDiscordBinding,
  withManagedAgentDiscordGateway,
  withoutManagedAgentDiscordBinding,
} from "@/lib/services/eliza-agent-config";

describe("managed Eliza Discord config helpers", () => {
  test("writes and reads the managed Discord binding payload", () => {
    const config = withManagedAgentDiscordBinding(
      {
        existing: true,
        [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
      },
      {
        mode: "cloud-managed",
        applicationId: "discord-app-1",
        guildId: "guild-1",
        guildName: "Guild One",
        adminDiscordUserId: "discord-user-1",
        adminDiscordUsername: "owner",
        adminDiscordDisplayName: "Owner Person",
        adminDiscordAvatarUrl:
          "https://cdn.discordapp.com/avatars/discord-user-1/avatar.png?size=128",
        adminElizaUserId: "user-1",
        botNickname: "Agent",
        connectedAt: "2026-04-04T16:00:00.000Z",
      },
    );

    expect(readManagedAgentDiscordBinding(config)).toEqual({
      mode: "cloud-managed",
      applicationId: "discord-app-1",
      guildId: "guild-1",
      guildName: "Guild One",
      adminDiscordUserId: "discord-user-1",
      adminDiscordUsername: "owner",
      adminDiscordDisplayName: "Owner Person",
      adminDiscordAvatarUrl:
        "https://cdn.discordapp.com/avatars/discord-user-1/avatar.png?size=128",
      adminElizaUserId: "user-1",
      botNickname: "Agent",
      connectedAt: "2026-04-04T16:00:00.000Z",
    });
    expect(config[AGENT_CHARACTER_OWNERSHIP_KEY]).toBe("reuse-existing");
  });

  test("removes only the managed Discord binding", () => {
    const config = withoutManagedAgentDiscordBinding({
      existing: true,
      [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
      __agentManagedDiscord: {
        guildId: "guild-1",
        guildName: "Guild One",
        adminDiscordUserId: "discord-user-1",
        adminDiscordUsername: "owner",
        adminElizaUserId: "user-1",
        connectedAt: "2026-04-04T16:00:00.000Z",
      },
    });

    expect(readManagedAgentDiscordBinding(config)).toBeNull();
    expect(config).toEqual({
      existing: true,
      [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
    });
  });

  test("writes and reads the managed Discord gateway marker", () => {
    const config = withManagedAgentDiscordGateway(
      {
        existing: true,
      },
      {
        mode: "shared-gateway",
        createdAt: "2026-04-09T00:00:00.000Z",
      },
    );

    expect(readManagedAgentDiscordGateway(config)).toEqual({
      mode: "shared-gateway",
      createdAt: "2026-04-09T00:00:00.000Z",
    });
    expect(config.existing).toBe(true);
  });
});
