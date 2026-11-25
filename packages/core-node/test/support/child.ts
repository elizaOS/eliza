// spec/core/atomicWriters.md, "Story: Publish whole snapshots despite interleaved processes"; spec/core/logging/files.md, "Story: Open optional log files lazily and close their descriptors"; spec/core/catalog.md, "Story: Discover and register first-party capabilities"
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";

export const coreNodeDir = path.resolve(import.meta.dirname, "../..");
export const coreDir = path.resolve(coreNodeDir, "../core");

export interface ChildRun {
  readonly file?: string;
  readonly script?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly vibe?: boolean;
}

export interface ChildExit {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Child {
  readonly exited: Promise<ChildExit>;
  output(text: string): Promise<void>;
  kill(signal: NodeJS.Signals): void;
}

export function spawnNode(run: ChildRun): Child {
  const entry = run.script === undefined ? [run.file ?? ""] : ["--input-type=module", "--eval", run.script, "--"];
  const argv = ["--no-warnings", ...(run.vibe ? ["--conditions", "eliza-source", "--import", "vibelang/register"] : []), ...entry, ...(run.args ?? [])];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(run.env ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const child = spawn(process.execPath, argv, { cwd: run.cwd ?? coreNodeDir, env, stdio: ["ignore", "pipe", "pipe"], timeout: run.timeoutMs ?? 60_000, killSignal: "SIGKILL" });
  const printed = { stdout: "", stderr: "" };
  const awaiting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    printed.stdout += chunk;
    for (const [text, waiter] of awaiting) if (printed.stdout.includes(text)) {
      awaiting.delete(text);
      waiter.resolve();
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    printed.stderr += chunk;
  });
  const exited = new Promise<ChildExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      for (const [text, waiter] of awaiting) waiter.reject(new Error(`the child exited before printing ${JSON.stringify(text)}: ${printed.stderr}`));
      awaiting.clear();
      resolve({ status, signal, stdout: printed.stdout, stderr: printed.stderr });
    });
  });
  return {
    exited,
    output: (text) => printed.stdout.includes(text) ? Promise.resolve()
      : child.exitCode !== null || child.signalCode !== null ? Promise.reject(new Error(`the child already exited: ${printed.stderr}`))
      : new Promise<void>((resolve, reject) => { awaiting.set(text, { resolve, reject }); }),
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

export function runNode(run: ChildRun): Promise<ChildExit> {
  return spawnNode(run).exited;
}

export async function catalogWorkspace(work: string): Promise<{ root: string; sourceDir: string; catalog: string }> {
  const root = path.join(await realpath(work), "producer");
  const sourceDir = path.join(root, "packages/core-node");
  const catalog = path.join(root, "packages/core/src/catalog");
  const workspace = path.resolve(coreNodeDir, "../..");
  await mkdir(sourceDir, { recursive: true });
  await cp(path.join(workspace, "tsconfig.base.json"), path.join(root, "tsconfig.base.json"));
  for (const name of await readdir(coreNodeDir)) {
    if (name === "package.json" || /^tsconfig(?:\..+)?\.json$/.test(name)) await cp(path.join(coreNodeDir, name), path.join(sourceDir, name));
  }
  await cp(path.join(coreNodeDir, "src"), path.join(sourceDir, "src"), { recursive: true });
  await cp(path.join(coreDir, "src/catalog"), catalog, { recursive: true });
  await symlink(await realpath(path.join(workspace, "node_modules")), path.join(root, "node_modules"), "dir");
  await symlink(await realpath(path.join(coreNodeDir, "node_modules")), path.join(sourceDir, "node_modules"), "dir");
  return { root, sourceDir, catalog };
}
