import { afterEach, describe, expect, it, vi } from "vitest";
import { WechatChannel } from "./channel";
import type { WechatMessageContext } from "./types";

function createConfig() {
  return {
    accounts: {
      main: {
        apiKey: "main-key",
        proxyUrl: "https://proxy.example.com",
      },
      secondary: {
        apiKey: "secondary-key",
        proxyUrl: "https://proxy.example.com",
      },
    },
  };
}

function createMessage(
  overrides: Partial<WechatMessageContext> = {},
): WechatMessageContext {
  return {
    id: "wechat-msg-1",
    type: "text",
    sender: "wxid-alice",
    recipient: "wxid-agent",
    content: "hello agent",
    timestamp: 123,
    raw: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WechatChannel", () => {
  it("routes inbound messages to the matching account bot", () => {
    const channel = new WechatChannel({
      config: createConfig(),
      onMessage: vi.fn(),
    });
    const mainBot = { handleIncoming: vi.fn(), stop: vi.fn() };
    const secondaryBot = { handleIncoming: vi.fn(), stop: vi.fn() };

    (
      channel as unknown as {
        accounts: Map<
          string,
          { client: object; dispatcher: object; bot: typeof mainBot }
        >;
        routeIncoming: (accountId: string, msg: WechatMessageContext) => void;
      }
    ).accounts.set("main", {
      client: {},
      dispatcher: {},
      bot: mainBot,
    });
    (
      channel as unknown as {
        accounts: Map<
          string,
          { client: object; dispatcher: object; bot: typeof secondaryBot }
        >;
      }
    ).accounts.set("secondary", {
      client: {},
      dispatcher: {},
      bot: secondaryBot,
    });

    (
      channel as unknown as {
        routeIncoming: (accountId: string, msg: WechatMessageContext) => void;
      }
    ).routeIncoming("secondary", createMessage());

    expect(mainBot.handleIncoming).not.toHaveBeenCalled();
    expect(secondaryBot.handleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wechat-msg-1" }),
    );
  });

  it("times out login when QR verification never completes", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const channel = new WechatChannel({
      config: createConfig(),
      onMessage: vi.fn(),
    });
    const client = {
      getStatus: vi.fn().mockResolvedValue({
        valid: true,
        loginState: "waiting",
      }),
      getQRCode: vi.fn().mockResolvedValue("https://proxy.example.com/qr"),
      checkLogin: vi.fn().mockResolvedValue({ status: "waiting" }),
    };

    (
      channel as unknown as { abortController: AbortController | null }
    ).abortController = new AbortController();

    const loginPromise = (
      channel as unknown as {
        ensureLoggedIn: (
          accountId: string,
          client: typeof client,
        ) => Promise<void>;
      }
    ).ensureLoggedIn("main", client);
    const rejection = expect(loginPromise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);
    await rejection;
  });
});
