/**
 * Build verification and type checking utilities for sandbox environments.
 *
 * Uses native Vercel Sandbox SDK methods where available:
 * - command.logs() for streaming output
 * - command.output() for efficient output collection
 */

import { logger } from "@/lib/utils/logger";
import type { SandboxInstance, CommandResult } from "./types";

// Minimal delay - Next.js Turbopack HMR is very fast (~50ms)
const BUILD_CHECK_DELAY_MS = 50;

/**
 * Check build status by running `bun run build`.
 * This catches TypeScript type errors that the dev server HMR might miss.
 *
 * NOTE: This runs a full production build which is more thorough than
 * just checking dev server logs.
 */
export async function checkBuild(sandbox: SandboxInstance): Promise<string> {
  // Small delay to let any pending file writes complete
  await new Promise((r) => setTimeout(r, BUILD_CHECK_DELAY_MS));

  try {
    // Run the actual build command
    const command = await sandbox.runCommand({
      cmd: "bun",
      args: ["run", "build"],
    });

    // Get both stdout and stderr
    const [stdout, stderr] = await Promise.all([
      command.stdout(),
      command.stderr(),
    ]);

    const output = `${stdout}\n${stderr}`.trim();
    const exitCode = command.exitCode ?? -1;

    if (exitCode === 0) {
      return "BUILD OK - No errors detected!";
    }

    // Extract meaningful error messages from build output
    const lines = output.split("\n");
    const errorLines = lines
      .filter(
        (line) =>
          line.includes("Error") ||
          line.includes("error") ||
          line.includes("failed") ||
          line.includes("Cannot") ||
          line.includes("Module not found") ||
          line.includes("Type ") ||
          line.includes("TS"),
      )
      .filter(
        (line) =>
          !line.includes("warning") && !line.includes("DeprecationWarning"),
      )
      .slice(0, 15);

    const errorSummary =
      errorLines.length > 0 ? errorLines.join("\n") : output.slice(0, 1500);

    return `BUILD ERRORS:\n${errorSummary}\n\nPlease fix these errors!`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Build check failed", { error: message });
    return `BUILD ERRORS:\nBuild command failed: ${message}\n\nPlease fix these errors!`;
  }
}

/**
 * Wait for dev server to be ready with exponential backoff.
 * Starts polling quickly (200ms) and gradually slows down.
 */
export async function waitForDevServer(
  sandbox: SandboxInstance,
  port: number = 3000,
  maxWaitMs: number = 60000,
): Promise<void> {
  const startTime = Date.now();
  let delay = 200; // Start with 200ms polling
  const maxDelay = 2000; // Cap at 2 seconds
  let attempt = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    const result = await sandbox.runCommand({
      cmd: "curl",
      args: [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-m",
        "3", // 3 second timeout per request
        `http://localhost:${port}`,
      ],
    });
    const statusCode = await result.stdout();

    if (statusCode === "200" || statusCode === "304") {
      const totalTime = Date.now() - startTime;
      logger.info("Dev server ready", {
        attempts: attempt,
        totalMs: totalTime,
      });
      return;
    }

    // Exponential backoff: 200ms → 300ms → 450ms → ... → 2000ms (capped)
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.floor(delay * 1.5), maxDelay);
  }

  throw new Error(`Dev server did not start within ${maxWaitMs / 1000}s`);
}

/**
 * Stream build output in real-time using command.logs().
 * Yields log entries as they arrive.
 */
export async function* streamBuildOutput(
  sandbox: SandboxInstance,
  options?: { signal?: AbortSignal },
): AsyncGenerator<{ stream: "stdout" | "stderr"; data: string }> {
  const command = await sandbox.runCommand({
    cmd: "bun",
    args: ["run", "build"],
    detached: true,
  });

  // Use native logs() streaming if available
  if (typeof command.logs === "function") {
    try {
      for await (const log of command.logs(options)) {
        yield log;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("abort") && !message.includes("cancel")) {
        throw error;
      }
    }
  } else {
    // Fallback: wait for completion and yield final output
    const result = await command.wait?.();
    if (result) {
      const stdout = await result.stdout();
      if (stdout) yield { stream: "stdout", data: stdout };
      const stderr = await result.stderr();
      if (stderr) yield { stream: "stderr", data: stderr };
    }
  }
}

/**
 * Run a production build and return the result.
 * Uses streaming logs when available for better performance.
 */
export async function runProductionBuild(
  sandbox: SandboxInstance,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ success: boolean; output: string; exitCode: number }> {
  const { signal, timeoutMs = 120000 } = options ?? {};

  // Create timeout signal if specified
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;

  const combinedSignal =
    signal && timeoutSignal
      ? AbortSignal.any([signal, timeoutSignal])
      : (signal ?? timeoutSignal);

  const command = await sandbox.runCommand({
    cmd: "bun",
    args: ["run", "build"],
  });

  // Use native output() method if available for efficiency
  let output: string;
  if (typeof command.output === "function") {
    output = await command.output("both", { signal: combinedSignal });
  } else {
    const [stdout, stderr] = await Promise.all([
      command.stdout({ signal: combinedSignal }),
      command.stderr({ signal: combinedSignal }),
    ]);
    output = `${stdout}\n${stderr}`.trim();
  }

  const exitCode = command.exitCode ?? -1;

  return {
    success: exitCode === 0,
    output,
    exitCode,
  };
}

/**
 * Get real-time command output using logs() streaming.
 * Collects output into a string while streaming.
 */
export async function getCommandOutputStreaming(
  command: CommandResult,
  options?: {
    signal?: AbortSignal;
    onLog?: (log: { stream: "stdout" | "stderr"; data: string }) => void;
    maxLength?: number;
  },
): Promise<string> {
  const { signal, onLog, maxLength = 100000 } = options ?? {};
  const chunks: string[] = [];
  let length = 0;

  // Use native logs() if available
  if (typeof command.logs === "function") {
    try {
      for await (const log of command.logs({ signal })) {
        onLog?.(log);

        if (length + log.data.length > maxLength) {
          const remaining = maxLength - length;
          if (remaining > 0) {
            chunks.push(log.data.substring(0, remaining));
          }
          chunks.push("\n... [output truncated]");
          break;
        }

        chunks.push(log.data);
        length += log.data.length;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("abort") && !message.includes("cancel")) {
        throw error;
      }
    }

    return chunks.join("");
  }

  // Fallback: use stdout() and stderr()
  const [stdout, stderr] = await Promise.all([
    command.stdout({ signal }),
    command.stderr({ signal }),
  ]);

  return `${stdout}\n${stderr}`.trim();
}
