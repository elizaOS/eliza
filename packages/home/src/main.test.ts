// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchElizaEventMock } = vi.hoisted(() => ({
  dispatchElizaEventMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "web",
    isNativePlatform: () => false,
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(),
    getLaunchUrl: vi.fn(async () => null),
  },
}));

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    addListener: vi.fn(),
    setAccessoryBarVisible: vi.fn(),
  },
}));

vi.mock("@capacitor/status-bar", () => ({
  StatusBar: {
    setBackgroundColor: vi.fn(),
    setOverlaysWebView: vi.fn(),
    setStyle: vi.fn(),
  },
  Style: {
    Dark: "dark",
  },
}));

vi.mock("@elizaos/app-core", () => ({
  App: () => null,
}));

vi.mock("@elizaos/app-core/bridge", () => ({
  initializeCapacitorBridge: vi.fn(),
  initializeStorageBridge: vi.fn(async () => undefined),
  isElectrobunRuntime: () => false,
}));

vi.mock("@elizaos/app-core/events", () => ({
  AGENT_READY_EVENT: "agent-ready",
  APP_PAUSE_EVENT: "app-pause",
  APP_RESUME_EVENT: "app-resume",
  COMMAND_PALETTE_EVENT: "command-palette",
  CONNECT_EVENT: "connect",
  SHARE_TARGET_EVENT: "share-target",
  TRAY_ACTION_EVENT: "tray-action",
  dispatchElizaEvent: dispatchElizaEventMock,
}));

vi.mock("@elizaos/app-core/platform", () => ({
  applyLaunchConnectionFromUrl: vi.fn(async () => undefined),
}));

vi.mock("@elizaos/app-core/state", () => ({
  AppProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("@elizaos/capacitor-agent", () => ({
  Agent: {
    getStatus: vi.fn(async () => ({
      agentName: "Eliza",
      state: "running",
    })),
  },
}));

vi.mock("@elizaos/capacitor-desktop", () => ({
  Desktop: {
    addListener: vi.fn(),
    getVersion: vi.fn(async () => ({ electron: "N/A" })),
    registerShortcut: vi.fn(),
    setTrayMenu: vi.fn(),
  },
}));

vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => ({ render: vi.fn() })),
}));

import {
  dispatchShareTarget,
  handleDeepLink,
  injectPopoutApiBase,
  isPopoutWindow,
  setupPlatformStyles,
} from "./main";

declare global {
  interface ShareTargetPayload {
    source?: string;
    title?: string;
    text?: string;
    url?: string;
    files?: {
      name: string;
      path?: string;
    }[];
  }

  interface Window {
    __ELIZA_API_BASE__?: string;
    __ELIZA_SHARE_QUEUE__?: ShareTargetPayload[];
  }
}

describe("home main entry helpers", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.className = "";
    document.body.removeAttribute("style");
    dispatchElizaEventMock.mockReset();
    delete window.__ELIZA_API_BASE__;
    delete window.__ELIZA_SHARE_QUEUE__;
    window.history.replaceState({}, "", "http://localhost/");
  });

  afterEach(() => {
    window.history.replaceState({}, "", "http://localhost/");
  });

  it("queues share targets and dispatches the share event", () => {
    const payload = {
      source: "unit-test",
      text: "hello",
      title: "Hello",
      url: "https://example.com/post",
    };

    dispatchShareTarget(payload);

    expect(window.__ELIZA_SHARE_QUEUE__).toEqual([payload]);
    expect(dispatchElizaEventMock).toHaveBeenCalledWith(
      "share-target",
      payload,
    );
  });

  it("routes chat deep links through the hash router", () => {
    handleDeepLink("eliza://chat");
    expect(window.location.hash).toBe("#chat");

    handleDeepLink("eliza://settings");
    expect(window.location.hash).toBe("#settings");
  });

  it("dispatches validated connect deep links", () => {
    handleDeepLink(
      "eliza://connect?url=http%3A%2F%2Flocalhost%3A31337%2Fgateway",
    );

    expect(dispatchElizaEventMock).toHaveBeenCalledWith("connect", {
      gatewayUrl: "http://localhost:31337/gateway",
    });
  });

  it("parses share deep links into queued payloads", () => {
    handleDeepLink(
      "eliza://share?title=Note&text=Saved&url=https%3A%2F%2Fexample.com&file=%2Ftmp%2Falpha.txt&file=C%3A%5Ctemp%5Cbeta.md",
    );

    expect(window.__ELIZA_SHARE_QUEUE__).toEqual([
      {
        files: [
          { name: "alpha.txt", path: "/tmp/alpha.txt" },
          { name: "beta.md", path: "C:\\temp\\beta.md" },
        ],
        source: "deep-link",
        text: "Saved",
        title: "Note",
        url: "https://example.com",
      },
    ]);
    expect(dispatchElizaEventMock).toHaveBeenCalledWith("share-target", {
      files: [
        { name: "alpha.txt", path: "/tmp/alpha.txt" },
        { name: "beta.md", path: "C:\\temp\\beta.md" },
      ],
      source: "deep-link",
      text: "Saved",
      title: "Note",
      url: "https://example.com",
    });
  });

  it("only injects safe popout api bases", () => {
    window.history.replaceState(
      {},
      "",
      "http://localhost/?popout=1&apiBase=http%3A%2F%2Flocalhost%3A31337",
    );

    expect(isPopoutWindow()).toBe(true);
    injectPopoutApiBase();
    expect(window.__ELIZA_API_BASE__).toBe("http://localhost:31337");

    delete window.__ELIZA_API_BASE__;
    window.history.replaceState(
      {},
      "",
      "http://localhost/?popout=1&apiBase=http%3A%2F%2Fexample.com%3A31337",
    );

    injectPopoutApiBase();
    expect(window.__ELIZA_API_BASE__).toBeUndefined();

    window.history.replaceState(
      {},
      "",
      "http://localhost/?popout=1&apiBase=%2Fproxy-api",
    );
    injectPopoutApiBase();
    expect(window.__ELIZA_API_BASE__).toBe("/proxy-api");
  });

  it("applies platform classes and safe-area variables", () => {
    setupPlatformStyles();

    expect(document.body.classList.contains("platform-web")).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue("--safe-area-top"),
    ).toBe("env(safe-area-inset-top, 0px)");
    expect(
      document.documentElement.style.getPropertyValue("--keyboard-height"),
    ).toBe("0px");
  });
});
