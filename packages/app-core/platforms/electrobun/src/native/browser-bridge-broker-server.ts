/** Hosts the authenticated enrollment broker on a bounded current-user IPC listener. */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  assertUnixBrokerSocketSecurity,
  assertUnixSocketPathLength,
  type BrowserBridgeBrokerTransportDescriptor,
  prepareUnixBrokerSocketDirectory,
  type UnixBrokerTransportDescriptor,
  type WindowsBrokerTransportDescriptor,
} from "./browser-bridge-broker-transport";
import type { BrowserBridgeEnrollmentBroker } from "./browser-bridge-enrollment-broker";

const MAX_BROKER_FRAME_BYTES = 64 * 1024;
const CONNECTION_TIMEOUT_MS = 5_000;
const WINDOWS_HELPER_SHUTDOWN_TIMEOUT_MS = 2_000;

export interface BrowserBridgeBrokerServerHandle {
  descriptor: BrowserBridgeBrokerTransportDescriptor;
  close(): Promise<void>;
}

export function windowsSecurePipeHostInvocation(
  descriptor: WindowsBrokerTransportDescriptor,
  helperPath: string,
): { command: string; args: string[] } {
  if (
    (!path.isAbsolute(helperPath) && !path.win32.isAbsolute(helperPath)) ||
    !helperPath.endsWith(".ps1")
  ) {
    throw new Error("Windows secure pipe helper path is invalid");
  }
  const pipeName = descriptor.pipePath.replace(/^\\\\\.\\pipe\\/, "");
  if (!pipeName || pipeName.includes("\\")) {
    throw new Error("Windows secure pipe name is invalid");
  }
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
      "-PipeName",
      pipeName,
    ],
  };
}

export function resolveWindowsSecurePipeHelper(
  moduleDir: string,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const candidates = [
    path.resolve(moduleDir, "browser-bridge-pipe-host.ps1"),
    path.resolve(moduleDir, "..", "browser-bridge-pipe-host.ps1"),
    path.resolve(
      moduleDir,
      "..",
      "..",
      "scripts",
      "browser-bridge-pipe-host.ps1",
    ),
  ];
  const resolved = candidates.find(exists);
  if (!resolved)
    throw new Error("packaged Windows secure pipe helper is missing");
  return resolved;
}

function waitForWindowsHelperExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

export async function terminateWindowsSecurePipeHelper(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = WINDOWS_HELPER_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulExit = waitForWindowsHelperExit(child, timeoutMs);
  child.kill();
  if (await gracefulExit) return;
  const forcedExit = waitForWindowsHelperExit(child, timeoutMs);
  child.kill("SIGKILL");
  if (!(await forcedExit)) {
    throw new Error("Windows secure pipe helper did not exit");
  }
}

async function startWindowsSecureBrokerServer(options: {
  descriptor: WindowsBrokerTransportDescriptor;
  broker: BrowserBridgeEnrollmentBroker;
  helperPath?: string;
  spawnImpl?: typeof spawn;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}): Promise<BrowserBridgeBrokerServerHandle> {
  const invocation = windowsSecurePipeHostInvocation(
    options.descriptor,
    options.helperPath ?? resolveWindowsSecurePipeHelper(import.meta.dir),
  );
  const child = (options.spawnImpl ?? spawn)(
    invocation.command,
    invocation.args,
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  let pending = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.byteLength < 4) return;
    const length = pending.readUInt32LE(0);
    if (length === 0 || length > MAX_BROKER_FRAME_BYTES) {
      child.kill();
      return;
    }
    if (pending.byteLength < length + 4) return;
    const body = pending.subarray(4, length + 4);
    pending = pending.subarray(length + 4);
    let input: unknown;
    try {
      input = JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      // error-policy:J3 malformed helper input is translated by the broker boundary.
      input = null;
    }
    void options.broker.handle(input).then((response) => {
      const responseBody = Buffer.from(JSON.stringify(response), "utf8");
      const frame = Buffer.allocUnsafe(responseBody.byteLength + 4);
      frame.writeUInt32LE(responseBody.byteLength, 0);
      responseBody.copy(frame, 4);
      child.stdin.write(frame);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.stderr.removeListener("data", onStderr);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        finish(
          new Error(
            `Windows secure pipe helper exited before readiness (${code ?? signal ?? "unknown"})`,
          ),
        );
      const onStderr = (chunk: Uint8Array) => {
        stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-1024);
        if (stderr.includes("READY")) finish();
      };
      const timeout = setTimeout(
        () => finish(new Error("Windows secure pipe helper startup timed out")),
        options.startupTimeoutMs ?? 5_000,
      );
      child.once("error", onError);
      child.once("exit", onExit);
      child.stderr.on("data", onStderr);
    });
  } catch (error) {
    // error-policy:J2 failed helper startup is reaped before preserving the startup failure.
    try {
      await terminateWindowsSecurePipeHelper(child, options.shutdownTimeoutMs);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Windows secure pipe helper startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
  let closing = false;
  let unexpectedFailure: Error | null = null;
  child.once("error", (error) => {
    if (!closing) {
      unexpectedFailure = new Error(
        "Windows secure pipe helper failed after readiness",
        { cause: error },
      );
    }
  });
  child.once("exit", (code, signal) => {
    if (!closing) {
      unexpectedFailure = new Error(
        `Windows secure pipe helper exited unexpectedly (${code ?? signal ?? "unknown"})`,
      );
    }
  });
  return {
    descriptor: options.descriptor,
    close: async () => {
      closing = true;
      await terminateWindowsSecurePipeHelper(child, options.shutdownTimeoutMs);
      if (unexpectedFailure) throw unexpectedFailure;
    },
  };
}

function removeOwnedStaleUnixSocket(
  descriptor: UnixBrokerTransportDescriptor,
): void {
  if (!fs.existsSync(descriptor.socketPath)) return;
  const stat = fs.lstatSync(descriptor.socketPath);
  if (
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    stat.uid !== descriptor.expectedUid
  ) {
    throw new Error(
      "refusing to replace an unowned browser bridge broker endpoint",
    );
  }
  fs.unlinkSync(descriptor.socketPath);
}

export async function startBrowserBridgeBrokerServer(options: {
  descriptor: BrowserBridgeBrokerTransportDescriptor;
  broker: BrowserBridgeEnrollmentBroker;
  windowsSecurePipeHelperPath?: string;
  windowsSpawn?: typeof spawn;
  windowsHelperStartupTimeoutMs?: number;
  windowsHelperShutdownTimeoutMs?: number;
}): Promise<BrowserBridgeBrokerServerHandle> {
  const { descriptor } = options;
  if (descriptor.kind === "windows_named_pipe") {
    return startWindowsSecureBrokerServer({
      descriptor,
      broker: options.broker,
      helperPath: options.windowsSecurePipeHelperPath,
      spawnImpl: options.windowsSpawn,
      startupTimeoutMs: options.windowsHelperStartupTimeoutMs,
      shutdownTimeoutMs: options.windowsHelperShutdownTimeoutMs,
    });
  }
  assertUnixSocketPathLength(descriptor.socketPath);
  prepareUnixBrokerSocketDirectory(descriptor);
  removeOwnedStaleUnixSocket(descriptor);
  let accepting = true;
  const server = net.createServer((socket) => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
    let pending = Buffer.alloc(0);
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) {
        socket.destroy();
        return;
      }
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (pending.byteLength < 4) return;
      const length = pending.readUInt32LE(0);
      if (length === 0 || length > MAX_BROKER_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      if (pending.byteLength < length + 4) return;
      if (pending.byteLength !== length + 4) {
        socket.destroy();
        return;
      }
      handled = true;
      void (async () => {
        let input: unknown;
        try {
          input = JSON.parse(pending.subarray(4).toString("utf8")) as unknown;
        } catch {
          // error-policy:J3 malformed broker input is translated into the canonical bounded error.
          input = null;
        }
        const response = await options.broker.handle(input);
        const body = Buffer.from(JSON.stringify(response), "utf8");
        const frame = Buffer.allocUnsafe(body.byteLength + 4);
        frame.writeUInt32LE(body.byteLength, 0);
        body.copy(frame, 4);
        socket.end(frame);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(descriptor.socketPath, resolve);
  });
  try {
    fs.chmodSync(descriptor.socketPath, descriptor.socketMode);
    assertUnixBrokerSocketSecurity(descriptor);
  } catch (error) {
    // error-policy:J2 listener security setup is rolled back before preserving the failure.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    descriptor,
    close: async () => {
      accepting = false;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (fs.existsSync(descriptor.socketPath)) {
        const stat = fs.lstatSync(descriptor.socketPath);
        if (stat.isSocket() && stat.uid === descriptor.expectedUid)
          fs.unlinkSync(descriptor.socketPath);
      }
    },
  };
}
