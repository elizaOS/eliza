/**
 * Drives ComputerUseService against the selected host driver only after an
 * operator opts in; hardware and permission failures fail instead of skipping.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertScreenshotBase64NotBlank } from "../../test/helpers/screenshot-quality.ts";
import {
  startComputerUseRuntime,
  stopComputerUseRuntime,
} from "../../test/helpers/service-runtime.ts";
import type { ComputerUseService } from "../services/computer-use-service.js";

const realDesktopEnabled = process.env.COMPUTER_USE_REAL_DESKTOP_TESTS === "1";
const describeRealDesktop = realDesktopEnabled ? describe : describe.skip;

describeRealDesktop("ComputerUseService real desktop", () => {
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

  it("captures a non-blank screenshot through the service", async () => {
    const result = await service.executeDesktopAction({ action: "screenshot" });
    expect(result.success, `screenshot failed: ${result.error}`).toBe(true);
    assertScreenshotBase64NotBlank(
      result.screenshot,
      "ComputerUseService screenshot action",
    );
  });

  it("moves the pointer through the selected service driver", async () => {
    const result = await service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [200, 200],
    });

    expect(result.success, `mouse_move failed: ${result.error}`).toBe(true);
    expect(result.screenshot).toBeUndefined();
  });

  it("clicks through the selected service driver", async () => {
    const result = await service.executeDesktopAction({
      action: "click",
      coordinate: [200, 200],
    });

    expect(result.success, `click failed: ${result.error}`).toBe(true);
  });

  it("sends keys through the selected service driver", async () => {
    const keyResult = await service.executeDesktopAction({
      action: "key",
      key: "Escape",
    });
    expect(keyResult.success, `key failed: ${keyResult.error}`).toBe(true);

    const comboResult = await service.executeDesktopAction({
      action: "key_combo",
      key: "shift+Escape",
    });
    expect(comboResult.success, `key_combo failed: ${comboResult.error}`).toBe(
      true,
    );
  });

  it("scrolls through the selected service driver", async () => {
    const result = await service.executeDesktopAction({
      action: "scroll",
      coordinate: [400, 400],
      scrollDirection: "down",
      scrollAmount: 2,
    });

    expect(result.success, `scroll failed: ${result.error}`).toBe(true);
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
