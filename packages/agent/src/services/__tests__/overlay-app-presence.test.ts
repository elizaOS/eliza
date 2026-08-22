import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OVERLAY_APP_PRESENCE_TTL_MS,
  isOverlayAppPresenceActive,
  setOverlayAppPresence,
} from "./overlay-app-presence.ts";

beforeEach(() => {
  vi.useFakeTimers();
  setOverlayAppPresence(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("overlay-app-presence", () => {
  it("reports active for the same app within TTL", () => {
    vi.setSystemTime(1_000_000);
    setOverlayAppPresence("companion");
    vi.setSystemTime(1_000_000 + OVERLAY_APP_PRESENCE_TTL_MS - 1);
    expect(isOverlayAppPresenceActive("companion")).toBe(true);
  });

  it("expires after the TTL", () => {
    vi.setSystemTime(1_000_000);
    setOverlayAppPresence("companion");
    vi.setSystemTime(1_000_000 + OVERLAY_APP_PRESENCE_TTL_MS + 1);
    expect(isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("is inactive for a different app name", () => {
    setOverlayAppPresence("companion");
    expect(isOverlayAppPresenceActive("other")).toBe(false);
  });

  it("is inactive with no presence reported", () => {
    expect(isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("clearing presence (null) makes it inactive", () => {
    setOverlayAppPresence("companion");
    setOverlayAppPresence(null);
    expect(isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("blank names are treated as cleared", () => {
    setOverlayAppPresence("   ");
    expect(isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("honors a custom max age", () => {
    vi.setSystemTime(1_000_000);
    setOverlayAppPresence("companion");
    vi.setSystemTime(1_000_000 + 5_000);
    expect(isOverlayAppPresenceActive("companion", 10_000)).toBe(true);
    expect(isOverlayAppPresenceActive("companion", 1_000)).toBe(false);
  });
});
