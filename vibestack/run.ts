// Shared bounded execution for the Quint, TypeScript, test and proof stages.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { addAbortListener } from "node:events";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

// --- running tools -------------------------------------------------------------

const WINDOWS = process.platform === "win32";
/** The most output a tool may write before it is stopped. */
const OUTPUT_LIMIT = 1 << 28;
/**
 * How much processor time a tool and what it started may use, and how long it may run before a minute in which it uses
 * none stops it: long enough that only a tool that loops or hangs is stopped, however busy the machine is.
 */
const TOOL_TIMEOUT = 60 * 60 * 1000;
/** How often a running tool's processor time is read: each minute. */
const WATCH = 60 * 1000;
const ACCOUNTING_TIMEOUT = 5_000;

/** The executable named `name` that the PATH finds first. */
export const onPath = (name: string) => (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  .flatMap((dir) => (WINDOWS ? [".exe", ".cmd", ""] : [""]).map((ext) => path.join(dir, name + ext))).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });

/** Installed files as they are: a reinstall writes them again, at a new inode, size or modification or change time, which a copy or an archive cannot set back. */
export const stamp = (files: string[]) => files.map((f) => { const s = fs.statSync(f, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }).join(" ");

/** An executable from the toolchain's dependencies, wherever npm put it: beside the tools, or in the project. */
export function findBin(cmd: string, root: string): string | undefined {
  // On Windows pnpm installs a `.cmd` shim beside the extensionless shell script, and only the shim runs there.
  const name = WINDOWS ? `${cmd}.cmd` : cmd;
  for (let dir of [path.join(import.meta.dirname, ".."), root]) {
    for (;;) {
      const candidate = path.join(dir, "node_modules/.bin", name);
      if (fs.existsSync(candidate)) return candidate;
      if (dir === path.dirname(dir)) break;
      dir = path.dirname(dir);
    }
  }
  return undefined;
}
export function bin(cmd: string, root: string): string {
  const exe = findBin(cmd, root);
  if (exe) return exe;
  throw new Error(`${cmd} is not installed; run pnpm install`);
}

/** `[[days-]hours:]minutes:seconds` as seconds. */
const seconds = (time = "0") => { const [days, clock] = time.includes("-") ? time.split("-") : ["0", time]; return Number(days) * 86400 + clock.split(":").reduce((sum, part) => sum * 60 + Number(part), 0); };

/** Every process as its id, its parent's, its group's and the processor seconds it has used. */
const psArgs = ["-Ao", "pid=,ppid=,pgid=,time="];
const processTable = (output: string) => output.trim().split("\n").filter(Boolean).map((line) => {
  const [pid, parent, group, time] = line.trim().split(/\s+/);
  return [Number(pid), Number(parent), Number(group), seconds(time)];
});
function processes() {
  if (WINDOWS) return [];
  const snapshot = spawnSync("ps", psArgs, { encoding: "utf8", timeout: ACCOUNTING_TIMEOUT, killSignal: "SIGKILL" });
  return snapshot.status === 0 && !snapshot.error ? processTable(snapshot.stdout) : [];
}

async function readCounters(command: string, args: string[], stopSignal: AbortSignal) {
  if (stopSignal.aborted) return "";
  return new Promise<string>((resolve) => {
    let child: ChildProcess;
    try { child = spawn(command, args, { detached: !WINDOWS, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve(""); return; }
    endsWithTheCheck(child, "SIGKILL");
    const chunks: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, finished = false;
    const finish = (value: string) => {
      if (finished) return;
      finished = true;
      cancellation[Symbol.dispose]();
      chunks.length = 0;
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(value);
    };
    const stop = () => {
      if (finished) return;
      finish("");
      signal(child, "SIGKILL");
      child.unref();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (finished) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > 1 << 20) stop();
      else chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (finished) return;
      stderrBytes += chunk.length;
      if (stderrBytes > 1 << 20) stop();
    });
    child.on("error", stop);
    child.once("close", (code) => finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : ""));
    const cancellation = addAbortListener(stopSignal, stop);
  });
}

/** The processes in `table` that `child` started, itself included. */
function startedBy(child: ChildProcess, table: number[][]) {
  const started = new Set([child.pid]);
  const ordered = table.filter(([pid]) => pid === child.pid);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of table) {
      const [pid, parent] = row;
      if (!started.has(parent) || started.has(pid)) continue;
      started.add(pid);
      ordered.push(row);
      grew = true;
    }
  }
  return ordered;
}

const darwinCpu = `ObjC.import("Foundation");
ObjC.bindFunction("proc_pid_rusage", ["int", ["int", "int", "void *"]]);
ObjC.bindFunction("mach_timebase_info", ["int", ["void *"]]);
function run(pids) {
  const clock = $.NSMutableData.dataWithLength(8), usage = $.NSMutableData.dataWithLength(144);
  if ($.mach_timebase_info(clock.mutableBytes) !== 0) throw Error("mach_timebase_info failed");
  return [ObjC.unwrap(clock.base64EncodedStringWithOptions(0)), ...pids.map(pid =>
    $.proc_pid_rusage(Number(pid), 1, usage.mutableBytes) === 0 ? ObjC.unwrap(usage.base64EncodedStringWithOptions(0)) : "-"
  )].join("\\n");
}`;

let linuxTicksPerSecond: number | undefined;
async function cpuCounters(pids: number[], table: number[][], signal: AbortSignal) {
  const readings = new Map<number, number>();
  if (!pids.length) return readings;
  if (process.platform === "darwin") {
    const output = await readCounters("/usr/bin/osascript", ["-l", "JavaScript", "-e", darwinCpu, ...pids.map(String)], signal);
    const [first, ...rows] = output.trim().split("\n");
    const clock = Buffer.from(first, "base64");
    if (clock.length !== 8 || !clock.readUInt32LE(4) || rows.length !== pids.length) return readings;
    const secondsPerTick = clock.readUInt32LE(0) / clock.readUInt32LE(4) / 1e9;
    for (const [index, row] of rows.entries()) {
      const usage = Buffer.from(row, "base64");
      if (usage.length !== 144) continue;
      const own = usage.readBigUInt64LE(16) + usage.readBigUInt64LE(24);
      const reaped = usage.readBigUInt64LE(96) + usage.readBigUInt64LE(104);
      readings.set(pids[index], Number(own + reaped) * secondsPerTick);
    }
  } else if (process.platform === "linux") {
    if (linuxTicksPerSecond === undefined) {
      const rate = Number(await readCounters("getconf", ["CLK_TCK"], signal));
      if (!(rate > 0)) return readings;
      linuxTicksPerSecond = rate;
    }
    const rate = linuxTicksPerSecond;
    for (const pid of pids) {
      try {
        const stat = await fs.promises.readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal });
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = fields.slice(11, 15).map(Number);
        if (ticks.length === 4 && ticks.every(Number.isFinite)) readings.set(pid, ticks.reduce((sum, n) => sum + n, 0) / rate);
      } catch { continue; }
    }
  } else {
    for (const [pid, , , time] of table) readings.set(pid, time);
  }
  return readings;
}

type CpuReading = { seconds: number; complete: true } | { seconds: number; complete: false; known: Map<number, number> };

export async function toolCpuSeconds(children: ChildProcess[], signal?: AbortSignal): Promise<(CpuReading | undefined)[]> {
  const deadline = AbortSignal.timeout(WATCH);
  const observation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const table = processTable(await readCounters("ps", psArgs, observation));
  const trees = children.map(child => {
    const leader = child.exitCode === null && child.signalCode === null ? child.pid : undefined;
    const rows = leader === undefined ? table.filter(([, , group]) => group === child.pid) : startedBy(child, table);
    return { leader, pids: rows.map(([pid]) => pid) };
  });
  const counters = await cpuCounters([...new Set(trees.flatMap(tree => tree.pids))], table, observation);
  return trees.map(({ leader, pids }) => {
    if (leader !== undefined && !counters.has(leader)) return undefined;
    const known = new Map<number, number>();
    let seconds = 0, lowerBound = 0;
    for (const pid of pids) {
      const used = counters.get(pid);
      if (used === undefined) continue;
      known.set(pid, used);
      seconds += used;
      lowerBound = Math.max(lowerBound, used);
    }
    if (!known.size) return undefined;
    if (leader !== undefined && known.size === pids.length) return { seconds, complete: true };
    return { seconds: lowerBound, complete: false, known };
  });
}

type CpuRetry = { confirm: () => Promise<CpuReading | undefined>; cleanupTable: () => number[][] };
type CpuWatcher = (reading: CpuReading | undefined, retry: CpuRetry) => Promise<void>;
const watched = new Map<ChildProcess, CpuWatcher>();
let watchTimer: NodeJS.Timeout | undefined;
let polling: AbortController | undefined;
function watchCpu(child: ChildProcess, check: CpuWatcher) {
  watched.set(child, check);
  watchTimer ??= setInterval(async () => {
    if (polling) return;
    const cycle = new AbortController();
    polling = cycle;
    try {
      const jobs = [...watched];
      const children = jobs.map(([job]) => job);
      const readings = WINDOWS ? [] : await toolCpuSeconds(children, cycle.signal);
      let confirmed: ReturnType<typeof toolCpuSeconds> | undefined;
      let table: ReturnType<typeof processes> | undefined;
      const cleanupTable = () => table ??= processes();
      await Promise.all(jobs.flatMap(([job, report], index) => watched.has(job) ? [report(readings[index], {
        confirm: async () => (await (confirmed ??= toolCpuSeconds(children, cycle.signal)))[index],
        cleanupTable,
      })] : []));
    } finally { polling = undefined; }
  }, WATCH);
  return () => {
    watched.delete(child);
    if (!watched.size) {
      polling?.abort();
      clearInterval(watchTimer);
      watchTimer = undefined;
    }
  };
}

/** Signal the process group of `child`, and of each process in `table` that it started: a browser leaves the group of the tool that started it. */
function signal(child: ChildProcess, name: NodeJS.Signals, table: number[][] = []) {
  const own = table.find(([pid]) => pid === process.pid)?.[2];
  const groups = new Set([child.pid, ...startedBy(child, table).flatMap(([, , group]) => group === own ? [] : [group])]);
  for (const group of groups) {
    try { if (!WINDOWS && group) process.kill(-group, name); else child.kill(name); } catch { /* already exited */ }
  }
}

/** How each tool still running is ended: an interrupted check ends them and what they started before it ends itself, and so does one that exits. A tool is asked to end, so that one that is a check ends its own tools; a shell command is killed. */
const ending = new Map<ChildProcess, NodeJS.Signals>();
const endAll = () => {
  polling?.abort();
  const table = ending.size ? processes() : [];
  for (const [child, name] of ending) signal(child, name, table);
};
process.once("exit", endAll);
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, () => { endAll(); process.kill(process.pid, name); });

function endsWithTheCheck(child: ChildProcess, name: NodeJS.Signals) {
  ending.set(child, name);
  for (const over of ["close", "error"] as const) child.once(over, () => ending.delete(child));
}

export function startAttached(exe: string, args: string[], cwd: string) {
  const child = spawn(exe, args, { cwd, stdio: "inherit", detached: !WINDOWS });
  endsWithTheCheck(child, "SIGTERM");
  return child;
}

/** How many programs run at once; the others wait for one to end. */
const SLOTS = availableParallelism();
let busy = 0;
const waiting = new Set<() => void>();

function waitForSlot(signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((settle) => {
    const grant = () => {
      subscription?.[Symbol.dispose]();
      settle(true);
    };
    const subscription = signal && addAbortListener(signal, () => {
      if (waiting.delete(grant)) settle(false);
    });
    waiting.add(grant);
  });
}

function releaseSlot() {
  for (const next of waiting) {
    waiting.delete(next);
    next();
    return;
  }
  busy--;
}

/**
 * Run a program to the end, once fewer than SLOTS are running, and return what it wrote. One that cannot be started
 * is an error; one that writes too much, runs too long or is killed by a signal is stopped, and `stopped` says so.
 */
export async function exec(exe: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string, cancellation?: AbortSignal): Promise<{ status: number; stdout: string; stderr: string; stopped?: string }> {
  const canceled = { status: -1, stdout: "", stderr: "", stopped: "proof work was canceled after simulation failed" };
  if (cancellation?.aborted) return canceled;
  if (busy < SLOTS) busy++;
  else if (!await waitForSlot(cancellation)) return canceled;
  // On Windows anything but an .exe (an npm .cmd shim, or a name on the PATH) needs a shell, which reads each argument quoted for cmd.exe.
  const shell = WINDOWS && !/\.exe$/i.test(exe);
  const quote = (a: string) => (shell && (a === "" || /[\s"&|<>^%()!,;=]/.test(a)) ? `"${a.replace(/"/g, '""')}"` : a);
  const name = path.basename(exe).replace(/\.cmd$/, "");
  const started = Date.now();
  let unwatch: (() => void) | undefined;
  let unabort: Disposable | undefined;
  try {
    if (cancellation?.aborted) return canceled;
    return await new Promise((resolve, reject) => {
      const child = spawn(quote(exe), args.map(quote), { cwd, env, shell, detached: !WINDOWS });
      endsWithTheCheck(child, "SIGTERM");
      const output = { stdout: "", stderr: "" };
      let stopped: string | undefined;
      const stop = (why: string, table = processes()) => {
        stopped ??= `${name} ${why} and was stopped`;
        signal(child, "SIGKILL", table);
        child.stdout.destroy();
        child.stderr.destroy();
      };
      if (cancellation && !WINDOWS) unabort = addAbortListener(cancellation, () => stop("was canceled after simulation failed"));
      const minutes = TOOL_TIMEOUT / 60_000;
      let lastComplete: { seconds: number; since: number } | undefined;
      let observedAt = started;
      const partialHigh = new Map<number, number>();
      const observe = (sample: CpuReading | undefined, now: number) => {
        if (!sample) return;
        if (sample.complete) {
          observedAt = now;
          partialHigh.clear();
        } else {
          for (const [pid, used] of sample.known) {
            const previous = partialHigh.get(pid);
            if (previous === undefined || used > previous) {
              partialHigh.set(pid, used);
              if (previous !== undefined) observedAt = now;
            }
          }
        }
      };
      unwatch = watchCpu(child, async (reading, retry) => {
        const now = Date.now(), ran = now - started;
        const sample: CpuReading | undefined = WINDOWS ? { seconds: ran / 1000, complete: true } : reading;
        observe(sample, now);
        if (!sample?.complete) lastComplete = undefined;
        else if (lastComplete?.seconds !== sample.seconds) lastComplete = { seconds: sample.seconds, since: now };
        const over = (sample?.seconds ?? 0) * 1000 > TOOL_TIMEOUT;
        const idle = ran > TOOL_TIMEOUT && lastComplete !== undefined && now - lastComplete.since >= WATCH;
        if (!over && !idle && now - observedAt <= TOOL_TIMEOUT) return;
        const confirmed = WINDOWS ? sample : await retry.confirm();
        if (!watched.has(child)) return;
        observe(confirmed, Date.now());
        if (over && confirmed && confirmed.seconds * 1000 > TOOL_TIMEOUT) stop(`used more than ${minutes} minutes of processor time`, retry.cleanupTable());
        else if (idle && confirmed?.complete && confirmed.seconds === sample?.seconds) stop(`ran for more than ${minutes} minutes, the last minute without the processor,`, retry.cleanupTable());
        else if (Date.now() - observedAt > TOOL_TIMEOUT) stop(`had no complete processor accounting or measurable progress for ${minutes} minutes`, retry.cleanupTable());
      });
      for (const stream of ["stdout", "stderr"] as const) child[stream].setEncoding("utf8").on("data", (chunk: string) => {
        if (output[stream].length > OUTPUT_LIMIT) return;
        output[stream] += chunk;
        if (output[stream].length > OUTPUT_LIMIT) stop(`wrote more than ${OUTPUT_LIMIT / 2 ** 20} MB of output`);
      });
      child.once("error", reject);
      child.once("exit", (_, by) => { if (by) signal(child, "SIGKILL"); });
      child.once("close", (code, by) => {
        unabort?.[Symbol.dispose]();
        unabort = undefined;
        resolve({ status: code ?? -1, ...output, stopped: stopped ?? (by ? `${name} was killed by ${by} after ${Math.round((Date.now() - started) / 1000)} s` : undefined) });
      });
      // A tool may exit before reading its input; its exit status still reports the failure.
      if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    });
  } finally {
    unabort?.[Symbol.dispose]();
    unwatch?.();
    releaseSlot();
  }
}

/** A shell command in a process group of its own, so that stopping it stops what it started too; `stop` waits until it has closed. */
export function startGroup(command: string, cwd: string, env?: NodeJS.ProcessEnv) {
  const child = spawn(command, { cwd, env, shell: true, detached: !WINDOWS, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  endsWithTheCheck(child, "SIGKILL");
  const stop = async () => { signal(child, "SIGTERM"); const timer = setTimeout(() => signal(child, "SIGKILL"), 5000); await closed; clearTimeout(timer); };
  return { child, closed, stop };
}

/** What the proof stage needs installed. */
export const NEEDS_DAFNY = "the proof stage needs Dafny 4.11 on the PATH: https://github.com/dafny-lang/dafny/releases";

/** Run a tool from the toolchain, or Dafny, and return whether it succeeded and all it wrote. */
export async function run(cmd: string, args: string[], cwd: string, input?: string): Promise<{ ok: boolean; out: string; status: number; stderr: string }> {
  const exe = cmd === "dafny" ? cmd : bin(cmd, cwd);
  const r = await exec(exe, args, cwd, undefined, input).catch((e: Error) => {
    throw new Error(`${cmd} could not be run (${exe}): ${e.message}${cmd === "dafny" ? `; ${NEEDS_DAFNY}` : "; run pnpm install"}`);
  });
  return { ok: r.status === 0 && !r.stopped, out: `${r.stdout}${r.stderr}${r.stopped ? `\n${r.stopped}\n` : ""}`, status: r.status, stderr: r.stderr };
}
