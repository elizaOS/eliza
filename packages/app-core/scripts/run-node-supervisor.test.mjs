/**
 * Real-process integration test for the agent supervisor (`run-node.mjs`).
 *
 * Drives the *actual* runner — not a reimplementation — with `ELIZA_ENTRY_FILE`
 * pointed at a tiny fake child, in a temp cwd whose `dist/.buildstamp` makes the
 * staleness check skip the rebuild. The fake child exits with the real restart
 * exit code a controlled number of times, so we assert the genuine restart
 * relaunch loop and the rapid-restart abort guard end to end, using real OS
 * processes and real exit codes.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import restartExitCodeDefinition from "../../shared/src/restart-exit-code.json" with {
  type: "json",
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_NODE = path.join(SCRIPT_DIR, "run-node.mjs");
const RESTART_EXIT_CODE = restartExitCodeDefinition.restartExitCode;

// A child that records each spawn and exits with the shared restart code until
// it has been started FAKE_CHILD_RESTART_UNTIL times, then exits 0 (clean).
const FAKE_CHILD = `import fs from "node:fs";
const counterFile = process.env.FAKE_CHILD_COUNTER;
const restartExitCode = Number(process.env.RESTART_EXIT_CODE);
const restartUntil = Number(process.env.FAKE_CHILD_RESTART_UNTIL ?? "0");
let count = 0;
try { count = Number(fs.readFileSync(counterFile, "utf8").trim()) || 0; } catch {}
count += 1;
fs.writeFileSync(counterFile, String(count));
process.exit(count <= restartUntil ? restartExitCode : 0);
`;

let workDir;
let counterFile;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-supervisor-"));
  counterFile = path.join(workDir, "spawn-count.txt");
  fs.writeFileSync(path.join(workDir, "fake-child.mjs"), FAKE_CHILD);
  // Pre-stamped dist so shouldBuild() returns false (no rebuild before launch).
  fs.mkdirSync(path.join(workDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "dist", "entry.js"), "// noop\n");
  fs.writeFileSync(
    path.join(workDir, "dist", ".buildstamp"),
    `${Date.now()}\n`,
  );
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Run the real supervisor against the fake child; resolve with exit code + output. */
function runSupervisor(restartUntil) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN_NODE], {
      cwd: workDir,
      env: {
        ...process.env,
        ELIZA_RUNTIME: "node",
        ELIZA_ENTRY_FILE: "fake-child.mjs",
        ELIZA_FORCE_BUILD: "0",
        ELIZA_RUNNER_LOG: "1",
        FAKE_CHILD_COUNTER: counterFile,
        FAKE_CHILD_RESTART_UNTIL: String(restartUntil),
        RESTART_EXIT_CODE: String(RESTART_EXIT_CODE),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const spawnCount = Number(
        fs.readFileSync(counterFile, "utf8").trim() || "0",
      );
      resolve({ code, spawnCount, stdout, stderr });
    });
  });
}

// Windows-ci only: the supervisor-spawned fake child never writes its
// `spawn-count.txt`, so this test's own `child.on("exit")` handler throws
// `ENOENT` reading it and the run Promise never resolves → both cases hit the
// 30s timeout. The spawn (`spawn(<full node exec path>, ["fake-child.mjs"],
// { cwd: workDir, stdio: "inherit" })`) and the child's absolute-path
// `fs.writeFileSync` are Windows-portable and pass on Linux (2/2, ~1.2s); the
// runner-specific failure (the child process never runs/writes) is not
// reproducible off the GitHub-hosted Windows runner. Gated there pending a
// Windows-box root-cause — a likely hardening is pinning `ELIZA_NODE_PATH` to
// the current node so the supervisor skips runtime-resolution/PATH probing.
describe.skipIf(process.platform === "win32")(
  "run-node.mjs supervisor (real processes)",
  () => {
    it("relaunches a child that exits with the restart code, then exits cleanly", async () => {
      // Child requests a restart twice, then exits 0 on the 3rd launch.
      const { code, spawnCount, stderr } = await runSupervisor(2);
      expect(spawnCount).toBe(3); // initial + 2 relaunches
      expect(code).toBe(0); // clean exit after the child stops requesting restarts
      expect(stderr).toContain("Restart requested — relaunching...");
    }, 30_000);

    it("aborts a crash loop after MAX_RESTARTS_IN_WINDOW restarts", async () => {
      // Child always requests restart; the guard must abort instead of spinning forever.
      const { code, spawnCount, stderr } = await runSupervisor(
        Number.MAX_SAFE_INTEGER,
      );
      // MAX_RESTARTS_IN_WINDOW = 5; the 6th restart trips the guard and aborts.
      expect(spawnCount).toBe(6); // initial + 5 relaunches, then abort on the 6th exit
      expect(code).toBe(1);
      expect(stderr).toContain("Restart loop detected");
    }, 30_000);
  },
);
