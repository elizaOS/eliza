/**
 * OSWorld benchmark adapter.
 *
 * Bridges the xlang-ai/OSWorld evaluation framework with plugin-computeruse.
 * Provides the observation/action loop expected by OSWorld:
 *
 *   1. getObservation() — capture screenshot + optional a11y tree
 *   2. executeAction() — execute an OSWorld action (computer_13 or pyautogui)
 *   3. step() — combined execute + observe (gymnasium-style)
 *
 * Usage:
 *   const adapter = new OSWorldAdapter(computerUseService);
 *   const obs = await adapter.getObservation("Open the settings app");
 *   const result = await adapter.executeAction({ action_type: "CLICK", x: 100, y: 200 });
 *   // or with pyautogui:
 *   const result2 = await adapter.executePyAutoGUI("pyautogui.click(100, 200)");
 */

import { extractA11yTree, isA11yAvailable } from "../platform/a11y.js";
import { captureScreenshot } from "../platform/screenshot.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import {
  fromOSWorldAction,
  fromPyAutoGUI,
  toOSWorldAction,
} from "./action-converter.js";
import type {
  DEFAULT_AGENT_CONFIG,
  OSWorldAction,
  OSWorldAgentConfig,
  OSWorldObservation,
  OSWorldStepResult,
} from "./types.js";

export class OSWorldAdapter {
  private service: ComputerUseService;
  private config: OSWorldAgentConfig;
  private stepCount = 0;
  private trajectory: Array<{
    action: OSWorldAction | string;
    observation: OSWorldObservation;
    timestamp: number;
  }> = [];

  constructor(
    service: ComputerUseService,
    config?: Partial<OSWorldAgentConfig>,
  ) {
    this.service = service;
    this.config = {
      actionSpace: config?.actionSpace ?? "computer_13",
      observationType: config?.observationType ?? "screenshot",
      maxTrajectoryLength: config?.maxTrajectoryLength ?? 15,
      includeA11yTree: config?.includeA11yTree ?? false,
      screenshotDelayMs: config?.screenshotDelayMs ?? 1000,
    };
  }

  // ── Observation ─────────────────────────────────────────────────────

  /**
   * Capture the current screen state as an OSWorld observation.
   */
  async getObservation(instruction: string): Promise<OSWorldObservation> {
    let screenshot = "";
    try {
      const buf = captureScreenshot();
      screenshot = buf.toString("base64");
    } catch {
      // Screenshot failed — return empty
    }

    let accessibility_tree: string | null = null;
    if (
      this.config.includeA11yTree ||
      this.config.observationType === "a11y_tree" ||
      this.config.observationType === "screenshot_a11y_tree"
    ) {
      accessibility_tree = extractA11yTree();
    }

    return {
      screenshot,
      accessibility_tree,
      instruction,
    };
  }

  // ── Action Execution ────────────────────────────────────────────────

  /**
   * Execute an OSWorld computer_13 action.
   * Returns true if the action was executed, false for control flow (WAIT/DONE/FAIL).
   */
  async executeAction(
    action: OSWorldAction,
  ): Promise<{ executed: boolean; done: boolean; failed: boolean }> {
    if (action.action_type === "DONE") {
      return { executed: false, done: true, failed: false };
    }
    if (action.action_type === "FAIL") {
      return { executed: false, done: true, failed: true };
    }
    if (action.action_type === "WAIT") {
      await this.sleep(this.config.screenshotDelayMs);
      return { executed: true, done: false, failed: false };
    }

    const params = fromOSWorldAction(action);
    if (!params) {
      return { executed: false, done: false, failed: false };
    }

    await this.service.executeDesktopAction(params);

    // Brief pause to let the UI update
    await this.sleep(this.config.screenshotDelayMs);

    return { executed: true, done: false, failed: false };
  }

  /**
   * Execute a pyautogui Python code string.
   */
  async executePyAutoGUI(
    code: string,
  ): Promise<{ executed: boolean; done: boolean; failed: boolean }> {
    const trimmed = code.trim();

    if (trimmed === "DONE") {
      return { executed: false, done: true, failed: false };
    }
    if (trimmed === "FAIL") {
      return { executed: false, done: true, failed: true };
    }
    if (trimmed === "WAIT") {
      await this.sleep(this.config.screenshotDelayMs);
      return { executed: true, done: false, failed: false };
    }

    const params = fromPyAutoGUI(trimmed);
    if (!params) {
      return { executed: false, done: false, failed: false };
    }

    await this.service.executeDesktopAction(params);
    await this.sleep(this.config.screenshotDelayMs);

    return { executed: true, done: false, failed: false };
  }

  // ── Gymnasium-style Step ────────────────────────────────────────────

  /**
   * Execute an action and return the next observation (gymnasium step).
   * Matches the signature: step(action) → (obs, reward, done, info)
   */
  async step(
    action: OSWorldAction | string,
    instruction: string,
  ): Promise<OSWorldStepResult> {
    this.stepCount++;

    // Execute the action
    let result: { executed: boolean; done: boolean; failed: boolean };
    if (typeof action === "string") {
      result = await this.executePyAutoGUI(action);
    } else {
      result = await this.executeAction(action);
    }

    // Check trajectory limit
    const trajectoryExceeded =
      this.stepCount >= this.config.maxTrajectoryLength;

    // Capture observation
    const observation = await this.getObservation(instruction);

    // Record in trajectory
    this.trajectory.push({
      action,
      observation,
      timestamp: Date.now(),
    });

    return {
      observation,
      reward: 0, // OSWorld computes reward externally via evaluators
      done: result.done || trajectoryExceeded,
      info: {
        ...(result.failed ? { fail: true } : {}),
        stepCount: this.stepCount,
        trajectoryExceeded,
      },
    };
  }

  // ── State ──────────────────────────────────────────────────────────

  /**
   * Reset the adapter for a new task.
   */
  reset(): void {
    this.stepCount = 0;
    this.trajectory = [];
  }

  /**
   * Get the full trajectory of actions and observations.
   */
  getTrajectory() {
    return [...this.trajectory];
  }

  /**
   * Get current step count.
   */
  getStepCount(): number {
    return this.stepCount;
  }

  /**
   * Check if a11y tree extraction is available.
   */
  isA11yAvailable(): boolean {
    return isA11yAvailable();
  }

  /**
   * Get adapter config.
   */
  getConfig(): OSWorldAgentConfig {
    return { ...this.config };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
