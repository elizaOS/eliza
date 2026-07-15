/**
 * Exercises ComputerUseService through a real AgentRuntime and in-memory
 * database without capturing or actuating the host desktop. The final block is
 * a regression guard for the headless-CI hang: input validation must run before
 * the approval gate, which blocks on a decision no headless runner can produce.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// Regression guard for the CI Plugin-lane hang. The approval gate awaits a
// human/API decision; the default smart_approve mode gives a headless runner no
// way to produce one, so any destructive action requested before its input is
// validated blocks until the 90s test timeout. This pins "off" (deny-all): the
// gate resolves immediately, so instead of hanging we get an observable
// distinction — with validation running first, malformed input yields the
// *field* error; if the gate ran first it would yield the deny message. The
// host's persisted approval mode is saved and restored (setMode persists to
// ~/.eliza), and this block runs last so its transient on-disk mode cannot leak
// into the earlier blocks.
describe("ComputerUseService validates input before the approval gate", () => {
  const approvalConfigPath = path.join(
    os.homedir(),
    ".eliza",
    "computer-use-approval.json",
  );
  let savedApprovalConfig: string | null = null;
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    savedApprovalConfig = readApprovalConfig(approvalConfigPath);
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_APPROVAL_MODE: "off",
    }));
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
    restoreApprovalConfig(approvalConfigPath, savedApprovalConfig);
  });

  it("runs deny-all so the gate cannot auto-approve", () => {
    expect(service.getApprovalMode()).toBe("off");
  });

  it("rejects a coordinate-less click at validation, not the gate", async () => {
    const result = await service.executeDesktopAction({ action: "click" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("coordinate");
    expect(result.error).not.toContain("paused");
  }, 10_000);

  it("rejects a targetless window focus at validation, not the gate", async () => {
    const result = await service.executeWindowAction({ action: "focus" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("windowId");
    expect(result.error).not.toContain("paused");
  }, 10_000);
});

/** Reads the persisted approval-mode config, or null when none exists. */
function readApprovalConfig(configPath: string): string | null {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch (err) {
    // error-policy:J3 a missing file is the expected first-run/CI shape; a
    // different read error means we cannot safely restore, so surface it.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** Restores the approval-mode config to its pre-test contents (or absence). */
function restoreApprovalConfig(configPath: string, saved: string | null): void {
  if (saved === null) {
    fs.rmSync(configPath, { force: true });
    return;
  }
  fs.writeFileSync(configPath, saved, "utf8");
}
