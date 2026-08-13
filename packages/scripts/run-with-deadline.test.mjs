/**
 * Real-process process-group supervision harness for run-with-deadline. These
 * tests spawn actual Node children and descendants; no child lifecycle is mocked.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.resolve("packages/scripts/run-with-deadline.mjs");

test("waits for SIGKILL escalation when the direct child closes first", {
  timeout: 20_000,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "run-with-deadline-"));
  const pidFile = path.join(root, "descendant.pid");
  const descendant = path.join(root, "descendant.mjs");
  const child = path.join(root, "child.mjs");
  writeFileSync(
    descendant,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
  writeFileSync(
    child,
    `import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "100", "--", process.execPath, child],
      {
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    assert.match(result.stderr, /termination grace expired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settles promptly when a descendant honors SIGTERM", {
  timeout: 10_000,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "run-with-deadline-grace-"));
  const descendant = path.join(root, "descendant.mjs");
  const child = path.join(root, "child.mjs");
  writeFileSync(
    descendant,
    `const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
`,
  );
  writeFileSync(
    child,
    `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );

  try {
    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "100", "--", process.execPath, child],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.ok(Date.now() - startedAt < 5_000, "graceful teardown was delayed");
    assert.doesNotMatch(result.stderr, /termination grace expired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
