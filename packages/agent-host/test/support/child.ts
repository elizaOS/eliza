// spec/agent/host/launch.md, "Story: Tell the supervisor why the process ended"; spec/agent/host/launch.md, "Story: Keep the credential out of every file and reply"
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { inject } from "vitest";
import type { TestProject } from "vitest/node";
import { request, type LocalAnswer, type Refusal } from "./socket-client.ts";
import type { LaunchFrame } from "./scratch.ts";

export const agentDir = resolve(import.meta.dirname, "../..");

declare module "vitest" {
  interface ProvidedContext {
    agentCli: string;
  }
}

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cache = join(agentDir, ".cache");
  await mkdir(cache, { recursive: true });
  const output = await mkdtemp(join(cache, "cli-test-"));
  const remove = () => rm(output, { recursive: true, force: true });
  try {
    const { compilerCommand, findCompiler } = await import("vibelang/project");
    const [compiler, args] = compilerCommand(findCompiler(agentDir), ["-p", "tsconfig.build.json", "--outDir", output]);
    await promisify(execFile)(compiler, args, { cwd: agentDir, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" });
    const executable = join(output, "src", "bin.js");
    if (!(await stat(executable)).isFile()) throw new Error("Agent CLI build did not emit a regular executable");
    project.provide("agentCli", executable);
    return remove;
  } catch (failure) {
    await remove();
    throw failure;
  }
}

export type Transport =
  | { readonly kind: "socket"; readonly path: string }
  | { readonly kind: "http"; readonly port: number };

export interface AgentRun {
  readonly launchFile: string;
  readonly stateDir: string;
  readonly frame: LaunchFrame | string;
  readonly transport: Transport;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly entry?: string;
}

export interface Exited {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AgentChild {
  readonly transport: Transport;
  readonly exited: Promise<Exited>;
  /** @throws {never} */
  output(): { readonly stdout: string; readonly stderr: string };
  health(): Promise<LocalAnswer | Refusal>;
  ready(timeoutMs?: number): Promise<LocalAnswer>;
  actions(): Promise<readonly string[]>;
  held(): Promise<void>;
  signal(signal: NodeJS.Signals): void;
  stop(): Promise<Exited>;
}

const socketPathLimit = 103;

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done());
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function transportArgs(transport: Transport): string[] {
  switch (transport.kind) {
    case "socket":
      if (Buffer.byteLength(transport.path) > socketPathLimit) throw new RangeError(`socket path is longer than ${socketPathLimit} bytes: ${transport.path}`);
      return ["--socket", transport.path];
    case "http":
      return ["--http", `127.0.0.1:${transport.port}`];
    default: {
      const unhandled: never = transport;
      throw new TypeError(`unknown transport ${JSON.stringify(unhandled)}`);
    }
  }
}

async function healthOver(transport: Transport): Promise<LocalAnswer | Refusal> {
  if (transport.kind === "socket") return request(transport.path, { method: "GET", path: "/api/health" });
  const response = await fetch(`http://127.0.0.1:${transport.port}/api/health`);
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json };
}

export function startAgentChild(run: AgentRun): AgentChild {
  const lifetimeMs = run.timeoutMs ?? 120_000;
  const child = spawn(
    process.execPath,
    ["--no-warnings", ...(run.entry === undefined ? [inject("agentCli")] : ["--conditions", "eliza-source", "--import", "vibelang/register", run.entry]), "serve", "--launch", run.launchFile, "--state", run.stateDir, ...transportArgs(run.transport)],
    {
      cwd: agentDir,
      env: { HOME: run.stateDir, TMPDIR: run.stateDir, TZ: "UTC", ...(run.entry === undefined ? {} : { VIBELANG_CACHE_DIR: join(agentDir, ".cache", "vibelang") }), ...run.env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      timeout: lifetimeMs,
      killSignal: "SIGKILL",
    },
  );
  const pipes = { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr };
  if (pipes.stdin === null || pipes.stdout === null || pipes.stderr === null) throw new TypeError("the agent child was spawned without its pipes");
  let stdout = "";
  let stderr = "";
  pipes.stdout.setEncoding("utf8").on("data", (data: string) => {
    stdout += data;
  });
  pipes.stderr.setEncoding("utf8").on("data", (data: string) => {
    stderr += data;
  });
  const received = (kind: string) => new Promise<object>((done) => {
    child.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === kind) done(message);
    });
  });
  const actions = received("bundleActionRegistry").then((message) => "actions" in message && Array.isArray(message.actions) ? message.actions.map(String) : []);
  const held = received("hostedModuleHeld");
  pipes.stdin.end(typeof run.frame === "string" ? run.frame : `${JSON.stringify(run.frame)}\n`);
  const exited = new Promise<Exited>((done, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) => done({ code, signal, stdout, stderr }));
  });
  let running = true;
  void exited.finally(() => {
    running = false;
  });
  return {
    transport: run.transport,
    exited,
    output: () => ({ stdout, stderr }),
    health: () => healthOver(run.transport),
    actions: () => Promise.race([actions, exited.then(({ stderr: said }) => Promise.reject(new Error(`agent exited before it published its actions: ${said}`)))]),
    held: () => Promise.race([held.then(() => undefined), exited.then(({ stderr: said }) => Promise.reject(new Error(`agent exited before its hosted module was held: ${said}`)))]),
    ready: async (timeoutMs = lifetimeMs) => {
      const deadline = Date.now() + timeoutMs;
      while (running && Date.now() < deadline) {
        const answer = await healthOver(run.transport).catch(() => undefined);
        if (answer !== undefined && "status" in answer && answer.status === 200) return answer;
        await Effect.runPromise(Effect.sleep(50));
      }
      throw new Error(`agent did not become ready (${running ? "timed out" : "exited"}): ${stderr}`);
    },
    signal: (signal) => {
      child.kill(signal);
    },
    stop: async () => {
      if (running) child.kill("SIGTERM");
      return exited;
    },
  };
}
