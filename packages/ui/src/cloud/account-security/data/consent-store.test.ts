/**
 * Unit tests for consent-store: validates privacy-by-default false values
 * and localStorage write/read roundtrip.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTrajectoryLoggingEnabled,
  getVisionEnabled,
  setTrajectoryLoggingEnabled,
  setVisionEnabled,
} from "./consent-store.ts";

describe("consent-store", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    (globalThis as any).window = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, val: string) => storage.set(key, val),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("defaults to false for vision and trajectory logging", () => {
    expect(getVisionEnabled()).toBe(false);
    expect(getTrajectoryLoggingEnabled()).toBe(false);
  });

  it("updates and reads vision enabled state", () => {
    setVisionEnabled(true);
    expect(getVisionEnabled()).toBe(true);
    setVisionEnabled(false);
    expect(getVisionEnabled()).toBe(false);
  });

  it("updates and reads trajectory logging state", () => {
    setTrajectoryLoggingEnabled(true);
    expect(getTrajectoryLoggingEnabled()).toBe(true);
    setTrajectoryLoggingEnabled(false);
    expect(getTrajectoryLoggingEnabled()).toBe(false);
  });
});
