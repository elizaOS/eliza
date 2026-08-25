/**
 * Unit tests for Telegram multi-account resolution in `accounts.ts`.
 * Fail-closes ghost / unrecognized accountIds so they cannot inherit the
 * owner's character-level `settings.telegram.botToken` (or env
 * `TELEGRAM_BOT_TOKEN`). Uses a hand-built fake runtime; no live Telegram API.
 */
import type { Character, IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listEnabledTelegramAccounts,
  resolveTelegramAccount,
  type TelegramMultiAccountConfig,
} from "./accounts";

function createRuntime(
  telegram?: TelegramMultiAccountConfig,
  env?: Record<string, string | undefined>,
): IAgentRuntime {
  const character: Partial<Character> = {
    settings: telegram ? { telegram } : {},
  };
  const settings = env ?? {};
  return {
    agentId: "agent-1",
    character: character as Character,
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

const savedBotToken = process.env.TELEGRAM_BOT_TOKEN;
const savedApiRoot = process.env.TELEGRAM_API_ROOT;

afterEach(() => {
  if (savedBotToken === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = savedBotToken;
  }
  if (savedApiRoot === undefined) {
    delete process.env.TELEGRAM_API_ROOT;
  } else {
    process.env.TELEGRAM_API_ROOT = savedApiRoot;
  }
});

describe("resolveTelegramAccount owner-bind fail-closed", () => {
  it("lets the default account inherit character-level botToken", () => {
    const rt = createRuntime({ botToken: "owner-bot-token" });
    const resolved = resolveTelegramAccount(rt, "default");
    expect(resolved.accountId).toBe("default");
    expect(resolved.botToken).toBe("owner-bot-token");
  });

  it("still binds omitted accountId to the default owner botToken", () => {
    const rt = createRuntime({ botToken: "owner-bot-token" });
    const omitted = resolveTelegramAccount(rt);
    expect(omitted.accountId).toBe("default");
    expect(omitted.botToken).toBe("owner-bot-token");
  });

  it("lets the default account inherit env TELEGRAM_BOT_TOKEN", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const rt = createRuntime(undefined, {
      TELEGRAM_BOT_TOKEN: "env-bot-token",
    });
    const resolved = resolveTelegramAccount(rt, "default");
    expect(resolved.accountId).toBe("default");
    expect(resolved.botToken).toBe("env-bot-token");
  });

  it("does not give a ghost accountId the owner character botToken", () => {
    const rt = createRuntime({
      botToken: "owner-bot-token",
      accounts: { work: { botToken: "work-bot-token", enabled: true } },
    });
    const ghost = resolveTelegramAccount(rt, "ghost-account");
    expect(ghost.accountId).toBe("ghost-account");
    expect(ghost.botToken).toBeUndefined();
  });

  it("does not inherit env TELEGRAM_BOT_TOKEN for a ghost accountId", () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-bot-token";
    const rt = createRuntime(undefined, {
      TELEGRAM_BOT_TOKEN: "env-bot-token",
    });
    const ghost = resolveTelegramAccount(rt, "ghost-account");
    expect(ghost.accountId).toBe("ghost-account");
    expect(ghost.botToken).toBeUndefined();
  });

  it("does not let a named account without its own token inherit character botToken", () => {
    const rt = createRuntime({
      botToken: "owner-bot-token",
      accounts: { work: { enabled: true } },
    });
    const work = resolveTelegramAccount(rt, "work");
    expect(work.accountId).toBe("work");
    expect(work.botToken).toBeUndefined();
  });

  it("keeps a named account's own botToken and does not attach the owner token", () => {
    const rt = createRuntime({
      botToken: "owner-bot-token",
      accounts: {
        work: {
          enabled: true,
          botToken: "work-bot-token",
        },
      },
    });
    const work = resolveTelegramAccount(rt, "work");
    expect(work.accountId).toBe("work");
    expect(work.botToken).toBe("work-bot-token");
  });

  it("does not list ghost or tokenless named accounts as enabled bots", () => {
    const rt = createRuntime({
      botToken: "owner-bot-token",
      accounts: {
        work: { enabled: true },
        personal: { enabled: true, botToken: "personal-bot-token" },
      },
    });
    const enabled = listEnabledTelegramAccounts(rt);
    expect(enabled.map((account) => account.accountId)).toEqual(["personal"]);
    expect(enabled[0]?.botToken).toBe("personal-bot-token");
  });
});
