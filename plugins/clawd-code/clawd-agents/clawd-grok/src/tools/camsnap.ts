import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolResult } from "../types/index";

export interface RunCamsnapOptions {
  cwd: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export async function runCamsnap(args: string[], options: RunCamsnapOptions): Promise<ToolResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolveResult) => {
    const child = spawn("camsnap", args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish({ success: false, output: "camsnap command cancelled." });
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ success: false, output: `camsnap timed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      const message =
        err.code === "ENOENT"
          ? "camsnap CLI not found on PATH. Install camsnap and ensure ffmpeg is available before using this toolset."
          : `camsnap failed to start: ${err.message}`;
      finish({ success: false, output: message, error: message });
    });
    child.on("close", (code) => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (code === 0) {
        finish({ success: true, output: output || "camsnap completed successfully." });
        return;
      }
      const message = output || `camsnap exited with status ${code}.`;
      finish({ success: false, output: message, error: message });
    });
  });
}

export function resolveCamsnapOutputPath(cwd: string, outputPath: string | undefined, fallbackName: string): string {
  const resolved = outputPath ? (isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath)) : resolve(cwd, fallbackName);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

export function buildCamsnapFileName(prefix: string, extension: "jpg" | "mp4"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safePrefix = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `.clawd/camsnap/${safePrefix || "camera"}-${stamp}.${extension}`;
}
