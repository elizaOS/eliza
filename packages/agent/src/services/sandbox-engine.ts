/** Cross-platform sandbox engine: Docker, Apple Container, auto-detect. */

import { execFileSync, spawn } from "node:child_process";
import { arch, platform } from "node:os";
import { logger, sanitizeSpawnEnv } from "@elizaos/core";
import {
  applyHostExecutionBaseline,
  resolveHostExecutable,
} from "@elizaos/shared/host-execution-env";

export type SandboxEngineType = "docker" | "apple-container" | "auto";

export interface ContainerRunOptions {
  image: string;
  name: string;
  detach: boolean;
  mounts: Array<{ host: string; container: string; readonly: boolean }>;
  env: Record<string, string>;
  network: string;
  user: string;
  capDrop: string[];
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  readOnlyRoot?: boolean;
  ports?: Array<{ host: number; container: number }>;
  dns?: string[];
}

export interface ContainerExecOptions {
  containerId: string;
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface ContainerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

type ExecCommandResult = {
  binary: string;
  args: string[];
  timeoutMs?: number;
  stdin?: string;
};

function hostEngineEnv(): NodeJS.ProcessEnv {
  return applyHostExecutionBaseline(sanitizeSpawnEnv(process.env));
}

function appendMountArgs(
  args: string[],
  mounts: Array<{ host: string; container: string; readonly: boolean }>,
) {
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        "--mount",
        `type=bind,source=${mount.host},target=${mount.container},readonly`,
      );
    } else {
      args.push("-v", `${mount.host}:${mount.container}`);
    }
  }
}

function appendEnvArgs(args: string[], env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }
}

function listContainersFromBinary(binary: string, prefix: string): string[] {
  try {
    const output = execFileSync(
      binary,
      ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.ID}}"],
      {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        env: hostEngineEnv(),
      },
    );
    return output
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function checkHealthWithBinary(binary: string, id: string): Promise<boolean> {
  try {
    const result = execFileSync(binary, ["exec", id, "echo", "healthy"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: hostEngineEnv(),
    }).trim();
    return Promise.resolve(result === "healthy");
  } catch {
    return Promise.resolve(false);
  }
}

function getChildProcessErrorText(error: unknown): string {
  const execError = error as {
    message?: string;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
  };

  const parts = [execError.message, execError.stderr, execError.stdout]
    .map((value) => {
      if (value === undefined || value === null) return "";
      if (typeof value === "string") return value;
      if (typeof value === "object" && "toString" in value)
        return value.toString();
      return "";
    })
    .filter(Boolean)
    .join(" ");

  return parts.toLowerCase();
}

function isContainerVersionUnsupported(error: unknown): boolean {
  const errorText = getChildProcessErrorText(error);
  return (
    errorText.includes("unknown option") ||
    errorText.includes("unrecognized option") ||
    errorText.includes("invalid option") ||
    errorText.includes("unknown flag") ||
    errorText.includes("no such option")
  );
}

async function runExecInContainer(
  opts: ExecCommandResult,
): Promise<ContainerExecResult> {
  const { binary, args, timeoutMs, stdin } = opts;
  const start = Date.now();
  return new Promise<ContainerExecResult>((resolve) => {
    const proc = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: hostEngineEnv(),
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => proc.kill("SIGKILL"), timeoutMs ?? 30_000);

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `Exec error: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });
  });
}

function parseContainerCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaping = false;
  let tokenStarted = false;

  const emitCurrent = () => {
    if (tokenStarted) {
      args.push(current);
      current = "";
      tokenStarted = false;
    }
  };

  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("Container exec command is required");
  }

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else if (char === "\\") {
        const next = trimmed[i + 1];
        if (next === "\\" || next === '"' || next === "$" || next === "`") {
          i += 1;
          current += trimmed[i];
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      tokenStarted = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      tokenStarted = true;
      continue;
    }

    if (char === "\\") {
      if (i + 1 >= trimmed.length) {
        throw new Error(
          "Container exec command cannot end with dangling escape",
        );
      }
      escaping = true;
      continue;
    }

    if (/\s/.test(char)) {
      emitCurrent();
      continue;
    }

    if (
      char === "&" ||
      char === "|" ||
      char === ";" ||
      char === "<" ||
      char === ">" ||
      char === "$" ||
      char === "`" ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === "}" ||
      char === "\n" ||
      char === "\r"
    ) {
      throw new Error(
        "Container exec command contains unsupported shell syntax",
      );
    }

    current += char;
    tokenStarted = true;
  }

  if (inSingleQuote || inDoubleQuote) {
    throw new Error("Container exec command has unterminated quotes");
  }

  if (escaping) {
    throw new Error("Container exec command has trailing escape");
  }

  emitCurrent();

  if (args.length === 0) {
    throw new Error("Container exec command is required");
  }

  return args;
}

export function buildContainerExecArgs(opts: ContainerExecOptions): string[] {
  const args = ["exec"];
  if (opts.workdir) args.push("-w", opts.workdir);
  if (opts.env) appendEnvArgs(args, opts.env);
  const commandArgs = parseContainerCommand(opts.command);
  args.push(opts.containerId, ...commandArgs);
  return args;
}

export interface EngineInfo {
  type: SandboxEngineType;
  available: boolean;
  version: string;
  platform: string;
  arch: string;
  details: string;
}

export interface ISandboxEngine {
  readonly engineType: SandboxEngineType;
  isAvailable(): boolean;
  getInfo(): EngineInfo;
  runContainer(opts: ContainerRunOptions): Promise<string>; // returns container ID
  execInContainer(opts: ContainerExecOptions): Promise<ContainerExecResult>;
  stopContainer(id: string): Promise<void>;
  removeContainer(id: string): Promise<void>;
  isContainerRunning(id: string): boolean;
  imageExists(image: string): boolean;
  pullImage(image: string): Promise<void>;
  listContainers(prefix: string): string[];
  healthCheck(id: string): Promise<boolean>;
}

export class DockerEngine implements ISandboxEngine {
  readonly engineType: SandboxEngineType = "docker";

  private binary(): string | undefined {
    return resolveHostExecutable("docker");
  }

  private requiredBinary(): string {
    const binary = this.binary();
    if (!binary) throw new Error("Docker executable unavailable");
    return binary;
  }

  isAvailable(): boolean {
    try {
      const binary = this.binary();
      if (!binary) return false;
      execFileSync(binary, ["info"], {
        stdio: "ignore",
        timeout: 10000,
        env: hostEngineEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  getInfo(): EngineInfo {
    let version = "unknown";
    try {
      const binary = this.binary();
      if (!binary) throw new Error("Docker executable unavailable");
      version = execFileSync(binary, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
        env: hostEngineEnv(),
      }).trim();
    } catch {
      // ignore
    }

    return {
      type: "docker",
      available: this.isAvailable(),
      version,
      platform: platform(),
      arch: arch(),
      details: this.getDockerContext(),
    };
  }

  async runContainer(opts: ContainerRunOptions): Promise<string> {
    const args = ["run"];
    if (opts.detach) args.push("-d");
    args.push("--name", opts.name);

    if (opts.network) args.push("--network", opts.network);
    if (opts.user) args.push("--user", opts.user);
    if (opts.memory) args.push("--memory", opts.memory);
    if (opts.cpus) args.push("--cpus", String(opts.cpus));
    if (opts.pidsLimit) args.push("--pids-limit", String(opts.pidsLimit));
    if (opts.readOnlyRoot) args.push("--read-only");

    for (const cap of opts.capDrop) {
      args.push("--cap-drop", cap);
    }
    appendMountArgs(args, opts.mounts);
    appendEnvArgs(args, opts.env);
    if (opts.ports) {
      for (const p of opts.ports) {
        args.push("-p", `${p.host}:${p.container}`);
      }
    }
    if (opts.dns) {
      for (const d of opts.dns) {
        args.push("--dns", d);
      }
    }

    args.push(opts.image);

    const binary = this.requiredBinary();
    const output = execFileSync(binary, args, {
      encoding: "utf-8",
      timeout: 60000,
      env: hostEngineEnv(),
    }).trim();

    return output.substring(0, 12);
  }

  async execInContainer(
    opts: ContainerExecOptions,
  ): Promise<ContainerExecResult> {
    const args = buildContainerExecArgs(opts);
    return runExecInContainer({
      binary: this.requiredBinary(),
      args,
      timeoutMs: opts.timeoutMs,
      stdin: opts.stdin,
    });
  }

  async stopContainer(id: string): Promise<void> {
    try {
      execFileSync(this.requiredBinary(), ["stop", id], {
        timeout: 15000,
        stdio: "ignore",
        env: hostEngineEnv(),
      });
    } catch (error) {
      // error-policy:J6 teardown continues so callers can remove remaining resources.
      logger.debug({ error, id }, "[SandboxEngine] Docker stop failed");
    }
  }

  async removeContainer(id: string): Promise<void> {
    try {
      execFileSync(this.requiredBinary(), ["rm", "-f", id], {
        timeout: 10000,
        stdio: "ignore",
        env: hostEngineEnv(),
      });
    } catch (error) {
      // error-policy:J6 teardown continues so callers can remove remaining resources.
      logger.debug({ error, id }, "[SandboxEngine] Docker removal failed");
    }
  }

  isContainerRunning(id: string): boolean {
    try {
      const result = execFileSync(
        this.requiredBinary(),
        ["inspect", "-f", "{{.State.Running}}", id],
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
          env: hostEngineEnv(),
        },
      ).trim();
      return result === "true";
    } catch {
      return false;
    }
  }

  imageExists(image: string): boolean {
    try {
      execFileSync(this.requiredBinary(), ["image", "inspect", image], {
        stdio: "ignore",
        timeout: 10000,
        env: hostEngineEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async pullImage(image: string): Promise<void> {
    execFileSync(this.requiredBinary(), ["pull", image], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
      env: hostEngineEnv(),
    });
  }

  listContainers(prefix: string): string[] {
    const binary = this.binary();
    return binary ? listContainersFromBinary(binary, prefix) : [];
  }

  async healthCheck(id: string): Promise<boolean> {
    const binary = this.binary();
    return binary ? checkHealthWithBinary(binary, id) : false;
  }

  private getDockerContext(): string {
    try {
      return execFileSync(this.requiredBinary(), ["context", "show"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        env: hostEngineEnv(),
      }).trim();
    } catch {
      return "default";
    }
  }
}

/**
 * Upper bound on the start-check stderr buffer. The spawned container outlives
 * runContainer, so this buffer must not grow for the container's whole life.
 */
const MAX_START_STDERR_CHARS = 64 * 1024;

export class AppleContainerEngine implements ISandboxEngine {
  readonly engineType: SandboxEngineType = "apple-container";

  private binary(): string | undefined {
    return resolveHostExecutable("container");
  }

  private requiredBinary(): string {
    const binary = this.binary();
    if (!binary) throw new Error("Apple Container executable unavailable");
    return binary;
  }

  isAvailable(): boolean {
    try {
      const binary = this.binary();
      if (!binary) return false;
      execFileSync(binary, ["--version"], {
        stdio: "ignore",
        timeout: 5000,
        env: hostEngineEnv(),
      });
      return true;
    } catch (error) {
      if (!isContainerVersionUnsupported(error)) {
        return false;
      }
      try {
        const binary = this.binary();
        if (!binary) return false;
        execFileSync(binary, ["help"], {
          stdio: "ignore",
          timeout: 5000,
          env: hostEngineEnv(),
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  getInfo(): EngineInfo {
    let version = "unknown";
    try {
      const binary = this.binary();
      if (!binary) throw new Error("Apple Container executable unavailable");
      version = execFileSync(binary, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
        env: hostEngineEnv(),
      }).trim();
    } catch {
      // ignore
    }

    return {
      type: "apple-container",
      available: this.isAvailable(),
      version,
      platform: "darwin",
      arch: arch(),
      details: `Apple Silicon: ${arch() === "arm64" ? "yes" : "no"}`,
    };
  }

  async runContainer(opts: ContainerRunOptions): Promise<string> {
    // Apple Container uses `container run` with different syntax than Docker.
    // It doesn't have a `-d` detach flag — instead, we spawn it as a background
    // process with stdin piped so it doesn't block.
    const args = ["run", "--name", opts.name];

    // Apple Container: --mount for readonly, -v for read-write
    appendMountArgs(args, opts.mounts);
    appendEnvArgs(args, opts.env);

    args.push(opts.image);

    // Spawn as a background process (non-blocking) instead of execSync.
    // Apple Container doesn't support `-d`; we use spawn with detached + unref.
    return new Promise<string>((resolve, reject) => {
      const binary = this.binary();
      if (!binary) {
        reject(new Error("Apple Container executable unavailable"));
        return;
      }
      // stdout is discarded rather than piped: nothing here ever reads it, and
      // this child outlives the promise, so a piped stdout nobody drains fills
      // the OS pipe buffer and blocks the container in write(2) forever.
      const proc = spawn(binary, args, {
        stdio: ["pipe", "ignore", "pipe"],
        detached: true,
        env: hostEngineEnv(),
      });

      // Collect initial output for error detection. The listener stays attached
      // for the child's whole life so stderr keeps draining, but the buffer is
      // only needed for the start check, so it is bounded and then released.
      let stderr = "";
      let collectStderr = true;
      proc.stderr.on("data", (chunk: Buffer) => {
        if (!collectStderr) return;
        stderr += chunk.toString();
        if (stderr.length >= MAX_START_STDERR_CHARS) {
          stderr = `${stderr.slice(0, MAX_START_STDERR_CHARS)}\n[truncated]`;
          collectStderr = false;
        }
      });

      // Give it a moment to start, then check if it's still running
      const checkTimer = setTimeout(() => {
        if (proc.exitCode !== null) {
          reject(new Error(`Apple Container exited immediately: ${stderr}`));
        } else {
          // Container is running in background
          collectStderr = false;
          proc.unref(); // Allow Node process to exit independently
          resolve(opts.name);
        }
      }, 2000);

      proc.on("error", (err) => {
        clearTimeout(checkTimer);
        reject(new Error(`Apple Container spawn failed: ${err.message}`));
      });

      proc.on("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(checkTimer);
          reject(
            new Error(`Apple Container exited with code ${code}: ${stderr}`),
          );
        }
      });
    });
  }

  async execInContainer(
    opts: ContainerExecOptions,
  ): Promise<ContainerExecResult> {
    const args = buildContainerExecArgs(opts);
    return runExecInContainer({
      binary: this.requiredBinary(),
      args,
      timeoutMs: opts.timeoutMs,
      stdin: opts.stdin,
    });
  }

  async stopContainer(id: string): Promise<void> {
    try {
      execFileSync(this.requiredBinary(), ["stop", id], {
        timeout: 15000,
        stdio: "ignore",
        env: hostEngineEnv(),
      });
    } catch (error) {
      // error-policy:J6 teardown continues so callers can remove remaining resources.
      logger.debug(
        { error, id },
        "[SandboxEngine] Apple container stop failed",
      );
    }
  }

  async removeContainer(id: string): Promise<void> {
    // Apple Container uses --rm by default; explicit remove for safety
    try {
      execFileSync(this.requiredBinary(), ["rm", id], {
        timeout: 10000,
        stdio: "ignore",
        env: hostEngineEnv(),
      });
    } catch (error) {
      // error-policy:J6 teardown continues so callers can remove remaining resources.
      logger.debug(
        { error, id },
        "[SandboxEngine] Apple container removal failed",
      );
    }
  }

  isContainerRunning(id: string): boolean {
    try {
      execFileSync(this.requiredBinary(), ["inspect", id], {
        stdio: "ignore",
        timeout: 5000,
        env: hostEngineEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  imageExists(image: string): boolean {
    try {
      execFileSync(this.requiredBinary(), ["image", "inspect", image], {
        stdio: "ignore",
        timeout: 10000,
        env: hostEngineEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async pullImage(image: string): Promise<void> {
    execFileSync(this.requiredBinary(), ["pull", image], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
      env: hostEngineEnv(),
    });
  }

  listContainers(prefix: string): string[] {
    const binary = this.binary();
    return binary ? listContainersFromBinary(binary, prefix) : [];
  }

  async healthCheck(id: string): Promise<boolean> {
    const binary = this.binary();
    return binary ? checkHealthWithBinary(binary, id) : false;
  }
}

/** Auto-detect: prefer Apple Container on ARM Mac, else Docker. */
export function detectBestEngine(): ISandboxEngine {
  const os = platform();

  if (os === "darwin" && arch() === "arm64") {
    const apple = new AppleContainerEngine();
    if (apple.isAvailable()) {
      return apple;
    }
  }

  const docker = new DockerEngine();
  return docker; // Falls through to Docker (fails at runtime if not available)
}

export function createEngine(type: SandboxEngineType): ISandboxEngine {
  switch (type) {
    case "apple-container":
      return new AppleContainerEngine();
    case "docker":
      return new DockerEngine();
    case "auto":
      return detectBestEngine();
    default:
      return new DockerEngine();
  }
}

export function getAllEngineInfo(): EngineInfo[] {
  const engines: ISandboxEngine[] = [
    new DockerEngine(),
    new AppleContainerEngine(),
  ];
  return engines.map((e) => e.getInfo());
}

export function getPlatformSetupNotes(): string {
  const os = platform();
  const a = arch();

  switch (os) {
    case "darwin":
      if (a === "arm64") {
        return [
          "macOS Apple Silicon detected.",
          "Preferred: Apple Container (install via: brew install apple/apple/container-tools)",
          "Fallback: Docker Desktop for Mac",
          "Apple Container provides per-container VM isolation (strongest).",
        ].join("\n");
      }
      return [
        "macOS Intel detected.",
        "Use: Docker Desktop for Mac",
        "Apple Container is not available on Intel Macs.",
      ].join("\n");

    case "linux":
      return [
        "Linux detected.",
        "Use: Docker (install via your package manager)",
        "Docker provides namespace-based isolation.",
        "For stronger isolation, consider gVisor runtime (--runtime=runsc).",
      ].join("\n");

    case "win32":
      return [
        "Windows detected.",
        "Use: Docker Desktop with WSL2 backend",
        "Ensure WSL2 is enabled: wsl --install",
        "Docker Desktop must be configured to use WSL2 engine.",
        "Containers run inside a lightweight Linux VM via Hyper-V.",
      ].join("\n");

    default:
      return `Unsupported platform: ${os}. Docker may work if installed.`;
  }
}
