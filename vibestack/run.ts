// Shared bounded execution for the Quint, TypeScript, test and proof stages.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
const processes = () => WINDOWS ? [] : (spawnSync("ps", ["-Ao", "pid=,ppid=,pgid=,time="], { encoding: "utf8" }).stdout ?? "").trim().split("\n").map((line) => {
  const [pid, parent, group, time] = line.trim().split(/\s+/);
  return [Number(pid), Number(parent), Number(group), seconds(time)];
});

/** The processes in `table` that `child` started, itself included. */
function startedBy(child: ChildProcess, table: number[][]) {
  const started = new Set([child.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, parent] of table) if (started.has(parent) && !started.has(pid)) { started.add(pid); grew = true; }
  }
  return table.filter(([pid]) => started.has(pid));
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
const endAll = () => { const table = ending.size ? processes() : []; for (const [child, name] of ending) signal(child, name, table); };
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
const waiting: (() => void)[] = [];

/**
 * Run a program to the end, once fewer than SLOTS are running, and return what it wrote. One that cannot be started
 * is an error; one that writes too much, runs too long or is killed by a signal is stopped, and `stopped` says so.
 */
export async function exec(exe: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string): Promise<{ status: number; stdout: string; stderr: string; stopped?: string }> {
  if (busy < SLOTS) busy++;
  else await new Promise<void>((go) => waiting.push(go));
  // On Windows anything but an .exe (an npm .cmd shim, or a name on the PATH) needs a shell, which reads each argument quoted for cmd.exe.
  const shell = WINDOWS && !/\.exe$/i.test(exe);
  const quote = (a: string) => (shell && (a === "" || /[\s"&|<>^%()!,;=]/.test(a)) ? `"${a.replace(/"/g, '""')}"` : a);
  const name = path.basename(exe).replace(/\.cmd$/, "");
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(quote(exe), args.map(quote), { cwd, env, shell, detached: !WINDOWS });
      endsWithTheCheck(child, "SIGTERM");
      const output = { stdout: "", stderr: "" };
      let stopped: string | undefined;
      const stop = (why: string) => { stopped ??= `${name} ${why} and was stopped`; signal(child, "SIGKILL", processes()); };
      const minutes = TOOL_TIMEOUT / 60_000;
      let used = 0;
      timer = setInterval(() => {
        const ran = Date.now() - started, before = used;
        used = WINDOWS ? ran : 1000 * startedBy(child, processes()).reduce((sum, [, , , time]) => sum + time, 0);
        if (used > TOOL_TIMEOUT) stop(`used more than ${minutes} minutes of processor time`);
        else if (ran > TOOL_TIMEOUT && used <= before) stop(`ran for more than ${minutes} minutes, the last minute without the processor,`);
      }, WATCH);
      for (const stream of ["stdout", "stderr"] as const) child[stream].setEncoding("utf8").on("data", (chunk: string) => {
        if (output[stream].length > OUTPUT_LIMIT) return;
        output[stream] += chunk;
        if (output[stream].length > OUTPUT_LIMIT) stop(`wrote more than ${OUTPUT_LIMIT / 2 ** 20} MB of output`);
      });
      child.once("error", reject);
      child.once("exit", (_, by) => { if (by) signal(child, "SIGKILL"); });
      child.once("close", (code, by) => resolve({ status: code ?? -1, ...output, stopped: stopped ?? (by ? `${name} was killed by ${by} after ${Math.round((Date.now() - started) / 1000)} s` : undefined) }));
      // A tool may exit before reading its input; its exit status still reports the failure.
      if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    });
  } finally {
    clearInterval(timer);
    const next = waiting.shift();
    if (next) next();
    else busy--;
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
