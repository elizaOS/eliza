/** Runs the actual vision setup script with a package-manager sentinel; default checks cannot install software. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("default startup never invokes a package manager", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "eliza-vision-policy-"));
  const marker = path.join(dir, "invoked");
  try {
    for (const command of ["brew", "apt-get", "sudo", "winget"]) {
      writeFileSync(
        path.join(dir, command),
        '#!/bin/sh\n/bin/touch "$INSTALL_MARKER"\n',
        { mode: 0o755 },
      );
    }
    const script = fileURLToPath(
      new URL("./ensure-vision-deps.ts", import.meta.url),
    );
    const output = execFileSync(process.execPath, [script], {
      env: {
        ...process.env,
        PATH: dir,
        INSTALL_MARKER: marker,
        ELIZA_NO_VISION_DEPS: "0",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(existsSync(marker), false);
    assert.equal(output.includes("Installing"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installed tools are silent and missing tools explain the next action", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "eliza-vision-output-"));
  const script = fileURLToPath(
    new URL("./ensure-vision-deps.ts", import.meta.url),
  );
  const run = () =>
    spawnSync(process.execPath, [script], {
      env: { ...process.env, PATH: dir, ELIZA_NO_VISION_DEPS: "0" },
      encoding: "utf8",
    });
  try {
    const missing = run();
    assert.equal(missing.status, 0);
    if (["darwin", "linux", "win32"].includes(process.platform)) {
      assert.match(missing.stderr, /Optional vision tool .* is missing/);
      assert.match(missing.stderr, /--install/);
    }
    for (const tool of ["imagesnap", "fswebcam", "ffmpeg", "ffmpeg.EXE"]) {
      writeFileSync(path.join(dir, tool), "", { mode: 0o755 });
    }
    const installed = run();
    assert.equal(installed.status, 0);
    assert.equal(installed.stdout + installed.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
