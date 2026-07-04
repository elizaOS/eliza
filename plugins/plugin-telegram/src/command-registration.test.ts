/**
 * Unit tests for the command-registration helpers: that the universal command
 * catalog maps to a well-formed `setMyCommands` payload, one Telegraf handler
 * per command (never clobbering `eliza_pair`), and role-gated dispatch. Runtime
 * and `hasRoleAccess` are mocked.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The connector bridge gates auth via the agent role model (`hasRoleAccess`).
// Mock it so each test controls the sender's resolved trust level without
// standing up a full world/role graph. The default returns true (lenient
// no-world path), matching real local-only behavior. `vi.hoisted` is required
// because `vi.mock` factories are hoisted above imports.
const { hasRoleAccess } = vi.hoisted(() => ({
  hasRoleAccess: vi.fn(async () => true),
}));
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return { ...actual, hasRoleAccess };
});

const pluginCommandsMock = vi.hoisted(() => ({
  getConnectorCommands: vi.fn(() => [
    {
      name: "think",
      description: "Set thinking level",
      target: { kind: "agent" },
    },
    {
      name: "stop",
      description: "Stop the current task",
      target: { kind: "agent" },
    },
    {
      name: "settings",
      description: "Open settings",
      target: { kind: "navigate", viewId: "settings" },
    },
    {
      name: "restart",
      description: "Restart the agent",
      target: { kind: "agent" },
      requiresAuth: true,
    },
  ]),
  gateConnectorCommandByName: vi.fn(
    (
      _agentId: string,
      commandName: string,
      sender: { isAuthorized?: boolean },
    ) =>
      commandName === "restart" && !sender.isAuthorized
        ? { allowed: false, reply: "This command requires authorization." }
        : { allowed: true },
  ),
  resolveCommand: vi.fn(async (_runtime, message) => {
    const text = message.content?.text ?? "";
    if (text.startsWith("/think")) {
      return { handled: true, reply: "Thinking set to high." };
    }
    return { handled: false };
  }),
  resolveSettingsSection: vi.fn((raw: string) =>
    raw === "ai-model" ? "AI Model" : undefined,
  ),
}));

vi.mock("@elizaos/plugin-commands", () => pluginCommandsMock);

import {
  applyTelegramSetMyCommands,
  buildTelegramCommandDescriptors,
  registerTelegramCommandHandlers,
  resolveTelegramEmbedUrl,
} from "./command-registration";
import type { MessageManager } from "./messageManager";

const { getConnectorCommands } = pluginCommandsMock;

const TELEGRAM_COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    character: { name: "TestAgent" },
  } as unknown as IAgentRuntime;
}

function makeMessageManager() {
  const handleMessage = vi.fn(async () => undefined);
  return {
    manager: { handleMessage } as unknown as MessageManager,
    handleMessage,
  };
}

/** A Telegram context with sender + chat identity so auth resolution runs. */
function makeCtx(text: string) {
  const reply = vi.fn(async (_text: string) => undefined);
  return {
    ctx: {
      message: { text },
      from: { id: 4242, username: "tester" },
      chat: { id: -100123 },
      reply,
    } as never,
    reply,
  };
}

function registerHandlers(
  runtime = makeRuntime(),
  manager = makeMessageManager().manager,
) {
  const handlers = new Map<string, (ctx: never) => Promise<void>>();
  const command = vi.fn(
    (name: string, handler: (ctx: never) => Promise<void>) => {
      handlers.set(name, handler);
    },
  );
  const bot = { command } as never;
  const registered = registerTelegramCommandHandlers(
    bot,
    runtime,
    manager,
    "default",
  );
  return { handlers, registered, command };
}

beforeEach(() => {
  hasRoleAccess.mockReset();
  hasRoleAccess.mockResolvedValue(true);
});

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
    const { registered, command } = registerHandlers();

    expect(registered.length).toBeGreaterThan(0);
    // Reserved names owned by other services must be skipped.
    expect(registered.map((entry) => entry.name)).not.toContain("eliza_pair");
    expect(registered.map((entry) => entry.name)).not.toContain("start");
    // bot.command is invoked once per registered catalog command, plus /app for
    // the Telegram Mini App launch surface.
    expect(command).toHaveBeenCalledTimes(registered.length + 1);
    const registeredNames = command.mock.calls.map((call) => call[0]);
    expect(registeredNames).toEqual([
      "app",
      ...registered.map((entry) => entry.name),
    ]);
    // Every registered handler is a function (the second arg).
    for (const call of command.mock.calls) {
      expect(typeof call[1]).toBe("function");
    }
  });

  it("agent option command: resolves a deterministic local reply without the pipeline", async () => {
    const { manager, handleMessage } = makeMessageManager();
    const { handlers } = registerHandlers(makeRuntime(), manager);

    const thinkHandler = handlers.get("think");
    expect(thinkHandler).toBeDefined();
    const { ctx, reply } = makeCtx("/think high");
    await thinkHandler?.(ctx);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toContain("Thinking set to high.");
  });

  it("agent (pipeline-owned): routes the command message and forces a reply", async () => {
    // `stop` is an agent command whose side effects are owned by the pipeline,
    // so it must route through the agent.
    const { manager, handleMessage } = makeMessageManager();
    const { handlers } = registerHandlers(makeRuntime(), manager);

    const stopHandler = handlers.get("stop");
    expect(stopHandler).toBeDefined();
    const { ctx } = makeCtx("/stop");
    await stopHandler?.(ctx);

    expect(handleMessage).toHaveBeenCalledWith(ctx, { forceReply: true });
  });

  it("wires navigate handlers to reply with an app destination", async () => {
    const { manager, handleMessage } = makeMessageManager();
    const { handlers } = registerHandlers(makeRuntime(), manager);

    const settingsHandler = handlers.get("settings");
    expect(settingsHandler).toBeDefined();
    const { ctx, reply } = makeCtx("/settings ai-model");
    await settingsHandler?.(ctx);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toContain("settings");
    expect(reply.mock.calls[0]?.[0]).toContain("Eliza app");
  });
});

describe("Telegram Mini App launch command", () => {
  it("normalizes a configured HTTPS app URL to /embed?platform=telegram", () => {
    expect(
      resolveTelegramEmbedUrl(
        makeRuntime({ ELIZA_EMBED_URL: "https://app.elizacloud.ai/" }),
      ),
    ).toBe("https://app.elizacloud.ai/embed?platform=telegram");
    expect(
      resolveTelegramEmbedUrl(
        makeRuntime({ ELIZA_EMBED_URL: "http://app.elizacloud.ai/embed" }),
      ),
    ).toBeNull();
  });

  it("emits a web_app button only for OWNER or ADMIN senders", async () => {
    hasRoleAccess.mockResolvedValue(false);
    const denied = registerHandlers(
      makeRuntime({ ELIZA_EMBED_URL: "https://app.elizacloud.ai/embed" }),
    );
    const deniedHandler = denied.handlers.get("app");
    const deniedCtx = makeCtx("/app");
    await deniedHandler?.(deniedCtx.ctx);
    expect(deniedCtx.reply.mock.calls[0]?.[0]).toContain("OWNER or ADMIN");

    hasRoleAccess.mockReset();
    hasRoleAccess.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const allowed = registerHandlers(
      makeRuntime({ ELIZA_EMBED_URL: "https://app.elizacloud.ai/embed" }),
    );
    const allowedHandler = allowed.handlers.get("app");
    const allowedCtx = makeCtx("/app");
    await allowedHandler?.(allowedCtx.ctx);
    expect(allowedCtx.reply).toHaveBeenCalledWith(
      "Open the Eliza app.",
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Open Eliza",
                web_app: {
                  url: "https://app.elizacloud.ai/embed?platform=telegram",
                },
              },
            ],
          ],
        },
      }),
    );
  });
});

describe("auth gating", () => {
  it("refuses a requiresAuth command when the sender is not an owner", async () => {
    hasRoleAccess.mockResolvedValue(false);
    const { manager, handleMessage } = makeMessageManager();
    const { handlers } = registerHandlers(makeRuntime(), manager);

    // `restart` requires auth and is pipeline-owned.
    const restartHandler = handlers.get("restart");
    expect(restartHandler).toBeDefined();
    const { ctx, reply } = makeCtx("/restart");
    await restartHandler?.(ctx);

    // Refused before any dispatch.
    expect(handleMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toContain("requires authorization");
  });

  it("allows a requiresAuth command when the sender is an owner", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const { manager, handleMessage } = makeMessageManager();
    const { handlers } = registerHandlers(makeRuntime(), manager);

    const restartHandler = handlers.get("restart");
    expect(restartHandler).toBeDefined();
    const { ctx } = makeCtx("/restart");
    await restartHandler?.(ctx);

    // Owner access → command routes to the agent.
    expect(handleMessage).toHaveBeenCalledWith(ctx, { forceReply: true });
  });

  it("consults both the OWNER and ADMIN roles when resolving the sender", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const { manager } = makeMessageManager();
    const { handlers } = registerHandlers(makeRuntime(), manager);

    const restartHandler = handlers.get("restart");
    const { ctx } = makeCtx("/restart");
    await restartHandler?.(ctx);

    const requestedRoles = hasRoleAccess.mock.calls.map((call) => call[2]);
    expect(requestedRoles).toContain("OWNER");
    expect(requestedRoles).toContain("ADMIN");
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
