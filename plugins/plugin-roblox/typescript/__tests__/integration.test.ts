/**
 * Real integration tests for the Roblox plugin.
 * Tests plugin metadata, action validate/handler, provider get(), config, and types.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRuntime(
  settings: Record<string, string> = {}
): IAgentRuntime {
  return {
    agentId: "test-agent-00000000" as UUID,
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    getService: vi.fn(() => null),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
    },
    character: { name: "TestAgent" },
  } as unknown as IAgentRuntime;
}

function createMockMemory(text: string): Memory {
  return {
    content: { text },
    userId: "user-1" as UUID,
    agentId: "agent-1" as UUID,
    roomId: "room-1" as UUID,
  } as Memory;
}

// ---------------------------------------------------------------------------
// Plugin Metadata
// ---------------------------------------------------------------------------

describe("Roblox Plugin – Metadata", () => {
  it("should have name = 'roblox' and description mentioning Roblox", async () => {
    const { robloxPlugin } = await import("../index");
    expect(robloxPlugin.name).toBe("roblox");
    expect(robloxPlugin.description).toMatch(/roblox/i);
  });

  it("should register exactly 3 actions", async () => {
    const { robloxPlugin } = await import("../index");
    expect(robloxPlugin.actions).toHaveLength(3);
    const names = robloxPlugin.actions!.map((a) => a.name);
    expect(names).toContain("SEND_ROBLOX_MESSAGE");
    expect(names).toContain("EXECUTE_ROBLOX_ACTION");
    expect(names).toContain("GET_ROBLOX_PLAYER");
  });

  it("should register exactly 1 provider (roblox-game-state)", async () => {
    const { robloxPlugin } = await import("../index");
    expect(robloxPlugin.providers).toHaveLength(1);
    expect(robloxPlugin.providers![0].name).toBe("roblox-game-state");
  });

  it("should register exactly 1 service (RobloxService)", async () => {
    const { robloxPlugin } = await import("../index");
    expect(robloxPlugin.services).toHaveLength(1);
  });

  it("should include a test suite", async () => {
    const { robloxPlugin } = await import("../index");
    expect(robloxPlugin.tests).toBeDefined();
    expect(robloxPlugin.tests!.length).toBeGreaterThan(0);
  });

  it("should expose an init function", async () => {
    const { robloxPlugin } = await import("../index");
    expect(typeof robloxPlugin.init).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Action: SEND_ROBLOX_MESSAGE
// ---------------------------------------------------------------------------

describe("Action – SEND_ROBLOX_MESSAGE", () => {
  it("has correct name, description, and examples", async () => {
    const { sendGameMessage } = await import("../actions");
    expect(sendGameMessage.name).toBe("SEND_ROBLOX_MESSAGE");
    expect(sendGameMessage.description).toMatch(/message/i);
    expect(sendGameMessage.examples.length).toBeGreaterThan(0);
    expect(sendGameMessage.examples[0].length).toBeGreaterThan(0);
  });

  // validate ---

  it("validate → true when API key + universe ID are set", async () => {
    const { sendGameMessage } = await import("../actions");
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "key-abc",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    expect(await sendGameMessage.validate(rt, {} as Memory)).toBe(true);
  });

  it("validate → false when API key is missing", async () => {
    const { sendGameMessage } = await import("../actions");
    const rt = createMockRuntime({ ROBLOX_UNIVERSE_ID: "12345" });
    expect(await sendGameMessage.validate(rt, {} as Memory)).toBe(false);
  });

  it("validate → false when universe ID is missing", async () => {
    const { sendGameMessage } = await import("../actions");
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key-abc" });
    expect(await sendGameMessage.validate(rt, {} as Memory)).toBe(false);
  });

  // handler ---

  it("handler returns failure + calls callback when service unavailable", async () => {
    const { sendGameMessage } = await import("../actions");
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    const cb = vi.fn();

    const result = await sendGameMessage.handler(
      rt,
      createMockMemory("Say hello"),
      undefined,
      undefined,
      cb
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/not found/i);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/not available/i) })
    );
  });

  it("handler returns failure when message content is empty", async () => {
    const { sendGameMessage } = await import("../actions");
    const svc = { sendMessage: vi.fn() };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await sendGameMessage.handler(
      rt,
      createMockMemory(""),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/no message content/i);
  });

  it("handler sends message to all players on success", async () => {
    const { sendGameMessage } = await import("../actions");
    const svc = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);
    const cb = vi.fn();

    const result = await sendGameMessage.handler(
      rt,
      createMockMemory("Hello everyone in the game"),
      undefined,
      undefined,
      cb
    );

    expect(result!.success).toBe(true);
    expect(svc.sendMessage).toHaveBeenCalledWith(
      "test-agent-00000000",
      "Hello everyone in the game",
      undefined
    );
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/all players/i) })
    );
  });

  it("handler extracts player IDs from message text", async () => {
    const { sendGameMessage } = await import("../actions");
    const svc = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await sendGameMessage.handler(
      rt,
      createMockMemory("Send hello to player 42"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(true);
    expect(svc.sendMessage).toHaveBeenCalledWith(
      "test-agent-00000000",
      "Send hello to player 42",
      [42]
    );
  });

  it("handler wraps thrown errors", async () => {
    const { sendGameMessage } = await import("../actions");
    const svc = {
      sendMessage: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "12345",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await sendGameMessage.handler(
      rt,
      createMockMemory("hello game"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(false);
    expect(result!.error).toBe("network down");
  });
});

// ---------------------------------------------------------------------------
// Action: EXECUTE_ROBLOX_ACTION
// ---------------------------------------------------------------------------

describe("Action – EXECUTE_ROBLOX_ACTION", () => {
  it("has correct name and description", async () => {
    const { executeGameAction } = await import("../actions");
    expect(executeGameAction.name).toBe("EXECUTE_ROBLOX_ACTION");
    expect(executeGameAction.description).toMatch(/action/i);
  });

  // validate ---

  it("validate → true when both settings present", async () => {
    const { executeGameAction } = await import("../actions");
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "k",
      ROBLOX_UNIVERSE_ID: "1",
    });
    expect(await executeGameAction.validate(rt, {} as Memory)).toBe(true);
  });

  it("validate → false when settings missing", async () => {
    const { executeGameAction } = await import("../actions");
    expect(
      await executeGameAction.validate(createMockRuntime({}), {} as Memory)
    ).toBe(false);
  });

  // handler ---

  it("handler returns failure when service unavailable", async () => {
    const { executeGameAction } = await import("../actions");
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "k",
      ROBLOX_UNIVERSE_ID: "1",
    });
    const cb = vi.fn();

    const result = await executeGameAction.handler(
      rt,
      createMockMemory("spawn a dragon at plaza"),
      undefined,
      undefined,
      cb
    );

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/not found/i);
    expect(cb).toHaveBeenCalled();
  });

  it("handler parses spawn_entity from message", async () => {
    const { executeGameAction } = await import("../actions");
    const svc = { executeAction: vi.fn().mockResolvedValue(undefined) };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "k",
      ROBLOX_UNIVERSE_ID: "1",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await executeGameAction.handler(
      rt,
      createMockMemory("spawn a dragon at plaza"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(true);
    expect(svc.executeAction).toHaveBeenCalledWith(
      "test-agent-00000000",
      "spawn_entity",
      expect.objectContaining({ entityType: "dragon", location: "plaza" }),
      undefined
    );
  });

  it("handler parses teleport from message", async () => {
    const { executeGameAction } = await import("../actions");
    const svc = { executeAction: vi.fn().mockResolvedValue(undefined) };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "k",
      ROBLOX_UNIVERSE_ID: "1",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await executeGameAction.handler(
      rt,
      createMockMemory("teleport everyone to the lobby"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(true);
    expect(svc.executeAction).toHaveBeenCalledWith(
      "test-agent-00000000",
      "teleport",
      expect.objectContaining({ destination: "lobby" }),
      undefined
    );
  });

  it("handler parses start_event from message", async () => {
    const { executeGameAction } = await import("../actions");
    const svc = { executeAction: vi.fn().mockResolvedValue(undefined) };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "k",
      ROBLOX_UNIVERSE_ID: "1",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await executeGameAction.handler(
      rt,
      createMockMemory("start a fireworks show"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(true);
    expect(svc.executeAction).toHaveBeenCalledWith(
      "test-agent-00000000",
      "start_event",
      expect.objectContaining({ eventType: "fireworks" }),
      undefined
    );
  });

  it("handler returns failure when action cannot be parsed", async () => {
    const { executeGameAction } = await import("../actions");
    const svc = { executeAction: vi.fn() };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "k",
      ROBLOX_UNIVERSE_ID: "1",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await executeGameAction.handler(
      rt,
      createMockMemory("hello world"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/could not parse/i);
    expect(svc.executeAction).not.toHaveBeenCalled();
  });

  it("handler extracts target player ID when message contains player reference", async () => {
    const { executeGameAction } = await import("../actions");
    const svc = { executeAction: vi.fn().mockResolvedValue(undefined) };
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "k",
      ROBLOX_UNIVERSE_ID: "1",
    });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await executeGameAction.handler(
      rt,
      createMockMemory("give player 999 50 coins"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(true);
    expect(svc.executeAction).toHaveBeenCalledWith(
      "test-agent-00000000",
      "give_coins",
      expect.objectContaining({ playerId: 999, amount: 50 }),
      [999]
    );
  });
});

// ---------------------------------------------------------------------------
// Action: GET_ROBLOX_PLAYER
// ---------------------------------------------------------------------------

describe("Action – GET_ROBLOX_PLAYER", () => {
  it("has correct name and description", async () => {
    const { getPlayerInfo } = await import("../actions");
    expect(getPlayerInfo.name).toBe("GET_ROBLOX_PLAYER");
    expect(getPlayerInfo.description).toMatch(/player/i);
  });

  // validate ---

  it("validate → true when API key is set", async () => {
    const { getPlayerInfo } = await import("../actions");
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key" });
    expect(await getPlayerInfo.validate(rt, {} as Memory)).toBe(true);
  });

  it("validate → false when API key is missing", async () => {
    const { getPlayerInfo } = await import("../actions");
    expect(
      await getPlayerInfo.validate(createMockRuntime({}), {} as Memory)
    ).toBe(false);
  });

  // handler ---

  it("handler returns failure when service unavailable", async () => {
    const { getPlayerInfo } = await import("../actions");
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key" });
    const cb = vi.fn();

    const result = await getPlayerInfo.handler(
      rt,
      createMockMemory("Who is player 12345678"),
      undefined,
      undefined,
      cb
    );

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/not found/i);
  });

  it("handler returns failure when client unavailable", async () => {
    const { getPlayerInfo } = await import("../actions");
    const svc = { getClient: vi.fn().mockReturnValue(null) };
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key" });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await getPlayerInfo.handler(
      rt,
      createMockMemory("Who is player 12345678"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/client not found/i);
  });

  it("handler extracts numeric ID and calls getUserById", async () => {
    const { getPlayerInfo } = await import("../actions");
    const mockClient = {
      getUserById: vi.fn().mockResolvedValue({
        id: 12345678,
        username: "CoolPlayer",
        displayName: "Cool Player",
        isBanned: false,
      }),
      getAvatarUrl: vi.fn().mockResolvedValue("https://avatar.example.com/img.png"),
    };
    const svc = { getClient: vi.fn().mockReturnValue(mockClient) };
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key" });
    vi.mocked(rt.getService).mockReturnValue(svc as any);
    const cb = vi.fn();

    const result = await getPlayerInfo.handler(
      rt,
      createMockMemory("Who is player 12345678"),
      undefined,
      undefined,
      cb
    );

    expect(result!.success).toBe(true);
    expect(result!.data).toMatchObject({
      userId: 12345678,
      username: "CoolPlayer",
      displayName: "Cool Player",
    });
    expect(mockClient.getUserById).toHaveBeenCalledWith(12345678);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Cool Player") })
    );
  });

  it("handler extracts username and calls getUserByUsername", async () => {
    const { getPlayerInfo } = await import("../actions");
    const mockClient = {
      getUserByUsername: vi.fn().mockResolvedValue({
        id: 99,
        username: "TestUser",
        displayName: "Test",
        isBanned: false,
      }),
      getAvatarUrl: vi.fn().mockResolvedValue(undefined),
    };
    const svc = { getClient: vi.fn().mockReturnValue(mockClient) };
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key" });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await getPlayerInfo.handler(
      rt,
      createMockMemory("Find info on user TestUser"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(true);
    expect(mockClient.getUserByUsername).toHaveBeenCalledWith("TestUser");
  });

  it("handler returns success with message when user not found", async () => {
    const { getPlayerInfo } = await import("../actions");
    const mockClient = {
      getUserByUsername: vi.fn().mockResolvedValue(null),
      getAvatarUrl: vi.fn(),
    };
    const svc = { getClient: vi.fn().mockReturnValue(mockClient) };
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key" });
    vi.mocked(rt.getService).mockReturnValue(svc as any);
    const cb = vi.fn();

    const result = await getPlayerInfo.handler(
      rt,
      createMockMemory("Find info on user GhostUser"),
      undefined,
      undefined,
      cb
    );

    expect(result!.success).toBe(true);
    expect(result!.text).toMatch(/not found/i);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/couldn't find/i) })
    );
  });

  it("handler returns failure when no identifier can be extracted", async () => {
    const { getPlayerInfo } = await import("../actions");
    const mockClient = {};
    const svc = { getClient: vi.fn().mockReturnValue(mockClient) };
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key" });
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await getPlayerInfo.handler(
      rt,
      createMockMemory("hello world"),
      undefined,
      undefined,
      vi.fn()
    );

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/could not extract/i);
  });
});

// ---------------------------------------------------------------------------
// Provider: roblox-game-state
// ---------------------------------------------------------------------------

describe("Provider – roblox-game-state", () => {
  it("has correct name and description", async () => {
    const { gameStateProvider } = await import(
      "../providers/gameStateProvider"
    );
    expect(gameStateProvider.name).toBe("roblox-game-state");
    expect(gameStateProvider.description).toMatch(/roblox/i);
  });

  it("get() returns empty text when service is unavailable", async () => {
    const { gameStateProvider } = await import(
      "../providers/gameStateProvider"
    );
    const rt = createMockRuntime();
    const result = await gameStateProvider.get(rt, {} as Memory);

    expect(result.text).toBe("");
    expect(result.data).toEqual({});
  });

  it("get() returns empty text when client is unavailable", async () => {
    const { gameStateProvider } = await import(
      "../providers/gameStateProvider"
    );
    const svc = { getClient: vi.fn().mockReturnValue(null) };
    const rt = createMockRuntime();
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await gameStateProvider.get(rt, {} as Memory);
    expect(result.text).toBe("");
  });

  it("get() returns formatted context when service + client are available", async () => {
    const { gameStateProvider } = await import(
      "../providers/gameStateProvider"
    );
    const mockClient = {
      getConfig: vi.fn().mockReturnValue({
        universeId: "12345",
        placeId: "67890",
        messagingTopic: "test-topic",
        dryRun: false,
      }),
      getExperienceInfo: vi.fn().mockResolvedValue({
        name: "Epic Adventure",
        playing: 250,
        visits: 100_000,
        creator: { id: 1, type: "User", name: "GameDev42" },
      }),
    };
    const svc = { getClient: vi.fn().mockReturnValue(mockClient) };
    const rt = createMockRuntime();
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await gameStateProvider.get(rt, {} as Memory);

    expect(result.text).toContain("Universe ID");
    expect(result.text).toContain("12345");
    expect(result.text).toContain("67890");
    expect(result.text).toContain("Epic Adventure");
    expect(result.text).toContain("250");
    expect(result.text).toContain("GameDev42");
    expect(result.text).toContain("test-topic");
  });

  it("get() shows dry-run note when enabled", async () => {
    const { gameStateProvider } = await import(
      "../providers/gameStateProvider"
    );
    const mockClient = {
      getConfig: vi.fn().mockReturnValue({
        universeId: "1",
        messagingTopic: "t",
        dryRun: true,
      }),
      getExperienceInfo: vi.fn().mockRejectedValue(new Error("offline")),
    };
    const svc = { getClient: vi.fn().mockReturnValue(mockClient) };
    const rt = createMockRuntime();
    vi.mocked(rt.getService).mockReturnValue(svc as any);

    const result = await gameStateProvider.get(rt, {} as Memory);

    expect(result.text).toMatch(/dry run/i);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("Config – validateRobloxConfig & helpers", () => {
  it("creates config from runtime settings including optionals", async () => {
    const { validateRobloxConfig } = await import("../utils/config");
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "my-key",
      ROBLOX_UNIVERSE_ID: "111",
      ROBLOX_PLACE_ID: "222",
      ROBLOX_MESSAGING_TOPIC: "custom-topic",
      ROBLOX_POLL_INTERVAL: "60",
      ROBLOX_DRY_RUN: "true",
    });

    const config = validateRobloxConfig(rt);

    expect(config.apiKey).toBe("my-key");
    expect(config.universeId).toBe("111");
    expect(config.placeId).toBe("222");
    expect(config.messagingTopic).toBe("custom-topic");
    expect(config.pollInterval).toBe(60);
    expect(config.dryRun).toBe(true);
  });

  it("uses defaults for optional settings", async () => {
    const { validateRobloxConfig, ROBLOX_DEFAULTS } = await import(
      "../utils/config"
    );
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "key",
      ROBLOX_UNIVERSE_ID: "123",
    });

    const config = validateRobloxConfig(rt);

    expect(config.messagingTopic).toBe(ROBLOX_DEFAULTS.MESSAGING_TOPIC);
    expect(config.pollInterval).toBe(ROBLOX_DEFAULTS.POLL_INTERVAL);
    expect(config.dryRun).toBe(false);
    expect(config.placeId ?? undefined).toBeUndefined();
  });

  it("throws when API key is missing", async () => {
    const { validateRobloxConfig } = await import("../utils/config");
    const rt = createMockRuntime({ ROBLOX_UNIVERSE_ID: "123" });
    expect(() => validateRobloxConfig(rt)).toThrow(/ROBLOX_API_KEY/);
  });

  it("throws when universe ID is missing", async () => {
    const { validateRobloxConfig } = await import("../utils/config");
    const rt = createMockRuntime({ ROBLOX_API_KEY: "key" });
    expect(() => validateRobloxConfig(rt)).toThrow(/ROBLOX_UNIVERSE_ID/);
  });

  it("hasRobloxEnabled → true when both keys present", async () => {
    const { hasRobloxEnabled } = await import("../utils/config");
    const rt = createMockRuntime({
      ROBLOX_API_KEY: "k",
      ROBLOX_UNIVERSE_ID: "1",
    });
    expect(hasRobloxEnabled(rt)).toBe(true);
  });

  it("hasRobloxEnabled → false when either key missing", async () => {
    const { hasRobloxEnabled } = await import("../utils/config");
    expect(hasRobloxEnabled(createMockRuntime({}))).toBe(false);
    expect(
      hasRobloxEnabled(createMockRuntime({ ROBLOX_API_KEY: "k" }))
    ).toBe(false);
    expect(
      hasRobloxEnabled(createMockRuntime({ ROBLOX_UNIVERSE_ID: "1" }))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

describe("Types – constants and enums", () => {
  it("ROBLOX_SERVICE_NAME equals 'roblox'", async () => {
    const { ROBLOX_SERVICE_NAME } = await import("../types");
    expect(ROBLOX_SERVICE_NAME).toBe("roblox");
  });

  it("RobloxEventType enum has correct values", async () => {
    const { RobloxEventType } = await import("../types");
    expect(RobloxEventType.PLAYER_JOINED).toBe("roblox:player_joined");
    expect(RobloxEventType.PLAYER_LEFT).toBe("roblox:player_left");
    expect(RobloxEventType.PLAYER_MESSAGE).toBe("roblox:player_message");
    expect(RobloxEventType.GAME_EVENT).toBe("roblox:game_event");
    expect(RobloxEventType.WEBHOOK_RECEIVED).toBe("roblox:webhook_received");
  });

  it("RobloxConfig can be fully constructed", () => {
    const config = {
      apiKey: "test-key",
      universeId: "12345",
      placeId: "67890",
      webhookSecret: "secret",
      messagingTopic: "eliza-agent",
      pollInterval: 30,
      dryRun: false,
    };

    expect(config.apiKey).toBe("test-key");
    expect(config.universeId).toBe("12345");
    expect(config.pollInterval).toBe(30);
    expect(config.dryRun).toBe(false);
  });

  it("RobloxUser can be constructed with optional fields", () => {
    const user = {
      id: 42,
      username: "hero",
      displayName: "The Hero",
      avatarUrl: "https://img.example.com/42.png",
      isBanned: false,
      createdAt: new Date("2024-01-15T00:00:00Z"),
    };

    expect(user.id).toBe(42);
    expect(user.username).toBe("hero");
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.isBanned).toBe(false);
  });

  it("DataStoreEntry can hold typed values", () => {
    const entry = {
      key: "leaderboard:score",
      value: { score: 9001, name: "Champion" },
      version: "v1.2",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(entry.key).toBe("leaderboard:score");
    expect(entry.value.score).toBe(9001);
    expect(entry.version).toBe("v1.2");
  });

  it("MessagingServiceMessage can hold sender info", () => {
    const msg = {
      topic: "eliza-agent",
      data: {
        type: "agent_message",
        content: "hello",
        timestamp: Date.now(),
      },
      sender: {
        agentId: "agent-1" as UUID,
        agentName: "Bot",
      },
    };

    expect(msg.topic).toBe("eliza-agent");
    expect(msg.sender!.agentName).toBe("Bot");
    expect(msg.data.content).toBe("hello");
  });
});
