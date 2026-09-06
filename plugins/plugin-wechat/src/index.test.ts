/**
 * Unit tests for the direct WeChat connector's transport-independent
 * internals with mocked collaborators: `Bot` dedup/gating and delivery-failure
 * propagation, `ReplyDispatcher` chunking (against a stub transport),
 * runtime-bridge reply memory construction, direct config resolution with
 * typed rejection of legacy proxy/personal shapes, and observed-targets-only
 * account selection. No network.
 */
import { describe, expect, it, vi } from "vitest";
import { Bot } from "./bot";
import { resolveDirectAccount, WechatChannel } from "./channel";
import { WechatDeliveryError } from "./delivery-error";
import { isWechatConnectorConfigured } from "./index";
import {
  ReplyDispatcher,
  type WechatOutboundTransport,
} from "./reply-dispatcher";
import { deliverIncomingWechatMessage } from "./runtime-bridge";
import type { WechatMessageContext } from "./types";
import { WechatError } from "./types";

function baseMessage(
  overrides: Partial<WechatMessageContext> = {},
): WechatMessageContext {
  return {
    id: "msg-1",
    type: "text",
    sender: "openid-alice",
    recipient: "gh_app",
    content: "hello",
    timestamp: 1_700_000_000,
    platform: { mode: "official-account", accountId: "main" },
    raw: {},
    ...overrides,
  };
}

describe("direct config resolution (#24371)", () => {
  it("resolves a valid official-account configuration", () => {
    const resolved = resolveDirectAccount("main", {
      mode: "official-account",
      appId: " wx1234 ",
      appSecret: "sec",
      token: "tok",
    });
    expect(resolved).toMatchObject({
      id: "main",
      mode: "official-account",
      platformIdentity: "wx1234",
      securityMode: "plaintext",
    });
  });

  it("resolves a valid wecom self-built configuration", () => {
    const resolved = resolveDirectAccount("corp", {
      mode: "wecom",
      corpId: "corp1",
      agentId: 7,
      corpSecret: "sec",
      token: "tok",
      encodingAESKey: "K".repeat(43),
    });
    expect(resolved).toMatchObject({
      id: "corp",
      mode: "wecom",
      platformAccountId: "corp1_7",
      wecomAgentId: 7,
      securityMode: "encrypted",
    });
  });

  it("rejects personal mode with its dedicated typed error", () => {
    expect(() =>
      resolveDirectAccount("p", {
        mode: "personal",
      } as never),
    ).toThrowError(
      expect.objectContaining({ code: "WECHAT_PERSONAL_MODE_UNSUPPORTED" }),
    );
  });

  it("rejects proxy mode with its dedicated typed error", () => {
    expect(() =>
      resolveDirectAccount("p", {
        mode: "proxy",
        apiKey: "k",
        proxyUrl: "https://proxy.example.com",
      } as never),
    ).toThrowError(
      expect.objectContaining({ code: "WECHAT_PROXY_CONFIG_UNSUPPORTED" }),
    );
  });

  it("rejects incomplete official-account credentials", () => {
    expect(() =>
      resolveDirectAccount("oa", {
        mode: "official-account",
        appId: "wx1",
        appSecret: "",
        token: "t",
      }),
    ).toThrowError(expect.objectContaining({ code: "WECHAT_CONFIG_INVALID" }));
  });

  it("rejects encrypted security mode without an encodingAESKey", () => {
    expect(() =>
      resolveDirectAccount("oa", {
        mode: "official-account",
        appId: "wx1",
        appSecret: "s",
        token: "t",
        messageSecurityMode: "encrypted",
      }),
    ).toThrowError(expect.objectContaining({ code: "WECHAT_CONFIG_INVALID" }));
  });

  it("rejects incomplete wecom credentials", () => {
    expect(() =>
      resolveDirectAccount("w", {
        mode: "wecom",
        corpId: "corp1",
        corpSecret: "s",
        token: "t",
        encodingAESKey: "K".repeat(43),
      } as never),
    ).toThrowError(expect.objectContaining({ code: "WECHAT_CONFIG_INVALID" }));
  });

  it("detects configured direct accounts and ignores proxy-shaped config", () => {
    expect(
      isWechatConnectorConfigured({
        account: {
          mode: "official-account",
          appId: "a",
          appSecret: "s",
          token: "t",
        },
      }),
    ).toBe(true);
    expect(
      isWechatConnectorConfigured({
        accounts: {
          corp: {
            mode: "wecom",
            corpId: "c",
            agentId: 1,
            corpSecret: "s",
            token: "t",
            encodingAESKey: "K".repeat(43),
          },
        },
      }),
    ).toBe(true);
    // Legacy proxy config no longer counts as configured.
    expect(
      isWechatConnectorConfigured({
        apiKey: "k",
        proxyUrl: "https://p",
      } as never),
    ).toBe(false);
    expect(isWechatConnectorConfigured(undefined)).toBe(false);
  });
  it("does not treat a disabled single-account block as configured", () => {
    expect(
      isWechatConnectorConfigured({
        account: {
          mode: "official-account",
          appId: "a",
          appSecret: "s",
          token: "t",
          enabled: false,
        },
      }),
    ).toBe(false);
  });

  it("rejects whitespace-only account ids at channel resolution", () => {
    const channel = new WechatChannel({
      config: {
        accounts: {
          "   ": {
            mode: "wecom",
            corpId: "c",
            agentId: 1,
            corpSecret: "s",
            token: "t",
            encodingAESKey: "K".repeat(43),
          },
        },
      },
      onMessage: () => undefined,
    });
    expect(() => channel.resolveAccounts()).toThrow(
      expect.objectContaining({ code: "WECHAT_CONFIG_INVALID" }),
    );
  });

  it("resolves callbackIdentity for both direct modes", () => {
    const channel = new WechatChannel({
      config: {
        accounts: {
          oa: {
            mode: "official-account",
            appId: "wx-app",
            appSecret: "s",
            token: "t",
            callbackId: "gh_original",
          },
          wecom: {
            mode: "wecom",
            corpId: "corp9",
            agentId: 7,
            corpSecret: "s",
            token: "t",
            encodingAESKey: "K".repeat(43),
          },
        },
      },
      onMessage: () => undefined,
    });
    const resolved = channel.resolveAccounts();
    const oa = resolved.find((a) => a.mode === "official-account");
    const wecom = resolved.find((a) => a.mode === "wecom");
    expect(oa?.callbackIdentity).toBe("gh_original");
    expect(oa?.platformIdentity).toBe("wx-app");
    expect(wecom?.callbackIdentity).toBe("corp9");
  });
});

describe("@elizaos/plugin-wechat internals", () => {
  it("deduplicates inbound messages before dispatching to runtime", async () => {
    const onMessage = vi.fn();
    const bot = new Bot({ onMessage });
    const message = baseMessage();

    await bot.handleIncoming(message);
    await bot.handleIncoming(message);
    bot.stop();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(message);
  });

  it("propagates failed delivery and leaves the message retryable", async () => {
    const failure = new Error("runtime delivery failed");
    const onMessage = vi
      .fn<(message: WechatMessageContext) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const bot = new Bot({ onMessage });
    const message = baseMessage({ id: "msg-retry" });

    await expect(bot.handleIncoming(message)).rejects.toBe(failure);
    await expect(bot.handleIncoming(message)).resolves.toBeUndefined();
    bot.stop();

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("makes concurrent duplicates share the owning delivery failure", async () => {
    let rejectOwner: ((error: Error) => void) | undefined;
    const ownerResult = new Promise<void>((_resolve, reject) => {
      rejectOwner = reject;
    });
    const onMessage = vi.fn(() => ownerResult);
    const bot = new Bot({ onMessage });
    const message = baseMessage({ id: "msg-concurrent" });

    const owner = bot.handleIncoming(message);
    const duplicate = bot.handleIncoming(message);
    const failure = new Error("runtime unavailable");
    rejectOwner?.(failure);

    await expect(owner).rejects.toBe(failure);
    await expect(duplicate).rejects.toBe(failure);
    expect(onMessage).toHaveBeenCalledTimes(1);
    bot.stop();
  });

  it("does not retry a message after its outbound side effect committed", async () => {
    const failure = new WechatDeliveryError("post-send persistence failed", {
      cause: new Error("database unavailable"),
      sideEffectCommitted: true,
    });
    const onMessage = vi.fn().mockRejectedValue(failure);
    const bot = new Bot({ onMessage });
    const message = baseMessage({ id: "msg-committed" });

    await expect(bot.handleIncoming(message)).rejects.toBe(failure);
    await expect(bot.handleIncoming(message)).resolves.toBeUndefined();
    expect(onMessage).toHaveBeenCalledTimes(1);
    bot.stop();
  });

  it("bounds the dedup cache at its declared cap under sustained inbound traffic", async () => {
    const onMessage = vi.fn();
    const bot = new Bot({ onMessage, dedupWindowMs: 60 * 60 * 1000 });
    const seen = (bot as unknown as { seen: Map<string, number> }).seen;

    for (let i = 0; i < 5000; i += 1) {
      await bot.handleIncoming(
        baseMessage({
          id: `msg-${i}`,
          content: `msg-${i}`,
          timestamp: Date.now(),
        }),
      );
    }

    expect(seen.size).toBeLessThanOrEqual(1000);
    expect(onMessage).toHaveBeenCalledTimes(5000);

    onMessage.mockClear();
    await bot.handleIncoming(
      baseMessage({ id: "msg-4999", timestamp: Date.now() }),
    );
    expect(onMessage).not.toHaveBeenCalled();

    onMessage.mockClear();
    await bot.handleIncoming(
      baseMessage({ id: "msg-0", timestamp: Date.now() }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    bot.stop();
  });

  it("expires a cached id at the dedup-window boundary plus one millisecond", async () => {
    const onMessage = vi.fn();
    const bot = new Bot({ onMessage, dedupWindowMs: 1000 });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const message = baseMessage({ timestamp: 10_000 });

    await bot.handleIncoming(message);
    nowSpy.mockReturnValue(11_000);
    await bot.handleIncoming(message);
    expect(onMessage).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(11_001);
    await bot.handleIncoming(message);
    expect(onMessage).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
    bot.stop();
  });

  it("marks a failure after sending a reply as non-retryable", async () => {
    const sendText = vi.fn(async () => undefined);
    const persistenceFailure = new Error("database unavailable");
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      createMemory: vi.fn(async () => {
        throw persistenceFailure;
      }),
      elizaOS: {
        sendMessage: async (
          _runtime: unknown,
          _message: unknown,
          options?: {
            onResponse?: (content: { text: string }) => Promise<unknown>;
          },
        ) => {
          await options?.onResponse?.({ text: "hello back" });
          return undefined;
        },
      },
    };

    const delivery = deliverIncomingWechatMessage({
      runtime,
      accountId: "main",
      message: baseMessage({ id: "msg-runtime-committed" }),
      sendText,
    });

    await expect(delivery).rejects.toEqual(
      expect.objectContaining({
        cause: persistenceFailure,
        sideEffectCommitted: true,
      }),
    );
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("chunks long outgoing text through the outbound transport", async () => {
    const client: WechatOutboundTransport = {
      sendText: vi.fn(async () => undefined),
    };
    const dispatcher = new ReplyDispatcher({ client, chunkSize: 5 });

    await dispatcher.sendText("openid-alice", "hello world");

    const sent = vi.mocked(client.sendText).mock.calls.map((call) => call[1]);
    expect(sent.join("")).toBe("hello world");
    expect(sent[0]).toBe("hello");
  });

  it("keeps surrogate pairs intact when chunking", async () => {
    const client: WechatOutboundTransport = {
      sendText: vi.fn(async () => undefined),
    };
    const dispatcher = new ReplyDispatcher({ client, chunkSize: 6 });

    await dispatcher.sendText("openid-alice", "aaaaa🦊bbbbb");

    const sent = vi.mocked(client.sendText).mock.calls.map((c) => c[1]);
    expect(sent.length).toBeGreaterThan(1);
    for (const chunk of sent) {
      expect(chunk.isWellFormed()).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(6);
    }
  });

  it.each([0, -1, Number.NaN, 1.5])(
    "rejects invalid reply chunk size %s",
    (chunkSize) => {
      const client: WechatOutboundTransport = {
        sendText: vi.fn(async () => undefined),
      };

      expect(() => new ReplyDispatcher({ client, chunkSize })).toThrow(
        expect.objectContaining({ code: "WECHAT_REPLY_CHUNK_SIZE_INVALID" }),
      );
    },
  );

  it("fails before sending when the chunk cap cannot fit an emoji", async () => {
    const client: WechatOutboundTransport = {
      sendText: vi.fn(async () => undefined),
    };
    const dispatcher = new ReplyDispatcher({ client, chunkSize: 1 });

    await expect(dispatcher.sendText("openid-alice", "🦊abc")).rejects.toEqual(
      expect.objectContaining({ code: "WECHAT_REPLY_CHUNK_SIZE_TOO_SMALL" }),
    );
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it("sanitizes pre-existing lone surrogates before sending", async () => {
    const client: WechatOutboundTransport = {
      sendText: vi.fn(async () => undefined),
    };
    const dispatcher = new ReplyDispatcher({ client, chunkSize: 3 });

    await dispatcher.sendText("openid-alice", "a\ud800bc");

    const sent = vi.mocked(client.sendText).mock.calls.map((call) => call[1]);
    expect(sent).toEqual(["a�b", "c"]);
    expect(sent.every((chunk) => chunk.isWellFormed())).toBe(true);
  });

  it("preserves whitespace exactly across a natural chunk boundary", async () => {
    const client: WechatOutboundTransport = {
      sendText: vi.fn(async () => undefined),
    };
    const dispatcher = new ReplyDispatcher({ client, chunkSize: 6 });

    await dispatcher.sendText("openid-alice", "hello  world");

    const sent = vi.mocked(client.sendText).mock.calls.map((call) => call[1]);
    expect(sent).toEqual(["hello ", " world"]);
    expect(sent.join("")).toBe("hello  world");
  });

  it("typed WechatError carries a stable machine code", () => {
    const err = new WechatError("WECHAT_CONFIG_INVALID", "test", { a: 1 });
    expect(err.code).toBe("WECHAT_CONFIG_INVALID");
    expect(err.context).toEqual({ a: 1 });
  });
});
