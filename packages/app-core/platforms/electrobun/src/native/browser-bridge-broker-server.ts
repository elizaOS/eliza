/** Hosts the authenticated enrollment broker on a bounded current-user IPC listener. */

import { spawn } from "node:child_process";
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

async function startWindowsSecureBrokerServer(options: {
  descriptor: WindowsBrokerTransportDescriptor;
  broker: BrowserBridgeEnrollmentBroker;
  helperPath?: string;
}): Promise<BrowserBridgeBrokerServerHandle> {
  const invocation = windowsSecurePipeHostInvocation(
    options.descriptor,
    options.helperPath ?? resolveWindowsSecurePipeHelper(import.meta.dir),
  );
  const child = spawn(invocation.command, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
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
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Windows secure pipe helper startup timed out")),
      5_000,
    );
    child.once("error", reject);
    child.stderr.on("data", (chunk) => {
      if (!Buffer.from(chunk).toString("utf8").includes("READY")) return;
      clearTimeout(timeout);
      resolve();
    });
  });
  return {
    descriptor: options.descriptor,
    close: async () => {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
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
}): Promise<BrowserBridgeBrokerServerHandle> {
  const { descriptor } = options;
  if (descriptor.kind === "windows_named_pipe") {
    return startWindowsSecureBrokerServer({
      descriptor,
      broker: options.broker,
      helperPath: options.windowsSecurePipeHelperPath,
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
