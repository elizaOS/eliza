/**
 * Owns readiness and teardown for the controller's synthetic authority process.
 * A rejected ready record never transfers a live child to a caller that cannot
 * own it; failed startup waits for teardown before exposing the error.
 */
import type { ChildProcess } from "node:child_process";
import { ElizaError } from "@elizaos/core/errors";

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null || !child.pid;
}

async function awaitExit(
  child: ChildProcess,
  milliseconds: number,
): Promise<boolean> {
  if (exited(child)) return true;
  return new Promise((resolve) => {
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once("close", onClose);
  });
}

export async function stopAuthority(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  child.kill("SIGTERM");
  if (await awaitExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (await awaitExit(child, 5_000)) return;
  throw new ElizaError("Synthetic authority process survived SIGKILL", {
    code: "STABILITY_AUTHORITY_TEARDOWN_FAILED",
    context: { pid: child.pid },
  });
}

export async function waitForAuthorityReady(
  child: ChildProcess,
  timeoutMs = 15_000,
): Promise<string> {
  let stdout = "";
  let stderr = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (error: Error | null, url?: string) => {
        clearTimeout(timer);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        child.stdout?.resume();
        child.stderr?.resume();
        if (error) reject(error);
        else if (url) resolve(url);
      };
      const failure = (message: string, cause?: unknown) =>
        finish(
          new ElizaError(message, {
            code: "STABILITY_AUTHORITY_NOT_READY",
            cause,
          }),
        );
      const onError = (error: Error) =>
        failure("Synthetic authority could not start", error);
      const onClose = (code: number | null) =>
        failure(
          `Synthetic authority exited before ready (${String(code)}): ${stderr.slice(0, 2_000)}`,
        );
      const onStderr = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (Buffer.byteLength(stderr) > 256 * 1024)
          failure("Synthetic authority startup diagnostics exceeded 256 KiB");
      };
      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > 4_096) {
          failure("Synthetic authority ready record exceeded 4096 bytes");
          return;
        }
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try {
          const ready: unknown = JSON.parse(stdout.slice(0, newline));
          if (
            !ready ||
            typeof ready !== "object" ||
            !("type" in ready) ||
            ready.type !== "ready" ||
            !("url" in ready) ||
            typeof ready.url !== "string"
          ) {
            failure("Synthetic authority emitted an invalid ready record");
            return;
          }
          const url = new URL(ready.url);
          if (
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            !url.port ||
            url.username ||
            url.password
          ) {
            failure("Synthetic authority emitted a non-loopback ready record");
            return;
          }
          finish(null, ready.url);
        } catch (error) {
          // error-policy:J3 Malformed readiness is rejected before ownership transfer.
          failure(
            "Synthetic authority emitted invalid ready JSON or URL",
            error,
          );
        }
      };
      const timer = setTimeout(
        () =>
          failure(
            "Synthetic authority did not become ready before its deadline",
          ),
        timeoutMs,
      );
      child.once("error", onError);
      child.once("close", onClose);
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
    });
  } catch (error) {
    // error-policy:J2 Startup retains child ownership until teardown completes.
    try {
      await stopAuthority(child);
    } catch (cleanupError) {
      // error-policy:J2 Retain both the rejected startup and failed ownership cleanup.
      throw new ElizaError("Synthetic authority startup and teardown failed", {
        code: "STABILITY_AUTHORITY_STARTUP_CLEANUP_FAILED",
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
}
