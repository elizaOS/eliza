/**
 * Exercises ComputerUseService through an initialized AgentRuntime, using real
 * host integrations when available and permission-independent paths otherwise.
 */

import { AgentRuntime, createCharacter, stringToUuid } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
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

let hasScreenCapture = false;
try {
  await captureScreenshot();
  hasScreenCapture = true;
} catch {
  // error-policy:J4 The hardware lane is explicitly unavailable without screen-capture permission.
}

let hasDesktopControl = false;
try {
  desktopMouseMove(0, 0);
  hasDesktopControl = true;
} catch {
  // error-policy:J4 The hardware lane is explicitly unavailable without a desktop driver or permission.
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

    for (const key of [
      "screenshot",
      "computerUse",
      "windowList",
      "browser",
    ] as const) {
      expect(typeof caps[key].available).toBe("boolean");
      expect(typeof caps[key].tool).toBe("string");
    }

    if (os === "darwin") {
      expect(caps.screenshot.available).toBe(true);
      expect(caps.screenshot.tool).toContain("screencapture");
    }

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

const describeIfScreenCapture = hasScreenCapture ? describe : describe.skip;
const describeIfDesktop = hasDesktopControl ? describe : describe.skip;

describeIfScreenCapture("ComputerUseService screen capture (real)", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime());
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("captures a non-blank screenshot", async () => {
    const result = await service.executeDesktopAction({ action: "screenshot" });
    expect(result.success).toBe(true);
    assertScreenshotBase64NotBlank(
      result.screenshot,
      "ComputerUseService screenshot action",
    );
  });
});

describeIfDesktop("ComputerUseService desktop actions (real)", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
    }));
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
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
});

describe("ComputerUseService desktop validation and history", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeEach(async () => {
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
    }));
  });

  afterEach(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("records failed actions and caps history at ten entries", async () => {
    for (let index = 0; index < 12; index++) {
      const result = await service.executeDesktopAction({ action: "click" });
      expect(result.success).toBe(false);
    }

    const history = service.getRecentActions();
    expect(history).toHaveLength(10);
    expect(history.every((entry) => entry.action === "click")).toBe(true);
    expect(history.every((entry) => entry.success === false)).toBe(true);
  });

  it("rejects click without a coordinate", async () => {
    const result = await service.executeDesktopAction({ action: "click" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("coordinate");
  });

  it("rejects type without text", async () => {
    const result = await service.executeDesktopAction({ action: "type" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("text is required");
  });

  it("rejects key without a key name", async () => {
    const result = await service.executeDesktopAction({ action: "key" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("key is required");
  });

  it("rejects an unknown desktop action", async () => {
    const result = await executeRawDesktopAction(service, {
      action: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown desktop action");
  });

  it("rejects drag without a starting coordinate", async () => {
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
