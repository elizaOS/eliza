/**
 * Stagehand browser target tests for environment detection and command forwarding.
 */

import { describe, expect, it } from "vitest";
import { maybeCreateStagehandTarget } from "./stagehand-target.js";

const COMMAND_URL = "https://stagehand.example/api/browser-command";

function stagehandEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ELIZA_BROWSER_STAGEHAND_AUTO_SETUP: "false",
    ELIZA_BROWSER_STAGEHAND_COMMAND_URL: COMMAND_URL,
    ...overrides,
  };
}

describe("Stagehand browser target platform gating", () => {
  it("does not register Stagehand on mobile by default", async () => {
    const target = await maybeCreateStagehandTarget(
      stagehandEnv({ ELIZA_MOBILE_PLATFORM: "ios" }),
    );

    expect(target).toBeNull();
  });

  it("keeps opted-in mobile Stagehand explicit-only for automatic routing", async () => {
    const target = await maybeCreateStagehandTarget(
      stagehandEnv({
        ELIZA_BROWSER_ALLOW_STAGEHAND_ON_MOBILE: "true",
        ELIZA_MOBILE_PLATFORM: "android",
      }),
    );

    expect(target).not.toBeNull();
    if (!target) {
      throw new Error("Stagehand target was not created");
    }
    expect(
      target.score?.({
        command: { subaction: "state" },
        env: stagehandEnv({ ELIZA_MOBILE_PLATFORM: "android" }),
        mobile: true,
      }),
    ).toBeNull();
    expect(
      target.score?.({
        command: { subaction: "state" },
        env: stagehandEnv(),
        mobile: false,
      }),
    ).toBe(10);
    await expect(target.available()).resolves.toBe(true);
  });
});
