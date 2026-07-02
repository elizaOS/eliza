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
  const dispatchNavigationIntent = vi.fn();
  const ctx: DeepLinkHandlerContext = {
    urlScheme: "elizaos",
    appId: "ai.elizaos.app",
    desktopBundleId: undefined,
    logPrefix: "[test]",
    trustPolicy: { isTrustedDeepLinkApiBaseUrl: () => true } as never,
    dispatchShareTarget,
    dispatchDeepLinkCallback,
    dispatchNavigationIntent,
    appLinkHosts: ["eliza.app"],
    ...over,
  };
  return {
    handle: createDeepLinkHandler(ctx),
    dispatchShareTarget,
    dispatchDeepLinkCallback,
    dispatchNavigationIntent,
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

describe("createDeepLinkHandler — top-level-surface navigation intents", () => {
  it("routes wallet links (custom scheme AND universal) onto the navigation bus, not the hash", () => {
    const { handle, dispatchNavigationIntent } = makeHandler();
    handle("elizaos://wallet");
    expect(dispatchNavigationIntent).toHaveBeenCalledWith({
      viewId: "inventory",
      viewPath: "/wallet",
    });
    // A hash write never opens a tab on the mobile/Capacitor entrypoint.
    expect(window.location.hash).toBe("");

    dispatchNavigationIntent.mockClear();
    handle("https://eliza.app/wallet");
    expect(dispatchNavigationIntent).toHaveBeenCalledWith({
      viewId: "inventory",
      viewPath: "/wallet",
    });
  });

  it("maps the connectors deep path from a universal link to the Settings connectors section", () => {
    const { handle, dispatchNavigationIntent } = makeHandler();
    handle("https://eliza.app/settings/connectors/discord");
    expect(dispatchNavigationIntent).toHaveBeenCalledWith({
      viewId: "settings",
      viewPath: "/settings",
      subview: "connectors",
    });
    expect(window.location.hash).toBe("");
  });

  it("routes apps/deploy (the #10823 Apps Deploy UI entry) to the cloud-apps page", () => {
    const { handle, dispatchNavigationIntent } = makeHandler();
    handle("elizaos://apps/deploy");
    expect(dispatchNavigationIntent).toHaveBeenCalledWith({
      viewId: "cloud-apps",
      viewPath: "/cloud-apps",
    });
    expect(window.location.hash).toBe("");

    dispatchNavigationIntent.mockClear();
    handle("https://eliza.app/apps/deploy");
    expect(dispatchNavigationIntent).toHaveBeenCalledWith({
      viewId: "cloud-apps",
      viewPath: "/cloud-apps",
    });
  });

  it("dispatches on the eliza:navigate:view bus by default (no injected seam)", () => {
    const { handle } = makeHandler({ dispatchNavigationIntent: undefined });
    const seen: unknown[] = [];
    const onNavigate = (event: Event) => {
      seen.push((event as CustomEvent).detail);
    };
    window.addEventListener("eliza:navigate:view", onNavigate);
    try {
      handle("elizaos://apps/deploy");
    } finally {
      window.removeEventListener("eliza:navigate:view", onNavigate);
    }
    expect(seen).toEqual([{ viewId: "cloud-apps", viewPath: "/cloud-apps" }]);
    expect(window.location.hash).toBe("");
  });
});

describe("createDeepLinkHandler — universal (https) app links", () => {
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
