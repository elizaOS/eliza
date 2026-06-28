/**
 * Static safety guard for the Windows PowerShell platform layer.
 *
 * Regression coverage for a class of bug where a PowerShell command references
 * a .NET type from `System.Windows.Forms` (e.g. `[System.Windows.Forms.Screen]`)
 * without first running `Add-Type -AssemblyName System.Windows.Forms`. On a clean
 * PowerShell session the type is then unresolved (`TypeNotFound`) and the call
 * silently fails / falls back. This bit `getScreenSize()` in windows-list.ts,
 * which reported a hard-coded 1920x1080 instead of the real primary screen.
 *
 * These checks are static (source text + an exported command constant) so they
 * run on every platform in the normal unit lane — no PowerShell required.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WINDOWS_PRIMARY_SCREEN_SIZE_COMMAND } from "../platform/windows-list.js";

const platformDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "platform",
);

function listPlatformSources(): string[] {
  return readdirSync(platformDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(platformDir, f));
}

describe("Windows PowerShell assembly-load safety", () => {
  it("loads System.Windows.Forms before using the Screen type (command constant)", () => {
    const cmd = WINDOWS_PRIMARY_SCREEN_SIZE_COMMAND;
    const addTypeIdx = cmd.indexOf(
      "Add-Type -AssemblyName System.Windows.Forms",
    );
    const useIdx = cmd.indexOf("[System.Windows.Forms.Screen]");
    expect(
      addTypeIdx,
      "command must Add-Type System.Windows.Forms",
    ).toBeGreaterThanOrEqual(0);
    expect(useIdx, "command must use the Screen type").toBeGreaterThan(
      addTypeIdx,
    );
  });

  it("every platform source that uses a WinForms type also loads the assembly", () => {
    const offenders: string[] = [];
    for (const file of listPlatformSources()) {
      const text = readFileSync(file, "utf-8");
      const usesWinForms = /\[System\.Windows\.Forms\./.test(text);
      if (!usesWinForms) continue;
      const loadsWinForms =
        /Add-Type[^\n;]*-AssemblyName[^\n;]*System\.Windows\.Forms/.test(text);
      if (!loadsWinForms) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `These files reference [System.Windows.Forms.*] in a PowerShell command ` +
        `but never run "Add-Type -AssemblyName System.Windows.Forms":\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
