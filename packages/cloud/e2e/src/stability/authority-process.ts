/**
 * Owns readiness and teardown for the controller's synthetic authority process.
 * A rejected ready record never transfers a live child to a caller that cannot
 * own it; failed startup waits for teardown before exposing the error.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import { ElizaError } from "@elizaos/core/errors";
import { authorityChildEnvironment } from "./cloud-stability-environment.ts";

/** Only a refused TCP connection proves the former loopback listener is absent. */
export async function authorityPortClosed(
  authorityUrl: string,
): Promise<boolean> {
  const url = new URL(authorityUrl);
  if (url.hostname !== "127.0.0.1" || !url.port) {
    throw new ElizaError(
      "Authority closure probe requires explicit IPv4 loopback",
      {
        code: "STABILITY_AUTHORITY_PROBE_INVALID",
      },
    );
  }
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    let settled = false;
    const finish = (error: Error | undefined, closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(closed);
    };
    const deadline = setTimeout(() => {
      finish(
        new ElizaError("Authority TCP closure probe exceeded one second", {
          code: "STABILITY_AUTHORITY_PROBE_TIMEOUT",
        }),
        false,
      );
    }, 1_000);
    socket.once("connect", () => finish(undefined, false));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish(undefined, true);
      else
        finish(
          new ElizaError("Authority TCP closure could not be established", {
            code: "STABILITY_AUTHORITY_PROBE_FAILED",
            cause: error,
          }),
          false,
        );
    });
  });
}

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

/** Transfers a ready loopback authority child to its controller; startup failure tears it down. */
export async function startAuthority(
  repoRoot: string,
  namespace: string,
  token: string,
): Promise<{
  child: ReturnType<typeof spawn>;
  url: string;
}> {
  const child = spawn(
    process.execPath,
    [
      "--conditions=eliza-source",
      path.join(
        repoRoot,
        "packages/cloud/test-mocks/test/fixtures/synthetic-control-authority.ts",
      ),
    ],
    {
      cwd: repoRoot,
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: authorityChildEnvironment(process.env, namespace, token),
    },
  );
  const url = await waitForAuthorityReady(child);
  return { child, url };
}

/** Stops the owned authority before restoring the controller's original signal semantics. */
export function installAuthoritySignalCleanup(
  child: ReturnType<typeof spawn>,
): () => void {
  let handling = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      if (handling) return;
      handling = true;
      const reraise = (): void => {
        for (const [registeredSignal, registeredHandler] of handlers) {
          process.removeListener(registeredSignal, registeredHandler);
        }
        process.kill(process.pid, signal);
      };
      void stopAuthority(child).then(reraise, (error: unknown) => {
        // error-policy:J1 Signal cleanup reports the bounded teardown failure before preserving signal semantics.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[cloud-stability] authority signal cleanup failed: ${message.slice(0, 1_000)}\n`,
        );
        reraise();
      });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}
