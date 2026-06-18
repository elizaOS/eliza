import type { IAgentRuntime } from "@elizaos/core";
import {
  type ConnectorCommand,
  getConnectorCommands,
} from "@elizaos/plugin-commands";
import { describe, expect, it, vi } from "vitest";
import {
  applyTelegramSetMyCommands,
  buildClientReply,
  buildNavigateReply,
  buildTelegramSetMyCommands,
  executeTelegramCommand,
  registerTelegramCommandHandlers,
} from "./command-registration";
import type { MessageManager } from "./messageManager";

const TELEGRAM_COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

function findCommand(predicate: (c: ConnectorCommand) => boolean) {
  const cmd = getConnectorCommands("telegram").find(predicate);
  if (!cmd) {
    throw new Error("No matching command in the telegram catalog");
  }
  return cmd;
}

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

describe("buildTelegramSetMyCommands", () => {
  it("returns a non-empty, well-formed setMyCommands payload", () => {
    const commands = buildTelegramSetMyCommands();

    expect(commands.length).toBeGreaterThan(0);
    for (const entry of commands) {
      expect(entry.command).toMatch(TELEGRAM_COMMAND_NAME);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(100);
    }
    // No reserved name should leak into the published menu name set.
    const names = commands.map((c) => c.command);
    expect(new Set(names).size).toBe(names.length); // de-duplicated
  });

  it("includes both an agent command and a navigation command", () => {
    const commands = getConnectorCommands("telegram");
    expect(commands.some((c) => c.target.kind === "agent")).toBe(true);
    expect(commands.some((c) => c.target.kind === "navigate")).toBe(true);
  });
});

describe("buildNavigateReply", () => {
  it("names the destination without a link when no app URL is configured", () => {
    const settingsCmd = findCommand(
      (c) => c.target.kind === "navigate" && c.name === "settings",
    );
    const reply = buildNavigateReply(settingsCmd, null);
    expect(reply).toContain("settings");
    expect(reply).toContain("Eliza app");
    expect(reply).not.toContain("http");
  });

  it("appends a deep link when an app base URL and path are present", () => {
    const settingsCmd = findCommand(
      (c) => c.target.kind === "navigate" && c.name === "settings",
    );
    const reply = buildNavigateReply(settingsCmd, "https://app.eliza.test");
    expect(reply).toContain("https://app.eliza.test/settings");
  });

  it("folds in the default section when the command target carries one", () => {
    const settingsCmd = findCommand(
      (c) => c.target.kind === "navigate" && c.name === "settings",
    );
    // The settings catalog entry has no default `section` today; synthesize one
    // to assert the formatting branch deterministically.
    const withSection: ConnectorCommand = {
      ...settingsCmd,
      target: { kind: "navigate", path: "/settings", section: "ai-model" },
    };
    const reply = buildNavigateReply(withSection, null);
    expect(reply).toContain("settings → ai-model");
  });

  it("throws when handed a non-navigate command", () => {
    const agentCmd = findCommand((c) => c.target.kind === "agent");
    expect(() => buildNavigateReply(agentCmd, null)).toThrow();
  });
});

describe("executeTelegramCommand", () => {
  it("routes agent commands through handleMessage with forceReply", async () => {
    const helpCmd = findCommand(
      (c) => c.name === "help" && c.target.kind === "agent",
    );
    const { manager, handleMessage } = makeMessageManager();
    const reply = vi.fn(async () => undefined);
    const ctx = {
      message: { text: "/help" },
      reply,
    } as never;

    await executeTelegramCommand(
      helpCmd,
      ctx,
      makeRuntime(),
      manager,
      "default",
    );

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith(ctx, { forceReply: true });
    expect(reply).not.toHaveBeenCalled();
  });

  it("replies with a navigation hint for navigate commands (no agent routing)", async () => {
    const navCmd = findCommand(
      (c) => c.target.kind === "navigate" && c.name === "settings",
    );
    const { manager, handleMessage } = makeMessageManager();
    const reply = vi.fn(async (_text: string) => undefined);
    const ctx = { message: { text: "/settings" }, reply } as never;

    await executeTelegramCommand(
      navCmd,
      ctx,
      makeRuntime({ ELIZA_APP_URL: "https://app.eliza.test" }),
      manager,
      "default",
    );

    expect(handleMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toContain(
      "https://app.eliza.test/settings",
    );
  });

  it("replies with an unavailable notice for client commands", async () => {
    const clientCmd: ConnectorCommand = {
      key: "clear",
      name: "clear",
      description: "Clear the chat",
      options: [],
      target: { kind: "client", clientAction: "clear-chat" },
    };
    const { manager, handleMessage } = makeMessageManager();
    const reply = vi.fn(async (_text: string) => undefined);
    const ctx = { message: { text: "/clear" }, reply } as never;

    await executeTelegramCommand(
      clientCmd,
      ctx,
      makeRuntime(),
      manager,
      "default",
    );

    expect(handleMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toBe(buildClientReply(clientCmd));
    expect(reply.mock.calls[0]?.[0]).toContain("Telegram");
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
    expect(registered).not.toContain("eliza_pair");
    expect(registered).not.toContain("start");
    // bot.command was invoked once per registered command, with the name first.
    expect(command).toHaveBeenCalledTimes(registered.length);
    const registeredNames = command.mock.calls.map((call) => call[0]);
    expect(registeredNames).toEqual(registered);
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
});

describe("applyTelegramSetMyCommands", () => {
  it("sends the catalog payload via bot.telegram.setMyCommands", async () => {
    const setMyCommands = vi.fn(
      async (_commands: Array<{ command: string; description: string }>) =>
        true,
    );
    const bot = { telegram: { setMyCommands } } as never;

    const ok = await applyTelegramSetMyCommands(bot, makeRuntime(), "default");

    expect(ok).toBe(true);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    const payload = setMyCommands.mock.calls[0]?.[0] ?? [];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBeGreaterThan(0);
    expect(payload).toEqual(buildTelegramSetMyCommands());
  });

  it("swallows setMyCommands network failures without throwing", async () => {
    const setMyCommands = vi.fn(async () => {
      throw new Error("ETELEGRAM 429: Too Many Requests");
    });
    const bot = { telegram: { setMyCommands } } as never;

    await expect(
      applyTelegramSetMyCommands(bot, makeRuntime(), "default"),
    ).resolves.toBe(false);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
  });
});
