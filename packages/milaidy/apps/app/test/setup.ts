/**
 * Test setup for Milaidy Capacitor app and plugin tests.
 *
 * Mocks @capacitor/core since tests run in Node.js, not a browser.
 */
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @capacitor/core
// ---------------------------------------------------------------------------

/**
 * Minimal WebPlugin mock that mirrors the real Capacitor WebPlugin interface.
 * All web implementations extend this class.
 */
class MockWebPlugin {
  private _listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  notifyListeners(eventName: string, data: unknown): void {
    const handlers = this._listeners.get(eventName);
    if (handlers) {
      for (const fn of handlers) {
        fn(data);
      }
    }
  }

  addListener(
    eventName: string,
    listenerFunc: (...args: unknown[]) => void
  ): Promise<{ remove: () => Promise<void> }> {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }
    this._listeners.get(eventName)!.add(listenerFunc);
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
  registerPlugin: vi.fn((_name: string, _opts?: Record<string, unknown>) => ({})),
  Capacitor: {
    getPlatform: vi.fn(() => "web"),
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => true),
  },
}));

// ---------------------------------------------------------------------------
// Minimal DOM mocks for plugins that reference DOM APIs
// ---------------------------------------------------------------------------

if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(),
        getDisplayMedia: vi.fn(),
      },
      geolocation: {
        getCurrentPosition: vi.fn(),
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      },
      permissions: {
        query: vi.fn(),
      },
      clipboard: {
        writeText: vi.fn(),
        readText: vi.fn(),
        write: vi.fn(),
      },
      platform: "test",
      userAgent: "test-agent",
    },
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.document === "undefined") {
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: vi.fn(() => ({
        getContext: vi.fn(() => ({
          drawImage: vi.fn(),
        })),
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
      hidden: false,
      hasFocus: vi.fn(() => true),
      documentElement: {
        requestFullscreen: vi.fn(),
      },
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
      screenX: 0,
      screenY: 0,
      outerWidth: 1920,
      outerHeight: 1080,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.WebSocket === "undefined") {
  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    url: string;
    readyState = MockWebSocket.OPEN;
    private eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor(url: string) {
      this.url = url;
      // Simulate connection in next tick
      setTimeout(() => {
        this.dispatchEvent("open", {});
      }, 0);
    }

    addEventListener(event: string, handler: (...args: unknown[]) => void): void {
      if (!this.eventHandlers.has(event)) {
        this.eventHandlers.set(event, []);
      }
      this.eventHandlers.get(event)!.push(handler);
    }

    removeEventListener(event: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    }

    dispatchEvent(event: string, data: unknown): void {
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        for (const h of handlers) {
          h(data);
        }
      }
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
    value: class MockNotification {
      static permission = "granted";
      static requestPermission = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
      onclick: (() => void) | null = null;
      constructor(_title: string, _options?: NotificationOptions) {}
    },
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.AudioContext === "undefined") {
  Object.defineProperty(globalThis, "AudioContext", {
    value: class MockAudioContext {
      currentTime = 0;
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
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      }));
    },
    writable: true,
    configurable: true,
  });
}
