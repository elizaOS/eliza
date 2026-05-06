/**
 * `bash` tool — execute a shell command inside the allowed workspace.
 *
 * Safety posture:
 *   - cwd defaults to SHELL_ALLOWED_DIRECTORY (default /workspace).
 *   - explicit cwd override must resolve inside the allowed dir.
 *   - blocks obvious footguns (rm -rf /, mkfs, fork bombs, dd of=/dev/sd*).
 *   - hard wall-clock timeout (SHELL_TIMEOUT, default 120000ms).
 *   - combined stdout+stderr truncated at 100KB.
 */

import { spawn } from "node:child_process";
import type {
  NativeTool,
  NativeToolHandler,
  ToolHandlerResult,
} from "../tool-schema.js";
import { getAllowedDir, resolveSafePath, truncate } from "./_safe-path.js";

const MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Patterns that match destructive or denial-of-service commands. We reject
 * any *substring* match (case-insensitive); intentionally conservative.
 *
 * Add to this list rather than rewriting it — every entry is a Chesterton's
 * fence put there by some past incident.
 */
const FOOTGUN_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$)/i, // rm -rf /
  /\brm\s+-[a-z]*f[a-z]*r?\s+\/(?:\s|$)/i,
  /\bmkfs(\.|\s)/i, // mkfs.ext4 etc
  /\bdd\s+[^|]*of=\/dev\//i, // dd of=/dev/sda
  /:\s*\(\s*\)\s*\{[^}]*\|\s*:[^}]*\}\s*;?\s*:/, // classic fork bomb
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /\b>\s*\/dev\/sd[a-z]/i, // raw disk write via redirection
  /\bchmod\s+-R\s+0?00\s+\//i,
];

export interface BashInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

export const tool: NativeTool = {
  type: "custom",
  name: "bash",
  description:
    "Execute a shell command inside the agent's allowed workspace " +
    "directory (default /workspace). Returns combined stdout+stderr. " +
    "Times out after 120s by default. Refuses obvious destructive " +
    "commands (rm -rf /, mkfs, fork bombs).",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to run (interpreted by /bin/sh -c).",
      },
      cwd: {
        type: "string",
        description:
          "Working directory. Must be within the allowed workspace. Defaults to the workspace root.",
      },
      timeout_ms: {
        type: "number",
        description: "Wall-clock timeout in milliseconds (default 120000).",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

function isFootgun(cmd: string): RegExp | null {
  for (const re of FOOTGUN_PATTERNS) {
    if (re.test(cmd)) return re;
  }
  return null;
}

export const handler: NativeToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as Partial<BashInput>;
  if (typeof input.command !== "string" || input.command.length === 0) {
    return { content: "bash: 'command' is required", is_error: true };
  }

  const blocked = isFootgun(input.command);
  if (blocked) {
    return {
      content: `bash: refused to execute command (matched safety pattern ${blocked.source})`,
      is_error: true,
    };
  }

  const allowedDir = getAllowedDir();
  let cwd: string;
  try {
    cwd = input.cwd ? resolveSafePath(input.cwd, allowedDir) : allowedDir;
  } catch (err) {
    return {
      content: `bash: invalid cwd: ${(err as Error).message}`,
      is_error: true,
    };
  }

  const timeoutMs = pickTimeout(input.timeout_ms);

  return runShell(input.command, cwd, timeoutMs);
};

function pickTimeout(requested: number | undefined): number {
  if (
    typeof requested === "number" &&
    Number.isFinite(requested) &&
    requested > 0
  ) {
    return Math.min(requested, 10 * 60 * 1000);
  }
  const fromEnv = Number.parseInt(process.env.SHELL_TIMEOUT ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TIMEOUT_MS;
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ToolHandlerResult> {
  return await new Promise<ToolHandlerResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let buf = "";
    let bytes = 0;
    let killedForSize = false;

    const append = (chunk: Buffer | string) => {
      if (killedForSize) return;
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytes += Buffer.byteLength(s, "utf8");
      buf += s;
      if (bytes > MAX_OUTPUT_BYTES * 2) {
        killedForSize = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        content: `bash: spawn error: ${err.message}`,
        is_error: true,
      });
    });

    child.on("close", (code, sig) => {
      clearTimeout(timer);
      const { text } = truncate(buf, MAX_OUTPUT_BYTES);
      const exit = typeof code === "number" ? code : sig ? 128 : 1;
      const header =
        exit === 0 ? "" : `[exit ${exit}${sig ? ` signal=${sig}` : ""}]\n`;
      resolve({
        content: `${header}${text}`,
        is_error: exit !== 0,
      });
    });
  });
}
