// spec/core/release.md, "Story: Install the replacement through existing npm entry points"; spec/core/release.md, "Every release check names the candidate it actually examined"; spec/core/atomicWriters.md, "Story: Publish whole snapshots despite interleaved processes"
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface NodeRun {
  file?: string;
  script?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  vibe?: boolean;
}

export interface NodeResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface NodeChild {
  readonly pid: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly exited: Promise<NodeResult>;
  kill(signal?: NodeJS.Signals): void;
  output(text: string): Promise<void>;
}

export interface Packed {
  tarball: string;
  sha256: string;
  remove(): Promise<void>;
}

export const coreDir = path.resolve(import.meta.dirname, "../..");

const run = promisify(execFile);

function nodeArguments(options: NodeRun): string[] {
  const loader = options.vibe ? ["--import", "vibelang/register"] : [];
  if (options.file !== undefined && options.script === undefined) return ["--no-warnings", ...loader, options.file, ...(options.args ?? [])];
  if (options.script !== undefined && options.file === undefined) return ["--no-warnings", ...loader, "--input-type=module", "--eval", options.script, "--", ...(options.args ?? [])];
  throw new TypeError("runNode needs exactly one of file and script");
}

function childEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const [name, value] of Object.entries(overrides)) if (value === undefined) delete env[name];
  return env;
}

export function spawnNode(options: NodeRun): NodeChild {
  const child = spawn(process.execPath, nodeArguments(options), {
    cwd: options.cwd ?? coreDir,
    env: childEnvironment(options.env),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 60_000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  const waiters: Array<{ text: string; resolve: () => void; reject: (error: Error) => void }> = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (const waiter of waiters.filter((entry) => stdout.includes(entry.text))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<NodeResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`node child exited (${status ?? signal}) before printing ${JSON.stringify(waiter.text)}: ${stderr}`));
      resolve({ status, signal, stdout, stderr });
    });
  });
  return {
    pid: child.pid,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    exited,
    kill: (signal = "SIGTERM") => {
      child.kill(signal);
    },
    output: (text) => {
      if (stdout.includes(text)) return Promise.resolve();
      if (child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error(`node child already exited before printing ${JSON.stringify(text)}: ${stderr}`));
      return new Promise((resolve, reject) => {
        waiters.push({ text, resolve, reject });
      });
    },
  };
}

export function runNode(options: NodeRun): Promise<NodeResult> {
  return spawnNode(options).exited;
}

export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function extractTarball(tarball: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1"]);
}

async function stagePackage(packageDir: string, stage: string): Promise<void> {
  await run(path.join(coreDir, "node_modules", ".bin", "vibelang"), ["-p", path.join(packageDir, "tsconfig.build.json"), "--outDir", path.join(stage, "dist")], {
    cwd: packageDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as { files?: string[] };
  const copied = ["package.json", "README.md", "LICENSE", ...(manifest.files ?? []).filter((entry) => entry !== "dist")];
  for (const entry of copied) {
    if (existsSync(path.join(packageDir, entry))) await cp(path.join(packageDir, entry), path.join(stage, entry), { recursive: true });
  }
}

export async function packAndExtract(packageDir: string, destination: string): Promise<Packed> {
  const work = await mkdtemp(path.join(os.tmpdir(), "core-pack-"));
  const remove = () => rm(work, { recursive: true, force: true });
  try {
    const stage = path.join(work, "stage");
    await stagePackage(packageDir, stage);
    const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: stage, maxBuffer: 64 * 1024 * 1024 });
    const [packed] = JSON.parse(stdout) as Array<{ filename: string }>;
    const tarball = path.join(work, packed.filename);
    await rm(stage, { recursive: true, force: true });
    await extractTarball(tarball, destination);
    return { tarball, sha256: await sha256File(tarball), remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
