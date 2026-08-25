// @vitest-environment jsdom

/**
 * Unit tests for the app-shell deep-link dispatcher (`createDeepLinkHandler`)
 * and its `isTrustedAppLink` host guard. Verifies custom-scheme and trusted
 * `https://` universal links route top-level surfaces (wallet, connectors,
 * apps/deploy) onto the navigation-intent bus rather than the hash, that
 * notifications/keyboard-dictation fire their injected side effects, and that
 * untrusted or unconfigured hosts are ignored. Runs under jsdom with `window`,
 * `location.hash`, and event listeners; dispatch seams are `vi.fn()` spies.
 */
import {
  CONNECT_EVENT,
  listenForNavigateViewRequests,
} from "@elizaos/ui/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeepLinkHandler,
  type DeepLinkHandlerContext,
  isTrustedAppLink,
} from "./deep-link-handler";

const mocks = vi.hoisted(() => ({
  applyLaunchConnection: vi.fn(() => ({
    apiBase: "http://100.96.0.1:31337/v1",
    token: null,
  })),
}));

vi.mock("@elizaos/ui/platform/browser-launch", () => ({
  applyLaunchConnection: mocks.applyLaunchConnection,
}));

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
  vi.clearAllMocks();
  mocks.applyLaunchConnection.mockReturnValue({
    apiBase: "http://100.96.0.1:31337/v1",
    token: null,
  });
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
  it("routes a trusted Cloudflare Live View into the built-in Browser", () => {
    const liveView = "https://live.browser.run/session?token=secret";
    const { handle, dispatchNavigationIntent } = makeHandler();
    handle(`elizaos://browser?browse=${encodeURIComponent(liveView)}`);
    expect(dispatchNavigationIntent).toHaveBeenCalledWith({
      viewId: "browser",
      viewPath: `/browser?browse=${encodeURIComponent(liveView)}`,
    });
  });

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

  it("maps the connectors deep path from a universal link to the per-connector Settings detail page", () => {
    // Connectors nest a detail segment since the per-connector Settings pages
    // (56cee4c21f0): the slug must survive into the subview so settings-route
    // can open the connector's own page instead of the flat index.
    const { handle, dispatchNavigationIntent } = makeHandler();
    handle("https://eliza.app/settings/connectors/discord");
    expect(dispatchNavigationIntent).toHaveBeenCalledWith({
      viewId: "settings",
      viewPath: "/settings",
      subview: "connectors/discord",
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
    const stop = listenForNavigateViewRequests((event) => {
      seen.push(event.detail);
    });
    try {
      handle("elizaos://apps/deploy");
    } finally {
      stop();
    }
    expect(seen).toEqual([{ viewId: "cloud-apps", viewPath: "/cloud-apps" }]);
    expect(window.location.hash).toBe("");
  });

  it("replays a default native dispatch that arrives before shell registration", () => {
    const { handle } = makeHandler({ dispatchNavigationIntent: undefined });
    handle("elizaos://apps/deploy");

    const seen: unknown[] = [];
    const stop = listenForNavigateViewRequests((event) => {
      seen.push(event.detail);
    });
    stop();

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

describe("createDeepLinkHandler — remote runtime connect links", () => {
  it("routes trusted connect links through the registry-sync launch seam", () => {
    const { handle } = makeHandler();
    const seen: unknown[] = [];
    const onConnect = (event: Event) => {
      seen.push((event as CustomEvent).detail);
    };
    document.addEventListener(CONNECT_EVENT, onConnect);
    try {
      handle(
        "elizaos://connect?url=http%3A%2F%2F100.96.0.1%3A31337%2Fv1%2F&token=attacker-token",
      );
    } finally {
      document.removeEventListener(CONNECT_EVENT, onConnect);
    }

    expect(mocks.applyLaunchConnection).toHaveBeenCalledWith({
      kind: "remote",
      apiBase: "http://100.96.0.1:31337/v1/",
      token: null,
    });
    expect(seen).toEqual([
      {
        gatewayUrl: "http://100.96.0.1:31337/v1",
        token: undefined,
      },
    ]);
  });

  it("rejects untrusted connect links before persisting or dispatching", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle } = makeHandler({
      trustPolicy: { isTrustedDeepLinkApiBaseUrl: () => false } as never,
    });
    const onConnect = vi.fn();
    document.addEventListener(CONNECT_EVENT, onConnect);
    try {
      handle("elizaos://connect?url=https%3A%2F%2Fagent.attacker.example");
      expect(mocks.applyLaunchConnection).not.toHaveBeenCalled();
      expect(onConnect).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Rejected untrusted gateway URL host"),
        "agent.attacker.example",
      );
    } finally {
      document.removeEventListener(CONNECT_EVENT, onConnect);
      warn.mockRestore();
    }
  });
});

describe("createDeepLinkHandler — iOS keyboard app-handoff dictation (#12185)", () => {
  it("dispatches keyboard-dictation links into the injected dictation session", () => {
    const startKeyboardDictation = vi.fn();
    const { handle } = makeHandler({ startKeyboardDictation });
    handle("elizaos://keyboard-dictation?source=ios-keyboard&session=abc-123");
    expect(startKeyboardDictation).toHaveBeenCalledTimes(1);
    const params = startKeyboardDictation.mock.calls[0][0] as URLSearchParams;
    expect(params.get("source")).toBe("ios-keyboard");
    expect(params.get("session")).toBe("abc-123");
    // Dictation is an in-app session, not a hash route.
    expect(window.location.hash).toBe("");
  });

  it("warns loudly instead of silently dropping the link when no handler is wired", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { handle } = makeHandler();
      handle("elizaos://keyboard-dictation?source=ios-keyboard");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("keyboard-dictation deep link received"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
