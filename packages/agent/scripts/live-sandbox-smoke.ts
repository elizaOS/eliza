/** Runs a live sandbox smoke path for agent plugin isolation and runtime launch behavior. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CapabilityError, type IAgentRuntime, type UUID } from "@elizaos/core";
import {
  E2BRemoteCapabilityRouterService,
  type E2BSandboxFactory,
  type SandboxRunnerProvider,
} from "../src/services/e2b-capability-router.ts";

async function loadE2BSandboxFactory(
  runtime: IAgentRuntime,
): Promise<E2BSandboxFactory | undefined> {
  try {
    const mod = await import("@elizaos/plugin-e2b-sandbox");
    return await mod.E2BSandboxFactoryService.start(runtime);
  } catch {
    return undefined;
  }
}

type SmokeTarget = SandboxRunnerProvider | "codex-app-server";
type JsonRecord = Record<string, unknown>;

type SmokeOutcome = {
  target: SmokeTarget;
  status: "passed" | "skipped" | "failed";
  message: string;
};

const requestedTarget = readArg("target") ?? readArg("provider") ?? "all";
const strict =
  hasArg("strict") || process.env.ELIZA_SANDBOX_LIVE_STRICT === "1";
const targets = resolveTargets(requestedTarget);
const outcomes: SmokeOutcome[] = [];

for (const target of targets) {
  try {
    outcomes.push(await runTarget(target));
  } catch (error) {
    // A CAPABILITY_UNAVAILABLE thrown from the router means the provider is not
    // configured/installed in this environment (e.g. the e2b factory plugin is
    // absent, or credentials are partial) — that is a SKIP, not a failure. The
    // `strict && skipped` gate below still fails-closed under --strict. Any
    // other error is a genuine smoke failure and stays `failed`.
    outcomes.push({
      target,
      status: isCapabilityUnavailable(error) ? "skipped" : "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

for (const outcome of outcomes) {
  process.stdout.write(
    `${outcome.status.toUpperCase()} ${outcome.target}: ${outcome.message}\n`,
  );
}

const failures = outcomes.filter((outcome) => outcome.status === "failed");
const skipped = outcomes.filter((outcome) => outcome.status === "skipped");
if (failures.length > 0 || (strict && skipped.length > 0)) {
  process.exitCode = 1;
}

async function runTarget(target: SmokeTarget): Promise<SmokeOutcome> {
  if (target === "codex-app-server") return runCodexAppServerSmoke();
  return runSandboxProviderSmoke(target);
}

async function runSandboxProviderSmoke(
  provider: SandboxRunnerProvider,
): Promise<SmokeOutcome> {
  if (provider === "eliza-cloud" && !hasElizaCloudRunnerTarget()) {
    return {
      target: provider,
      status: "skipped",
      message:
        "Eliza Cloud runner requires ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE or a direct runner URL.",
    };
  }
  const runtime = makeRuntime({ ELIZA_CODING_REMOTE_RUNNER: provider });
  // The e2b (`e2b.dev`) SDK backend lives in the optional
  // `@elizaos/plugin-e2b-sandbox` plugin (not in `@elizaos/agent`); inject its
  // sandbox factory so the router can reach the e2b provider in this smoke.
  const factory =
    provider === "e2b" ? await loadE2BSandboxFactory(runtime) : undefined;
  // In non-strict mode a provider that cannot initialize is a SKIP, not a
  // failure: `--strict` is the fail-closed switch (the workflow only passes it
  // on manual dispatch), so a routine push smoke must stay green when a
  // provider is genuinely unconfigurable in this environment. Here the e2b
  // backend is unreachable whenever its optional plugin (and the `e2b` SDK it
  // pulls in) is not installed — surface that as a clear skip up front rather
  // than letting the router throw CAPABILITY_UNAVAILABLE mid-run and reading as
  // a hard failure.
  if (provider === "e2b" && !factory) {
    return {
      target: provider,
      status: "skipped",
      message:
        "e2b backend unavailable: @elizaos/plugin-e2b-sandbox is not installed (add the plugin, or run with --strict to fail-close).",
    };
  }
  const service = new E2BRemoteCapabilityRouterService(
    runtime,
    undefined,
    factory,
  );
  const availability = await service.availability();
  if (!availability.available) {
    return {
      target: provider,
      status: "skipped",
      message: availability.reason ?? "provider is not configured",
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = `.eliza-sandbox-live-${stamp}.txt`;
  const text = `eliza sandbox live ${provider} ${stamp}\n`;
  const command = await service.pty.runCommand({
    command: "sh",
    args: ["-lc", "printf eliza-sandbox-live"],
    cwd: ".",
    timeoutMs: 60_000,
  });
  if (
    command.exitCode !== 0 ||
    !command.output.includes("eliza-sandbox-live")
  ) {
    throw new Error(
      `pty command failed with exitCode=${String(command.exitCode)}`,
    );
  }

  await service.fs.writeText({ path: filePath, text, overwrite: true });
  const read = await service.fs.readText({ path: filePath, maxBytes: 4096 });
  if (read.text !== text) {
    throw new Error(`fs read/write mismatch for ${filePath}`);
  }

  const list = await service.fs.list({
    path: ".",
    includeHidden: true,
    limit: 200,
  });
  if (!list.entries.some((entry) => entry.name === filePath)) {
    throw new Error(`fs list did not include ${filePath}`);
  }

  const git = await service.git.commandRun({ root: ".", args: ["--version"] });
  if (
    git.operation.status !== "completed" ||
    !git.operation.stdout.toLowerCase().includes("git")
  ) {
    throw new Error("git command route did not return a git version");
  }

  await service.stop();
  return {
    target: provider,
    status: "passed",
    message: "fs, pty, and git routes completed against live provider",
  };
}

async function runCodexAppServerSmoke(): Promise<SmokeOutcome> {
  const codex = process.env.CODEX_BIN?.trim() || "codex";
  if (!(await commandAvailable(codex))) {
    return {
      target: "codex-app-server",
      status: "skipped",
      message: `${codex} is not available on PATH`,
    };
  }
  const server = spawn(codex, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const client = new JsonRpcClient(server);
  try {
    const initialize = await client.request("initialize", {
      clientInfo: {
        name: "eliza_sandbox_live_smoke",
        title: "Eliza sandbox live smoke",
        version: "0.1.0",
      },
    });
    requireObject(initialize, "initialize result");
    client.notify("initialized", {});
    const models = await client.request("model/list", {
      limit: 5,
      includeHidden: false,
    });
    requireObject(models, "model/list result");
    const account = await client.request("account/read", {
      refreshToken: false,
    });
    requireObject(account, "account/read result");
    return {
      target: "codex-app-server",
      status: "passed",
      message:
        "stdio app-server initialized and responded to model/account RPCs",
    };
  } finally {
    await client.close();
  }
}

class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  private stderr = "";

  constructor(private readonly server: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: server.stdout });
    lines.on("line", (line) => this.onLine(line));
    server.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    server.once("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    server.once("exit", (code, signal) => {
      const error = new Error(
        `codex app-server exited code=${String(code)} signal=${String(signal)} ${this.stderr}`.trim(),
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  request(method: string, params: JsonRecord): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return withTimeout(promise, 20_000, `${method} timed out`);
  }

  notify(method: string, params: JsonRecord): void {
    this.write({ method, params });
  }

  async close(): Promise<void> {
    if (this.server.exitCode !== null || this.server.signalCode !== null)
      return;
    this.server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.server.exitCode === null && this.server.signalCode === null) {
          this.server.kill("SIGKILL");
        }
        resolve();
      }, 1500);
      this.server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isObject(message) || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (isObject(message.error)) {
      pending.reject(
        new Error(String(message.error.message ?? "Codex RPC error")),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private write(message: JsonRecord): void {
    this.server.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function makeRuntime(settings: Record<string, string>): IAgentRuntime {
  const runtime: Partial<IAgentRuntime> = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "Sandbox Live Smoke" },
    getSetting: (key: string) => settings[key] ?? process.env[key],
    getService: () => null,
  };
  return runtime as IAgentRuntime;
}

function resolveTargets(value: string): SmokeTarget[] {
  if (value === "all") {
    return ["e2b", "eliza-cloud", "home", "codex-app-server"];
  }
  if (
    value === "e2b" ||
    value === "eliza-cloud" ||
    value === "home" ||
    value === "codex-app-server"
  ) {
    return [value];
  }
  throw new Error(`Unsupported sandbox live target: ${value}`);
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function hasElizaCloudRunnerTarget(): boolean {
  return Boolean(
    readEnv("ELIZA_CLOUD_SANDBOX_BASE_URL") ||
      readEnv("ELIZA_CLOUD_REMOTE_RUNNER_URL") ||
      readEnv("ELIZA_CLOUD_RUNNER_URL") ||
      readEnv("ELIZA_CLOUD_SANDBOX_IMAGE") ||
      readEnv("ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE") ||
      readEnv("ELIZA_CODING_REMOTE_RUNNER_IMAGE"),
  );
}

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--help"], {
      stdio: "ignore",
      env: { ...process.env, NO_COLOR: "1" },
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function requireObject(value: unknown, label: string): JsonRecord {
  if (!isObject(value)) throw new Error(`${label} was not an object`);
  return value;
}

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapabilityUnavailable(error: unknown): boolean {
  return (
    error instanceof CapabilityError && error.code === "CAPABILITY_UNAVAILABLE"
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
