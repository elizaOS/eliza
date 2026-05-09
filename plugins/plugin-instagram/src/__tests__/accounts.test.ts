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
  } as unknown as IAgentRuntime;
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

describe("Instagram connector accounts", () => {
  it("registers account-scoped connectors and routes sends through the requested account", async () => {
    const registerMessageConnector = vi.fn();
    const registerPostConnector = vi.fn();
    const rt = {
      agentId: "agent-1",
      registerMessageConnector,
      registerPostConnector,
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
      logger: { info: vi.fn() },
    } as unknown as IAgentRuntime;

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
    expect(
      registerMessageConnector.mock.calls.map(([registration]) => registration.accountId)
    ).toEqual(["owner", "brand"]);

    const brandRegistration = registerMessageConnector.mock.calls[1][0];
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
});
