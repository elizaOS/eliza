/**
 * Proves observable ComputerUseService effects against the selected host
 * driver only after an operator opts in. Hardware and permission failures fail.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertScreenshotBase64NotBlank } from "../../test/helpers/screenshot-quality.ts";
import {
  startComputerUseRuntime,
  stopComputerUseRuntime,
} from "../../test/helpers/service-runtime.ts";
import type { ComputerUseService } from "../services/computer-use-service.js";

if (process.env.COMPUTER_USE_REAL_DESKTOP_TESTS !== "1") {
  throw new Error(
    "Real desktop service tests require per-command acknowledgment: set COMPUTER_USE_REAL_DESKTOP_TESTS=1 on an isolated interactive desktop",
  );
}

describe("ComputerUseService real desktop", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_APPROVAL_MODE: "full_control",
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
    }));
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("captures a non-blank screenshot through the service", async () => {
    const result = await service.executeDesktopAction({ action: "screenshot" });
    expect(result.success, `screenshot failed: ${result.error}`).toBe(true);
    assertScreenshotBase64NotBlank(
      result.screenshot,
      "ComputerUseService screenshot action",
    );
  });

  it("moves the pointer and reads the resulting OS position", async () => {
    const moveResult = await service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [200, 200],
    });
    expect(moveResult.success, `mouse_move failed: ${moveResult.error}`).toBe(
      true,
    );
    expect(moveResult.screenshot).toBeUndefined();

    const positionResult = await service.executeDesktopAction({
      action: "get_cursor_position",
    });
    expect(
      positionResult.success,
      `cursor query failed: ${positionResult.error}`,
    ).toBe(true);
    expect(
      Math.abs((positionResult.cursorPosition?.x ?? -1) - 200),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs((positionResult.cursorPosition?.y ?? -1) - 200),
    ).toBeLessThanOrEqual(2);
  });

  it("enumerates at least one real host window", async () => {
    const result = await service.executeWindowAction({ action: "list" });
    expect(result.success, `window list failed: ${result.error}`).toBe(true);
    if (!result.windows) {
      throw new Error("Window enumeration succeeded without a windows result");
    }
    expect(
      result.windows.length,
      "Window enumeration returned no windows; the real lane requires an interactive desktop",
    ).toBeGreaterThan(0);
  }, 15000);
});
