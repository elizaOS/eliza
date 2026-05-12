import { execFile } from "node:child_process";
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

    return runRipgrep(this.binary(), args, mode);
  }
}

function runRipgrep(
  rg: string,
  args: string[],
  mode: RipgrepMode,
): Promise<RipgrepResult> {
  return new Promise((resolve) => {
    const HARD_CAP_BYTES = 5_000_000;

    execFile(
      rg,
      args,
      {
        encoding: "utf8",
        maxBuffer: HARD_CAP_BYTES,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (process.env.CODING_TOOLS_RG_DEBUG === "1") {
          console.error("rg-debug-execfile", {
            mode,
            rg,
            args,
            errorCode: (error as NodeJS.ErrnoException | null)?.code,
            stdout,
            stderr,
          });
        }
        const output = stdout || stderr;
        if (!error) {
          resolve({ mode, output, exitCode: 0, truncated: false });
          return;
        }

        const err = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ mode, output, exitCode: 0, truncated: true });
          return;
        }
        if (typeof err.code === "number") {
          resolve({ mode, output, exitCode: err.code, truncated: false });
          return;
        }
        const timedOut = err.killed || err.signal === "SIGTERM";
        resolve({
          mode,
          output:
            output ||
            (timedOut
              ? "ripgrep timed out after 30000ms"
              : `ripgrep error: ${err.message}`),
          exitCode: -1,
          truncated: false,
        });
      },
    );
  });
}
