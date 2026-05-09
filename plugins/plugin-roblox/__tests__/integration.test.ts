import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { robloxAction } from "../actions";
import { robloxPlugin } from "../index";
import { gameStateProvider } from "../providers";
import { ROBLOX_SERVICE_NAME } from "../types";
import { hasRobloxEnabled, validateRobloxConfig } from "../utils/config";

function createMockRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const runtime = {
    agentId: "test-agent-00000000" as UUID,
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(() => null),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
    },
    character: { name: "TestAgent" },
  };

  return runtime as IAgentRuntime;
}

function createMockMemory(text: string): Memory {
  return {
    content: { text, source: "test" },
    entityId: "entity-1" as UUID,
    agentId: "agent-1" as UUID,
    roomId: "room-1" as UUID,
  } as Memory;
}

describe("Roblox plugin metadata", () => {
  it("registers one compact action and one real provider", () => {
    expect(robloxPlugin.name).toBe("roblox");
    expect(robloxPlugin.actions?.map((action) => action.name)).toEqual(["ROBLOX_ACTION"]);
    expect(robloxPlugin.providers?.map((provider) => provider.name)).toEqual(["roblox-game-state"]);
    expect(robloxPlugin.services).toHaveLength(1);
  });
});

describe("ROBLOX_ACTION", () => {
  it("validates only when Roblox settings are present", async () => {
    const configured = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    const missingUniverse = createMockRuntime({ ROBLOX_API_KEY: "key" });

    expect(await robloxAction.validate(configured, createMockMemory("send roblox message"))).toBe(
      true
    );
    expect(
      await robloxAction.validate(missingUniverse, createMockMemory("send roblox message"))
    ).toBe(false);
  });

  it("routes message subaction through the Roblox service", async () => {
    const service = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const runtime = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(runtime.getService).mockReturnValue(service as never);

    const result = await robloxAction.handler(
      runtime,
      createMockMemory("tell player 42 hello"),
      undefined,
      { parameters: { subaction: "message", message: "hello", targetPlayerIds: [42] } }
    );

    expect(result?.success).toBe(true);
    expect(service.sendMessage).toHaveBeenCalledWith("test-agent-00000000", "hello", [42]);
  });

  it("routes execute subaction through the Roblox service", async () => {
    const service = { executeAction: vi.fn().mockResolvedValue(undefined) };
    const runtime = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(runtime.getService).mockReturnValue(service as never);

    const result = await robloxAction.handler(
      runtime,
      createMockMemory("spawn a dragon at plaza"),
      undefined,
      { parameters: { subaction: "execute" } }
    );

    expect(result?.success).toBe(true);
    expect(service.executeAction).toHaveBeenCalledWith(
      "test-agent-00000000",
      "spawn_entity",
      { entityType: "dragon", location: "plaza" },
      undefined
    );
  });

  it("routes get_player subaction through the Roblox client", async () => {
    const client = {
      getUserById: vi.fn().mockResolvedValue({
        id: 12345678,
        username: "CoolPlayer",
        displayName: "Cool Player",
        isBanned: false,
      }),
      getAvatarUrl: vi.fn().mockResolvedValue("https://avatar.example.com/img.png"),
    };
    const service = { getClient: vi.fn().mockReturnValue(client) };
    const runtime = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(runtime.getService).mockReturnValue(service as never);

    const result = await robloxAction.handler(
      runtime,
      createMockMemory("Who is player 12345678?"),
      undefined,
      { parameters: { subaction: "get_player", playerId: 12345678 } }
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      subaction: "get_player",
      userId: 12345678,
      username: "CoolPlayer",
    });
    expect(client.getUserById).toHaveBeenCalledWith(12345678);
  });
});

describe("roblox-game-state provider", () => {
  it("returns non-empty configuration state when service is unavailable", async () => {
    const runtime = createMockRuntime({ ROBLOX_UNIVERSE_ID: "12345" });

    const result = await gameStateProvider.get(runtime, createMockMemory(""));

    expect(result.text).toContain("Roblox:");
    expect(result.text).toContain("service: unavailable");
    expect(result.values).toMatchObject({
      configured: false,
      serviceAvailable: false,
      clientAvailable: false,
    });
  });

  it("returns non-empty service state when client is unavailable", async () => {
    const service = { getClient: vi.fn().mockReturnValue(null) };
    const runtime = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(runtime.getService).mockReturnValue(service as never);

    const result = await gameStateProvider.get(runtime, createMockMemory(""));

    expect(result.text).toContain("service: available");
    expect(result.text).toContain("client: unavailable");
    expect(result.values).toMatchObject({
      configured: true,
      serviceAvailable: true,
      clientAvailable: false,
    });
  });

  it("returns experience metadata when service and client are available", async () => {
    const client = {
      getConfig: vi.fn().mockReturnValue({
        universeId: "12345",
        placeId: "67890",
        messagingTopic: "test-topic",
        dryRun: true,
      }),
      getExperienceInfo: vi.fn().mockResolvedValue({
        universeId: "12345",
        name: "Epic Adventure",
        playing: 250,
        visits: 100000,
        creator: { id: 1, type: "User", name: "GameDev42" },
        rootPlaceId: "67890",
      }),
    };
    const service = { getClient: vi.fn().mockReturnValue(client) };
    const runtime = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(runtime.getService).mockReturnValue(service as never);

    const result = await gameStateProvider.get(runtime, createMockMemory(""));

    expect(result.text).toContain("experienceName: Epic Adventure");
    expect(result.text).toContain("activePlayers: 250");
    expect(result.text).toContain("dryRun: true");
    expect(result.values).toMatchObject({
      configured: true,
      clientAvailable: true,
      experienceName: "Epic Adventure",
      activePlayers: 250,
    });
  });
});

describe("Roblox config helpers", () => {
  it("creates config from runtime settings and detects enablement", () => {
    const runtime = createMockRuntime({
      ROBLOX_API_KEY: "my-key",
      ROBLOX_UNIVERSE_ID: "111",
      ROBLOX_PLACE_ID: "222",
      ROBLOX_MESSAGING_TOPIC: "custom-topic",
      ROBLOX_DRY_RUN: "true",
    });

    expect(hasRobloxEnabled(runtime)).toBe(true);
    expect(validateRobloxConfig(runtime)).toMatchObject({
      apiKey: "my-key",
      universeId: "111",
      placeId: "222",
      messagingTopic: "custom-topic",
      dryRun: true,
    });
  });

  it("requires API key and universe ID", () => {
    expect(hasRobloxEnabled(createMockRuntime({}))).toBe(false);
    expect(() => validateRobloxConfig(createMockRuntime({ ROBLOX_UNIVERSE_ID: "123" }))).toThrow(
      /ROBLOX_API_KEY/
    );
    expect(() => validateRobloxConfig(createMockRuntime({ ROBLOX_API_KEY: "key" }))).toThrow(
      /ROBLOX_UNIVERSE_ID/
    );
  });
});

describe("Roblox constants", () => {
  it("keeps the service name stable", () => {
    expect(ROBLOX_SERVICE_NAME).toBe("roblox");
  });
});
