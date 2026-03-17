// @vitest-environment jsdom

import type { AppViewerAuthMessage, LogEntry } from "@elizaos/app-core/api";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface GameContextStub {
  activeGameApp: string;
  activeGameDisplayName: string;
  activeGameViewerUrl: string;
  activeGameSandbox: string;
  activeGamePostMessageAuth: boolean;
  activeGamePostMessagePayload: AppViewerAuthMessage | null;
  gameOverlayEnabled: boolean;
  plugins: { id: string; enabled: boolean }[];
  logs: LogEntry[];
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

const { mockClientFns, mockUseApp } = vi.hoisted(() => ({
  mockClientFns: {
    getCodingAgentStatus: vi.fn(async () => null),
    stopApp: vi.fn(),
    sendChatRest: vi.fn(),
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
    activeGamePostMessageAuth: true,
    activeGamePostMessagePayload: {
      type: "RS_2004SCAPE_AUTH",
      authToken: "testbot",
      sessionToken: "password",
    },
    gameOverlayEnabled: false,
    plugins: [],
    logs: [],
    loadLogs: vi.fn(async () => {}),
    setState: vi.fn<GameContextStub["setState"]>(),
    setActionNotice: vi.fn<GameContextStub["setActionNotice"]>(),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("GameView auth session reset", () => {
  beforeEach(() => {
    mockClientFns.stopApp.mockReset();
    mockClientFns.sendChatRest.mockReset();
    mockUseApp.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resends postMessage auth after switching to a different viewer session", async () => {
    const payloadOne: AppViewerAuthMessage = {
      type: "HYPERSCAPE_AUTH",
      authToken: "token-one",
    };
    const payloadTwo: AppViewerAuthMessage = {
      type: "HYPERSCAPE_AUTH",
      authToken: "token-two",
    };

    let currentContext = createContext({
      activeGameViewerUrl: "http://localhost:5175/viewer",
      activeGamePostMessagePayload: payloadOne,
    });
    mockUseApp.mockImplementation(() => currentContext);

    let messageHandler:
      | ((event: MessageEvent<{ type?: string }>) => void)
      | null = null;
    const fakeWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      location: { origin: "http://localhost:3000" },
      open: vi.fn(),
    } as unknown as Window & typeof globalThis;
    vi.stubGlobal("window", fakeWindow);

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

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(GameView), {
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
        origin: "http://localhost:5175",
      } as MessageEvent<{ type?: string }>);
    });
    expect(postMessage).toHaveBeenCalledWith(
      payloadOne,
      "http://localhost:5175",
    );
    expect(postMessage).toHaveBeenCalledTimes(1);

    currentContext = createContext({
      activeGameViewerUrl: "http://localhost:5177/viewer",
      activeGamePostMessagePayload: payloadTwo,
    });
    await act(async () => {
      tree.update(React.createElement(GameView));
    });
    await flush();

    await act(async () => {
      messageHandler?.({
        source: window,
        data: { type: "HYPERSCAPE_READY" },
        origin: "http://localhost:5177",
      } as MessageEvent<{ type?: string }>);
    });
    expect(postMessage).toHaveBeenCalledWith(
      payloadTwo,
      "http://localhost:5177",
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
