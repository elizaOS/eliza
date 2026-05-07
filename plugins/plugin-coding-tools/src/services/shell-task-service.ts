import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type IAgentRuntime, Service, logger as coreLogger } from "@elizaos/core";
import { CODING_TOOLS_LOG_PREFIX, SHELL_TASK_SERVICE } from "../types.js";

export interface ShellTaskRecord {
  id: string;
  command: string;
  cwd: string;
  description: string | undefined;
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | undefined;
  status: "running" | "completed" | "failed" | "killed";
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  command: string;
  cwd: string;
  description?: string;
  env?: Record<string, string>;
  shell?: string;
}

const STDOUT_CAP_BYTES = 2_000_000;
const STDERR_CAP_BYTES = 500_000;

/**
 * Tracks backgrounded shell tasks started by BASH(run_in_background=true).
 * TASK_OUTPUT polls or blocks on these; TASK_STOP terminates them.
 *
 * Output is buffered in-memory with a hard cap. Once a task ends, the record
 * is retained for `RECORD_TTL_MS` for late polling, then GC'd.
 */
export class ShellTaskService extends Service {
  static serviceType = SHELL_TASK_SERVICE;
  capabilityDescription = "Background shell task tracking.";

  private tasks = new Map<string, ShellTaskRecord>();
  private procs = new Map<string, ChildProcess>();
  private waiters = new Map<string, Array<() => void>>();
  private gcTimer: NodeJS.Timeout | undefined;

  private readonly RECORD_TTL_MS = 10 * 60 * 1000;

  static async start(runtime: IAgentRuntime): Promise<ShellTaskService> {
    const svc = new ShellTaskService(runtime);
    svc.gcTimer = setInterval(() => svc.gc(), 60_000);
    if (typeof svc.gcTimer.unref === "function") svc.gcTimer.unref();
    coreLogger.debug(`${CODING_TOOLS_LOG_PREFIX} ShellTaskService started`);
    return svc;
  }

  async stop(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    for (const [id, proc] of this.procs) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.tasks.set(id, {
        ...(this.tasks.get(id) as ShellTaskRecord),
        status: "killed",
        endedAt: Date.now(),
      });
    }
    this.procs.clear();
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, rec] of this.tasks) {
      if (rec.endedAt && now - rec.endedAt > this.RECORD_TTL_MS) {
        this.tasks.delete(id);
        this.waiters.delete(id);
      }
    }
  }

  start_(opts: SpawnOptions): ShellTaskRecord {
    const id = `task-${randomUUID().slice(0, 8)}`;
    const shell = opts.shell ?? "/bin/bash";
    const proc = spawn(shell, ["-c", opts.command], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rec: ShellTaskRecord = {
      id,
      command: opts.command,
      cwd: opts.cwd,
      description: opts.description,
      startedAt: Date.now(),
      endedAt: undefined,
      exitCode: undefined,
      status: "running",
      stdout: "",
      stderr: "",
    };
    this.tasks.set(id, rec);
    this.procs.set(id, proc);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (rec.stdout.length + chunk.length <= STDOUT_CAP_BYTES) {
        rec.stdout += chunk.toString("utf8");
      } else {
        rec.stdout += `\n…[stdout cap ${STDOUT_CAP_BYTES} reached]`;
        try {
          proc.stdout?.removeAllListeners("data");
        } catch {
          // ignore
        }
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (rec.stderr.length + chunk.length <= STDERR_CAP_BYTES) {
        rec.stderr += chunk.toString("utf8");
      }
    });
    proc.on("close", (code, signal) => {
      rec.endedAt = Date.now();
      rec.exitCode = typeof code === "number" ? code : null as unknown as number;
      if (signal) rec.status = "killed";
      else if ((typeof code === "number" ? code : 1) === 0) rec.status = "completed";
      else rec.status = "failed";
      this.procs.delete(id);
      const ws = this.waiters.get(id);
      if (ws) {
        for (const w of ws) w();
        this.waiters.delete(id);
      }
    });
    proc.on("error", (err) => {
      rec.stderr += `\n${err.message}`;
      rec.status = "failed";
      rec.endedAt = Date.now();
      this.procs.delete(id);
      const ws = this.waiters.get(id);
      if (ws) {
        for (const w of ws) w();
        this.waiters.delete(id);
      }
    });

    return rec;
  }

  get(taskId: string): ShellTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  list(): ShellTaskRecord[] {
    return [...this.tasks.values()];
  }

  async waitFor(taskId: string, timeoutMs: number): Promise<ShellTaskRecord | undefined> {
    const rec = this.tasks.get(taskId);
    if (!rec) return undefined;
    if (rec.status !== "running") return rec;
    if (timeoutMs <= 0) return rec;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const ws = this.waiters.get(taskId) ?? [];
        const filtered = ws.filter((w) => w !== onResolve);
        this.waiters.set(taskId, filtered);
        resolve(this.tasks.get(taskId));
      }, timeoutMs);
      const onResolve = () => {
        clearTimeout(timer);
        resolve(this.tasks.get(taskId));
      };
      const ws = this.waiters.get(taskId) ?? [];
      ws.push(onResolve);
      this.waiters.set(taskId, ws);
    });
  }

  stop_(taskId: string): boolean {
    const proc = this.procs.get(taskId);
    if (!proc) return false;
    try {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.procs.has(taskId)) {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 2000);
      return true;
    } catch {
      return false;
    }
  }
}
