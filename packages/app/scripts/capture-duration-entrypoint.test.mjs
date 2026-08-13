/**
 * Real-process regression for the five platform capture CLI entrypoints.
 * Each child receives malformed --duration input and must reject it before
 * probing a platform, device, display, or capture tool; no lifecycle is mocked.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = [
  "capture-android-emu.mjs",
  "capture-ios-sim.mjs",
  "capture-macos-desktop.mjs",
  "capture-windows-desktop.mjs",
  "capture-linux-desktop.mjs",
];

for (const script of SCRIPTS) {
  test(`${script} rejects malformed duration before platform setup`, () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), "--duration", "junk"],
      {
        encoding: "utf8",
        timeout: 5_000,
      },
    );

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /--duration/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\[skip\]/i);
  });
}
