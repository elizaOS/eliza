/**
 * Service lifecycle and integration tests for ComputerUseService.
 *
 * Tests service start/stop, capability detection, action dispatch,
 * and the action history buffer.
 */

import { AgentRuntime, createCharacter, stringToUuid } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../../packages/core/src/database/inMemoryAdapter.ts";
import { assertScreenshotBase64NotBlank } from "../../test/helpers/screenshot-quality.ts";
import { desktopMouseMove } from "../platform/desktop.js";
import { currentPlatform } from "../platform/helpers.js";
import { captureScreenshot } from "../platform/screenshot.js";
import { ComputerUseService } from "../services/computer-use-service.js";

type RawActionParams = { action: string };

function executeRawDesktopAction(
  service: ComputerUseService,
  params: RawActionParams,
): ReturnType<ComputerUseService["executeDesktopAction"]> {
  const execute = service.executeDesktopAction as (
    rawParams: RawActionParams,
  ) => ReturnType<ComputerUseService["executeDesktopAction"]>;
  return execute.call(service, params);
}

function executeRawWindowAction(
  service: ComputerUseService,
  params: RawActionParams,
): ReturnType<ComputerUseService["executeWindowAction"]> {
  const execute = service.executeWindowAction as (
    rawParams: RawActionParams,
  ) => ReturnType<ComputerUseService["executeWindowAction"]>;
  return execute.call(service, params);
}

const os = currentPlatform();

// Check if screenshot/desktop tools actually work (permissions may be missing)
let hasScreenCapture = false;
try {
  await captureScreenshot();
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

async function startComputerUseRuntime(
  settings: Record<string, string> = {},
): Promise<{ runtime: AgentRuntime; service: ComputerUseService }> {
  const runtime = new AgentRuntime({
    character: createCharacter({
      id: stringToUuid(`computeruse-service-${crypto.randomUUID()}`),
      name: "ComputerUseServiceIntegrationAgent",
      settings: {
        COMPUTER_USE_APPROVAL_MODE: "full_control",
        ...settings,
      },
    }),
    adapter: new InMemoryDatabaseAdapter(),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  await runtime.initialize();
  await runtime.registerPlugin({
    name: "computeruse-service-integration",
    description: "Real ComputerUseService lifecycle integration",
    services: [ComputerUseService],
  });
  const service = await runtime.getServiceLoadPromise(
    ComputerUseService.serviceType,
  );
  if (!(service instanceof ComputerUseService)) {
    throw new Error("ComputerUseService did not register with AgentRuntime");
  }
  return { runtime, service };
}

async function stopComputerUseRuntime(runtime: AgentRuntime): Promise<void> {
  await runtime.stop();
  await runtime.close();
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
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime());
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("registers a usable service with detected host capabilities", () => {
    expect(ComputerUseService.serviceType).toBe("computeruse");
    expect(service.capabilityDescription.length).toBeGreaterThan(0);
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
    const size = service.getScreenDimensions();
    expect(size.width).toBeGreaterThanOrEqual(640);
    expect(size.height).toBeGreaterThanOrEqual(480);
    expect(service.getRecentActions()).toEqual([]);
  });
});

// Tests that require working desktop control
const describeIfDesktop = hasDesktopControl ? describe : describe.skip;

describeIfDesktop("ComputerUseService desktop actions (real)", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false", // don't capture after every action in tests
    }));
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("executes screenshot action", async () => {
    const result = await service.executeDesktopAction({ action: "screenshot" });
    // Even if screenshot fails (permissions), the action should not crash
    expect(result).toHaveProperty("success");
    if (hasScreenCapture) {
      expect(result.success).toBe(true);
      assertScreenshotBase64NotBlank(
        result.screenshot,
        "ComputerUseService screenshot action",
      );
    }
  });

  it("executes mouse_move action", async ({ skip }) => {
    const result = await service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [200, 200],
    });

    skipIfAccessibilityPermissionMissing(skip, result);
    expect(result.success).toBe(true);
    expect(result.screenshot).toBeUndefined();
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
    const result = await executeRawDesktopAction(service, {
      action: "nonexistent",
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
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime());
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
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
    const result = await executeRawWindowAction(service, {
      action: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown window action");
  });
});
