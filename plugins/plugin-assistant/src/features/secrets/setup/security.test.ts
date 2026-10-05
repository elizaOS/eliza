/**
 * Regression coverage for setup-secret storage and provider projection.
 * Secret values may be used at the storage boundary, but must never remain in
 * plaintext world metadata or cross into provider text, values, or data.
 */

import type { Memory, State, UUID, World } from "@elizaos/core";
import { ChannelType, clearSaltCache, decryptStringValue } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettingsAction } from "./action.ts";
import type { SetupSetting } from "./config.ts";
import { setupSettingsProvider } from "./provider.ts";

const SECRET_SALT = "setup-security-test-salt";
const SECRET_VALUE = "sk-setup-secret-do-not-leak";
const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const WORLD_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const AGENT_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const ENTITY_ID = "44444444-4444-4444-4444-444444444444" as UUID;

function setting(
  name: string,
  secret: boolean,
  value: string | null = null,
): SetupSetting {
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

function message(): Memory {
  return {
    id: "55555555-5555-5555-5555-555555555555" as UUID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    agentId: AGENT_ID,
    content: { text: "save both settings", channelType: ChannelType.DM },
    createdAt: 0,
  } as Memory;
}

describe("SECRETS_UPDATE_SETTINGS storage", () => {
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

  it.each([true, false])(
    "encrypts metadata and preserves ordinary values (secret service=%s)",
    async (withService) => {
      const world: World = {
        id: WORLD_ID,
        agentId: AGENT_ID,
        messageServerId: "66666666-6666-6666-6666-666666666666" as UUID,
        metadata: {
          settings: {
            API_KEY: setting("API key", true),
            DISPLAY_NAME: setting("Display name", false),
          },
        },
      };
      const secretSet = vi.fn(async () => undefined);
      const runtime = createMockRuntime({
        agentId: AGENT_ID,
        getRoom: vi.fn(async () => ({
          id: ROOM_ID,
          source: "test",
          type: ChannelType.DM,
          worldId: WORLD_ID,
        })),
        getWorld: vi.fn(async () => world),
        updateWorld: vi.fn(async () => undefined),
        getService: vi.fn(
          () => (withService ? { set: secretSet } : null) as never,
        ),
        dynamicPromptExecFromState: vi.fn(async () => ({
          updates: [
            { key: "API_KEY", value: SECRET_VALUE },
            { key: "DISPLAY_NAME", value: "Eliza" },
          ],
        })),
      });

      const result = await updateSettingsAction.handler(
        runtime,
        message(),
        { text: "save both settings" } as State,
        undefined,
        vi.fn(async () => []),
      );

      expect(result?.success).toBe(true);
      if (withService)
        expect(secretSet).toHaveBeenCalledWith(
          "API_KEY",
          SECRET_VALUE,
          expect.any(Object),
          expect.objectContaining({ encrypted: true }),
        );
      else expect(secretSet).not.toHaveBeenCalled();
      const stored = world.metadata?.settings as Record<string, SetupSetting>;
      const storedSecret = stored.API_KEY.value;
      expect(storedSecret).not.toBe(SECRET_VALUE);
      expect(storedSecret).toMatch(/^v2:/);
      expect(decryptStringValue(String(storedSecret), SECRET_SALT)).toBe(
        SECRET_VALUE,
      );
      expect(stored.DISPLAY_NAME.value).toBe("Eliza");
      expect(JSON.stringify(world.metadata)).not.toContain(SECRET_VALUE);
      stored.SECOND_NAME = setting("Second name", false);
      vi.mocked(runtime.dynamicPromptExecFromState).mockResolvedValueOnce({
        updates: [{ key: "SECOND_NAME", value: "Updated name" }],
      });
      await updateSettingsAction.handler(
        runtime,
        message(),
        { text: "update display name" } as State,
        undefined,
        vi.fn(async () => []),
      );
      const savedAgain = world.metadata?.settings as Record<
        string,
        SetupSetting
      >;
      expect(savedAgain.API_KEY.value).toBe(storedSecret);
      expect(savedAgain.SECOND_NAME.value).toBe("Updated name");
    },
  );
});

describe("SETUP_SETTINGS provider projection", () => {
  it("masks secrets in text, values, and structured data during setup", async () => {
    const world: World = {
      id: WORLD_ID,
      agentId: AGENT_ID,
      metadata: {
        settings: {
          API_KEY: setting("API key", true, SECRET_VALUE),
          DISPLAY_NAME: setting("Display name", false, "Eliza"),
        },
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
      getWorld: vi.fn(async () => world),
    });

    const before = JSON.stringify(world.metadata);
    const result = await setupSettingsProvider.get(runtime, message(), {
      senderName: "Owner",
    } as State);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SECRET_VALUE);
    expect(result.text).toContain("****************");
    expect(result.text).toContain("Eliza");
    expect(serialized).toContain("Eliza");
    expect(JSON.stringify(world.metadata)).toBe(before);
  });
});
