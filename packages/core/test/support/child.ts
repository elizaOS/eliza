// spec/core/release.md, "Story: Install the replacement through existing npm entry points"; spec/core/release.md, "Every release check names the candidate it actually examined"; spec/core/atomicWriters.md, "Story: Publish whole snapshots despite interleaved processes"
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

export interface NodeRun {
  file?: string;
  script?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  conditions?: string[];
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
  readonly tarball: string;
  readonly sha256: string;
  readonly sourceDir: string;
  readonly revision: string;
  readonly attemptId: string;
  remove(): Promise<void>;
}

export const coreDir = path.resolve(import.meta.dirname, "../..");

const run = promisify(execFile);

function nodeArguments(options: NodeRun): string[] {
  const loader = [...(options.conditions ?? []).flatMap((condition) => ["--conditions", condition]), ...(options.vibe ? ["--import", "vibelang/register"] : [])];
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

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  exports: z.record(z.string(), z.record(z.string(), z.string())),
  dependencies: z.record(z.string(), z.string()).optional(),
});
const versionSchema = z.object({ version: z.string() });
const workspaceSchema = z.object({ packageManager: z.string() });
const packedSchema = z.object({ filename: z.string() });

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

async function producerFiles(packageDir: string): Promise<string[]> {
  const workspace = path.resolve(packageDir, "../..");
  const rootFiles = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "tsconfig.base.json", "LICENSE"];
  const packageFiles = ["package.json", ...(await readdir(packageDir)).filter((name) => /^tsconfig(?:\..+)?\.json$/.test(name)), ...["LICENSE", "README.md"].filter((name) => existsSync(path.join(packageDir, name)))];
  return [
    ...rootFiles.map((file) => path.join(workspace, file)),
    ...packageFiles.map((file) => path.join(packageDir, file)),
    ...await filesUnder(path.join(packageDir, "src")),
    ...(await readdir(path.join(packageDir, "gen"))).filter((file) => file.endsWith(".ts") || file.endsWith(".vibe")).map((file) => path.join(packageDir, "gen", file)),
    ...await filesUnder(path.join(workspace, "spec/core")),
  ].sort();
}

export async function freezeCore(packageDir: string, work: string): Promise<{ root: string; sourceDir: string; digest: string }> {
  const workspace = path.resolve(packageDir, "../..");
  const producer = path.join(await realpath(work), "producer");
  const sourceDir = path.join(producer, path.relative(workspace, packageDir));
  const files = await producerFiles(packageDir);
  const inputs = new Map<string, Buffer>();
  const digest = createHash("sha256");
  for (const file of files) {
    const contents = await readFile(file);
    const relative = path.relative(workspace, file);
    inputs.set(file, contents);
    digest.update(relative).update("\0").update(contents).update("\0");
    const destination = path.join(producer, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  if (JSON.stringify(files) !== JSON.stringify(await producerFiles(packageDir))) throw new Error("Core inputs changed while freezing the release candidate");
  for (const [file, contents] of inputs) {
    if (!contents.equals(await readFile(file))) throw new Error(`Core input changed while freezing: ${file}`);
  }
  await symlink(await realpath(path.join(workspace, "node_modules")), path.join(producer, "node_modules"), "dir");
  await symlink(await realpath(path.join(packageDir, "node_modules")), path.join(sourceDir, "node_modules"), "dir");
  return { root: producer, sourceDir, digest: digest.digest("hex") };
}

export async function packCandidate(packageDir: string): Promise<Packed> {
  const work = await mkdtemp(path.join(os.tmpdir(), "core-pack-"));
  const remove = () => rm(work, { recursive: true, force: true });
  try {
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: path.resolve(packageDir, "../..") })).stdout.trim();
    const { sourceDir, digest } = await freezeCore(packageDir, work);
    const options = { cwd: sourceDir, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 };
    await run("pnpm", ["build"], options);
    const { stdout } = await run("pnpm", ["pack", "--json", "--pack-destination", work], options);
    const { filename } = packedSchema.parse(JSON.parse(stdout));
    const tarball = path.resolve(work, filename);
    return { tarball, sha256: await sha256File(tarball), sourceDir, attemptId: randomUUID(), revision: `${head}+inputs.${digest}`, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

export async function installPacked(packed: Packed, directory: string, withTypes = false) {
  if (await sha256File(packed.tarball) !== packed.sha256) throw new Error("Packed candidate changed before installation");
  const { packageManager } = workspaceSchema.parse(JSON.parse(await readFile(path.resolve(packed.sourceDir, "../../package.json"), "utf8")));
  const devDependencies: Record<string, string> = {};
  if (withTypes) {
    for (const name of ["typescript", "@types/node"]) {
      devDependencies[name] = versionSchema.parse(JSON.parse(await readFile(path.join(packed.sourceDir, "node_modules", name, "package.json"), "utf8"))).version;
    }
  }
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "packed-core-consumer", private: true, type: "module", packageManager, dependencies: { "@elizaos/core": `file:${packed.tarball}` }, devDependencies }, null, 2) + "\n");
  await run("pnpm", ["install", "--strict-peer-dependencies", "--reporter", "append-only"], { cwd: directory, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const packageDirectory = await realpath(path.join(directory, "node_modules/@elizaos/core"));
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")));
  return { packageDirectory, manifest };
}
