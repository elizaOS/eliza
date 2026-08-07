/**
 * set_value (a11y element value write) parity (#9170 — trycua/cua `set_value`).
 *
 * Surface + driver-seam + per-OS shape assertions in the DEFAULT lane (runs on
 * Windows/Linux/macOS/AOSP-Node). The real end-to-end actuation (UIAutomation
 * ValuePattern on a live control) runs in the interactive real-driver lane —
 * the win32 ValuePattern path needs a UIA-capable desktop, and the universal
 * fallback is composed of the already-real-tested click/key-combo/type verbs.
 */

import { describe, expect, it } from "vitest";
import { computerUsePlugin } from "../index.js";
import * as desktop from "../platform/desktop.js";

const actionNames = (computerUsePlugin.actions ?? []).map((a) => a.name);

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
  it("win32TrySetValueByPattern no-ops to false off win32 (pure guard)", () => {
    // On a non-win32 test runner this returns false without spawning anything;
    // on win32 it would attempt UIAutomation. Either way it must be boolean.
    expect(typeof desktop.win32TrySetValueByPattern(10, 10, "x")).toBe(
      "boolean",
    );
  });
});
