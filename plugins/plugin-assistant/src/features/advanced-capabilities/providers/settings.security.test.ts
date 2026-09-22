/**
 * Regression coverage for the advanced SETTINGS provider. Decrypted world
 * secrets are internal-only and must not appear in any provider projection.
 */

import type {
  Memory,
  Setting,
  State,
  UUID,
  World,
  WorldSettings,
} from "@elizaos/core";
import { ChannelType, clearSaltCache, saltWorldSettings } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing/mock-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsProvider } from "./settings.ts";

const SECRET_SALT = "advanced-provider-security-test-salt";
const SECRET_VALUE = "sk-advanced-secret-do-not-leak";
const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const WORLD_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const AGENT_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const ENTITY_ID = "44444444-4444-4444-4444-444444444444" as UUID;

function setting(name: string, secret: boolean, value: string): Setting {
  return {
    name,
    description: `${name} description`,
    usageDescription: `${name} usage`,
    secret,
    public: !secret,
    required: true,
    dependsOn: [],
    value,
  };
}

describe("SETTINGS provider secret projection", () => {
  const originalSalt = process.env.SECRET_SALT;

  beforeEach(() => {
    process.env.SECRET_SALT = SECRET_SALT;
    clearSaltCache();
  });

  afterEach(() => {
    if (originalSalt === undefined) {
      delete process.env.SECRET_SALT;
    } else {
      process.env.SECRET_SALT = originalSalt;
    }
    clearSaltCache();
  });

  it("keeps decrypted secrets out of setup text, values, and data", async () => {
    const storedSettings = saltWorldSettings(
      {
        API_KEY: setting("API key", true, SECRET_VALUE),
        DISPLAY_NAME: setting("Display name", false, "Eliza"),
      },
      SECRET_SALT,
    );
    const world: World = {
      id: WORLD_ID,
      agentId: AGENT_ID,
      messageServerId: "66666666-6666-6666-6666-666666666666" as UUID,
      metadata: {
        ownership: { ownerId: ENTITY_ID },
        settings: storedSettings,
      },
    };
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      character: {
        ...createMockRuntime().character,
        name: "Security Agent",
      },
      getRoom: vi.fn(async () => ({
        id: ROOM_ID,
        source: "test",
        type: ChannelType.DM,
        worldId: WORLD_ID,
      })),
      getAllWorlds: vi.fn(async () => [world]),
    });
    const message = {
      id: "55555555-5555-5555-5555-555555555555" as UUID,
      entityId: ENTITY_ID,
      roomId: ROOM_ID,
      agentId: AGENT_ID,
      content: { text: "show settings", channelType: ChannelType.DM },
      createdAt: 0,
    } as Memory;

    const result = await settingsProvider.get(runtime, message, {
      senderName: "Owner",
    } as State);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SECRET_VALUE);
    expect(result.text).toContain("****************");
    expect(result.text).toContain("Eliza");
    const projected = result.data.settings as WorldSettings;
    expect(JSON.stringify(projected)).not.toContain(SECRET_VALUE);
  });

  it("masks secrets in the nested WorldSettings representation", async () => {
    const storedSettings = saltWorldSettings(
      {
        settings: {
          API_KEY: setting("API key", true, SECRET_VALUE),
          DISPLAY_NAME: setting("Display name", false, "Eliza"),
        },
      },
      SECRET_SALT,
    );
    const world: World = {
      id: WORLD_ID,
      agentId: AGENT_ID,
      messageServerId: "66666666-6666-6666-6666-666666666666" as UUID,
      metadata: {
        ownership: { ownerId: ENTITY_ID },
        settings: storedSettings,
      },
    };
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      character: {
        ...createMockRuntime().character,
        name: "Security Agent",
      },
      getRoom: vi.fn(async () => ({
        id: ROOM_ID,
        source: "test",
        type: ChannelType.DM,
        worldId: WORLD_ID,
      })),
      getAllWorlds: vi.fn(async () => [world]),
    });
    const message = {
      id: "55555555-5555-5555-5555-555555555555" as UUID,
      entityId: ENTITY_ID,
      roomId: ROOM_ID,
      agentId: AGENT_ID,
      content: { text: "show settings", channelType: ChannelType.DM },
      createdAt: 0,
    } as Memory;

    const result = await settingsProvider.get(runtime, message, {
      senderName: "Owner",
    } as State);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).toContain("****************");
    expect(serialized).toContain("Eliza");
  });
});
