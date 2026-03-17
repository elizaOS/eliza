import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  LobsterConfig,
  LobsterEnvelope,
  LobsterResumeParams,
  LobsterRunParams,
} from "../types";

const DEFAULT_CONFIG: LobsterConfig = {
  lobsterPath: "lobster",
  defaultTimeoutMs: 20_000,
  defaultMaxStdoutBytes: 512_000,
};

/**
 * Resolves and validates the lobster executable path
 */
function resolveExecutablePath(lobsterPathRaw: string | undefined): string {
  const lobsterPath = lobsterPathRaw?.trim() || "lobster";

  // Security: Only allow the lobster binary
  if (lobsterPath !== "lobster") {
    if (!path.isAbsolute(lobsterPath)) {
      throw new Error("lobsterPath must be an absolute path (or omit to use PATH)");
    }
    const base = path.basename(lobsterPath).toLowerCase();
    const allowed =
      process.platform === "win32" ? ["lobster.exe", "lobster.cmd", "lobster.bat"] : ["lobster"];
    if (!allowed.includes(base)) {
      throw new Error("lobsterPath must point to the lobster executable");
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lobsterPath);
    } catch {
      throw new Error("lobsterPath must exist");
    }
    if (!stat.isFile()) {
      throw new Error("lobsterPath must point to a file");
    }
    if (process.platform !== "win32") {
      try {
        fs.accessSync(lobsterPath, fs.constants.X_OK);
      } catch {
        throw new Error("lobsterPath must be executable");
      }
    }
  }

  return lobsterPath;
}

/**
 * Normalizes path for cwd sandbox checking
 */
function normalizeForCwdSandbox(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Resolves and validates the working directory
 */
function resolveCwd(cwdRaw: string | undefined): string {
  if (!cwdRaw?.trim()) {
    return process.cwd();
  }
  const cwd = cwdRaw.trim();
  if (path.isAbsolute(cwd)) {
    throw new Error("cwd must be a relative path");
  }
  const base = process.cwd();
  const resolved = path.resolve(base, cwd);

  const rel = path.relative(normalizeForCwdSandbox(base), normalizeForCwdSandbox(resolved));
  if (rel === "" || rel === ".") {
    return resolved;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("cwd must stay within the gateway working directory");
  }
  return resolved;
}

/**
 * Checks if a Windows spawn error can be retried with shell
 */
function isWindowsSpawnErrorThatCanUseShell(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "EINVAL" || code === "ENOENT";
}

/**
 * Runs the lobster subprocess once
 */
async function runLobsterSubprocessOnce(
  params: {
    execPath: string;
    argv: string[];
    cwd: string;
    timeoutMs: number;
    maxStdoutBytes: number;
  },
  useShell: boolean
): Promise<{ stdout: string }> {
  const { execPath, argv, cwd } = params;
  const timeoutMs = Math.max(200, params.timeoutMs);
  const maxStdoutBytes = Math.max(1024, params.maxStdoutBytes);

  const env = { ...process.env, LOBSTER_MODE: "tool" } as Record<string, string | undefined>;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes("--inspect")) {
    delete env.NODE_OPTIONS;
  }

  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(execPath, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: useShell,
      windowsHide: useShell ? true : undefined,
    });

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      const str = String(chunk);
      stdoutBytes += Buffer.byteLength(str, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        try {
          child.kill("SIGKILL");
        } finally {
          reject(new Error("lobster output exceeded maxStdoutBytes"));
        }
        return;
      }
      stdout += str;
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } finally {
        reject(new Error("lobster subprocess timed out"));
      }
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`lobster failed (${code ?? "?"}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout });
    });
  });
}

/**
 * Runs the lobster subprocess with Windows shell fallback
 */
async function runLobsterSubprocess(params: {
  execPath: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}): Promise<{ stdout: string }> {
  try {
    return await runLobsterSubprocessOnce(params, false);
  } catch (err) {
    if (process.platform === "win32" && isWindowsSpawnErrorThatCanUseShell(err)) {
      return await runLobsterSubprocessOnce(params, true);
    }
    throw err;
  }
}

/**
 * Parses the lobster output envelope
 */
function parseEnvelope(stdout: string): LobsterEnvelope {
  const trimmed = stdout.trim();

  const tryParse = (input: string): unknown => {
    try {
      return JSON.parse(input);
    } catch {
      return undefined;
    }
  };

  let parsed: unknown = tryParse(trimmed);

  // Handle extra stdout before JSON envelope
  if (parsed === undefined) {
    const suffixMatch = trimmed.match(/({[\s\S]*}|\[[\s\S]*])\s*$/);
    if (suffixMatch?.[1]) {
      parsed = tryParse(suffixMatch[1]);
    }
  }

  if (parsed === undefined) {
    throw new Error("lobster returned invalid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("lobster returned invalid JSON envelope");
  }

  const ok = (parsed as { ok?: unknown }).ok;
  if (ok === true || ok === false) {
    return parsed as LobsterEnvelope;
  }

  throw new Error("lobster returned invalid JSON envelope");
}

/**
 * Service for running Lobster pipelines
 */
export class LobsterService {
  private config: LobsterConfig;

  constructor(runtime: IAgentRuntime, config?: Partial<LobsterConfig>) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a Lobster pipeline
   */
  async run(params: LobsterRunParams): Promise<LobsterEnvelope> {
    if (!params.pipeline?.trim()) {
      throw new Error("pipeline required");
    }

    const execPath = resolveExecutablePath(this.config.lobsterPath);
    const cwd = resolveCwd(params.cwd);
    const timeoutMs = params.timeoutMs ?? this.config.defaultTimeoutMs ?? 20_000;
    const maxStdoutBytes = params.maxStdoutBytes ?? this.config.defaultMaxStdoutBytes ?? 512_000;

    const argv = ["run", "--mode", "tool", params.pipeline];
    if (params.argsJson?.trim()) {
      argv.push("--args-json", params.argsJson);
    }

    logger.info(`[LobsterService] Running pipeline: ${params.pipeline}`);

    const { stdout } = await runLobsterSubprocess({
      execPath,
      argv,
      cwd,
      timeoutMs,
      maxStdoutBytes,
    });

    return parseEnvelope(stdout);
  }

  /**
   * Resume a Lobster pipeline after approval
   */
  async resume(params: LobsterResumeParams): Promise<LobsterEnvelope> {
    if (!params.token?.trim()) {
      throw new Error("token required");
    }
    if (typeof params.approve !== "boolean") {
      throw new Error("approve required");
    }

    const execPath = resolveExecutablePath(this.config.lobsterPath);
    const cwd = resolveCwd(params.cwd);
    const timeoutMs = params.timeoutMs ?? this.config.defaultTimeoutMs ?? 20_000;
    const maxStdoutBytes = params.maxStdoutBytes ?? this.config.defaultMaxStdoutBytes ?? 512_000;

    const argv = ["resume", "--token", params.token, "--approve", params.approve ? "yes" : "no"];

    logger.info(`[LobsterService] Resuming with approve=${params.approve}`);

    const { stdout } = await runLobsterSubprocess({
      execPath,
      argv,
      cwd,
      timeoutMs,
      maxStdoutBytes,
    });

    return parseEnvelope(stdout);
  }

  /**
   * Check if lobster is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const execPath = resolveExecutablePath(this.config.lobsterPath);
      await runLobsterSubprocess({
        execPath,
        argv: ["--version"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Factory function to create a LobsterService instance
 */
export function createLobsterService(
  runtime: IAgentRuntime,
  config?: Partial<LobsterConfig>
): LobsterService {
  return new LobsterService(runtime, config);
}
