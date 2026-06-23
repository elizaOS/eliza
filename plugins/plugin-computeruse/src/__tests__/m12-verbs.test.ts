/**
 * M12 verb parity (#9170): open / launch + window getters.
 *
 * The pure guards (empty target/app, set_bounds param validation, application
 * filter) run in the default lane; a real benign `launch` proves a pid comes
 * back. The action-surface promotion is asserted against the plugin. Platform
 * window queries (active window, real resize) are exercised by the gated
 * real-driver evidence lane.
 */

import { describe, expect, it } from "vitest";
import { computerUsePlugin } from "../index.js";
import { launchApp, openTarget } from "../platform/launch.js";
import {
  getApplicationWindows,
  resizeWindow,
} from "../platform/windows-list.js";

const actionNames = (computerUsePlugin.actions ?? []).map((a) => a.name);

describe("open / launch guards", () => {
  it("openTarget rejects an empty target", async () => {
    await expect(openTarget("")).rejects.toThrow(/non-empty target/);
    await expect(openTarget("   ")).rejects.toThrow(/non-empty target/);
  });

  it("launchApp rejects an empty app", async () => {
    await expect(launchApp("")).rejects.toThrow(/non-empty app/);
  });

  it("launchApp returns a pid for a real executable", async () => {
    // Spawn the current JS runtime as a benign, immediately-exiting child.
    const result = await launchApp(process.execPath, ["-e", "0"]);
    expect(typeof result.pid).toBe("number");
    expect(result.pid).toBeGreaterThan(0);
    expect(result.command).toBe(process.execPath);
  });

  it("launchApp rejects a non-existent executable path", async () => {
    await expect(
      launchApp("/nonexistent/definitely-not-a-real-binary-xyz"),
    ).rejects.toThrow();
  });
});

describe("window getters", () => {
  it("getApplicationWindows returns [] for an empty app name", () => {
    expect(getApplicationWindows("")).toEqual([]);
    expect(getApplicationWindows("   ")).toEqual([]);
  });

  it("getApplicationWindows always returns an array", () => {
    expect(Array.isArray(getApplicationWindows("definitely-no-such-app"))).toBe(
      true,
    );
  });

  it("resizeWindow validates x/y before touching the OS", () => {
    expect(() => resizeWindow("w1", undefined as unknown as number, 5)).toThrow(
      /x and y are required/,
    );
    expect(() => resizeWindow("w1", 5, undefined as unknown as number)).toThrow(
      /x and y are required/,
    );
  });
});

describe("action-surface promotion (M12)", () => {
  it("promotes open / launch under COMPUTER_USE", () => {
    expect(actionNames, `actions: ${actionNames.join(", ")}`).toContain(
      "COMPUTER_USE_OPEN",
    );
    expect(actionNames).toContain("COMPUTER_USE_LAUNCH");
  });

  it("promotes the new window getters under WINDOW", () => {
    for (const verb of [
      "WINDOW_GET_CURRENT_WINDOW_ID",
      "WINDOW_GET_APPLICATION_WINDOWS",
      "WINDOW_SET_BOUNDS",
    ]) {
      expect(actionNames, `actions: ${actionNames.join(", ")}`).toContain(verb);
    }
  });
});
