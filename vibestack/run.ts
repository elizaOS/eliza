// Shared bounded execution for the Quint, TypeScript, test and proof stages.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

// --- running tools -------------------------------------------------------------

const WINDOWS = process.platform === "win32";
/** The most output a tool may write before it is stopped. */
const OUTPUT_LIMIT = 1 << 28;
/** How long a tool may run before it is stopped: long enough that only a tool that hangs is stopped. */
const TOOL_TIMEOUT = 60 * 60 * 1000;

/** The executable named `name` that the PATH finds first. */
export const onPath = (name: string) => (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  .flatMap((dir) => (WINDOWS ? [".exe", ".cmd", ""] : [""]).map((ext) => path.join(dir, name + ext))).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });

/** Installed files as they are: a reinstall writes them again, at a new inode, size or modification or change time, which a copy or an archive cannot set back. */
export const stamp = (files: string[]) => files.map((f) => { const s = fs.statSync(f, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }).join(" ");

/** An executable from the toolchain's dependencies, wherever npm put it: beside the tools, or in the project. */
export function bin(cmd: string, root: string): string {
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
  throw new Error(`${cmd} is not installed; run pnpm install`);
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
  try {
    return await new Promise((resolve, reject) => {
      const child = execFile(quote(exe), args.map(quote), { cwd, env, encoding: "utf8", maxBuffer: OUTPUT_LIMIT, timeout: TOOL_TIMEOUT, shell }, (e, stdout, stderr) => {
        const code = (e as NodeJS.ErrnoException | null)?.code as unknown;
        const stopped = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? `${name} wrote more than ${OUTPUT_LIMIT / 2 ** 20} MB of output and was stopped`
          : e?.killed ? `${name} ran for more than ${TOOL_TIMEOUT / 60_000} minutes and was stopped`
          : e?.signal ? `${name} was killed by ${e.signal} after ${Math.round((Date.now() - started) / 1000)} s`
          : undefined;
        if (typeof code === "string" && !stopped) reject(e);
        else resolve({ status: e ? (typeof code === "number" ? code : -1) : 0, stdout, stderr, stopped });
      });
      // A tool may exit before reading its input; its exit status still reports the failure.
      if (input !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(input); }
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else busy--;
  }
}

/** The process groups `startGroup` started that are still running: an interrupted check ends them before it ends itself. */
const groups = new Set<(name: NodeJS.Signals) => void>();
for (const name of ["SIGINT", "SIGTERM"] as const) process.once(name, () => { for (const signal of groups) signal("SIGKILL"); process.kill(process.pid, name); });

/** A shell command in a process group of its own, so that stopping it stops what it started too; `stop` waits until it has closed. */
export function startGroup(command: string, cwd: string, env?: NodeJS.ProcessEnv) {
  const child = spawn(command, { cwd, env, shell: true, detached: !WINDOWS, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const signal = (name: NodeJS.Signals) => {
    try { if (!WINDOWS && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* already exited */ }
  };
  groups.add(signal);
  void closed.then(() => groups.delete(signal));
  const stop = async () => { signal("SIGTERM"); const timer = setTimeout(() => signal("SIGKILL"), 5000); await closed; clearTimeout(timer); };
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
