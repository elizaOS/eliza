/**
 * Exercises ComputerUseService through a real AgentRuntime and in-memory
 * database without capturing or actuating the host desktop.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  startComputerUseRuntime,
  stopComputerUseRuntime,
} from "../../test/helpers/service-runtime.ts";
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

describe("ComputerUseService lifecycle", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime());
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("registers the service and reports capability state without claiming availability", () => {
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
    expect(service.getRecentActions()).toEqual([]);
  });
});

describe("ComputerUseService configuration", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
      COMPUTER_USE_ACTION_TIMEOUT_MS: "5000",
    }));
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("applies explicit settings without dispatching an action", () => {
    expect(service.getConfig()).toMatchObject({
      screenshotAfterAction: false,
      actionTimeoutMs: 5000,
    });
    expect(service.getRecentActions()).toEqual([]);
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

describe("ComputerUseService window validation", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime());
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

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
