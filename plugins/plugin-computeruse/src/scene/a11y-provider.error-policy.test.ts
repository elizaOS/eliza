/**
 * Error-policy tests for the accessibility scan failure paths (#12273). The
 * interface contract is that `snapshot()` returns `[]` for "no reachable
 * nodes" so the scene-builder always produces a Scene — but a genuine failure
 * (the platform a11y binary missing, permission revoked, windows dropped
 * mid-scan) must not be silently indistinguishable from an empty desktop.
 * These tests drive the real missing-binary path (osascript/powershell are
 * absent on non-native hosts), assert the failure lands in `lastScanStats()`
 * and `logger.warn`, and assert the SceneBuilder reports it exactly once per
 * scan through its `reportError` seam (wired to `runtime.reportError` →
 * ERROR_REPORTED by ComputerUseService).
 */

import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type A11yScanStats,
  type AccessibilityProvider,
  DarwinAccessibilityProvider,
  LinuxAccessibilityProvider,
  parseDarwinA11yPayload,
  parseLinuxAtspiPayload,
  parseWindowsUiaPayload,
  WindowsAccessibilityProvider,
} from "./a11y-provider.js";
import { SceneBuilder } from "./scene-builder.js";
import type { SceneAxNode } from "./scene-types.js";

const onDarwin = process.platform === "darwin";
const onWindows = process.platform === "win32";

// 1x1 PNG so the builder's dHash path has real bytes to chew on.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==",
  "base64",
);

const fakeDisplay = {
  id: 0,
  bounds: [0, 0, 4, 4] as [number, number, number, number],
  scaleFactor: 1,
  primary: true,
  name: "fake",
};

function makeBuilderWith(provider: AccessibilityProvider): {
  builder: SceneBuilder;
  reports: Array<{
    scope: string;
    error: unknown;
    context?: Record<string, unknown>;
  }>;
} {
  const reports: Array<{
    scope: string;
    error: unknown;
    context?: Record<string, unknown>;
  }> = [];
  const builder = new SceneBuilder({
    captureAll: async () => [{ display: fakeDisplay, frame: TINY_PNG }],
    captureOne: async () => ({ display: fakeDisplay, frame: TINY_PNG }),
    listDisplays: () => [fakeDisplay],
    enumerateApps: () => [],
    accessibilityProvider: provider,
    runOcrOnFrame: async () => [],
    log: () => {},
    reportError: (scope, error, context) => {
      reports.push({ scope, error, context });
    },
  });
  return { builder, reports };
}

describe("accessibility provider snapshot failure surfacing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.skipIf(onDarwin)(
    "Darwin provider surfaces the osascript failure via logger.warn, records scan stats, and still returns []",
    async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      // osascript does not exist on a non-macOS host → execFileSync throws.
      const provider = new DarwinAccessibilityProvider();
      const nodes = await provider.snapshot();

      expect(nodes).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "[DarwinAccessibilityProvider]",
      );
      // The whole-scan failure is recorded so the scene-builder can report it.
      const stats = provider.lastScanStats();
      expect(stats).not.toBeNull();
      expect(stats?.error).toBeTruthy();
    },
  );

  it.skipIf(process.platform === "linux")(
    "Linux provider on an AT-SPI-less host degrades by design: [] with no fabricated scan stats",
    async () => {
      // Real path, no mocks: on macOS/Windows hosts python3 either does not
      // exist (early return) or genuinely lacks the gi/Atspi bindings, so the
      // embedded script prints the designed {"unavailable": true} failover
      // payload. Neither case is a failure, so no error may be fabricated —
      // the compositor tiers (hyprctl/swaymsg absent here) then yield [].
      const provider = new LinuxAccessibilityProvider();
      const nodes = await provider.snapshot();

      expect(nodes).toEqual([]);
      expect(provider.lastScanStats()).toBeNull();
    },
  );

  it.skipIf(onWindows)(
    "Windows provider surfaces the PowerShell failure via logger.warn, records scan stats, and still returns []",
    async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      // powershell does not exist on a non-Windows host → execFileSync throws.
      const provider = new WindowsAccessibilityProvider();
      const nodes = await provider.snapshot();

      expect(nodes).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "[WindowsAccessibilityProvider]",
      );
      const stats = provider.lastScanStats();
      expect(stats).not.toBeNull();
      expect(stats?.error).toBeTruthy();
    },
  );
});

describe("scan payload parsers (untrusted embedded-script output)", () => {
  it("parseDarwinA11yPayload maps windows and preserves the failure counts", () => {
    const payload = JSON.stringify({
      windows: [
        { app: "Safari", title: "GitHub", bbox: [1, 2, 300, 200] },
        { app: "Notes" },
      ],
      failed: 3,
      total: 5,
    });
    const { nodes, failedWindows, totalWindows } =
      parseDarwinA11yPayload(payload);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      role: "window",
      label: "GitHub",
      bbox: [1, 2, 300, 200],
    });
    expect(nodes[1]?.label).toBe("Notes");
    expect(failedWindows).toBe(3);
    expect(totalWindows).toBe(5);
  });

  it("parseDarwinA11yPayload throws on a non-object payload instead of fabricating an empty scan", () => {
    expect(() => parseDarwinA11yPayload("[]")).toThrow();
    expect(() => parseDarwinA11yPayload("not json")).toThrow();
  });

  it("parseWindowsUiaPayload re-wraps the single-window ConvertTo-Json collapse and preserves counts", () => {
    const payload = JSON.stringify({
      windows: {
        role: "ControlType.Window",
        label: "Files",
        bbox: [0, 0, 8, 8],
      },
      failed: 2,
      total: 7,
    });
    const { nodes, failedWindows, totalWindows } =
      parseWindowsUiaPayload(payload);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.label).toBe("Files");
    expect(failedWindows).toBe(2);
    expect(totalWindows).toBe(7);
  });

  it("parseWindowsUiaPayload throws on a bare-array payload instead of fabricating an empty scan", () => {
    expect(() => parseWindowsUiaPayload("[]")).toThrow();
  });

  it("parseLinuxAtspiPayload preserves the counts when every window failed (an all-miss scan is not a clean empty desktop)", () => {
    const parsed = parseLinuxAtspiPayload(
      JSON.stringify({ nodes: [], failed: 4, total: 4 }),
    );
    expect(parsed.nodes).toEqual([]);
    expect(parsed.failedWindows).toBe(4);
    expect(parsed.totalWindows).toBe(4);
    expect(parsed.unavailable).toBe(false);
    expect(parsed.error).toBeUndefined();
  });

  it("parseLinuxAtspiPayload carries a mid-scan crash message alongside the counts accumulated before the crash", () => {
    const parsed = parseLinuxAtspiPayload(
      JSON.stringify({
        nodes: [
          { role: "frame", label: "Files", bbox: [0, 0, 10, 10], actions: [] },
        ],
        failed: 1,
        total: 3,
        error: "atspi bus vanished",
      }),
    );
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.failedWindows).toBe(1);
    expect(parsed.totalWindows).toBe(3);
    expect(parsed.error).toBe("atspi bus vanished");
  });

  it("parseLinuxAtspiPayload flags the designed bindings-absent failover distinctly from a crash", () => {
    const parsed = parseLinuxAtspiPayload(
      JSON.stringify({ nodes: [], unavailable: true }),
    );
    expect(parsed.unavailable).toBe(true);
    expect(parsed.error).toBeUndefined();
  });

  it("parseLinuxAtspiPayload throws on a non-object or empty payload instead of fabricating an empty scan", () => {
    expect(() => parseLinuxAtspiPayload("[]")).toThrow();
    expect(() => parseLinuxAtspiPayload("not json")).toThrow();
    expect(() => parseLinuxAtspiPayload("")).toThrow();
    expect(() => parseLinuxAtspiPayload("{}")).toThrow();
    expect(() =>
      parseLinuxAtspiPayload(JSON.stringify({ nodes: [] })),
    ).toThrow();
  });
});

describe("SceneBuilder reports a11y scan failures once per scan", () => {
  it.skipIf(onWindows)(
    "a really-failing provider (missing powershell binary) produces exactly one Computeruse.a11yScan report per tick",
    async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      // Real failing dependency: the PowerShell binary genuinely does not
      // exist on this host, so the UIA scan fails for real — no mocks.
      const { builder, reports } = makeBuilderWith(
        new WindowsAccessibilityProvider(),
      );

      await builder.tick("agent-turn");

      const scanReports = reports.filter(
        (r) => r.scope === "Computeruse.a11yScan",
      );
      expect(scanReports).toHaveLength(1);
      expect(scanReports[0]?.context).toMatchObject({ provider: "win32" });
      expect(scanReports[0]?.error).toBeInstanceOf(Error);
      vi.restoreAllMocks();
    },
  );

  it("per-window misses are reported once per scan with {failedWindows,totalWindows} context", async () => {
    // Hand-built provider standing in for a scan where some windows were
    // unreadable (a11y permission revoked mid-session): the SceneBuilder is
    // the unit under test here; the counting itself is exercised by the
    // parser tests above and the real-binary test.
    const provider: AccessibilityProvider = {
      name: "darwin",
      available: () => true,
      snapshot: async (): Promise<SceneAxNode[]> => [
        {
          id: "a0-1",
          role: "window",
          label: "Notes",
          bbox: [0, 0, 10, 10],
          actions: ["focus"],
          displayId: 0,
        },
      ],
      lastScanStats: (): A11yScanStats => ({
        failedWindows: 4,
        totalWindows: 6,
      }),
    };
    const { builder, reports } = makeBuilderWith(provider);

    await builder.tick("agent-turn");

    const scanReports = reports.filter(
      (r) => r.scope === "Computeruse.a11yScan",
    );
    expect(scanReports).toHaveLength(1);
    expect(scanReports[0]?.context).toMatchObject({
      failedWindows: 4,
      totalWindows: 6,
      provider: "darwin",
    });
    expect(String((scanReports[0]?.error as Error).message)).toContain("4/6");
  });

  it("an all-windows-failed scan (empty node list, non-zero counts) is reported, not read as a clean empty desktop", async () => {
    // The Linux AT-SPI regression class this guards: a scan that attempted N
    // windows and read none of them previously discarded its counts because
    // stats were only recorded when nodes came back.
    const provider: AccessibilityProvider = {
      name: "linux",
      available: () => true,
      snapshot: async (): Promise<SceneAxNode[]> => [],
      lastScanStats: (): A11yScanStats => ({
        failedWindows: 5,
        totalWindows: 5,
      }),
    };
    const { builder, reports } = makeBuilderWith(provider);

    await builder.tick("agent-turn");

    const scanReports = reports.filter(
      (r) => r.scope === "Computeruse.a11yScan",
    );
    expect(scanReports).toHaveLength(1);
    expect(scanReports[0]?.context).toMatchObject({
      failedWindows: 5,
      totalWindows: 5,
      provider: "linux",
    });
  });

  it("a clean scan produces no report", async () => {
    const provider: AccessibilityProvider = {
      name: "darwin",
      available: () => true,
      snapshot: async (): Promise<SceneAxNode[]> => [],
      lastScanStats: (): A11yScanStats => ({
        failedWindows: 0,
        totalWindows: 3,
      }),
    };
    const { builder, reports } = makeBuilderWith(provider);

    await builder.tick("agent-turn");

    expect(
      reports.filter((r) => r.scope === "Computeruse.a11yScan"),
    ).toHaveLength(0);
  });
});
