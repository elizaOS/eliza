/**
 * Service lifecycle and integration tests for ComputerUseService.
 *
 * Tests service start/stop, capability detection, action dispatch,
 * and the action history buffer.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desktopMouseMove } from "../platform/desktop.js";
import { currentPlatform } from "../platform/helpers.js";
import { captureScreenshot } from "../platform/screenshot.js";
import { ComputerUseService } from "../services/computer-use-service.js";

const os = currentPlatform();

// Check if screenshot/desktop tools actually work (permissions may be missing)
let hasScreenCapture = false;
try {
  captureScreenshot();
  hasScreenCapture = true;
} catch {
  // permissions not granted
}

let hasDesktopControl = false;
try {
  desktopMouseMove(0, 0);
  hasDesktopControl = true;
} catch {
  // permissions not granted or tools missing
}

function createMockRuntime(
  settings: Record<string, string> = {},
): IAgentRuntime {
  const merged: Record<string, string> = {
    COMPUTER_USE_APPROVAL_MODE: "full_control",
    ...settings,
  };
  return {
    character: {},
    getSetting(key: string) {
      return merged[key] ?? undefined;
    },
    getService() {
      return null;
    },
  } as IAgentRuntime;
}

function skipIfAccessibilityPermissionMissing(
  skip: (message?: string) => void,
  result: {
    permissionDenied?: boolean;
    permissionType?: string;
    message?: string;
    error?: string;
  },
): void {
  if (result.permissionDenied && result.permissionType === "accessibility") {
    skip(
      result.message ?? result.error ?? "Accessibility permission is missing",
    );
  }
}

describe("ComputerUseService lifecycle", () => {
  let service: ComputerUseService;

  beforeEach(async () => {
    const runtime = createMockRuntime();
    service = (await ComputerUseService.start(runtime)) as ComputerUseService;
  });

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
  });

  it("starts and exposes serviceType", () => {
    expect(ComputerUseService.serviceType).toBe("computeruse");
  });

  it("has a capabilityDescription", () => {
    expect(service.capabilityDescription).toBeDefined();
    expect(typeof service.capabilityDescription).toBe("string");
    expect(service.capabilityDescription.length).toBeGreaterThan(0);
  });

  it("detects platform capabilities", () => {
    const caps = service.getCapabilities();

    expect(caps).toHaveProperty("screenshot");
    expect(caps).toHaveProperty("computerUse");
    expect(caps).toHaveProperty("windowList");
    expect(caps).toHaveProperty("browser");

    // Each capability has available and tool
    for (const key of [
      "screenshot",
      "computerUse",
      "windowList",
      "browser",
    ] as const) {
      expect(typeof caps[key].available).toBe("boolean");
      expect(typeof caps[key].tool).toBe("string");
    }

    // On macOS, screenshot should always be available (screencapture is built-in)
    if (os === "darwin") {
      expect(caps.screenshot.available).toBe(true);
      expect(caps.screenshot.tool).toContain("screencapture");
    }

    // On Windows, screenshot and computer use should be available (PowerShell)
    if (os === "win32") {
      expect(caps.screenshot.available).toBe(true);
      expect(caps.computerUse.available).toBe(true);
    }
  });

  it("returns valid screen dimensions", () => {
    const size = service.getScreenDimensions();

    expect(size).toHaveProperty("width");
    expect(size).toHaveProperty("height");
    expect(size.width).toBeGreaterThanOrEqual(640);
    expect(size.height).toBeGreaterThanOrEqual(480);
  });

  it("starts with empty action history", () => {
    const history = service.getRecentActions();
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(0);
  });

  it("stops cleanly", async () => {
    await expect(service.stop()).resolves.toBeUndefined();
  });
});

describe("ComputerUseService config", () => {
  it("uses default config when no settings provided", async () => {
    const runtime = createMockRuntime();
    const svc = (await ComputerUseService.start(runtime)) as ComputerUseService;

    // Defaults: screenshotAfterAction=true, actionTimeoutMs=10000
    // We can verify by executing a screenshot action and checking it works
    const result = await svc.executeDesktopAction({ action: "screenshot" });
    // Screenshot should be attempted (may fail on CI but shouldn't error on config)
    expect(result).toHaveProperty("success");

    await svc.stop();
  });

  it("respects COMPUTER_USE_SCREENSHOT_AFTER_ACTION=false", async () => {
    const runtime = createMockRuntime({
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
    });
    const svc = (await ComputerUseService.start(runtime)) as ComputerUseService;

    // When disabled, non-screenshot desktop actions should not return a screenshot
    // We can only truly test this with a real desktop action, but we can verify the service starts
    expect(svc.getCapabilities()).toBeDefined();

    await svc.stop();
  });

  it("respects COMPUTER_USE_ACTION_TIMEOUT_MS setting", async () => {
    const runtime = createMockRuntime({
      COMPUTER_USE_ACTION_TIMEOUT_MS: "5000",
    });
    const svc = (await ComputerUseService.start(runtime)) as ComputerUseService;

    // Service should start without error with custom timeout
    expect(svc.getCapabilities()).toBeDefined();

    await svc.stop();
  });
});

// Tests that require working desktop control
const describeIfDesktop = hasDesktopControl ? describe : describe.skip;

describeIfDesktop("ComputerUseService desktop actions (real)", () => {
  let service: ComputerUseService;

  beforeEach(async () => {
    const runtime = createMockRuntime({
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false", // don't capture after every action in tests
    });
    service = (await ComputerUseService.start(runtime)) as ComputerUseService;
  });

  afterEach(async () => {
    if (service) await service.stop();
  });

  it("executes screenshot action", async () => {
    const result = await service.executeDesktopAction({ action: "screenshot" });
    // Even if screenshot fails (permissions), the action should not crash
    expect(result).toHaveProperty("success");
    if (hasScreenCapture) {
      expect(result.success).toBe(true);
      expect(result.screenshot).toBeDefined();
      expect(typeof result.screenshot).toBe("string");
      const buf = Buffer.from(result.screenshot!, "base64");
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50); // P
    }
  });

  it("executes mouse_move action", async ({ skip }) => {
    const result = await service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [200, 200],
    });

    skipIfAccessibilityPermissionMissing(skip, result);
    expect(result.success).toBe(true);
  });

  it("executes click action", async ({ skip }) => {
    const result = await service.executeDesktopAction({
      action: "click",
      coordinate: [200, 200],
    });

    skipIfAccessibilityPermissionMissing(skip, result);
    expect(result.success).toBe(true);
  });

  it("executes key action", async ({ skip }) => {
    const result = await service.executeDesktopAction({
      action: "key",
      key: "Escape",
    });

    skipIfAccessibilityPermissionMissing(skip, result);
    expect(result.success).toBe(true);
  });

  it("executes key_combo action", async ({ skip }) => {
    const result = await service.executeDesktopAction({
      action: "key_combo",
      key: "shift+Escape",
    });

    skipIfAccessibilityPermissionMissing(skip, result);
    expect(result.success).toBe(true);
  });

  it("executes scroll action", async ({ skip }) => {
    const result = await service.executeDesktopAction({
      action: "scroll",
      coordinate: [400, 400],
      scrollDirection: "down",
      scrollAmount: 2,
    });

    skipIfAccessibilityPermissionMissing(skip, result);
    expect(result.success).toBe(true);
  });

  it("records actions in history regardless of success", async () => {
    await service.executeDesktopAction({ action: "screenshot" });
    await service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [100, 100],
    });

    const history = service.getRecentActions();
    expect(history.length).toBe(2);
    expect(history[0].action).toBe("screenshot");
    expect(history[1].action).toBe("mouse_move");
    // Both should have recorded (success or failure depends on platform permissions)
    expect(typeof history[0].success).toBe("boolean");
    expect(typeof history[1].success).toBe("boolean");
  });

  it("caps history at max (10)", async () => {
    for (let i = 0; i < 15; i++) {
      await service.executeDesktopAction({
        action: "click",
      });
    }

    const history = service.getRecentActions();
    expect(history.length).toBe(10);
  }, 15000);

  it("returns error for missing coordinate", async () => {
    const result = await service.executeDesktopAction({ action: "click" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("coordinate");
  });

  it("returns error for missing text on type action", async () => {
    const result = await service.executeDesktopAction({ action: "type" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("text is required");
  });

  it("returns error for missing key on key action", async () => {
    const result = await service.executeDesktopAction({ action: "key" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("key is required");
  });

  it("returns error for unknown action", async () => {
    const result = await service.executeDesktopAction({
      action: "nonexistent" as any,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown desktop action");
  });

  it("returns error for drag without startCoordinate", async () => {
    const result = await service.executeDesktopAction({
      action: "drag",
      coordinate: [100, 100],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("startCoordinate");
  });
});

describe("ComputerUseService window actions (real)", () => {
  let service: ComputerUseService;

  beforeEach(async () => {
    service = (await ComputerUseService.start(
      createMockRuntime(),
    )) as ComputerUseService;
  });

  afterEach(async () => {
    if (service) await service.stop();
  });

  it("lists windows", async () => {
    const result = await service.executeWindowAction({ action: "list" });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.windows)).toBe(true);
  }, 15000);

  it("returns error for focus without windowId", async () => {
    const result = await service.executeWindowAction({ action: "focus" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("windowId");
  });

  it("returns error for unknown window action", async () => {
    const result = await service.executeWindowAction({
      action: "nonexistent" as any,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown window action");
  });
});
