/** Checks artifact placement from real subprocesses launched at different workspace depths. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "./test-output.mjs";

const moduleUrl = new URL("./test-output.mjs", import.meta.url).href;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("all working directories resolve one ignored root without creating package output", () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "test-output-cwd-"));
  try {
    for (const cwd of [
      repoRoot,
      path.join(repoRoot, "packages/app"),
      external,
    ]) {
      const actual = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { testOutputPath } from ${JSON.stringify(moduleUrl)}; process.stdout.write(testOutputPath("app", "capture.png"));`,
        ],
        { cwd, encoding: "utf8" },
      );
      assert.equal(actual, path.join(repoRoot, "test-results/app/capture.png"));
    }
    assert.equal(fs.existsSync(path.join(external, "test-results")), false);
    const ignored = execFileSync(
      "git",
      ["check-ignore", testOutputPath("app/capture.png")],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(ignored.trim(), testOutputPath("app/capture.png"));
  } finally {
    fs.rmSync(external, { recursive: true, force: true });
  }
});
