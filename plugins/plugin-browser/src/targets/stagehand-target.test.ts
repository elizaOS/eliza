/**
 * Stagehand browser target tests: environment detection, command forwarding, and
 * the load-time preflight the plugin resolver invokes generically (#12665). The
 * preflight moved out of the resolver's `=== "@elizaos/plugin-browser"` branch
 * into this plugin, so its degrade-when-missing behavior is covered here.
 */

import { describe, expect, it } from "vitest";
import {
  maybeCreateStagehandTarget,
  preflightStagehandServer,
} from "./stagehand-target.js";

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

describe("preflightStagehandServer degrade-when-missing", () => {
  it("returns without throwing when no stagehand-server is discoverable", () => {
    // Point discovery at a directory with no stagehand-server checkout under it,
    // so ensureLocalStagehandServer() finds nothing. The optional stagehand
    // backend degrades (logs) rather than blocking the plugin load.
    expect(() =>
      preflightStagehandServer({
        ELIZA_BROWSER_STAGEHAND_DIR: "/nonexistent/stagehand-server",
      }),
    ).not.toThrow();
  });

  it("is a no-op when stagehand is disabled", () => {
    // ELIZA_BROWSER_STAGEHAND_ENABLED=false short-circuits before any disk work.
    expect(() =>
      preflightStagehandServer({ ELIZA_BROWSER_STAGEHAND_ENABLED: "false" }),
    ).not.toThrow();
  });

  it("is a no-op when auto-setup is disabled", () => {
    expect(() =>
      preflightStagehandServer({ ELIZA_BROWSER_STAGEHAND_AUTO_SETUP: "false" }),
    ).not.toThrow();
  });

  it("degrades on mobile without throwing", () => {
    expect(() =>
      preflightStagehandServer({
        ELIZA_MOBILE_PLATFORM: "ios",
        ELIZA_BROWSER_STAGEHAND_DIR: "/nonexistent/stagehand-server",
      }),
    ).not.toThrow();
  });
});
