/**
 * Defines current-user-only IPC endpoints used by the browser native host to
 * reach the desktop broker without exposing enrollment on a TCP port.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "./auth-bridge";

export const BROWSER_BRIDGE_BROKER_SOCKET_NAME = "b.sock";
export const BROWSER_BRIDGE_BROKER_SOCKET_DIRECTORY = "bb";
export const MAC_BROWSER_BRIDGE_APP_GROUP = "group.ai.elizaos.browserbridge";
export const WINDOWS_PIPE_SDDL_SYSTEM_AND_USER =
  "O:{CURRENT_USER_SID}D:P(A;;GA;;;SY)(A;;GA;;;{CURRENT_USER_SID})";

export interface UnixBrokerTransportDescriptor {
  kind: "unix";
  socketPath: string;
  directoryMode: 0o700;
  socketMode: 0o600;
  expectedUid: number;
  directoryPolicy: "managed" | "apple_app_group";
}

export interface WindowsBrokerTransportDescriptor {
  kind: "windows_named_pipe";
  pipePath: string;
  currentUserSid: string;
  sddl: string;
  rejectRemoteClients: true;
}

export type BrowserBridgeBrokerTransportDescriptor =
  | UnixBrokerTransportDescriptor
  | WindowsBrokerTransportDescriptor;

export interface BrowserBridgeBrokerTransport {
  readonly descriptor: BrowserBridgeBrokerTransportDescriptor;
  request(message: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
}

const BROKER_IO_TIMEOUT_MS = 5_000;
const BROKER_MAX_FRAME_BYTES = 64 * 1024;
const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES = 103;
const OTHER_UNIX_SOCKET_PATH_MAX_BYTES = 107;

export class UnixSocketPathTooLongError extends Error {
  readonly code = "UNIX_SOCKET_PATH_TOO_LONG";

  constructor(
    readonly socketPath: string,
    readonly maxBytes: number,
  ) {
    super(`browser bridge Unix socket path exceeds ${maxBytes} UTF-8 bytes`);
    this.name = "UnixSocketPathTooLongError";
  }
}

export function assertUnixSocketPathLength(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const maxBytes =
    platform === "darwin"
      ? DARWIN_UNIX_SOCKET_PATH_MAX_BYTES
      : OTHER_UNIX_SOCKET_PATH_MAX_BYTES;
  if (Buffer.byteLength(socketPath, "utf8") > maxBytes) {
    throw new UnixSocketPathTooLongError(socketPath, maxBytes);
  }
}

export class NodeBrowserBridgeBrokerTransport
  implements BrowserBridgeBrokerTransport
{
  constructor(
    readonly descriptor: BrowserBridgeBrokerTransportDescriptor,
    private readonly timeoutMs = BROKER_IO_TIMEOUT_MS,
  ) {}

  request(message: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (
      message.byteLength === 0 ||
      message.byteLength > BROKER_MAX_FRAME_BYTES
    ) {
      return Promise.reject(
        new Error("browser bridge broker request size is invalid"),
      );
    }
    if (this.descriptor.kind === "unix") {
      assertUnixSocketPathLength(this.descriptor.socketPath);
      assertUnixBrokerSocketSecurity(this.descriptor);
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const socket = net.createConnection(
        this.descriptor.kind === "unix"
          ? { path: this.descriptor.socketPath }
          : { path: this.descriptor.pipePath },
      );
      let settled = false;
      let pending = Buffer.alloc(0);
      const finish = (error?: Error, value?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else if (value) resolve(value);
        else reject(new Error("browser bridge broker response is unavailable"));
      };
      const abort = (): void =>
        finish(new Error("browser bridge broker request aborted"));
      const timeout = setTimeout(
        () => finish(new Error("browser bridge broker request timed out")),
        this.timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("error", (error) => finish(error));
      socket.once("connect", () => {
        const frame = Buffer.allocUnsafe(message.byteLength + 4);
        frame.writeUInt32LE(message.byteLength, 0);
        Buffer.from(message).copy(frame, 4);
        socket.write(frame);
      });
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        if (pending.byteLength < 4) return;
        const length = pending.readUInt32LE(0);
        if (length === 0 || length > BROKER_MAX_FRAME_BYTES) {
          finish(new Error("browser bridge broker response size is invalid"));
          return;
        }
        if (pending.byteLength < length + 4) return;
        if (pending.byteLength !== length + 4) {
          finish(new Error("browser bridge broker returned trailing bytes"));
          return;
        }
        finish(undefined, pending.subarray(4));
      });
      socket.once("end", () => {
        if (!settled)
          finish(new Error("browser bridge broker closed a partial response"));
      });
      if (signal?.aborted) abort();
    });
  }
}

export function createUnixBrokerTransportDescriptor(
  env: NodeJS.ProcessEnv = process.env,
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
): UnixBrokerTransportDescriptor {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("current user uid is unavailable");
  }
  const descriptor: UnixBrokerTransportDescriptor = {
    kind: "unix",
    socketPath: path.join(
      resolveStateDir(env),
      BROWSER_BRIDGE_BROKER_SOCKET_DIRECTORY,
      BROWSER_BRIDGE_BROKER_SOCKET_NAME,
    ),
    directoryMode: 0o700,
    socketMode: 0o600,
    expectedUid: uid,
    directoryPolicy: "managed",
  };
  assertUnixSocketPathLength(descriptor.socketPath);
  return descriptor;
}

export function createMacAppGroupBrokerTransportDescriptor(
  appGroupContainerPath: string,
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
): UnixBrokerTransportDescriptor {
  if (!path.isAbsolute(appGroupContainerPath) || uid < 0) {
    throw new Error("macOS browser bridge app-group container is invalid");
  }
  const descriptor: UnixBrokerTransportDescriptor = {
    kind: "unix",
    socketPath: path.join(
      appGroupContainerPath,
      BROWSER_BRIDGE_BROKER_SOCKET_NAME,
    ),
    directoryMode: 0o700,
    socketMode: 0o600,
    expectedUid: uid,
    directoryPolicy: "apple_app_group",
  };
  assertUnixSocketPathLength(descriptor.socketPath, "darwin");
  return descriptor;
}

export function prepareUnixBrokerSocketDirectory(
  descriptor: UnixBrokerTransportDescriptor,
): void {
  const directory = path.dirname(descriptor.socketPath);
  if (descriptor.directoryPolicy === "managed") {
    fs.mkdirSync(directory, {
      recursive: true,
      mode: descriptor.directoryMode,
    });
  }
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const component of absolute
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    const componentStat = fs.lstatSync(current);
    if (componentStat.isSymbolicLink()) {
      if (
        process.platform === "darwin" &&
        (current === "/var" || current === "/tmp")
      ) {
        current = fs.realpathSync(current);
        continue;
      }
      throw new Error("browser bridge broker socket path traverses a symlink");
    }
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      "browser bridge broker socket directory must be a real directory",
    );
  }
  if (typeof stat.uid === "number" && stat.uid !== descriptor.expectedUid) {
    throw new Error(
      "browser bridge broker socket directory is not owned by the current user",
    );
  }
  if (descriptor.directoryPolicy === "managed") {
    fs.chmodSync(directory, descriptor.directoryMode);
  }
}

export function assertUnixBrokerSocketSecurity(
  descriptor: UnixBrokerTransportDescriptor,
): void {
  const stat = fs.lstatSync(descriptor.socketPath);
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new Error("browser bridge broker endpoint is not a Unix socket");
  }
  if (typeof stat.uid === "number" && stat.uid !== descriptor.expectedUid) {
    throw new Error(
      "browser bridge broker socket is not owned by the current user",
    );
  }
  if ((stat.mode & 0o777) !== descriptor.socketMode) {
    throw new Error("browser bridge broker socket must have mode 0600");
  }
}

function validateWindowsSid(value: string): string {
  if (!/^S-1-(?:\d+-){1,14}\d+$/.test(value)) {
    throw new Error("current user Windows SID is invalid");
  }
  return value;
}

interface WindowsSidCommandResult {
  status: number | null;
  stdout: string;
}

export function resolveWindowsCurrentUserSid(
  run: (
    command: string,
    args: string[],
    options: {
      encoding: "utf8";
      timeout: number;
      windowsHide: true;
    },
  ) => WindowsSidCommandResult = spawnSync,
): string {
  const result = run("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error("current user Windows SID lookup failed");
  }
  const match = result.stdout.match(/S-1-(?:\d+-){1,14}\d+/);
  if (!match)
    throw new Error("current user Windows SID lookup returned no SID");
  return validateWindowsSid(match[0]);
}

export function createWindowsBrokerTransportDescriptor(
  currentUserSid: string,
  brokerSecret: Uint8Array,
): WindowsBrokerTransportDescriptor {
  const sid = validateWindowsSid(currentUserSid);
  if (brokerSecret.byteLength !== 32) {
    throw new Error(
      "Windows broker transport requires the 32-byte broker secret",
    );
  }
  const stableUserSuffix = crypto
    .createHmac("sha256", brokerSecret)
    .update(`windows-pipe:${sid}`)
    .digest("base64url")
    .slice(0, 32);
  return {
    kind: "windows_named_pipe",
    pipePath: `\\\\.\\pipe\\ai.elizaos.browserbridge-${stableUserSuffix}`,
    currentUserSid: sid,
    sddl: WINDOWS_PIPE_SDDL_SYSTEM_AND_USER.replaceAll(
      "{CURRENT_USER_SID}",
      sid,
    ),
    rejectRemoteClients: true,
  };
}

export function defaultBrokerTransportDescriptor(options?: {
  env?: NodeJS.ProcessEnv;
  uid?: number;
  windowsUserSid?: string;
  windowsSidResolver?: () => string;
  brokerSecret?: Uint8Array;
  platform?: NodeJS.Platform;
}): BrowserBridgeBrokerTransportDescriptor {
  const platform = options?.platform ?? os.platform();
  if (platform === "win32") {
    const sid =
      options?.windowsUserSid ??
      (options?.windowsSidResolver ?? resolveWindowsCurrentUserSid)();
    if (!options?.brokerSecret) {
      throw new Error("Windows broker transport requires the broker secret");
    }
    return createWindowsBrokerTransportDescriptor(sid, options.brokerSecret);
  }
  return createUnixBrokerTransportDescriptor(options?.env, options?.uid);
}
