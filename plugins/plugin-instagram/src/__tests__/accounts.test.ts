/**
 * Unit tests for Instagram account-config resolution (`accounts.ts`) against a
 * mocked runtime — legacy default account, named `INSTAGRAM_ACCOUNTS`, and
 * character-settings sources. No live Instagram API.
 */
import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  listInstagramAccountIds,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccountConfig,
} from "../accounts.js";
import { InstagramService } from "../service.js";

function runtime(settings: Record<string, string>): IAgentRuntime {
  return {
    character: { settings: {} },
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
});

describe("INSTAGRAM_ACCOUNTS fail-closed parsing (#18969)", () => {
  it("throws a typed config error on malformed JSON instead of an empty map", () => {
    const rt = runtime({ INSTAGRAM_ACCOUNTS: "{not json" });

    expect(() => listInstagramAccountIds(rt)).toThrowError(
      /Instagram accounts config is not valid JSON/
    );
  });

  it("throws on valid-JSON non-object payloads", () => {
    const rt = runtime({ INSTAGRAM_ACCOUNTS: '"just-a-string"' });

    expect(() => listInstagramAccountIds(rt)).toThrowError(/must be a JSON object or array/);
  });

  it("normalizes padded object keys so listing and lookup agree", () => {
    const rt = runtime({
      INSTAGRAM_DEFAULT_ACCOUNT_ID: "brand",
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        " brand ": { username: "brand-user", password: "brand-password" },
      }),
    });

    expect(listInstagramAccountIds(rt)).toContain("brand");
    const config = resolveInstagramAccountConfig(rt);
    expect(config.accountId).toBe("brand");
    // Pre-#18969 the padded key listed as `brand` but resolved to an empty
    // config (no username) because lookup used the raw map key.
    expect(config.username).toBe("brand-user");
  });

  it("keeps well-formed object and array shapes working", () => {
    const objectRt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify({ a: { username: "a-user" } }),
    });
    expect(listInstagramAccountIds(objectRt)).toContain("a");

    const arrayRt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify([{ accountId: "b", username: "b-user" }]),
    });
    expect(listInstagramAccountIds(arrayRt)).toContain("b");
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
