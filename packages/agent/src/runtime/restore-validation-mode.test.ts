/**
 * Locks the provider boot-mode parser and the normal runtime's earliest
 * fail-closed guard without constructing the full agent module graph.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertNormalRuntimeBootMode,
  resolveRuntimeBootMode,
} from "./restore-validation-mode.ts";

describe("restore-validation boot mode", () => {
  test("accepts only normal or the exact provider mode", () => {
    expect(resolveRuntimeBootMode({})).toBe("normal");
    expect(
      resolveRuntimeBootMode({
        ELIZA_RUNTIME_BOOT_MODE: " restore-validation ",
      }),
    ).toBe("restore-validation");
    expect(() =>
      resolveRuntimeBootMode({ ELIZA_RUNTIME_BOOT_MODE: "restore" }),
    ).toThrow("Unsupported runtime boot mode");
    expect(() =>
      assertNormalRuntimeBootMode({
        ELIZA_RUNTIME_BOOT_MODE: "restore-validation",
      }),
    ).toThrow("cannot enter the full agent runtime");
  });

  test("guards startEliza before telemetry, faults, plugins, or logs", () => {
    const source = readFileSync(join(import.meta.dirname, "eliza.ts"), "utf8");
    const start = source.indexOf("export async function startEliza(");
    const guard = source.indexOf("assertNormalRuntimeBootMode();", start);
    const timer = source.indexOf("new BootTimer(", start);
    const telemetry = source.indexOf("recordBootEvent(", start);
    const pluginRegistration = source.indexOf(
      "ensureCoreStaticPluginsRegistered()",
      start,
    );

    expect(start).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(start);
    expect(guard).toBeLessThan(timer);
    expect(guard).toBeLessThan(telemetry);
    expect(guard).toBeLessThan(pluginRegistration);
  });
});
