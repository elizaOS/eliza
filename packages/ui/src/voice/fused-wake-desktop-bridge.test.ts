/** Verifies the deterministic desktop wake transport and opt-in lifecycle boundary in jsdom. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDesktopFusedWakeListening,
  registerDesktopFusedWake,
  startDesktopFusedWake,
  stopDesktopFusedWake,
} from "./fused-wake-desktop-bridge";

interface TestWindow extends Window {
  __ELIZA_ELECTROBUN_RPC__?: {
    request: Record<string, (params?: unknown) => Promise<unknown>>;
    onMessage: (name: string, listener: (payload: unknown) => void) => void;
    offMessage: (name: string, listener: (payload: unknown) => void) => void;
  };
  __ELIZA_FUSED_WAKE__?: boolean;
}

const testWindow = window as TestWindow;

afterEach(() => {
  delete testWindow.__ELIZA_ELECTROBUN_RPC__;
  delete testWindow.__ELIZA_FUSED_WAKE__;
  vi.clearAllMocks();
});

describe("desktop fused wake lifecycle", () => {
  it("registers transport capability without starting or stopping the microphone", () => {
    const start = vi.fn(async () => ({ started: true }));
    const stop = vi.fn(async () => undefined);
    const onMessage = vi.fn();
    const offMessage = vi.fn();
    testWindow.__ELIZA_ELECTROBUN_RPC__ = {
      request: { fusedWakeStart: start, fusedWakeStop: stop },
      onMessage,
      offMessage,
    };

    const unregister = registerDesktopFusedWake();

    expect(testWindow.__ELIZA_FUSED_WAKE__).toBe(true);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();

    unregister();

    expect(offMessage).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(testWindow.__ELIZA_FUSED_WAKE__).toBe(false);
  });

  it("exposes explicit start/query/stop calls for the opted-in controller", async () => {
    const isListening = vi.fn(async () => ({ listening: false }));
    const start = vi.fn(async () => ({ started: true }));
    const stop = vi.fn(async () => undefined);
    testWindow.__ELIZA_ELECTROBUN_RPC__ = {
      request: {
        fusedWakeIsListening: isListening,
        fusedWakeStart: start,
        fusedWakeStop: stop,
      },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };

    await expect(isDesktopFusedWakeListening()).resolves.toBe(false);
    await expect(startDesktopFusedWake("hey-eliza")).resolves.toEqual({
      started: true,
    });
    await stopDesktopFusedWake();

    expect(start).toHaveBeenCalledWith({ head: "hey-eliza" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("fails closed when no desktop bridge is installed", async () => {
    await expect(isDesktopFusedWakeListening()).resolves.toBeNull();
    await expect(startDesktopFusedWake("hey-eliza")).resolves.toEqual({
      started: false,
      reason: "desktop-wake-bridge-unavailable",
    });
    await expect(stopDesktopFusedWake()).resolves.toBeUndefined();
  });
});
