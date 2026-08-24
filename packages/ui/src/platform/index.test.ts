/** Verifies the platform barrel's uncovered runtime surface through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers consumer-visible behaviour exported through
 * `packages/ui/src/platform/index.ts` that no sibling module suite pins today:
 * `handleDeepLink` routing (including the connect URL validation and the share
 * file parsing), the `dispatchShareTarget` hand-off queue, `isPopoutWindow`
 * detection, the local-runtime capability predicates as observed under this
 * web runtime, and one launch round-trip proving the aggregate surface wires
 * together. Deeper per-module contracts live beside their own modules; this
 * suite drives everything through the barrel exactly as `@elizaos/ui/platform`
 * consumers import it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAssistantLaunchPayloadClaimsForTests } from "./assistant-launch-payload";
import {
  buildAssistantLaunchMetadata,
  canHostLocalAgent,
  canRunLocal,
  canSelectLocalRuntime,
  consumeAssistantLaunchPayloadFromHash,
  type DeepLinkHandlers,
  dispatchShareTarget,
  handleDeepLink,
  isAndroid,
  isDesktopPlatform,
  isElizaOS,
  isIOS,
  isNative,
  isPopoutWindow,
  isWebPlatform,
  platform,
  readAssistantLaunchPayloadFromHash,
  type ShareTargetPayload,
} from "./index";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  delete window.__ELIZAOS_SHARE_QUEUE__;
});

afterEach(() => {
  __resetAssistantLaunchPayloadClaimsForTests();
});

describe("handleDeepLink — eliza:// route table", () => {
  it("routes the chat path to onChat", () => {
    const onChat = vi.fn();
    handleDeepLink("eliza://chat", "eliza", { onChat });
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it("routes the settings path to onSettings", () => {
    const onSettings = vi.fn();
    handleDeepLink("eliza://settings", "eliza", { onSettings });
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("ignores URLs whose protocol does not match the app scheme", () => {
    const handlers: DeepLinkHandlers = {
      onChat: vi.fn(),
      onUnknown: vi.fn(),
    };
    handleDeepLink("https://example.com/chat", "eliza", handlers);
    expect(handlers.onChat).not.toHaveBeenCalled();
    expect(handlers.onUnknown).not.toHaveBeenCalled();
  });

  it("ignores malformed deep links without throwing (untrusted input)", () => {
    const onUnknown = vi.fn();
    expect(() =>
      handleDeepLink(":://not a url", "eliza", { onUnknown }),
    ).not.toThrow();
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it("hands unknown paths to onUnknown with leading slashes stripped", () => {
    const onUnknown = vi.fn();
    handleDeepLink("eliza:///wallet", "eliza", { onUnknown });
    expect(onUnknown).toHaveBeenCalledWith("wallet");
  });

  it("forwards https gateway URLs to onConnect as normalized hrefs", () => {
    const onConnect = vi.fn();
    handleDeepLink(
      "eliza://connect?url=https%3A%2F%2Fgw.example.com%2Fapi",
      "eliza",
      { onConnect },
    );
    expect(onConnect).toHaveBeenCalledWith("https://gw.example.com/api");
  });

  it("accepts plaintext http only for the gateway hand-off, not other schemes", () => {
    const onConnectHttp = vi.fn();
    handleDeepLink(
      "eliza://connect?url=http%3A%2F%2F192.168.1.10%3A3000",
      "eliza",
      { onConnect: onConnectHttp },
    );
    expect(onConnectHttp).toHaveBeenCalledWith("http://192.168.1.10:3000/");

    const onConnectJs = vi.fn();
    handleDeepLink("eliza://connect?url=javascript%3Aalert(1)", "eliza", {
      onConnect: onConnectJs,
    });
    expect(onConnectJs).not.toHaveBeenCalled();
  });

  it("ignores a connect action with no url parameter or an unparseable one", () => {
    const onConnect = vi.fn();
    handleDeepLink("eliza://connect", "eliza", { onConnect });
    handleDeepLink("eliza://connect?url=%3A%2F%2Fbad", "eliza", { onConnect });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("parses share payloads including file basenames from both slash styles", () => {
    const onShare = vi.fn();
    handleDeepLink(
      "eliza://share?title=Hello&text=World&url=https%3A%2F%2Fx.example%2Fa" +
        "&file=%2Fstorage%2Femulated%2F0%2Fpic.jpg&file=D%3A%5CUsers%5Cn.png" +
        "&file=",
      "eliza",
      { onShare },
    );
    expect(onShare).toHaveBeenCalledWith({
      source: "deep-link",
      title: "Hello",
      text: "World",
      url: "https://x.example/a",
      files: [
        { name: "pic.jpg", path: "/storage/emulated/0/pic.jpg" },
        { name: "n.png", path: "D:\\Users\\n.png" },
      ],
    });
  });

  it("still reports a bare share with defaults when nothing was attached", () => {
    const onShare = vi.fn();
    handleDeepLink("eliza://share", "eliza", { onShare });
    expect(onShare).toHaveBeenCalledWith({
      source: "deep-link",
      title: undefined,
      text: undefined,
      url: undefined,
      files: [],
    });
  });
});

describe("dispatchShareTarget — queued hand-off to the shell", () => {
  it("queues the payload and notifies the dispatcher with the event name", () => {
    const dispatchEvent = vi.fn();
    const payload: ShareTargetPayload = { title: "t", text: "hi" };
    dispatchShareTarget(payload, dispatchEvent, "eliza:share");
    expect(dispatchEvent).toHaveBeenCalledWith("eliza:share", payload);
    expect(window.__ELIZAOS_SHARE_QUEUE__).toEqual([payload]);
  });

  it("accumulates queued payloads across calls in arrival order", () => {
    const dispatchEvent = vi.fn();
    dispatchShareTarget({ title: "a" }, dispatchEvent, "eliza:share");
    dispatchShareTarget({ title: "b" }, dispatchEvent, "eliza:share");
    const queue = window.__ELIZAOS_SHARE_QUEUE__;
    if (!queue) throw new Error("dispatchShareTarget must create the queue");
    expect(queue.map((entry) => entry.title)).toEqual(["a", "b"]);
  });
});

describe("isPopoutWindow — renderer pop-out detection", () => {
  it("reports false on a plain renderer location", () => {
    expect(isPopoutWindow()).toBe(false);
  });

  it("detects ?popout in the search string", () => {
    window.history.replaceState(null, "", "/?popout=1");
    expect(isPopoutWindow()).toBe(true);
  });

  it("detects popout inside the hash route query", () => {
    window.history.replaceState(null, "", "/#/chat?popout=1");
    expect(isPopoutWindow()).toBe(true);
  });
});

describe("platform capability surface under this web runtime", () => {
  // Observed contract of the vitest/jsdom environment: Capacitor has no native
  // bridge here, so detection falls back to web. These pin what every
  // browser-context consumer of the barrel sees in that situation.
  it("resolves to the non-native web platform with no mobile flags", () => {
    expect(platform).toBe("web");
    expect(isNative).toBe(false);
    expect(isIOS).toBe(false);
    expect(isAndroid).toBe(false);
    expect(isWebPlatform()).toBe(true);
    expect(isDesktopPlatform()).toBe(false);
  });

  it("offers local runtime capability in dev and on any hostable device", () => {
    expect(canRunLocal()).toBe(true); // import.meta.env.DEV under vitest
    expect(canSelectLocalRuntime()).toBe(true);
    expect(canHostLocalAgent()).toBe(true);
  });

  it("never brands a non-Android host as the AOSP ElizaOS device", () => {
    expect(isElizaOS()).toBe(false);
  });
});

describe("assistant launch pipeline reachable over the public barrel", () => {
  it("carries one launch from read through consume exactly once", async () => {
    const hash =
      "#/?source=siri&text=Run%20the%20demo&action=compose" +
      "&assistant.launchId=launch-1";
    const payload = readAssistantLaunchPayloadFromHash(hash);
    if (!payload) throw new Error("trusted launch payload must parse");

    const sent: Array<{ text: string; metadata: Record<string, unknown> }> = [];
    const delivered = await consumeAssistantLaunchPayloadFromHash(hash, {
      sendText: (text, options) => {
        sent.push({ text, metadata: options.metadata });
      },
    });
    expect(delivered).toEqual(payload);
    expect(sent).toEqual([
      { text: "Run the demo", metadata: buildAssistantLaunchMetadata(payload) },
    ]);

    // The claim registry behind the barrel is shared state: replaying the same
    // launch id must be a no-op even though the hash string still parses.
    const replayed = await consumeAssistantLaunchPayloadFromHash(hash, {
      sendText: () => {
        throw new Error("a claimed launch must never resend");
      },
    });
    expect(replayed).toBeNull();
  });
});
