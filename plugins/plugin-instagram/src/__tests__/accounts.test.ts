/**
 * Unit tests for Instagram account-config resolution (`accounts.ts`) against a
 * mocked runtime — legacy default account, named `INSTAGRAM_ACCOUNTS`, padded
 * keys, and fail-closed malformed JSON. No live Instagram API.
 */
import { type Content, ElizaError, type IAgentRuntime, type TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  listInstagramAccountIds,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccountConfig,
} from "../accounts.js";
import { InstagramService } from "../service.js";

function runtime(
  settings: Record<string, string>,
  characterSettings: Record<string, unknown> = {}
): IAgentRuntime {
  return {
    character: { settings: characterSettings },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as IAgentRuntime;
}

describe("Instagram account config", () => {
  it("preserves legacy env settings as the default account", () => {
    const rt = runtime({
      INSTAGRAM_USERNAME: "owner",
      INSTAGRAM_PASSWORD: "password",
    });

    expect(resolveDefaultInstagramAccountId(rt)).toBe("default");
    expect(listInstagramAccountIds(rt)).toContain("default");
    expect(resolveInstagramAccountConfig(rt).accountId).toBe("default");
  });

  it("resolves named accounts from INSTAGRAM_ACCOUNTS", () => {
    const rt = runtime({
      INSTAGRAM_DEFAULT_ACCOUNT_ID: "brand",
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        brand: {
          username: "brand",
          password: "brand-password",
        },
      }),
    });

    const config = resolveInstagramAccountConfig(rt);
    expect(config.accountId).toBe("brand");
    expect(config.username).toBe("brand");
  });

  it("resolves padded object keys so the listed id matches the config", () => {
    const rt = runtime({
      INSTAGRAM_DEFAULT_ACCOUNT_ID: "brand",
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        " brand ": {
          username: "brand-user",
          password: "brand-password",
        },
      }),
    });

    expect(listInstagramAccountIds(rt)).toEqual(["brand"]);
    expect(resolveInstagramAccountConfig(rt, "brand")).toMatchObject({
      accountId: "brand",
      username: "brand-user",
      password: "brand-password",
    });
  });

  it("normalizes array account ids and skips non-object entries", () => {
    const rt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify([
        { id: " work ", username: "work-user", password: "work-password" },
        null,
        "bad",
        12,
        { accountId: "", username: "fallback", password: "fallback-password" },
      ]),
    });

    expect(listInstagramAccountIds(rt)).toEqual(["default", "work"]);
    expect(resolveInstagramAccountConfig(rt, "work")).toMatchObject({
      accountId: "work",
      username: "work-user",
      password: "work-password",
    });
    expect(resolveInstagramAccountConfig(rt, "default")).toMatchObject({
      accountId: "default",
      username: "fallback",
      password: "fallback-password",
    });
  });

  it("resolves padded character.settings.instagram.accounts keys", () => {
    const rt = runtime(
      {},
      {
        instagram: {
          accounts: {
            " brand ": {
              username: "character-brand",
              password: "character-password",
            },
          },
        },
      }
    );

    expect(listInstagramAccountIds(rt)).toEqual(["brand"]);
    expect(resolveInstagramAccountConfig(rt, "brand")).toMatchObject({
      accountId: "brand",
      username: "character-brand",
      password: "character-password",
    });
  });

  it("fails closed for malformed INSTAGRAM_ACCOUNTS JSON", () => {
    const rt = runtime({
      INSTAGRAM_USERNAME: "owner",
      INSTAGRAM_PASSWORD: "password",
      INSTAGRAM_ACCOUNTS: "{not-json",
    });

    expect(() => listInstagramAccountIds(rt)).toThrow(ElizaError);
    try {
      resolveDefaultInstagramAccountId(rt);
      throw new Error("expected malformed INSTAGRAM_ACCOUNTS to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("INSTAGRAM_CONFIG_INVALID");
      expect((error as ElizaError).context).toEqual({
        setting: "INSTAGRAM_ACCOUNTS",
      });
      expect((error as ElizaError).severity).toBe("fatal");
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("fails closed when INSTAGRAM_ACCOUNTS is a JSON primitive", () => {
    const rt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify("not-an-object"),
    });

    try {
      listInstagramAccountIds(rt);
      throw new Error("expected non-object INSTAGRAM_ACCOUNTS to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("INSTAGRAM_CONFIG_INVALID");
      expect((error as ElizaError).context).toEqual({
        setting: "INSTAGRAM_ACCOUNTS",
        valueType: "string",
      });
      expect((error as ElizaError).severity).toBe("fatal");
    }
  });
});

describe("Instagram connector accounts", () => {
  it("registers account-scoped connectors and routes sends through the requested account", async () => {
    const messageRegistrations: Array<
      Parameters<NonNullable<IAgentRuntime["registerMessageConnector"]>>[0]
    > = [];
    const registerMessageConnector = vi.fn((registration) => {
      messageRegistrations.push(registration);
    });
    const registerPostConnector = vi.fn();
    const rt = {
      agentId: "agent-1",
      registerMessageConnector,
      registerPostConnector,
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
      logger: { info: vi.fn() },
    } as IAgentRuntime;

    const service = Object.create(InstagramService.prototype) as InstagramService;
    const owner = Object.create(InstagramService.prototype) as InstagramService;
    const brand = Object.create(InstagramService.prototype) as InstagramService;
    const ownerSend = vi.fn();
    const brandSend = vi.fn();
    Object.assign(owner, {
      instagramConfig: { accountId: "owner", username: "owner", password: "pw" },
      isRunning: true,
      sendDirectMessage: ownerSend,
    });
    Object.assign(brand, {
      instagramConfig: { accountId: "brand", username: "brand", password: "pw" },
      isRunning: true,
      sendDirectMessage: brandSend,
    });
    Object.assign(service, {
      defaultAccountId: "owner",
      accountServices: new Map([
        ["owner", owner],
        ["brand", brand],
      ]),
    });

    InstagramService.registerSendHandlers(rt, service, "owner");
    InstagramService.registerSendHandlers(rt, service, "brand");

    expect(registerMessageConnector).toHaveBeenCalledTimes(2);
    expect(registerPostConnector).toHaveBeenCalledTimes(2);
    expect(messageRegistrations.map((registration) => registration.accountId)).toEqual([
      "owner",
      "brand",
    ]);

    const brandRegistration = messageRegistrations[1];
    await brandRegistration.sendHandler(
      rt,
      {
        source: "instagram",
        accountId: "brand",
        channelId: "thread-brand",
      } as TargetInfo,
      { text: "hello" } as Content
    );

    expect(brandSend).toHaveBeenCalledWith("thread-brand", "hello");
    expect(ownerSend).not.toHaveBeenCalled();
  });

  it("fails API operations explicitly instead of returning synthetic Instagram data", async () => {
    const service = Object.create(InstagramService.prototype) as InstagramService;
    Object.assign(service, {
      isRunning: true,
    });

    await expect(service.sendDirectMessage("thread-1", "hello")).rejects.toThrow(
      "requires a configured Instagram API client"
    );
    await expect(service.postComment(123, "hello")).rejects.toThrow(
      "requires a configured Instagram API client"
    );
    await expect(service.getUserInfo(456)).rejects.toThrow(
      "requires a configured Instagram API client"
    );
    await expect(service.getThreads()).rejects.toThrow(
      "requires a configured Instagram API client"
    );
  });
});
