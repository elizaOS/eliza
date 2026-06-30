/**
 * Behavioral guard for the central PowerShell spawn-timeout floor in
 * `helpers.ts#runCommand` / `runCommandBuffer`.
 *
 * Regression coverage for #9581: the legacy-driver desktop paths in
 * `desktop.ts` spawn `powershell` through `runCommand` with small hardcoded
 * budgets (e.g. the 5s `System.Windows.Forms.Cursor` position query that
 * `driverGetCursorPosition` always uses on Windows). On a Defender-heavy host a
 * cold `powershell.exe` spawn pays a ~10-16s AV-scan tax, so 5s ETIMEDOUTs and
 * the capability false-fails (`cua-parity-input.real` died at
 * `legacyGetCursorPosition`). #10100 floored the `windows-list.ts` spawns but
 * not these; flooring `runCommand` centrally covers every legacy-driver
 * PowerShell spawn at once. The mock keeps this a normal cross-platform unit
 * test (no real spawn), so it fails loudly if the floor is ever dropped.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => ""),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(() => ""),
}));

import { runCommand, runCommandBuffer } from "../platform/helpers.js";

const ENV = "ELIZA_COMPUTERUSE_PS_TIMEOUT_MS";

afterEach(() => {
  delete process.env[ENV];
  execFileSyncMock.mockClear();
});

function lastTimeout(): number {
  const call = execFileSyncMock.mock.calls.at(-1);
  return (call?.[2] as { timeout: number }).timeout;
}

describe("runCommand PowerShell spawn-timeout floor", () => {
  it("raises a powershell timeout to the ELIZA_COMPUTERUSE_PS_TIMEOUT_MS floor", () => {
    process.env[ENV] = "30000";
    runCommand("powershell", ["-Command", "x"], 5000);
    expect(lastTimeout()).toBe(30000);
  });

  it("also raises pwsh spawns", () => {
    process.env[ENV] = "30000";
    runCommand("pwsh", ["-Command", "x"], 5000);
    expect(lastTimeout()).toBe(30000);
  });

  it("only ever raises — never lowers a base above the floor", () => {
    process.env[ENV] = "1000";
    runCommand("powershell", ["-Command", "x"], 5000);
    expect(lastTimeout()).toBe(5000);
  });

  it("does not touch non-powershell commands", () => {
    process.env[ENV] = "30000";
    runCommand("cliclick", ["p:."], 5000);
    expect(lastTimeout()).toBe(5000);
  });

  it("is a no-op when the env var is unset", () => {
    runCommand("powershell", ["-Command", "x"], 5000);
    expect(lastTimeout()).toBe(5000);
  });

  it("floors runCommandBuffer powershell spawns too", () => {
    process.env[ENV] = "30000";
    runCommandBuffer("powershell", ["-Command", "x"], 5000);
    expect(lastTimeout()).toBe(30000);
  });
});
