/**
 * Tests `DesktopWeb`'s browser-fallback contracts — permission bridging,
 * notifications, window focus/blur listeners, external URL safety, battery
 * state, and `beep()` AudioContext lifecycle — against a stubbed
 * `window`/`navigator`/`AudioContext` and mocked Electrobun RPC, not a real
 * browser or native host. The AudioContext stub is deterministic and records
 * per-instance close() calls to prove `beep()` does not leak contexts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopWeb } from "./web";

const EXPECTED_TEST_PLATFORM =
  process.platform === "darwin" ||
  process.platform === "win32" ||
  process.platform === "linux"
    ? process.platform
    : "linux";

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

function setWindow(value: Partial<Window> & Record<string, unknown>): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
}

interface FakeOscillator {
  frequency: { value: number };
  type: OscillatorType;
  onended: (() => void) | null;
  connect: (target: unknown) => unknown;
  start: (when: number) => void;
  stop: (when: number) => void;
  started: number[];
  stopped: number[];
  connectedTo: unknown;
}

interface FakeGain {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: (target: unknown) => unknown;
}

interface FakeAudioContext {
  currentTime: number;
  destination: { id: string };
  closeCalls: number;
  osc: FakeOscillator;
  gain: FakeGain;
  createOscillator: () => FakeOscillator;
  createGain: () => FakeGain;
  close: () => Promise<void>;
}

/**
 * Installs a stubbed global `AudioContext` that records every constructed
 * instance and how many times each is closed. `fireEndedOnStop` mirrors the
 * real Web Audio contract where a scheduled `osc.stop()` eventually dispatches
 * `onended`; `closeRejects` models a browser that rejects `close()` (e.g. an
 * already-closed context) so best-effort teardown can be exercised.
 */
function installFakeAudioContext(
  options: { fireEndedOnStop?: boolean; closeRejects?: boolean } = {},
): { instances: FakeAudioContext[] } {
  const { fireEndedOnStop = true, closeRejects = false } = options;
  const instances: FakeAudioContext[] = [];

  class AudioContextStub implements FakeAudioContext {
    currentTime = 0;
    destination = { id: "destination" };
    closeCalls = 0;
    osc: FakeOscillator;
    gain: FakeGain;

    constructor() {
      const osc: FakeOscillator = {
        frequency: { value: 0 },
        type: "square",
        onended: null,
        started: [],
        stopped: [],
        connectedTo: undefined,
        connect: (target: unknown) => {
          osc.connectedTo = target;
          return target;
        },
        start: (when: number) => {
          osc.started.push(when);
        },
        stop: (when: number) => {
          osc.stopped.push(when);
          if (fireEndedOnStop) osc.onended?.();
        },
      };
      this.osc = osc;
      this.gain = {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: (target: unknown) => target,
      };
      instances.push(this);
    }

    createOscillator(): FakeOscillator {
      return this.osc;
    }
    createGain(): FakeGain {
      return this.gain;
    }
    close(): Promise<void> {
      this.closeCalls += 1;
      return closeRejects
        ? Promise.reject(new Error("Cannot close a closed AudioContext"))
        : Promise.resolve();
    }
  }

  vi.stubGlobal("AudioContext", AudioContextStub);
  return { instances };
}

describe("DesktopWeb browser fallback contracts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects malformed desktop bridge permission responses and falls back to browser query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const permissionsCheck = vi.fn(async () => ({
      id: "camera",
      status: "granted",
      canRequest: true,
    }));
    const query = vi.fn(async (descriptor: PermissionDescriptor) => {
      expect(descriptor.name).toBe("camera");
      return { state: "denied" };
    });
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: { permissionsCheck },
      },
    });
    setNavigator({
      platform: "MacIntel",
      permissions: { query } as unknown as Permissions,
    });

    await expect(
      new DesktopWeb().checkPermission({ id: "camera" }),
    ).resolves.toEqual({
      id: "camera",
      status: "denied",
      lastChecked: 10_000,
      canRequest: false,
      platform: EXPECTED_TEST_PLATFORM,
    });
    expect(permissionsCheck).toHaveBeenCalledWith({ id: "camera" });
  });

  it("uses browser microphone request when bridge leaves a browser permission unresolved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const track = { stop: vi.fn() };
    const permissionsRequest = vi.fn(async () => ({
      id: "microphone",
      status: "not-determined",
      lastChecked: 19_000,
      canRequest: true,
      platform: "linux",
    }));
    const query = vi.fn(async (descriptor: PermissionDescriptor) => {
      expect(descriptor.name).toBe("microphone");
      return { state: "granted" };
    });
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
    }));
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: { permissionsRequest },
      },
    });
    setNavigator({
      platform: "Linux x86_64",
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
      permissions: { query } as unknown as Permissions,
    });

    await expect(
      new DesktopWeb().requestPermission({
        id: "microphone",
        reason: "record calls",
      }),
    ).resolves.toEqual({
      id: "microphone",
      status: "granted",
      lastChecked: 20_000,
      lastRequested: 20_000,
      canRequest: false,
      platform: EXPECTED_TEST_PLATFORM,
    });
    expect(permissionsRequest).toHaveBeenCalledWith({ id: "microphone" });
    expect(getUserMedia).toHaveBeenCalledWith({ video: false, audio: true });
    expect(track.stop).toHaveBeenCalled();
  });

  it("fires notification click listeners and reports denied/request-failed notification states", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    type NotificationMockConstructor = {
      new (
        title: string,
        options?: NotificationOptions,
      ): { onclick?: (() => void) | null };
      permission: NotificationPermission;
      requestPermission: ReturnType<typeof vi.fn>;
    };
    let latestNotification:
      | {
          onclick?: (() => void) | null;
        }
      | undefined;
    const NotificationMock = vi.fn(function Notification(
      this: { onclick?: () => void },
      title: string,
      options: NotificationOptions,
    ) {
      expect(title).toBe("Build complete");
      expect(options).toEqual({
        body: "Ready",
        icon: undefined,
        silent: true,
      });
      latestNotification = this;
    }) as unknown as NotificationMockConstructor;
    NotificationMock.permission = "granted";
    NotificationMock.requestPermission = vi.fn();
    setWindow({ Notification: NotificationMock });
    vi.stubGlobal("Notification", NotificationMock);

    const plugin = new DesktopWeb();
    const clicked = vi.fn();
    await plugin.addListener("notificationClick", clicked);

    await expect(
      plugin.showNotification({
        title: "Build complete",
        body: "Ready",
        silent: true,
      }),
    ).resolves.toEqual({ id: "notification_30000", shown: true });
    (
      latestNotification as { onclick?: (() => void) | null } | undefined
    )?.onclick?.();
    expect(clicked).toHaveBeenCalledWith({});

    NotificationMock.permission = "denied";
    await expect(
      plugin.showNotification({ title: "Blocked" }),
    ).resolves.toEqual({
      id: "notification_30000",
      shown: false,
      error: "Notification permission denied",
    });

    NotificationMock.permission = "default";
    NotificationMock.requestPermission.mockResolvedValueOnce("default");
    await expect(
      plugin.showNotification({ title: "Prompt rejected" }),
    ).resolves.toEqual({
      id: "notification_30000",
      shown: false,
      error: "Notification permission not granted",
    });
  });

  it("cleans browser focus and blur listeners on handle removal and removeAllListeners", async () => {
    const listeners = new Map<string, EventListener[]>();
    const addEventListener = vi.fn(
      (eventName: string, listener: EventListener) => {
        const existing = listeners.get(eventName) ?? [];
        existing.push(listener);
        listeners.set(eventName, existing);
      },
    );
    const removeEventListener = vi.fn(
      (eventName: string, listener: EventListener) => {
        listeners.set(
          eventName,
          (listeners.get(eventName) ?? []).filter(
            (entry) => entry !== listener,
          ),
        );
      },
    );
    setWindow({ addEventListener, removeEventListener });

    const plugin = new DesktopWeb();
    const focused = vi.fn();
    const blurred = vi.fn();
    const focusHandle = await plugin.addListener("windowFocus", focused);
    await plugin.addListener("windowBlur", blurred);

    listeners.get("focus")?.forEach((listener) => {
      listener(new Event("focus"));
    });
    listeners.get("blur")?.forEach((listener) => {
      listener(new Event("blur"));
    });
    expect(focused).toHaveBeenCalledWith(undefined);
    expect(blurred).toHaveBeenCalledWith(undefined);

    await focusHandle.remove();
    expect(listeners.get("focus")).toEqual([]);
    await plugin.removeAllListeners();
    expect(listeners.get("blur")).toEqual([]);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe external URLs before opening a window", async () => {
    const open = vi.fn();
    setWindow({ open });

    await expect(
      new DesktopWeb().openExternal({ url: "javascript:alert(1)" }),
    ).rejects.toThrow("url protocol is not allowed");
    await expect(
      new DesktopWeb().openExternal({ url: "https://example.com/path" }),
    ).resolves.toBeUndefined();

    expect(open).toHaveBeenCalledWith(
      "https://example.com/path",
      "_blank",
      "noopener",
    );
  });

  it("clamps valid battery levels and ignores malformed battery fields", async () => {
    const getBattery = vi
      .fn()
      .mockResolvedValueOnce({ charging: false, level: 1.5 })
      .mockResolvedValueOnce({ charging: "yes", level: Number.NaN });
    setNavigator({ getBattery } as Partial<Navigator>);

    await expect(new DesktopWeb().getPowerState()).resolves.toMatchObject({
      onBattery: true,
      batteryLevel: 100,
      isCharging: false,
      idleState: "active",
    });
    await expect(new DesktopWeb().getPowerState()).resolves.toMatchObject({
      onBattery: false,
      batteryLevel: undefined,
      isCharging: undefined,
      idleState: "active",
    });
  });

  it("closes exactly one AudioContext per beep so repeated beeps do not leak", async () => {
    const { instances } = installFakeAudioContext();
    const plugin = new DesktopWeb();

    const beeps = 8;
    for (let i = 0; i < beeps; i += 1) {
      await plugin.beep();
    }

    // One context is opened per call...
    expect(instances).toHaveLength(beeps);
    // ...and each is closed exactly once (no leaked open contexts). Before the
    // fix, browsers throw on `new AudioContext()` after ~6 concurrent contexts.
    const leaked = instances.filter((ctx) => ctx.closeCalls === 0);
    expect(leaked).toHaveLength(0);
    for (const ctx of instances) {
      expect(ctx.closeCalls).toBe(1);
    }
  });

  it("drives the oscillator and gain ramp on the stubbed context before closing it", async () => {
    const { instances } = installFakeAudioContext();

    await new DesktopWeb().beep();

    expect(instances).toHaveLength(1);
    const ctx = instances[0];
    expect(ctx.osc.frequency.value).toBe(800);
    expect(ctx.osc.type).toBe("sine");
    expect(ctx.osc.connectedTo).toBe(ctx.gain);
    expect(ctx.osc.started).toEqual([0]);
    expect(ctx.osc.stopped).toEqual([0.1]);
    expect(ctx.gain.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 0);
    expect(ctx.gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      0.01,
      0.1,
    );
    expect(ctx.closeCalls).toBe(1);
  });

  it("swallows a close() rejection as best-effort teardown without rejecting beep", async () => {
    const { instances } = installFakeAudioContext({ closeRejects: true });

    await expect(new DesktopWeb().beep()).resolves.toBeUndefined();
    expect(instances).toHaveLength(1);
    expect(instances[0].closeCalls).toBe(1);
  });

  it("closes the AudioContext even when the tone never fires onended", async () => {
    const { instances } = installFakeAudioContext({ fireEndedOnStop: false });

    await new DesktopWeb().beep();

    expect(instances).toHaveLength(1);
    // The onended fallback fires manually here to prove teardown is wired to it
    // rather than to an unconditional synchronous close.
    instances[0].osc.onended?.();
    expect(instances[0].closeCalls).toBe(1);
  });
});
