/**
 * Static guard for the Windows PowerShell spawn-timeout floor.
 *
 * Regression coverage for #9581: on a Defender-heavy Windows host a cold
 * `powershell.exe` spawn pays a ~11.6s real-time-AV-scan tax, so a 10s budget
 * ETIMEDOUTs and `listWindows()` silently returns `[]` (finding #2). #10100
 * fixed this by routing every `windows-list.ts` PowerShell spawn through
 * `psSpawnTimeoutMs()` (the `ELIZA_COMPUTERUSE_PS_TIMEOUT_MS` floor) and raising
 * the `listWindows()` enumeration budget to 15s.
 *
 * The #10107 warm-host refactor then re-routed the window ops through
 * `runWindowsPowerShell`/`runPsHost` and, in the move, dropped the
 * `psSpawnTimeoutMs` import and reverted the enumeration budget back to 10s —
 * silently undoing the #10100 hardening (the env escape hatch no longer reached
 * any window op). These checks are static (source text only) so they run on
 * every platform in the normal unit lane and fail loudly if the floor is ever
 * dropped from the window-op spawn paths again.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const windowsListSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "platform",
    "windows-list.ts",
  ),
  "utf-8",
);

describe("Windows spawn-timeout floor (windows-list.ts)", () => {
  it("imports the psSpawnTimeoutMs floor helper", () => {
    expect(
      /import\s*\{[^}]*\bpsSpawnTimeoutMs\b[^}]*\}\s*from\s*["']\.\/windows-timeouts(\.js)?["']/.test(
        windowsListSource,
      ),
      "windows-list.ts must import psSpawnTimeoutMs from ./windows-timeouts " +
        "(the #10100 hardening that #10107 dropped)",
    ).toBe(true);
  });

  it("routes the central window-op PowerShell runner through the floor", () => {
    // `runWindowsPowerShell` is the single entry point #10107 funnels every
    // window op (focus/move/min/max/restore/close/bounds/active) through, so the
    // floor applied here covers them all — including the cold one-shot fallback.
    const fnStart = windowsListSource.indexOf(
      "async function runWindowsPowerShell",
    );
    expect(fnStart, "runWindowsPowerShell must exist").toBeGreaterThanOrEqual(
      0,
    );
    const fnBody = windowsListSource.slice(fnStart, fnStart + 1200);
    expect(
      /psSpawnTimeoutMs\(/.test(fnBody),
      "runWindowsPowerShell must raise its budget via psSpawnTimeoutMs",
    ).toBe(true);
  });

  it("floors every window-enumeration spawn (the listWindows() == 0 path)", () => {
    // Both the synchronous fallback (`execSync(\`powershell -Command ...\`)`) and
    // the warm-host pre-seed (`runPsHost(WINDOWS_LIST_PS, ...)`) run the
    // WINDOWS_LIST_PS enumeration; each pays the cold-spawn tax when the host is
    // absent/cold, so each must be floored or finding #2 returns.
    const spawnLines = windowsListSource
      .split("\n")
      .filter((line) => line.includes("WINDOWS_LIST_PS") && line.includes("("))
      // skip the constant definition itself
      .filter((line) => !line.includes("const WINDOWS_LIST_PS"));
    expect(
      spawnLines.length,
      "expected at least the sync + warm-host enumeration spawns",
    ).toBeGreaterThanOrEqual(2);
    // The line that runs the enumeration carries the timeout arg; assert the
    // surrounding call expression uses the floor (the timeout literal may be on
    // the next physical line for execSync, so check a small window per match).
    for (const line of spawnLines) {
      const idx = windowsListSource.indexOf(line);
      const region = windowsListSource.slice(idx, idx + 220);
      expect(
        /psSpawnTimeoutMs\(/.test(region),
        `window enumeration spawn must be floored via psSpawnTimeoutMs:\n${line.trim()}`,
      ).toBe(true);
    }
  });

  it("keeps the listWindows() enumeration budget at the 15s base (#10100)", () => {
    // The cold sync spawn pays the full ~11.6s Defender tax; a 10s base
    // ETIMEDOUTs before it returns. Guard the restored 15s base specifically.
    expect(
      /psSpawnTimeoutMs\(15000\)/.test(windowsListSource),
      "the synchronous listWindows() enumeration must use a 15000ms base",
    ).toBe(true);
  });
});
