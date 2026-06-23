/**
 * trycua/cua parity — pointer primitives (#9170 M8).
 *
 * trycua's BaseComputerInterface exposes middle_click, mouse_down (left-button
 * press-and-hold) and mouse_up (release). We expose the same three verbs on the
 * COMPUTER_USE action and through the driver seam. This suite verifies, on every
 * OS in the default unit lane:
 *   - the verbs are registered (promoted subactions) and present in the action enum;
 *   - the driver + nut + legacy backends export the new functions;
 *   - the per-OS legacy command shapes are correct (static source assertions —
 *     no real input is dispatched here; the live-driver behavior is covered by
 *     `cua-parity-input.real.test.ts` / the M8 runtime probe).
 *
 * Static source-text checks follow the same convention as
 * `windows-powershell-safety.test.ts`: they run on Linux/macOS/Windows CI alike.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computerUsePlugin } from "../index.js";
import * as driver from "../platform/driver.js";
import * as nut from "../platform/nut-driver.js";

const here = dirname(fileURLToPath(import.meta.url));
const desktopSrc = readFileSync(
  join(here, "..", "platform", "desktop.ts"),
  "utf8",
);
const serviceSrc = readFileSync(
  join(here, "..", "services", "computer-use-service.ts"),
  "utf8",
);

/** Slice the body of a `case "<verb>": {` block up to its closing `break;`. */
function caseBody(src: string, verb: string): string {
  const start = src.indexOf(`case "${verb}": {`);
  if (start === -1) throw new Error(`case "${verb}" not found in service`);
  const rest = src.slice(start);
  const end = rest.indexOf("break;");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Slice the body of an `export function <name>(` up to the next top-level
 * `export function` (or EOF). Lets us scope substring assertions to one verb. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in desktop.ts`);
  const rest = src.slice(start + 1);
  const nextIdx = rest.indexOf("\nexport function ");
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

const actionNames = (computerUsePlugin.actions ?? []).map((a) => a.name);

describe("cua parity — pointer primitive surface", () => {
  it("promotes middle_click / mouse_down / mouse_up to top-level actions", () => {
    expect(actionNames, actionNames.join(", ")).toContain(
      "COMPUTER_USE_MIDDLE_CLICK",
    );
    expect(actionNames).toContain("COMPUTER_USE_MOUSE_DOWN");
    expect(actionNames).toContain("COMPUTER_USE_MOUSE_UP");
  });

  it("lists the verbs in the COMPUTER_USE action parameter enum", () => {
    const cu = (computerUsePlugin.actions ?? []).find(
      (a) => a.name === "COMPUTER_USE",
    );
    expect(cu).toBeDefined();
    const actionParam = (
      cu as { parameters?: Array<{ name: string; schema?: { enum?: string[] } }> }
    ).parameters?.find((p) => p.name === "action");
    const en = actionParam?.schema?.enum ?? [];
    expect(en).toContain("middle_click");
    expect(en).toContain("mouse_down");
    expect(en).toContain("mouse_up");
  });
});

describe("cua parity — pointer primitive driver seam", () => {
  it("exports driver wrappers for all three verbs", () => {
    expect(typeof driver.driverMiddleClick).toBe("function");
    expect(typeof driver.driverMouseDown).toBe("function");
    expect(typeof driver.driverMouseUp).toBe("function");
  });

  it("exports nutjs implementations for all three verbs", () => {
    expect(typeof nut.nutMiddleClick).toBe("function");
    expect(typeof nut.nutMouseDown).toBe("function");
    expect(typeof nut.nutMouseUp).toBe("function");
  });

  it("treats mouse_up's coordinate as optional but middle_click/mouse_down as required", () => {
    // Press-hold-release gestures release at the current point when no
    // coordinate is supplied; release at (x,y) when one is — so the mouse_up
    // service branch must NOT requireCoordinate, while the press verbs must.
    const up = caseBody(serviceSrc, "mouse_up");
    expect(up).not.toContain("requireCoordinate");
    expect(up).toContain("if (params.coordinate)");
    expect(caseBody(serviceSrc, "mouse_down")).toContain("requireCoordinate");
    expect(caseBody(serviceSrc, "middle_click")).toContain("requireCoordinate");
  });
});

describe("cua parity — Windows legacy command shapes", () => {
  it("middle_click uses MOUSEEVENTF_MIDDLEDOWN/UP (0x0020 / 0x0040)", () => {
    const body = functionBody(desktopSrc, "desktopMiddleClick");
    expect(body).toContain("0x0020");
    expect(body).toContain("0x0040");
    expect(body).toContain("Add-Type -AssemblyName System.Windows.Forms");
  });

  it("mouse_down uses MOUSEEVENTF_LEFTDOWN (0x0002) without a release", () => {
    const body = functionBody(desktopSrc, "desktopMouseDown");
    expect(body).toContain("0x0002");
    expect(body).not.toContain("0x0004");
  });

  it("mouse_up uses MOUSEEVENTF_LEFTUP (0x0004)", () => {
    const body = functionBody(desktopSrc, "desktopMouseUp");
    expect(body).toContain("0x0004");
  });
});

describe("cua parity — Linux legacy command shapes", () => {
  it("middle_click issues xdotool click 2", () => {
    const body = functionBody(desktopSrc, "desktopMiddleClick");
    expect(body).toContain('"click", "2"');
  });

  it("mouse_down issues xdotool mousedown 1; mouse_up issues mouseup 1", () => {
    expect(functionBody(desktopSrc, "desktopMouseDown")).toContain(
      '"mousedown", "1"',
    );
    expect(functionBody(desktopSrc, "desktopMouseUp")).toContain(
      '"mouseup", "1"',
    );
  });
});

describe("cua parity — macOS legacy command shapes", () => {
  it("middle_click is reported unsupported (cliclick has no middle verb)", () => {
    const body = functionBody(desktopSrc, "desktopMiddleClick");
    expect(body).toMatch(/not supported on macOS/);
  });

  it("mouse_down/up use cliclick dd:/du:", () => {
    expect(functionBody(desktopSrc, "desktopMouseDown")).toContain("dd:");
    expect(functionBody(desktopSrc, "desktopMouseUp")).toContain("du:");
  });
});
