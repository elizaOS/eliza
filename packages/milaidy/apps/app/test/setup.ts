/**
 * Test setup — mocks browser APIs for Node.js vitest environment.
 *
 * All navigator sub-objects (mediaDevices, geolocation, permissions, clipboard)
 * are created here with vi.fn() stubs so tests can vi.spyOn() them freely.
 */
import { vi } from "vitest";

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
    if (!this._listeners.has(eventName)) this._listeners.set(eventName, new Set());
    this._listeners.get(eventName)!.add(listenerFunc);
    return Promise.resolve({
      remove: async () => { this._listeners.get(eventName)?.delete(listenerFunc); },
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

function ensureObj(parent: Record<string, unknown>, key: string, value: Record<string, unknown>): void {
  if (!parent[key]) {
    Object.defineProperty(parent, key, { value, writable: true, configurable: true });
  }
}

const nav: Record<string, unknown> = (typeof globalThis.navigator !== "undefined")
  ? globalThis.navigator as unknown as Record<string, unknown>
  : {};

if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", { value: nav, writable: true, configurable: true });
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

ensureObj(nav, "clipboard", {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(""),
  write: vi.fn().mockResolvedValue(undefined),
});

if (!nav.platform) nav.platform = "test";
if (!nav.userAgent) nav.userAgent = "test-agent";

// ---------------------------------------------------------------------------
// DOM mocks
// ---------------------------------------------------------------------------

if (typeof globalThis.document === "undefined") {
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: vi.fn(() => ({
        getContext: vi.fn(() => ({ drawImage: vi.fn() })),
        toDataURL: vi.fn(() => "data:image/jpeg;base64,dGVzdA=="),
        appendChild: vi.fn(),
        removeChild: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        style: {},
        width: 0, height: 0, videoWidth: 1920, videoHeight: 1080,
      })),
      hidden: false,
      hasFocus: vi.fn(() => true),
      documentElement: { requestFullscreen: vi.fn() },
      exitFullscreen: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    value: {
      close: vi.fn(),
      focus: vi.fn(),
      open: vi.fn(),
      location: { reload: vi.fn() },
      screenX: 0, screenY: 0, outerWidth: 1920, outerHeight: 1080,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
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
      (this.handlers.get(e) ?? (this.handlers.set(e, []), this.handlers.get(e)!)).push(h);
    }
    removeEventListener(e: string, h: (...a: unknown[]) => void) {
      const hs = this.handlers.get(e);
      if (hs) { const i = hs.indexOf(h); if (i >= 0) hs.splice(i, 1); }
    }
    private emit(e: string, d: unknown) { for (const h of this.handlers.get(e) ?? []) h(d); }
    send = vi.fn();
    close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED; });
  }
  Object.defineProperty(globalThis, "WebSocket", { value: MockWebSocket, writable: true, configurable: true });
}

if (typeof globalThis.Notification === "undefined") {
  Object.defineProperty(globalThis, "Notification", {
    value: class { static permission = "granted"; static requestPermission = vi.fn(() => Promise.resolve("granted")); onclick: (() => void) | null = null; },
    writable: true, configurable: true,
  });
}

if (typeof globalThis.AudioContext === "undefined") {
  Object.defineProperty(globalThis, "AudioContext", {
    value: class {
      currentTime = 0; destination = {};
      createOscillator = vi.fn(() => ({ connect: vi.fn(() => ({ connect: vi.fn() })), frequency: { value: 0 }, type: "sine", start: vi.fn(), stop: vi.fn() }));
      createGain = vi.fn(() => ({ connect: vi.fn(() => ({ connect: vi.fn() })), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }));
    },
    writable: true, configurable: true,
  });
}
