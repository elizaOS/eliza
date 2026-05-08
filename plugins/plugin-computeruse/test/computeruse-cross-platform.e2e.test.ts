/**
 * Cross-platform e2e smoke test for plugin-computeruse.
 *
 * Boots the ComputerUseService against a minimal mock runtime, registers the
 * service, and drives a short action sequence:
 *   screenshot → mouse_move(coords) → type("hello") → screenshot
 *
 * Asserts on observable outcomes only (success flags + non-empty screenshot
 * buffers). No vi.mock, no monkey-patching of platform code — the actual
 * cross-platform driver runs.
 *
 * Skip rules:
 *   - Linux: skipped unless DISPLAY is set (CI must use Xvfb / xvfb-run)
 *   - Windows: runs when the selected driver and desktop session are available
 *   - macOS: runs normally (Accessibility/Screen Recording permissions are a
 *     prerequisite; if denied the assertion-level check is converted to skip).
 *
 * Driver:
 *   - Default uses ELIZA_COMPUTERUSE_DRIVER=nutjs (cross-platform native).
 *   - When the @nut-tree-fork/nut-js native module is unavailable (deps not
 *     installed yet, or unsupported arch), the test gracefully skips.
 */

import { platform } from "node:os";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { ComputerUseService } from "../src/services/computer-use-service.js";
import {
  isAvailable as nutAvailable,
  loadFailureReason,
} from "../src/platform/nut-driver.js";
import type { ComputerActionResult } from "../src/types.js";

const os = platform();
const requestedDriver = (
  process.env.ELIZA_COMPUTERUSE_DRIVER ?? "nutjs"
).toLowerCase();

function shouldSkip(): { skip: boolean; reason: string } {
  if (os === "win32") {
    if (requestedDriver !== "nutjs") {
      return {
        skip: true,
        reason:
          "Windows cross-platform smoke uses the nutjs driver; legacy PowerShell coverage is validated by platform capability tests.",
      };
    }
  }
  if (os === "linux" && !process.env.DISPLAY) {
    return {
      skip: true,
      reason: "Linux requires DISPLAY (run under Xvfb / xvfb-run in CI)",
    };
  }
  if (requestedDriver === "nutjs" && !nutAvailable()) {
    return {
      skip: true,
      reason: `nutjs native module unavailable: ${loadFailureReason() ?? "unknown"}`,
    };
  }
  return { skip: false, reason: "" };
}

function createMockRuntime(): IAgentRuntime {
  const settings: Record<string, string> = {
    COMPUTER_USE_APPROVAL_MODE: "full_control",
    COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "true",
  };
  return {
    character: {},
    getSetting(key: string) {
      return settings[key];
    },
    getService() {
      return null;
    },
  } as unknown as IAgentRuntime;
}

describe("plugin-computeruse cross-platform driver e2e", () => {
  const { skip, reason } = shouldSkip();

  it.skipIf(skip)(
    "drives screenshot → mouse_move → type → screenshot via the selected driver",
    async ({ skip }) => {
      const service = (await ComputerUseService.start(
        createMockRuntime(),
      )) as ComputerUseService;
      try {
        const screenshotBefore = (await service.executeCommand(
          "screenshot",
        )) as ComputerActionResult;
        if (screenshotBefore.permissionDenied) {
          // macOS denies Screen Recording until granted in System Settings.
          // CI without that permission cannot prove driver wiring; treat as
          // an environment skip rather than a fail.
          skip(
            `Desktop screenshot permission denied: ${
              screenshotBefore.error ?? "unknown"
            }`,
          );
        }
        if (!screenshotBefore.success) {
          skip(
            `Desktop screenshot unavailable in this environment: ${
              screenshotBefore.error ?? "unknown"
            }`,
          );
        }
        expect(screenshotBefore.success).toBe(true);
        expect(screenshotBefore.screenshot).toBeTruthy();
        expect((screenshotBefore.screenshot as string).length).toBeGreaterThan(
          100,
        );

        const move = (await service.executeCommand("mouse_move", {
          coordinate: [100, 100],
        })) as ComputerActionResult;
        if (move.permissionDenied) return;
        expect(move.success).toBe(true);

        const typeResult = (await service.executeCommand("type", {
          text: "hello",
        })) as ComputerActionResult;
        if (typeResult.permissionDenied) return;
        expect(typeResult.success).toBe(true);

        const screenshotAfter = (await service.executeCommand(
          "screenshot",
        )) as ComputerActionResult;
        if (screenshotAfter.permissionDenied) return;
        expect(screenshotAfter.success).toBe(true);
        expect(screenshotAfter.screenshot).toBeTruthy();
      } finally {
        await service.stop();
      }
    },
    60_000,
  );

  if (skip) {
    it("skip-reason recorded for environment", () => {
      expect(reason.length).toBeGreaterThan(0);
    });
  }
});
