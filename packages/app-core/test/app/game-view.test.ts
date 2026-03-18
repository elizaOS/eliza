// @vitest-environment jsdom

import type { AppViewerAuthMessage } from "@elizaos/app-core/api";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface GameContextStub {
  t: (key: string) => string;
  activeGameApp: string;
  activeGameDisplayName: string;
  activeGameViewerUrl: string;
  activeGameSandbox: string;
  activeGamePostMessageAuth: boolean;
  activeGamePostMessagePayload: AppViewerAuthMessage | null;
  gameOverlayEnabled: boolean;
  plugins: { id: string; enabled: boolean }[];
  logs: unknown[];
  loadLogs: () => Promise<void>;
  setState: (
    key: string,
    value: string | boolean | AppViewerAuthMessage | null,
  ) => void;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
}

type TestWindow = Window & {
  __ELIZA_ELECTROBUN_RPC__?: {
    request: Record<string, (params?: unknown) => Promise<unknown>>;
  };
  __electrobunWindowId?: number;
};

const { mockClientFns, mockUseApp } = vi.hoisted(() => ({
  mockClientFns: {
    getCodingAgentStatus: vi.fn(async () => null),
    stopApp: vi.fn(),
  },
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClientFns,
}));
vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

import { GameView } from "@elizaos/app-core/components/GameView";

function createContext(overrides?: Partial<GameContextStub>): GameContextStub {
  return {
    t: (k: string) => k,
    activeGameApp: "@elizaos/app-2004scape",
    activeGameDisplayName: "2004scape",
    activeGameViewerUrl: "http://localhost:5175/viewer",
    activeGameSandbox: "allow-scripts allow-same-origin",
    activeGamePostMessageAuth: false,
    activeGamePostMessagePayload: null,
    gameOverlayEnabled: false,
    plugins: [],
    logs: [],
    loadLogs: vi.fn(async () => {}),
    setState: vi.fn<GameContextStub["setState"]>(),
    setActionNotice: vi.fn<GameContextStub["setActionNotice"]>(),
    ...overrides,
  };
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : ""))
    .join("")
    .trim();
}

function findButtonByText(
  root: TestRenderer.ReactTestInstance,
  label: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.type === "button" && text(node) === label,
  );
  if (!matches[0]) {
    throw new Error(`Button "${label}" not found`);
  }
  return matches[0];
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("GameView", () => {
  beforeEach(() => {
    mockClientFns.stopApp.mockReset();
    mockUseApp.mockReset();
  });

  afterEach(() => {
    delete (window as TestWindow).__ELIZA_ELECTROBUN_RPC__;
    delete (window as TestWindow).__electrobunWindowId;
    vi.restoreAllMocks();
  });

  it("renders empty state and Back to Apps returns to apps tab", async () => {
    const ctx = createContext({
      activeGameApp: "",
      activeGameDisplayName: "",
      activeGameViewerUrl: "",
    });
    mockUseApp.mockReturnValue(ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(GameView));
    });
    await flush();

    await act(async () => {
      findButtonByText(tree?.root, "game.backToApps").props.onClick();
    });

    expect(ctx.setState).toHaveBeenCalledWith("tab", "apps");
  });

  it("opens viewer in a new tab and handles popup blocking", async () => {
    const ctx = createContext();
    mockUseApp.mockReturnValue(ctx);

    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(GameView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "game.openInNewTab").props.onClick();
    });

    expect(openSpy).toHaveBeenCalledWith(
      ctx.activeGameViewerUrl,
      "_blank",
      "noopener,noreferrer",
    );
    expect(ctx.setActionNotice).not.toHaveBeenCalledWith(
      "Popup blocked. Allow popups and try again.",
      "error",
      3600,
    );

    openSpy.mockReturnValueOnce(null);
    await act(async () => {
      await findButtonByText(tree?.root, "game.openInNewTab").props.onClick();
    });
    expect(ctx.setActionNotice).toHaveBeenCalledWith(
      "Popup blocked. Allow popups and try again.",
      "error",
      3600,
    );
  });

  it("uses the Electrobun shell bridge when opening the viewer externally", async () => {
    const ctx = createContext();
    const desktopOpenExternal = vi.fn(async () => undefined);
    const gameOpenWindow = vi.fn(async () => ({ id: "game-window-1" }));
    mockUseApp.mockReturnValue(ctx);
    (window as TestWindow).__electrobunWindowId = 1;
    (window as TestWindow).__ELIZA_ELECTROBUN_RPC__ = {
      request: {
        desktopOpenExternal,
        gameOpenWindow,
      },
    };
    const openSpy = vi.spyOn(window, "open");

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(GameView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "game.openInNewTab").props.onClick();
    });

    expect(gameOpenWindow).toHaveBeenCalledWith({
      url: ctx.activeGameViewerUrl,
      title: ctx.activeGameDisplayName || ctx.activeGameApp,
    });
    expect(desktopOpenExternal).toHaveBeenCalledWith({
      url: ctx.activeGameViewerUrl,
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("stops app, resets state, and navigates back on success", async () => {
    const ctx = createContext();
    mockUseApp.mockReturnValue(ctx);
    mockClientFns.stopApp.mockResolvedValue({
      success: true,
      appName: ctx.activeGameApp,
      stoppedAt: new Date().toISOString(),
      pluginUninstalled: true,
      needsRestart: true,
      stopScope: "plugin-uninstalled",
      message:
        "App disconnected and plugin uninstalled. Agent restart required.",
    });

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(GameView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "game.stop").props.onClick();
    });

    expect(mockClientFns.stopApp).toHaveBeenCalledWith(ctx.activeGameApp);
    expect(ctx.setState).toHaveBeenCalledWith("activeGameApp", "");
    expect(ctx.setState).toHaveBeenCalledWith("activeGameDisplayName", "");
    expect(ctx.setState).toHaveBeenCalledWith("activeGameViewerUrl", "");
    expect(ctx.setState).toHaveBeenCalledWith(
      "activeGamePostMessageAuth",
      false,
    );
    expect(ctx.setState).toHaveBeenCalledWith(
      "activeGamePostMessagePayload",
      null,
    );
    expect(ctx.setState).toHaveBeenCalledWith("tab", "apps");
    expect(ctx.setActionNotice).toHaveBeenCalledWith(
      "App disconnected and plugin uninstalled. Agent restart required.",
      "success",
      5000,
    );
  });

  it("shows stop errors when API call fails", async () => {
    const ctx = createContext();
    mockUseApp.mockReturnValue(ctx);
    mockClientFns.stopApp.mockRejectedValue(new Error("stop failed"));

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(GameView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "game.stop").props.onClick();
    });
    expect(ctx.setActionNotice).toHaveBeenCalledWith(
      "Failed to stop: stop failed",
      "error",
    );
  });

  it("shows info notice when stop result is a no-op", async () => {
    const ctx = createContext();
    mockUseApp.mockReturnValue(ctx);
    mockClientFns.stopApp.mockResolvedValue({
      success: false,
      appName: ctx.activeGameApp,
      stoppedAt: new Date().toISOString(),
      pluginUninstalled: false,
      needsRestart: false,
      stopScope: "no-op",
      message: "No active session or installed plugin found.",
    });

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(GameView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "game.stop").props.onClick();
    });
    expect(ctx.setActionNotice).toHaveBeenCalledWith(
      "No active session or installed plugin found.",
      "info",
      3200,
    );
  });

  it("postMessage auth handshake sends auth once for matching origin", async () => {
    const payload: AppViewerAuthMessage = {
      type: "HYPERSCAPE_AUTH",
      authToken: "token-abc",
    };
    const ctx = createContext({
      activeGamePostMessageAuth: true,
      activeGamePostMessagePayload: payload,
    });
    mockUseApp.mockReturnValue(ctx);

    let messageHandler:
      | ((event: MessageEvent<{ type?: string }>) => void)
      | null = null;
    vi.spyOn(window, "addEventListener").mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (type === "message" && typeof listener === "function") {
        messageHandler = listener as (
          event: MessageEvent<{ type?: string }>,
        ) => void;
      }
    }) as typeof window.addEventListener);
    vi.spyOn(window, "removeEventListener").mockImplementation(
      (() => {}) as typeof window.removeEventListener,
    );

    const postMessage =
      vi.fn<(message: AppViewerAuthMessage, targetOrigin: string) => void>();
    Object.defineProperty(window, "postMessage", {
      value: postMessage,
      writable: true,
      configurable: true,
    });
    let _tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      _tree = TestRenderer.create(React.createElement(GameView), {
        createNodeMock: (element) => {
          if (element.type === "iframe") {
            return { contentWindow: window };
          }
          return {};
        },
      });
    });
    await flush();

    expect(messageHandler).toBeTypeOf("function");
    await act(async () => {
      messageHandler?.({
        source: window,
        data: { type: "HYPERSCAPE_READY" },
        origin: "http://localhost:5175",
      } as MessageEvent<{ type?: string }>);
    });
    expect(postMessage).toHaveBeenCalledWith(payload, "http://localhost:5175");
    expect(ctx.setActionNotice).toHaveBeenCalledWith(
      "Viewer auth sent.",
      "info",
      1800,
    );

    await act(async () => {
      messageHandler?.({
        source: window,
        data: { type: "HYPERSCAPE_READY" },
        origin: "http://localhost:5175",
      } as MessageEvent<{ type?: string }>);
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("does not send auth when ready event origin mismatches", async () => {
    const payload: AppViewerAuthMessage = {
      type: "HYPERSCAPE_AUTH",
      authToken: "token-abc",
    };
    const ctx = createContext({
      activeGamePostMessageAuth: true,
      activeGamePostMessagePayload: payload,
    });
    mockUseApp.mockReturnValue(ctx);

    let messageHandler:
      | ((event: MessageEvent<{ type?: string }>) => void)
      | null = null;
    vi.spyOn(window, "addEventListener").mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (type === "message" && typeof listener === "function") {
        messageHandler = listener as (
          event: MessageEvent<{ type?: string }>,
        ) => void;
      }
    }) as typeof window.addEventListener);
    vi.spyOn(window, "removeEventListener").mockImplementation(
      (() => {}) as typeof window.removeEventListener,
    );

    const postMessage =
      vi.fn<(message: AppViewerAuthMessage, targetOrigin: string) => void>();
    Object.defineProperty(window, "postMessage", {
      value: postMessage,
      writable: true,
      configurable: true,
    });
    let _tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      _tree = TestRenderer.create(React.createElement(GameView), {
        createNodeMock: (element) => {
          if (element.type === "iframe") {
            return { contentWindow: window };
          }
          return {};
        },
      });
    });
    await flush();

    await act(async () => {
      messageHandler?.({
        source: window,
        data: { type: "HYPERSCAPE_READY" },
        origin: "http://evil.example",
      } as MessageEvent<{ type?: string }>);
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("Back to Apps button switches tab", async () => {
    const ctx = createContext();
    mockUseApp.mockReturnValue(ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(GameView));
    });
    await flush();

    await act(async () => {
      findButtonByText(tree?.root, "game.backToApps").props.onClick();
    });
    expect(ctx.setState).toHaveBeenCalledWith("tab", "apps");
  });
});
