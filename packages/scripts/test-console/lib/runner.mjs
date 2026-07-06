/**
 * Run orchestrator for the test console: executes selected plan tasks as
 * child processes, streams status transitions to subscribers, and persists
 * every byte of output under the console state dir.
 *
 * Each task runs as its own `run-all-tests.mjs --filter='^<label>$'`
 * invocation rather than one big sweep. That keeps full parity with CI lane
 * semantics (lane env, Postgres auto-provision, empty-suite skip logic live
 * in run-all-tests, not here) while giving the console per-task exit codes,
 * per-task logs, targeted re-runs, and cancellation. Discovery costs ~0.2s
 * per spawn — noise against real suite runtimes.
 *
 * Result classification: run-all-tests prints `[eliza-test] PASS/SKIP/FAIL
 * <label>` lines. A self-skipping task exits 3 (the vacuous-green floor with
 * --min-tasks=1), so classification parses the log tail first and only falls
 * back to the exit code — exit 0 alone is not proof a test ran.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./registry.mjs";
import {
  newRunDir,
  recordTaskStatus,
  runLogPath,
  saveRunManifest,
} from "./store.mjs";

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function taskSlug(label) {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

const CLOUD_LABEL = "cloud#test";

export class RunManager extends EventEmitter {
  constructor() {
    super();
    this.current = null;
  }

  isRunning() {
    return Boolean(this.current && !this.current.finished);
  }

  /**
   * Start a run over the given plan tasks. `lane` is "pr" (deterministic,
   * keyless) or "live" (post-merge semantics). Extra env carries saved
   * credentials + opt-in gates; it is injected only into child processes,
   * never into this server's own process.env.
   */
  startRun({ tasks, lane = "pr", extraEnv = {}, concurrency = 3 }) {
    if (this.isRunning()) throw new Error("a run is already in progress");
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${lane}`;
    newRunDir(runId);

    const entries = tasks.map((task) => ({
      label: task.label,
      relativeDir: task.relativeDir,
      scriptName: task.scriptName,
      parallelSafe: Boolean(task.parallelSafe) && lane === "pr",
      status: "queued",
      exitCode: null,
      durationMs: null,
      startedAt: null,
      finishedAt: null,
      log: path.relative(REPO_ROOT, runLogPath(runId, taskSlug(task.label))),
    }));

    const run = {
      runId,
      lane,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      cancelled: false,
      finished: false,
      tasks: entries,
      children: new Set(),
    };
    this.current = run;
    this.persist();
    this.emit("event", {
      type: "run-started",
      runId,
      lane,
      total: entries.length,
    });

    void this.drive(run, { extraEnv, concurrency }).catch((error) => {
      this.emit("event", {
        type: "run-error",
        runId,
        message: String(error?.message ?? error),
      });
    });
    return runId;
  }

  async drive(run, { extraEnv, concurrency }) {
    const queue = [...run.tasks];
    const parallel = queue.filter(
      (t) => t.parallelSafe && t.label !== CLOUD_LABEL,
    );
    const serial = queue.filter(
      (t) => !t.parallelSafe || t.label === CLOUD_LABEL,
    );

    const workers = Array.from(
      { length: Math.max(1, Math.min(concurrency, parallel.length || 1)) },
      async () => {
        while (parallel.length > 0 && !run.cancelled) {
          const entry = parallel.shift();
          await this.executeTask(run, entry, extraEnv);
        }
      },
    );
    await Promise.all(workers);
    for (const entry of serial) {
      if (run.cancelled) break;
      await this.executeTask(run, entry, extraEnv);
    }

    for (const entry of run.tasks) {
      if (entry.status === "queued") entry.status = "cancelled";
    }
    run.finished = true;
    run.finishedAt = new Date().toISOString();
    this.persist();
    this.emit("event", {
      type: "run-finished",
      runId: run.runId,
      cancelled: run.cancelled,
      counts: countStatuses(run.tasks),
    });
  }

  buildCommand(entry, lane) {
    if (entry.label === CLOUD_LABEL) {
      return { cmd: "bun", args: ["run", "test:cloud"] };
    }
    const args = [
      "packages/scripts/run-all-tests.mjs",
      `--filter=^${escapeRegex(entry.label)}$`,
      "--min-tasks=1",
      "--no-cloud",
    ];
    // Non-`test` scripts (test:e2e, test:live, …) need --all so the extra
    // script lanes are collected; plain `test` stays scoped to --only=test.
    args.push(entry.scriptName === "test" ? "--only=test" : "--all");
    return { cmd: process.execPath, args };
  }

  laneEnv(lane) {
    if (lane === "live") {
      return {
        TEST_LANE: "post-merge",
        ELIZA_LIVE_TEST: "1",
        ELIZA_REAL_APIS: "1",
      };
    }
    return {
      TEST_LANE: "pr",
      ELIZA_LIVE_TEST: "0",
      SCENARIO_USE_LLM_PROXY: "1",
    };
  }

  executeTask(run, entry, extraEnv) {
    return new Promise((resolvePromise) => {
      const logFile = path.join(REPO_ROOT, entry.log);
      const logStream = fs.createWriteStream(logFile);
      const { cmd, args } = this.buildCommand(entry, run.lane);
      entry.status = "running";
      entry.startedAt = new Date().toISOString();
      this.persist();
      this.emit("event", {
        type: "task",
        runId: run.runId,
        label: entry.label,
        status: "running",
      });

      const started = Date.now();
      // Own process group so cancel can kill the whole spawn tree (vitest
      // workers, browsers, emulators) rather than just the wrapper.
      const child = spawn(cmd, args, {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...this.laneEnv(run.lane),
          ...extraEnv,
          FORCE_COLOR: "0",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      run.children.add(child);

      let tail = "";
      const capture = (chunk) => {
        logStream.write(chunk);
        tail = (tail + chunk.toString()).slice(-16_384);
        this.emit("event", {
          type: "log",
          runId: run.runId,
          label: entry.label,
          chunk: chunk.toString(),
        });
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);

      child.once("close", (code, signal) => {
        run.children.delete(child);
        logStream.end();
        entry.exitCode = code;
        entry.durationMs = Date.now() - started;
        entry.finishedAt = new Date().toISOString();
        entry.status = classifyResult({
          label: entry.label,
          code,
          signal,
          tail,
          cancelled: run.cancelled,
        });
        recordTaskStatus(entry.label, {
          status: entry.status,
          runId: run.runId,
          at: entry.finishedAt,
          durationMs: entry.durationMs,
        });
        this.persist();
        this.emit("event", {
          type: "task",
          runId: run.runId,
          label: entry.label,
          status: entry.status,
          exitCode: code,
          durationMs: entry.durationMs,
        });
        resolvePromise();
      });
    });
  }

  cancel() {
    const run = this.current;
    if (!run || run.finished) return false;
    run.cancelled = true;
    for (const child of run.children) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // error-policy:J6 best-effort teardown — the group may already be gone.
      }
    }
    this.emit("event", { type: "run-cancelling", runId: run.runId });
    return true;
  }

  persist() {
    const run = this.current;
    if (!run) return;
    saveRunManifest(run.runId, {
      runId: run.runId,
      lane: run.lane,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      cancelled: run.cancelled,
      counts: countStatuses(run.tasks),
      tasks: run.tasks.map(
        ({
          label,
          relativeDir,
          scriptName,
          status,
          exitCode,
          durationMs,
          startedAt,
          finishedAt,
          log,
        }) => ({
          label,
          relativeDir,
          scriptName,
          status,
          exitCode,
          durationMs,
          startedAt,
          finishedAt,
          log,
        }),
      ),
    });
  }

  snapshot() {
    const run = this.current;
    if (!run) return null;
    return {
      runId: run.runId,
      lane: run.lane,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      cancelled: run.cancelled,
      finished: run.finished,
      counts: countStatuses(run.tasks),
      tasks: run.tasks.map(({ label, status, exitCode, durationMs }) => ({
        label,
        status,
        exitCode,
        durationMs,
      })),
    };
  }
}

export function classifyResult({ label, code, signal, tail, cancelled }) {
  if (cancelled) return "cancelled";
  if (signal) return "failed";
  const labelPattern = escapeRegex(label);
  if (new RegExp(`\\[eliza-test\\] FAIL ${labelPattern}`).test(tail))
    return "failed";
  if (new RegExp(`\\[eliza-test\\] PASS ${labelPattern}`).test(tail))
    return "passed";
  if (new RegExp(`\\[eliza-test\\] SKIP ${labelPattern}`).test(tail))
    return "skipped";
  // Exit 3 is run-all-tests' vacuous-green floor: the only task collected
  // self-skipped. Anything else nonzero without a status line is a failure.
  if (code === 3) return "skipped";
  return code === 0 ? "passed" : "failed";
}

export function countStatuses(tasks) {
  const counts = {};
  for (const task of tasks)
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}
