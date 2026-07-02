/**
 * set_value (a11y element value write) parity (#9170 — trycua/cua `set_value`).
 *
 * Surface + driver-seam + per-OS shape assertions in the DEFAULT lane (runs on
 * Windows/Linux/macOS/AOSP-Node). The real end-to-end actuation (UIAutomation
 * ValuePattern on a live control) runs in the interactive real-driver lane —
 * the win32 ValuePattern path needs a UIA-capable desktop, and the universal
 * fallback is composed of the already-real-tested click/key-combo/type verbs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computerUsePlugin } from "../index.js";
import * as desktop from "../platform/desktop.js";
import * as driver from "../platform/driver.js";

const actionNames = (computerUsePlugin.actions ?? []).map((a) => a.name);
const driverSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "platform", "driver.ts"),
  "utf8",
);
const desktopSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "platform", "desktop.ts"),
  "utf8",
);

describe("set_value surface", () => {
  it("promotes set_value under COMPUTER_USE", () => {
    expect(actionNames, `actions: ${actionNames.join(", ")}`).toContain(
      "COMPUTER_USE_SET_VALUE",
    );
  });

  it("set_value is in the COMPUTER_USE action enum", () => {
    const cu = (computerUsePlugin.actions ?? []).find(
      (a) => a.name === "COMPUTER_USE",
    ) as
      | { parameters?: Array<{ name: string; schema?: { enum?: string[] } }> }
      | undefined;
    const en =
      cu?.parameters?.find((p) => p.name === "action")?.schema?.enum ?? [];
    expect(en).toContain("set_value");
  });
});

describe("set_value driver seam", () => {
  it("exports driverSetValue + the win32 ValuePattern helper", () => {
    expect(typeof driver.driverSetValue).toBe("function");
    expect(typeof desktop.win32TrySetValueByPattern).toBe("function");
  });

  it("win32TrySetValueByPattern no-ops to false off win32 (pure guard)", () => {
    // On a non-win32 test runner this returns false without spawning anything;
    // on win32 it would attempt UIAutomation. Either way it must be boolean.
    expect(typeof desktop.win32TrySetValueByPattern(10, 10, "x")).toBe(
      "boolean",
    );
  });
});

describe("set_value implementation shape", () => {
  it("driverSetValue tries the win32 ValuePattern fast-path then falls back to click→select-all→type", () => {
    const start = driverSrc.indexOf("export async function driverSetValue");
    expect(start).toBeGreaterThan(-1);
    const body = driverSrc.slice(start, start + 700);
    expect(body).toContain("win32TrySetValueByPattern");
    expect(body).toContain("driverClick");
    expect(body).toContain("driverKeyCombo");
    expect(body).toContain("driverType");
    // macOS uses cmd+a, others ctrl+a.
    expect(body).toContain('"cmd+a"');
    expect(body).toContain('"ctrl+a"');
  });

  it("the win32 fast-path uses UIAutomation ValuePattern (not synthesized keys)", () => {
    const start = desktopSrc.indexOf(
      "export function win32TrySetValueByPattern",
    );
    expect(start).toBeGreaterThan(-1);
    const body = desktopSrc.slice(start, start + 1200);
    expect(body).toContain("UIAutomationClient");
    expect(body).toContain("ValuePattern");
    expect(body).toContain("FromPoint");
  });
});
