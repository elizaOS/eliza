// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeepLinkHandler,
  type DeepLinkHandlerContext,
  isTrustedAppLink,
} from "./deep-link-handler";

function makeHandler(over: Partial<DeepLinkHandlerContext> = {}) {
  const dispatchShareTarget = vi.fn();
  const dispatchDeepLinkCallback = vi.fn();
  const ctx: DeepLinkHandlerContext = {
    urlScheme: "elizaos",
    appId: "ai.elizaos.app",
    desktopBundleId: undefined,
    logPrefix: "[test]",
    trustPolicy: { isTrustedDeepLinkApiBaseUrl: () => true } as never,
    dispatchShareTarget,
    dispatchDeepLinkCallback,
    appLinkHosts: ["eliza.app"],
    ...over,
  };
  return {
    handle: createDeepLinkHandler(ctx),
    dispatchShareTarget,
    dispatchDeepLinkCallback,
  };
}

beforeEach(() => {
  window.location.hash = "";
});

describe("isTrustedAppLink", () => {
  it("accepts https on a configured host or subdomain, rejects others", () => {
    const hosts = ["eliza.app"];
    expect(isTrustedAppLink(new URL("https://eliza.app/wallet"), hosts)).toBe(
      true,
    );
    expect(isTrustedAppLink(new URL("https://share.eliza.app/x"), hosts)).toBe(
      true,
    );
    expect(isTrustedAppLink(new URL("http://eliza.app/wallet"), hosts)).toBe(
      false,
    ); // not https
    expect(isTrustedAppLink(new URL("https://evil.com/wallet"), hosts)).toBe(
      false,
    );
    expect(isTrustedAppLink(new URL("https://eliza.app/x"), undefined)).toBe(
      false,
    );
  });
});

describe("createDeepLinkHandler — universal (https) app links", () => {
  it("routes https://eliza.app/<path> into the same hash route as the custom scheme", () => {
    const { handle } = makeHandler();
    handle("elizaos://wallet");
    expect(window.location.hash).toBe("#wallet");

    window.location.hash = "";
    handle("https://eliza.app/wallet");
    expect(window.location.hash).toBe("#wallet");
  });

  it("maps the connectors deep path from a universal link", () => {
    const { handle } = makeHandler();
    handle("https://eliza.app/settings/connectors/discord");
    expect(window.location.hash).toBe("#connectors");
  });

  it("opens the notification center on a notifications deep link without changing route (#10706)", async () => {
    const { OPEN_NOTIFICATION_CENTER_EVENT } = await import(
      "@elizaos/ui/events"
    );
    const { handle, dispatchDeepLinkCallback } = makeHandler();
    let opened = 0;
    const onOpen = () => {
      opened += 1;
    };
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    try {
      handle("elizaos://notifications");
      // In-place open — no route change — and the callback still fires.
      expect(opened).toBe(1);
      expect(window.location.hash).toBe("");
      expect(dispatchDeepLinkCallback).toHaveBeenCalledWith(
        "elizaos://notifications",
      );
      // Same via a universal https app link.
      handle("https://eliza.app/notifications");
      expect(opened).toBe(2);
    } finally {
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    }
  });

  it("carries query params through a universal link", () => {
    const { handle } = makeHandler();
    handle("https://eliza.app/messages?to=alice");
    expect(window.location.hash).toBe("#messages?to=alice");
  });

  it("ignores an untrusted https host", () => {
    const { handle } = makeHandler();
    handle("https://evil.com/wallet");
    expect(window.location.hash).toBe("");
  });

  it("ignores https when no appLinkHosts are configured", () => {
    const { handle } = makeHandler({ appLinkHosts: undefined });
    handle("https://eliza.app/wallet");
    expect(window.location.hash).toBe("");
  });
});
