import { type ChildProcess, spawn } from "node:child_process";
import { type IAgentRuntime, Service, logger as coreLogger } from "@elizaos/core";
import { CODING_TOOLS_LOG_PREFIX, RIPGREP_SERVICE } from "../types.js";

const VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

export interface RipgrepOptions {
  pattern: string;
  path: string;
  glob?: string;
  type?: string;
  contextBefore?: number;
  contextAfter?: number;
  contextAround?: number;
  caseInsensitive?: boolean;
  multiline?: boolean;
  showLineNumbers?: boolean;
  maxCount?: number;
}

export type RipgrepMode = "content" | "files_with_matches" | "count";

export interface RipgrepResult {
  mode: RipgrepMode;
  output: string;
  exitCode: number;
  truncated: boolean;
}

/**
 * Wraps the `@vscode/ripgrep` binary. Search is the only thing it does.
 * Always excludes VCS directories. Bounded by `maxCount` and a hard 30s
 * runtime cap.
 */
export class RipgrepService extends Service {
  static serviceType = RIPGREP_SERVICE;
  capabilityDescription = "Bounded ripgrep wrapper with VCS exclusion.";

  private rgPath: string | undefined;

  static async start(runtime: IAgentRuntime): Promise<RipgrepService> {
    const svc = new RipgrepService(runtime);
    await svc.locateBinary();
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} RipgrepService started (rg=${svc.rgPath ?? "system"})`,
    );
    return svc;
  }

  async stop(): Promise<void> {
    // no-op
  }

  private async locateBinary(): Promise<void> {
    try {
      const mod = (await import("@vscode/ripgrep")) as { rgPath?: string };
      if (mod && typeof mod.rgPath === "string") {
        this.rgPath = mod.rgPath;
        return;
      }
    } catch {
      // fall through to system rg
    }
    this.rgPath = "rg";
  }

  binary(): string {
    return this.rgPath ?? "rg";
  }

  async search(
    options: RipgrepOptions,
    mode: RipgrepMode,
  ): Promise<RipgrepResult> {
    const args: string[] = [];
    if (mode === "files_with_matches") args.push("--files-with-matches");
    else if (mode === "count") args.push("--count");
    else {
      args.push("--no-heading");
      if (options.showLineNumbers) args.push("-n");
    }
    if (options.caseInsensitive) args.push("-i");
    if (options.multiline) args.push("--multiline", "--multiline-dotall");
    if (options.glob) args.push("-g", options.glob);
    if (options.type) args.push("-t", options.type);
    if (options.maxCount && mode === "content") {
      args.push("-m", String(options.maxCount));
    }
    if (options.contextBefore !== undefined) args.push("-B", String(options.contextBefore));
    if (options.contextAfter !== undefined) args.push("-A", String(options.contextAfter));
    if (options.contextAround !== undefined) args.push("-C", String(options.contextAround));
    for (const dir of VCS_EXCLUDES) {
      args.push("-g", `!${dir}/**`);
    }
    args.push("--", options.pattern, options.path);

    return runRipgrep(this.binary(), args);
  }
}

function runRipgrep(rg: string, args: string[]): Promise<RipgrepResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const HARD_CAP_BYTES = 5_000_000;

    let proc: ChildProcess;
    try {
      proc = spawn(rg, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        mode: "content",
        output: `ripgrep spawn failed: ${(err as Error).message}`,
        exitCode: -1,
        truncated: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, 30_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > HARD_CAP_BYTES) {
        truncated = true;
        proc.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        mode: "content",
        output: stdout || stderr,
        exitCode: typeof code === "number" ? code : -1,
        truncated,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        mode: "content",
        output: `ripgrep error: ${err.message}`,
        exitCode: -1,
        truncated: false,
      });
    });
  });
}
