/**
 * Unit coverage for UI host-capability detection and interval warnings:
 * maps shared host probes to UI branching fields and warns when short
 * polling exceeds mobile/browser background limits. Deterministic — no
 * browser APIs, real functions with mocked shared probe for the detector.
 */
import { describe, expect, test, vi } from "vitest";

import {
  detectUiHostCapabilities,
  intervalHostWarning,
  SHORT_INTERVAL_THRESHOLD_MS,
} from "./host-capabilities";

describe("SHORT_INTERVAL_THRESHOLD_MS", () => {
  test("is 15 minutes", () => {
    expect(SHORT_INTERVAL_THRESHOLD_MS).toBe(15 * 60 * 1000);
  });
});

describe("intervalHostWarning", () => {
  test("no warning when interval at or above threshold", () => {
    expect(
      intervalHostWarning(
        {
          longRunning: true,
          isMobile: true,
          isBrowser: false,
          label: "mobile",
        },
        SHORT_INTERVAL_THRESHOLD_MS,
      ),
    ).toEqual({ show: false, message: "" });
    expect(
      intervalHostWarning(
        {
          longRunning: false,
          isMobile: false,
          isBrowser: true,
          label: "browser",
        },
        SHORT_INTERVAL_THRESHOLD_MS + 1,
      ),
    ).toEqual({ show: false, message: "" });
    expect(
      intervalHostWarning(
        { longRunning: false, isMobile: true, isBrowser: false, label: "m" },
        15 * 60 * 1000,
      ),
    ).toEqual({ show: false, message: "" });
  });

  test("mobile shows warning for short interval", () => {
    const warn = intervalHostWarning(
      { longRunning: false, isMobile: true, isBrowser: false, label: "mobile" },
      60 * 1000,
    );
    expect(warn.show).toBe(true);
    expect(warn.message).toContain("15 minutes");
    expect(warn.message).toContain("Mobile");
  });

  test("browser shows warning for short interval", () => {
    const warn = intervalHostWarning(
      {
        longRunning: false,
        isMobile: false,
        isBrowser: true,
        label: "browser",
      },
      5 * 60 * 1000,
    );
    expect(warn.show).toBe(true);
    expect(warn.message).toContain("Browser");
    expect(warn.message).toContain("discarded");
  });

  test("longRunning alone does not warn but contradictory mobile still warns", () => {
    expect(
      intervalHostWarning(
        {
          longRunning: true,
          isMobile: false,
          isBrowser: false,
          label: "desktop",
        },
        1000,
      ),
    ).toEqual({ show: false, message: "" });
    const contradictory = intervalHostWarning(
      {
        longRunning: true,
        isMobile: true,
        isBrowser: false,
        label: "mobile",
      },
      1000,
    );
    expect(contradictory.show).toBe(true);
    expect(contradictory.message).toContain("Mobile");
  });

  test("mobile takes precedence over browser when both true", () => {
    const warn = intervalHostWarning(
      { longRunning: false, isMobile: true, isBrowser: true, label: "hybrid" },
      1000,
    );
    expect(warn.show).toBe(true);
    expect(warn.message).toContain("Mobile");
  });

  test("threshold boundary 1ms below shows warning", () => {
    const warn = intervalHostWarning(
      { longRunning: false, isMobile: true, isBrowser: false, label: "m" },
      SHORT_INTERVAL_THRESHOLD_MS - 1,
    );
    expect(warn.show).toBe(true);
  });

  test("invalid numeric inputs are handled without throw", () => {
    expect(
      intervalHostWarning(
        { longRunning: false, isMobile: true, isBrowser: false, label: "m" },
        Number.NaN,
      ).show,
    ).toBe(true);
    expect(
      intervalHostWarning(
        { longRunning: false, isMobile: false, isBrowser: true, label: "b" },
        Number.NaN,
      ).show,
    ).toBe(true);
    expect(
      intervalHostWarning(
        { longRunning: false, isMobile: true, isBrowser: false, label: "m" },
        Number.POSITIVE_INFINITY,
      ),
    ).toEqual({ show: false, message: "" });
    expect(
      intervalHostWarning(
        { longRunning: false, isMobile: false, isBrowser: false, label: "x" },
        -1000,
      ).show,
    ).toBe(false);
    expect(
      intervalHostWarning(
        { longRunning: false, isMobile: true, isBrowser: false, label: "m" },
        0,
      ).show,
    ).toBe(true);
  });
});

describe("detectUiHostCapabilities", () => {
  test("returns subset of shared detectHostCapabilities", async () => {
    const shared = await import("@elizaos/shared");
    const raw = (
      shared as unknown as {
        detectHostCapabilities: () => Record<string, unknown>;
      }
    ).detectHostCapabilities();
    const ui = detectUiHostCapabilities();
    expect(ui).toEqual({
      longRunning: (raw as Record<string, unknown>).longRunning,
      isMobile: (raw as Record<string, unknown>).isMobile,
      isBrowser: (raw as Record<string, unknown>).isBrowser,
      label: (raw as Record<string, unknown>).label,
    });
    expect(typeof ui.longRunning).toBe("boolean");
    expect(typeof ui.isMobile).toBe("boolean");
    expect(typeof ui.isBrowser).toBe("boolean");
    expect(typeof ui.label).toBe("string");
  });

  test("mocked shared probe returns exact mapping", async () => {
    vi.resetModules();
    vi.doMock("@elizaos/shared", async () => {
      const actual =
        await vi.importActual<typeof import("@elizaos/shared")>(
          "@elizaos/shared",
        );
      return {
        ...actual,
        detectHostCapabilities: () => ({
          longRunning: true,
          isMobile: true,
          isBrowser: true,
          label: "mocked-label",
          isCapacitor: false,
          isElectron: false,
        }),
      };
    });
    const { detectUiHostCapabilities: mockedDetect } = await import(
      "./host-capabilities"
    );
    expect(mockedDetect()).toEqual({
      longRunning: true,
      isMobile: true,
      isBrowser: true,
      label: "mocked-label",
    });
    vi.doUnmock("@elizaos/shared");
    vi.resetModules();
  });
});
