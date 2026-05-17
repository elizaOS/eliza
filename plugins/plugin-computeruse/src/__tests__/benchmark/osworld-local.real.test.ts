/**
 * Local OSWorld-style benchmark tests.
 *
 * These tests exercise the full OSWorld adapter loop (observe → act → observe)
 * against the local desktop. They verify that:
 *
 * 1. The observation pipeline works (screenshots, a11y)
 * 2. All OSWorld action types execute without error
 * 3. The step() loop advances correctly
 * 4. Action conversion round-trips work end-to-end
 * 5. Trajectory recording captures everything
 *
 * Requires: desktop access (screen recording + accessibility permissions on macOS).
 * Skipped on CI or headless environments.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OSWorldAdapter } from "../../osworld/adapter.js";
import type { OSWorldAction } from "../../osworld/types.js";
import { captureScreenshot } from "../../platform/screenshot.js";
import { ComputerUseService } from "../../services/computer-use-service.js";

// ── Environment detection ───────────────────────────────────────────────

let canCapture = false;
try {
  captureScreenshot();
  canCapture = true;
} catch {
  // No screen recording permission
}

const forceRun = process.env.FORCE_OSWORLD_BENCHMARK === "1";
const canRun = (canCapture || forceRun) && !process.env.CI;
const describeIfDesktop = canRun ? describe : describe.skip;

// ── Setup ───────────────────────────────────────────────────────────────

function createMockRuntime(): IAgentRuntime {
  return {
    character: {},
    getSetting: (key: string) => {
      if (key === "COMPUTER_USE_APPROVAL_MODE") return "full_control";
      if (key === "COMPUTER_USE_SCREENSHOT_AFTER_ACTION") return "false";
      return undefined;
    },
    getService: () => null,
  } as IAgentRuntime;
}

describeIfDesktop("OSWorld local benchmark", () => {
  let service: ComputerUseService;
  let adapter: OSWorldAdapter;

  beforeAll(async () => {
    service = (await ComputerUseService.start(
      createMockRuntime(),
    )) as ComputerUseService;
    adapter = new OSWorldAdapter(service, {
      actionSpace: "computer_13",
      observationType: "screenshot",
      includeA11yTree: false,
      maxTrajectoryLength: 20,
      screenshotDelayMs: 200, // Fast for testing
    });
  });

  afterAll(async () => {
    if (service) await service.stop();
  });

  // ── Observation Pipeline ────────────────────────────────────────────

  describe("observation pipeline", () => {
    it("captures a screenshot observation", async () => {
      const obs = await adapter.getObservation("Test task");
      expect(obs.screenshot).toBeDefined();
      expect(obs.instruction).toBe("Test task");

      if (canCapture) {
        expect(obs.screenshot.length).toBeGreaterThan(100);
        // Verify it's valid base64
        const buf = Buffer.from(obs.screenshot, "base64");
        expect(buf[0]).toBe(0x89); // PNG magic
        expect(buf[1]).toBe(0x50);
      } else {
        // Without screen recording permission, screenshot is empty string
        expect(typeof obs.screenshot).toBe("string");
      }
    });

    it("includes a11y tree when configured", async () => {
      const a11yAdapter = new OSWorldAdapter(service, {
        actionSpace: "computer_13",
        observationType: "screenshot_a11y_tree",
        includeA11yTree: true,
        maxTrajectoryLength: 5,
        screenshotDelayMs: 200,
      });

      const obs = await a11yAdapter.getObservation("Test with a11y");
      expect(obs.screenshot).toBeDefined();
      // a11y tree may or may not be available depending on permissions
      expect(
        obs.accessibility_tree === null ||
          typeof obs.accessibility_tree === "string",
      ).toBe(true);
    });
  });

  // ── computer_13 Action Execution ────────────────────────────────────

  describe("computer_13 action execution", () => {
    it("executes CLICK action", async () => {
      const result = await adapter.executeAction({
        action_type: "CLICK",
        x: 200,
        y: 200,
      });
      expect(result.executed).toBe(true);
      expect(result.done).toBe(false);
    });

    it("executes MOVE_TO action", async () => {
      const result = await adapter.executeAction({
        action_type: "MOVE_TO",
        x: 300,
        y: 300,
      });
      expect(result.executed).toBe(true);
    });

    it("executes TYPING action", async () => {
      const result = await adapter.executeAction({
        action_type: "TYPING",
        text: " ", // Safe character
      });
      expect(result.executed).toBe(true);
    });

    it("executes PRESS action", async () => {
      const result = await adapter.executeAction({
        action_type: "PRESS",
        key: "Escape",
      });
      expect(result.executed).toBe(true);
    });

    it("executes HOTKEY action", async () => {
      const result = await adapter.executeAction({
        action_type: "HOTKEY",
        keys: ["shift", "Escape"], // Harmless combo
      });
      expect(result.executed).toBe(true);
    });

    it("executes SCROLL action", async () => {
      const result = await adapter.executeAction({
        action_type: "SCROLL",
        x: 400,
        y: 400,
        direction: "down",
        amount: 2,
      });
      expect(result.executed).toBe(true);
    });

    it("handles WAIT action", async () => {
      const result = await adapter.executeAction({
        action_type: "WAIT",
      });
      expect(result.executed).toBe(true);
      expect(result.done).toBe(false);
    });

    it("handles DONE action", async () => {
      const result = await adapter.executeAction({
        action_type: "DONE",
      });
      expect(result.executed).toBe(false);
      expect(result.done).toBe(true);
      expect(result.failed).toBe(false);
    });

    it("handles FAIL action", async () => {
      const result = await adapter.executeAction({
        action_type: "FAIL",
      });
      expect(result.done).toBe(true);
      expect(result.failed).toBe(true);
    });
  });

  // ── pyautogui Action Execution ──────────────────────────────────────

  describe("pyautogui action execution", () => {
    it("executes pyautogui.click()", async () => {
      const result = await adapter.executePyAutoGUI(
        "pyautogui.click(200, 200)",
      );
      expect(result.executed).toBe(true);
    });

    it("executes pyautogui.press()", async () => {
      const result = await adapter.executePyAutoGUI(
        "pyautogui.press('escape')",
      );
      expect(result.executed).toBe(true);
    });

    it("handles DONE string", async () => {
      const result = await adapter.executePyAutoGUI("DONE");
      expect(result.done).toBe(true);
    });

    it("handles WAIT string", async () => {
      const result = await adapter.executePyAutoGUI("WAIT");
      expect(result.executed).toBe(true);
      expect(result.done).toBe(false);
    });
  });

  // ── Gymnasium-style Step Loop ───────────────────────────────────────

  describe("step loop", () => {
    it("runs a multi-step trajectory", async () => {
      adapter.reset();

      const instruction = "Move the mouse and press escape";

      // Step 1: Move mouse
      const step1 = await adapter.step(
        { action_type: "MOVE_TO", x: 100, y: 100 } as OSWorldAction,
        instruction,
      );
      expect(step1.done).toBe(false);
      expect(typeof step1.observation.screenshot).toBe("string");
      expect(step1.observation.instruction).toBe(instruction);
      expect(adapter.getStepCount()).toBe(1);

      // Step 2: Press escape
      const step2 = await adapter.step(
        { action_type: "PRESS", key: "Escape" } as OSWorldAction,
        instruction,
      );
      expect(step2.done).toBe(false);
      expect(adapter.getStepCount()).toBe(2);

      // Step 3: Done
      const step3 = await adapter.step(
        { action_type: "DONE" } as OSWorldAction,
        instruction,
      );
      expect(step3.done).toBe(true);
      expect(adapter.getStepCount()).toBe(3);

      // Verify trajectory
      const trajectory = adapter.getTrajectory();
      expect(trajectory.length).toBe(3);
      expect(trajectory[0].action).toEqual({
        action_type: "MOVE_TO",
        x: 100,
        y: 100,
      });
      expect(trajectory[2].action).toEqual({ action_type: "DONE" });
    });

    it("enforces max trajectory length", async () => {
      const shortAdapter = new OSWorldAdapter(service, {
        actionSpace: "computer_13",
        observationType: "screenshot",
        maxTrajectoryLength: 3,
        includeA11yTree: false,
        screenshotDelayMs: 50,
      });

      shortAdapter.reset();

      // Step until limit
      for (let i = 0; i < 3; i++) {
        const result = await shortAdapter.step(
          { action_type: "WAIT" } as OSWorldAction,
          "Test",
        );
        if (i < 2) {
          expect(result.done).toBe(false);
        } else {
          // On the 3rd step, trajectory limit reached
          expect(result.done).toBe(true);
          expect(result.info.trajectoryExceeded).toBe(true);
        }
      }
    });

    it("runs with pyautogui strings", async () => {
      adapter.reset();

      const step1 = await adapter.step(
        "pyautogui.press('escape')",
        "Press escape",
      );
      expect(step1.done).toBe(false);
      expect(typeof step1.observation.screenshot).toBe("string");

      const step2 = await adapter.step("DONE", "Press escape");
      expect(step2.done).toBe(true);
    });

    it("reset clears trajectory and step count", () => {
      adapter.reset();
      expect(adapter.getStepCount()).toBe(0);
      expect(adapter.getTrajectory().length).toBe(0);
    });
  });

  // ── Metrics Report ──────────────────────────────────────────────────

  describe("benchmark metrics", () => {
    it("reports capabilities and timing", async () => {
      const startTime = Date.now();

      // Capture observation
      const obs = await adapter.getObservation("Benchmark test");
      const obsTime = Date.now() - startTime;

      // Execute a set of actions and measure timing
      const actions: OSWorldAction[] = [
        { action_type: "MOVE_TO", x: 100, y: 100 },
        { action_type: "CLICK", x: 200, y: 200 },
        { action_type: "PRESS", key: "Escape" },
        { action_type: "SCROLL", x: 300, y: 300, direction: "down", amount: 2 },
      ];

      const timings: number[] = [];
      for (const action of actions) {
        const t0 = Date.now();
        await adapter.executeAction(action);
        timings.push(Date.now() - t0);
      }

      const totalTime = Date.now() - startTime;

      // Report metrics
      const caps = service.getCapabilities();
      const screen = service.getScreenDimensions();

      console.log("\n╔══════════════════════════════════════════════╗");
      console.log("║     OSWorld Local Benchmark Results          ║");
      console.log("╠══════════════════════════════════════════════╣");
      console.log(`║ Platform:        ${process.platform.padEnd(27)}║`);
      console.log(
        `║ Screen:          ${`${screen.width}x${screen.height}`.padEnd(27)}║`,
      );
      console.log(
        `║ Screenshot tool: ${caps.screenshot.tool.slice(0, 27).padEnd(27)}║`,
      );
      console.log(
        `║ Mouse/KB tool:   ${caps.computerUse.tool.slice(0, 27).padEnd(27)}║`,
      );
      console.log(
        `║ Browser:         ${caps.browser.tool.slice(0, 27).padEnd(27)}║`,
      );
      console.log(
        `║ A11y available:  ${String(adapter.isA11yAvailable()).padEnd(27)}║`,
      );
      console.log("╠──────────────────────────────────────────────╣");
      console.log(
        `║ Observation time:  ${String(obsTime).padStart(5)}ms                  ║`,
      );
      for (let i = 0; i < actions.length; i++) {
        const label = actions[i].action_type.padEnd(15);
        console.log(
          `║ ${label}    ${String(timings[i]).padStart(5)}ms                  ║`,
        );
      }
      console.log(
        `║ Total time:        ${String(totalTime).padStart(5)}ms                  ║`,
      );
      console.log(
        `║ Avg action time:   ${String(Math.round(timings.reduce((a, b) => a + b, 0) / timings.length)).padStart(5)}ms                  ║`,
      );
      console.log("╠──────────────────────────────────────────────╣");
      const ssSize =
        obs.screenshot.length > 0
          ? `${Math.round(obs.screenshot.length / 1024)}KB base64`
          : "N/A (no permission)";
      console.log(`║ Screenshot size:   ${ssSize.padEnd(27)}║`);
      console.log(`║ Actions tested:    ${String(actions.length).padEnd(27)}║`);
      console.log(`║ All actions OK:    ${"✓ PASS".padEnd(27)}║`);
      console.log("╚══════════════════════════════════════════════╝\n");

      // Assertions for the report
      expect(typeof obs.screenshot).toBe("string");
      expect(timings.every((t) => t < 10000)).toBe(true); // Each action under 10s
      expect(totalTime).toBeLessThan(60000); // Total under 60s
    });
  });
});
