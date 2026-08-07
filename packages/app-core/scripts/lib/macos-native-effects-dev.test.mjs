/** Verifies source-checkout discovery and staleness policy for the macOS native bridge. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMacNativeEffectsDevPlan } from "./macos-native-effects-dev.mjs";

const cwd = "/repo";
const packageDir = path.join(
  cwd,
  "packages",
  "app-core",
  "platforms",
  "electrobun",
);
const source = path.join(packageDir, "native", "macos", "window-effects.mm");
const output = path.join(packageDir, "src", "libMacWindowEffects.dylib");

function plan({
  env = {},
  platform = "darwin",
  existing = [source],
  mtimes = {},
} = {}) {
  const files = new Set(existing);
  return resolveMacNativeEffectsDevPlan({
    cwd,
    env,
    platform,
    exists: (value) => files.has(value),
    modifiedAt: (value) => mtimes[value] ?? 0,
  });
}

describe("macOS native effects dev plan", () => {
  it("skips hosts that cannot load the Darwin bridge", () => {
    expect(plan({ platform: "linux" })).toEqual({ kind: "skip" });
  });

  it("keeps an existing operator override authoritative", () => {
    expect(
      plan({
        env: { ELIZA_NATIVE_PERMISSIONS_DYLIB: "/custom/native.dylib" },
        existing: [source, "/custom/native.dylib"],
      }),
    ).toEqual({ kind: "use", dylibPath: "/custom/native.dylib" });
  });

  it("builds a missing source-checkout artifact", () => {
    expect(plan()).toEqual({
      kind: "build",
      packageDir,
      dylibPath: output,
    });
  });

  it("reuses a fresh artifact and rebuilds a stale one", () => {
    expect(
      plan({
        existing: [source, output],
        mtimes: { [source]: 10, [output]: 11 },
      }),
    ).toEqual({ kind: "use", dylibPath: output });

    expect(
      plan({
        existing: [source, output],
        mtimes: { [source]: 12, [output]: 11 },
      }),
    ).toMatchObject({ kind: "build", dylibPath: output });
  });

  it("honors an explicit dev opt-out", () => {
    expect(plan({ env: { ELIZA_DEV_NATIVE_EFFECTS: "0" } })).toEqual({
      kind: "skip",
    });
  });
});
