import type { IAgentRuntime } from "@elizaos/core";
import { getConnectorCommands } from "@elizaos/plugin-commands";
import { describe, expect, it, vi } from "vitest";
import {
  applyTelegramSetMyCommands,
  buildTelegramCommandDescriptors,
  registerTelegramCommandHandlers,
} from "./command-registration";
import type { MessageManager } from "./messageManager";

const TELEGRAM_COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

function makeMessageManager() {
  const handleMessage = vi.fn(async () => undefined);
  return {
    manager: { handleMessage } as unknown as MessageManager,
    handleMessage,
  };
}

describe("buildTelegramCommandDescriptors", () => {
  it("returns a non-empty, well-formed setMyCommands payload", () => {
    const descriptors = buildTelegramCommandDescriptors();

    expect(descriptors.length).toBeGreaterThan(0);
    for (const entry of descriptors) {
      expect(entry.name).toMatch(TELEGRAM_COMMAND_NAME);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
    const names = descriptors.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length); // de-duplicated
  });

  it("includes both an agent command and a navigation command", () => {
    const commands = getConnectorCommands("telegram");
    expect(commands.some((c) => c.target.kind === "agent")).toBe(true);
    expect(commands.some((c) => c.target.kind === "navigate")).toBe(true);
  });
});

describe("registerTelegramCommandHandlers", () => {
  it("registers one handler per catalog command and never clobbers eliza_pair", () => {
    const command = vi.fn();
    const bot = { command } as never;
    const { manager } = makeMessageManager();

    const registered = registerTelegramCommandHandlers(
      bot,
      makeRuntime(),
      manager,
      "default",
    );

    expect(registered.length).toBeGreaterThan(0);
    // Reserved names owned by other services must be skipped.
    expect(registered.map((entry) => entry.name)).not.toContain("eliza_pair");
    expect(registered.map((entry) => entry.name)).not.toContain("start");
    // bot.command was invoked once per registered command, with the name first.
    expect(command).toHaveBeenCalledTimes(registered.length);
    const registeredNames = command.mock.calls.map((call) => call[0]);
    expect(registeredNames).toEqual(registered.map((entry) => entry.name));
    // Every registered handler is a function (the second arg).
    for (const call of command.mock.calls) {
      expect(typeof call[1]).toBe("function");
    }
  });

  it("wires the agent handler so an invoked command forces a reply", async () => {
    const handlers = new Map<string, (ctx: never) => Promise<void>>();
    const command = vi.fn(
      (name: string, handler: (ctx: never) => Promise<void>) => {
        handlers.set(name, handler);
      },
    );
    const bot = { command } as never;
    const { manager, handleMessage } = makeMessageManager();

    registerTelegramCommandHandlers(bot, makeRuntime(), manager, "default");

    const helpHandler = handlers.get("help");
    expect(helpHandler).toBeDefined();
    const ctx = { message: { text: "/help" }, reply: vi.fn() } as never;
    await helpHandler?.(ctx);
    expect(handleMessage).toHaveBeenCalledWith(ctx, { forceReply: true });
  });

  it("wires navigate handlers to reply with an app destination", async () => {
    const handlers = new Map<string, (ctx: never) => Promise<void>>();
    const command = vi.fn(
      (name: string, handler: (ctx: never) => Promise<void>) => {
        handlers.set(name, handler);
      },
    );
    const bot = { command } as never;
    const { manager, handleMessage } = makeMessageManager();

    registerTelegramCommandHandlers(bot, makeRuntime(), manager, "default");

    const settingsHandler = handlers.get("settings");
    expect(settingsHandler).toBeDefined();
    const reply = vi.fn(async (_text: string) => undefined);
    const ctx = {
      message: { text: "/settings ai-model" },
      reply,
    } as never;
    await settingsHandler?.(ctx);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toContain("settings");
    expect(reply.mock.calls[0]?.[0]).toContain("Eliza app");
  });
});

describe("applyTelegramSetMyCommands", () => {
  it("sends the catalog payload via bot.telegram.setMyCommands", async () => {
    const setMyCommands = vi.fn(
      async (_commands: Array<{ command: string; description: string }>) =>
        true,
    );
    const bot = { telegram: { setMyCommands } } as never;

    const ok = await applyTelegramSetMyCommands(bot, makeRuntime(), "default");

    expect(ok).toBeUndefined();
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    const payload = setMyCommands.mock.calls[0]?.[0] ?? [];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBeGreaterThan(0);
    expect(payload).toEqual(
      buildTelegramCommandDescriptors().map((descriptor) => ({
        command: descriptor.name,
        description: descriptor.description,
      })),
    );
  });

  it("swallows setMyCommands network failures without throwing", async () => {
    const setMyCommands = vi.fn(async () => {
      throw new Error("ETELEGRAM 429: Too Many Requests");
    });
    const bot = { telegram: { setMyCommands } } as never;

    await expect(
      applyTelegramSetMyCommands(bot, makeRuntime(), "default"),
    ).resolves.toBeUndefined();
    expect(setMyCommands).toHaveBeenCalledTimes(1);
  });
});
