/**
 * Test setup — mocks browser APIs for Node.js vitest environment.
 *
 * All navigator sub-objects (mediaDevices, geolocation, permissions, clipboard)
 * are created here with vi.fn() stubs so tests can vi.spyOn() them freely.
 */

import React from "react";
import { vi } from "vitest";
import {
  createMemoryStorage,
  hasStorageApi,
  suppressReactTestConsoleErrors,
} from "../../../test/helpers/browser-mocks";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const ANCHOR_CLICK_PATCH_MARK = Symbol.for("eliza.test.anchorClickPatched");
const JSDOM_EMIT_PATCH_MARK = Symbol.for("eliza.test.jsdomEmitPatched");

globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

suppressReactTestConsoleErrors();

function ensureStorage(
  target: Record<string, unknown>,
  key: "localStorage" | "sessionStorage",
  fallback?: Storage,
): Storage {
  const existing = target[key];
  if (hasStorageApi(existing)) {
    return existing;
  }
  const storage = fallback ?? createMemoryStorage();
  Object.defineProperty(target, key, {
    value: storage,
    writable: true,
    configurable: true,
  });
  return storage;
}

// ---------------------------------------------------------------------------
// Mock @elizaos/app-core bridge modules — the real electrobun RPC module
// relies on native Electrobun bindings that are unavailable in the test
// environment.
// ---------------------------------------------------------------------------

type RpcMessageHandler = (
  message: string,
  listener: (payload: unknown) => void,
) => void;
type RpcRequestMap = Record<string, (params?: unknown) => unknown>;

interface ElectrobunTestWindow {
  __electrobunWindowId?: number;
  __electrobunWebviewId?: number;
  __ELIZA_ELECTROBUN_RPC__?: unknown;
}

function isInjectedElectrobunRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as ElectrobunTestWindow;
  return (
    typeof w.__electrobunWindowId === "number" ||
    typeof w.__electrobunWebviewId === "number"
  );
}

// Shared bridge mock implementation — used by both module paths
function createBridgeMock(extraExports: Record<string, unknown> = {}) {
  function getElectrobunRendererRpc() {
    if (typeof window === "undefined") return null;
    const w = window as ElectrobunTestWindow;
    return w.__ELIZA_ELECTROBUN_RPC__ ?? null;
  }

  return {
    getElectrobunRendererRpc,
    isElectrobunRuntime: isInjectedElectrobunRuntime,
    getBackendStartupTimeoutMs: () =>
      isInjectedElectrobunRuntime() ? 180_000 : 30_000,
    invokeDesktopBridgeRequest: async (options: {
      rpcMethod: string;
      params?: unknown;
    }) => {
      const rpc = getElectrobunRendererRpc() as Record<string, unknown> | null;
      const request = (rpc?.request as RpcRequestMap)?.[options.rpcMethod];
      if (request) return await request(options.params);
      return null;
    },
    subscribeDesktopBridgeEvent: (options: {
      rpcMessage: string;
      listener: (payload: unknown) => void;
    }) => {
      const rpc = getElectrobunRendererRpc() as Record<string, unknown> | null;
      if (rpc) {
        (rpc.onMessage as RpcMessageHandler)(
          options.rpcMessage,
          options.listener,
        );
        return () => {
          (rpc.offMessage as RpcMessageHandler)(
            options.rpcMessage,
            options.listener,
          );
        };
      }
      return () => {};
    },
    invokeDesktopBridgeRequestWithTimeout: async (options: {
      rpcMethod: string;
      ipcChannel?: string;
      params?: unknown;
      timeoutMs: number;
    }) => {
      const rpc = getElectrobunRendererRpc() as Record<string, unknown> | null;
      const request = (rpc?.request as RpcRequestMap)?.[options.rpcMethod];
      if (!request) return { status: "missing" as const };
      const call = request(options.params) as Promise<unknown>;
      type RaceWinner =
        | { tag: "done"; value: unknown }
        | { tag: "reject"; error: unknown }
        | { tag: "timeout" };
      let tid: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<RaceWinner>((resolve) => {
        tid = setTimeout(() => resolve({ tag: "timeout" }), options.timeoutMs);
      });
      const settledPromise: Promise<RaceWinner> = call.then(
        (value) => ({ tag: "done" as const, value }),
        (error: unknown) => ({ tag: "reject" as const, error }),
      );
      try {
        const winner = await Promise.race([settledPromise, timeoutPromise]);
        if (tid !== undefined) clearTimeout(tid);
        if (winner.tag === "timeout") return { status: "timeout" as const };
        if (winner.tag === "reject")
          return { status: "rejected" as const, error: winner.error };
        return { status: "ok" as const, value: winner.value };
      } catch (error: unknown) {
        if (tid !== undefined) clearTimeout(tid);
        return { status: "rejected" as const, error };
      }
    },
    initializeCapacitorBridge: () => {},
    initializeStorageBridge: async () => {},
    scanProviderCredentials: vi.fn(async () => []),
    ElectrobunRendererRpc: {},
    ...extraExports,
  };
}

vi.mock("@elizaos/app-core", () =>
  createBridgeMock({
    platform: "web",
    isWeb: () => true,
    isNative: false,
    isIOS: false,
    isAndroid: false,
    isDesktop: () => false,
    isMacOS: () => false,
    getPluginCapabilities: () => ({
      gateway: { available: true, websocket: true, discovery: false },
      voiceWake: { available: false },
      talkMode: { available: false, elevenlabs: true },
      camera: { available: false },
      location: { available: false, gps: false, background: false },
      screenCapture: { available: false },
      canvas: { available: true },
      desktop: { available: false, tray: false, shortcuts: false, menu: false },
    }),
    isFeatureAvailable: (feature: string) => {
      const map: Record<string, boolean> = {
        gatewayDiscovery: false,
        voiceWake: false,
        talkMode: false,
        elevenlabs: true,
        camera: false,
        location: false,
        backgroundLocation: false,
        screenCapture: false,
        desktopTray: false,
      };
      return map[feature] ?? false;
    },
  }),
);

// ---------------------------------------------------------------------------
// Mock @capacitor/core
// ---------------------------------------------------------------------------

class MockWebPlugin {
  private _listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  notifyListeners(eventName: string, data: unknown): void {
    for (const fn of this._listeners.get(eventName) ?? []) fn(data);
  }

  addListener(
    eventName: string,
    listenerFunc: (...args: unknown[]) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    if (!this._listeners.has(eventName))
      this._listeners.set(eventName, new Set());
    this._listeners.get(eventName)?.add(listenerFunc);
    return Promise.resolve({
      remove: async () => {
        this._listeners.get(eventName)?.delete(listenerFunc);
      },
    });
  }

  removeAllListeners(): Promise<void> {
    this._listeners.clear();
    return Promise.resolve();
  }
}

vi.mock("@capacitor/core", () => ({
  WebPlugin: MockWebPlugin,
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    getPlatform: vi.fn(() => "web"),
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => true),
  },
}));

// ---------------------------------------------------------------------------
// Navigator mocks — always applied, writable, and spyable
// ---------------------------------------------------------------------------

function ensureObj(
  parent: Record<string, unknown>,
  key: string,
  value: Record<string, unknown>,
): void {
  if (!parent[key]) {
    Object.defineProperty(parent, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
}

const nav: Record<string, unknown> =
  typeof globalThis.navigator !== "undefined"
    ? (globalThis.navigator as Record<string, unknown>)
    : {};

if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: nav,
    writable: true,
    configurable: true,
  });
}

ensureObj(nav, "mediaDevices", {
  getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(),
  getDisplayMedia: vi.fn(),
});

ensureObj(nav, "geolocation", {
  getCurrentPosition: vi.fn(),
  watchPosition: vi.fn(),
  clearWatch: vi.fn(),
});

ensureObj(nav, "permissions", { query: vi.fn() });

if (typeof globalThis.window !== "undefined") {
  const anchorPrototype = globalThis.HTMLAnchorElement?.prototype as
    | ({
        click?: () => void;
        [ANCHOR_CLICK_PATCH_MARK]?: boolean;
      } & Record<string, unknown>)
    | undefined;
  const originalAnchorClick = anchorPrototype?.click;
  if (
    anchorPrototype &&
    typeof originalAnchorClick === "function" &&
    !anchorPrototype[ANCHOR_CLICK_PATCH_MARK]
  ) {
    Object.defineProperty(anchorPrototype, "click", {
      configurable: true,
      writable: true,
      value: function patchedAnchorClick(this: HTMLAnchorElement) {
        const href = this.getAttribute("href") ?? "";
        const target = this.getAttribute("target") ?? "";
        const shouldSuppressNavigation =
          this.hasAttribute("download") ||
          target === "_blank" ||
          /^(?:https?:|blob:|data:)/i.test(href);

        if (shouldSuppressNavigation) {
          this.dispatchEvent(
            new window.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              composed: true,
            }),
          );
          return;
        }

        return originalAnchorClick.call(this);
      },
    });
    anchorPrototype[ANCHOR_CLICK_PATCH_MARK] = true;
  }

  const virtualConsole = (
    globalThis.window as typeof globalThis.window & {
      _virtualConsole?: {
        emit?: ((eventName: string, ...args: unknown[]) => unknown) & {
          [JSDOM_EMIT_PATCH_MARK]?: boolean;
        };
      };
    }
  )._virtualConsole;
  const originalEmit = virtualConsole?.emit;
  if (
    virtualConsole &&
    typeof originalEmit === "function" &&
    !originalEmit[JSDOM_EMIT_PATCH_MARK]
  ) {
    const patchedEmit = function patchedEmit(eventName, ...args) {
      const [firstArg] = args;
      if (
        eventName === "jsdomError" &&
        firstArg instanceof Error &&
        firstArg.message === "Not implemented: navigation to another Document"
      ) {
        return;
      }
      return originalEmit.call(this, eventName, ...args);
    } as typeof originalEmit;
    patchedEmit[JSDOM_EMIT_PATCH_MARK] = true;
    virtualConsole.emit = patchedEmit;
  }
}

ensureObj(nav, "clipboard", {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(""),
  write: vi.fn().mockResolvedValue(undefined),
});

if (!nav.platform) {
  Object.defineProperty(nav, "platform", {
    value: "test",
    writable: true,
  });
}
if (!nav.userAgent) {
  Object.defineProperty(nav, "userAgent", {
    value: "test-agent",
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// DOM mocks
// ---------------------------------------------------------------------------

if (typeof globalThis.document === "undefined") {
  const mockHead = { appendChild: vi.fn(), removeChild: vi.fn() };
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: vi.fn(() => ({
        getContext: vi.fn(() => ({ drawImage: vi.fn() })),
        toDataURL: vi.fn(() => "data:image/jpeg;base64,dGVzdA=="),
        appendChild: vi.fn(),
        removeChild: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        style: {},
        width: 0,
        height: 0,
        videoWidth: 1920,
        videoHeight: 1080,
      })),
      createTextNode: vi.fn((text: string) => ({ textContent: text })),
      getElementsByTagName: vi.fn((tagName: string) =>
        tagName?.toLowerCase() === "head" ? [mockHead] : [],
      ),
      head: mockHead,
      hidden: false,
      hasFocus: vi.fn(() => true),
      documentElement: { requestFullscreen: vi.fn() },
      exitFullscreen: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}

const sharedLocalStorage = ensureStorage(
  globalThis as Record<string, unknown>,
  "localStorage",
);
const sharedSessionStorage = ensureStorage(
  globalThis as Record<string, unknown>,
  "sessionStorage",
);

if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    value: {
      close: vi.fn(),
      focus: vi.fn(),
      open: vi.fn(),
      location: { reload: vi.fn() },
      screenX: 0,
      screenY: 0,
      outerWidth: 1920,
      outerHeight: 1080,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: sharedLocalStorage,
      sessionStorage: sharedSessionStorage,
      navigator: globalThis.navigator,
    },
    writable: true,
    configurable: true,
  });
} else {
  const win = globalThis.window as Record<string, unknown>;
  ensureStorage(win, "sessionStorage", sharedSessionStorage);
  ensureStorage(win, "localStorage", sharedLocalStorage);
  if (!win.navigator) {
    Object.defineProperty(win, "navigator", {
      value: globalThis.navigator,
      writable: true,
      configurable: true,
    });
  }
}

if (typeof globalThis.WebSocket === "undefined") {
  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readonly OPEN = 1;
    readonly CLOSED = 3;
    url: string;
    readyState = MockWebSocket.OPEN;
    private handlers = new Map<string, ((...a: unknown[]) => void)[]>();

    constructor(url: string) {
      this.url = url;
      setTimeout(() => this.emit("open", {}), 0);
    }
    addEventListener(e: string, h: (...a: unknown[]) => void) {
      let eventHandlers = this.handlers.get(e);
      if (!eventHandlers) {
        eventHandlers = [];
        this.handlers.set(e, eventHandlers);
      }
      eventHandlers.push(h);
    }
    removeEventListener(e: string, h: (...a: unknown[]) => void) {
      const hs = this.handlers.get(e);
      if (hs) {
        const i = hs.indexOf(h);
        if (i >= 0) hs.splice(i, 1);
      }
    }
    private emit(e: string, d: unknown) {
      for (const h of this.handlers.get(e) ?? []) h(d);
    }
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = MockWebSocket.CLOSED;
    });
  }
  Object.defineProperty(globalThis, "WebSocket", {
    value: MockWebSocket,
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.Notification === "undefined") {
  Object.defineProperty(globalThis, "Notification", {
    value: class {
      static permission = "granted";
      static requestPermission = vi.fn(() => Promise.resolve("granted"));
      onclick: (() => void) | null = null;
    },
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.AudioContext === "undefined") {
  Object.defineProperty(globalThis, "AudioContext", {
    value: class {
      currentTime = 0;
      state = "running";
      destination = {};
      createOscillator = vi.fn(() => ({
        connect: vi.fn(() => ({ connect: vi.fn() })),
        frequency: { value: 0 },
        type: "sine",
        start: vi.fn(),
        stop: vi.fn(),
      }));
      createGain = vi.fn(() => ({
        connect: vi.fn(() => ({ connect: vi.fn() })),
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      }));
      createAnalyser = vi.fn(() => ({
        fftSize: 2048,
        smoothingTimeConstant: 0.8,
        connect: vi.fn(),
        getFloatTimeDomainData: vi.fn((arr: Float32Array) => {
          arr.fill(0);
        }),
      }));
      createBufferSource = vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      }));
      decodeAudioData = vi.fn(async () => ({
        duration: 1,
        length: 44100,
        sampleRate: 44100,
      }));
      resume = vi.fn(async () => {});
      close = vi.fn(async () => {});
    },
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// SpeechSynthesis mocks (for voice chat testing)
// ---------------------------------------------------------------------------

if (typeof globalThis.SpeechSynthesisUtterance === "undefined") {
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    value: class {
      text = "";
      rate = 1;
      pitch = 1;
      lang = "";
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(text?: string) {
        this.text = text ?? "";
      }
    },
    writable: true,
    configurable: true,
  });
}

// Note: SpeechSynthesis instance is NOT mocked globally to avoid breaking
// TalkModeWeb tests that expect synthesis to be unavailable. Tests needing
// SpeechSynthesis should create their own mock instances locally.
