import { createServer, type Server, type Socket } from "node:net";
import type { InstallExecutionResult } from "./executor";
import {
  type ActiveOwnerSession,
  type ActiveOwnerSessionProvider,
  type LocalInstallExecutionRequest,
  type LocalInstallPeerCredentials,
  type LocalInstallPeerProcessIdentity,
  parseLocalInstallExecutionFrame,
} from "./root-service";

export const MAX_UNIX_INSTALL_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_FRAME_TIMEOUT_MILLISECONDS = 5_000;
export const DEFAULT_EXECUTION_TIMEOUT_MILLISECONDS = 6 * 60 * 60 * 1_000;
export const MIN_EXECUTION_TIMEOUT_MILLISECONDS = 1_000;
export const MAX_EXECUTION_TIMEOUT_MILLISECONDS = 24 * 60 * 60 * 1_000;
const FRAME_HEADER_BYTES = 4;

export interface KernelUnixPeerCredentials {
  uid: number;
  gid: number;
  /** SO_PEERPIDFD/pidfd-backed handle captured with SO_PEERCRED. */
  process: KernelBoundPeerProcessHandle;
}

export interface KernelBoundPeerProcessHandle {
  readonly pid: number;
  /** Revalidate the same kernel process object, never a numeric PID lookup. */
  isAlive(): Promise<boolean>;
  /** Release the pidfd only after request work reaches a terminal state. */
  close(): void;
}

/**
 * Native boundary. This synchronous call must atomically capture SO_PEERCRED
 * and a non-reusable SO_PEERPIDFD/pidfd handle before control can yield.
 */
export interface LinuxUnixPeerCredentialProvider {
  inspect(socket: Socket): KernelUnixPeerCredentials;
}

export interface LogindSessionResolver {
  inspectForProcess(
    process: KernelBoundPeerProcessHandle,
    uid: number,
  ): Promise<ActiveOwnerSession | null>;
}

export class LinuxLogindActiveOwnerSessionProvider
  implements ActiveOwnerSessionProvider
{
  readonly logind: LogindSessionResolver;
  readonly handles = new WeakMap<
    object,
    { handle: KernelBoundPeerProcessHandle; uid: number }
  >();

  constructor(logind: LogindSessionResolver) {
    this.logind = logind;
  }

  bindPeer(peer: KernelUnixPeerCredentials): LocalInstallPeerProcessIdentity {
    if (
      !Number.isSafeInteger(peer.process.pid) ||
      peer.process.pid <= 0 ||
      typeof peer.process.isAlive !== "function" ||
      typeof peer.process.close !== "function"
    ) {
      throw new Error("Installer peer lacks a kernel-bound process handle.");
    }
    const token = Object.freeze({});
    this.handles.set(token, { handle: peer.process, uid: peer.uid });
    return { pid: peer.process.pid, livenessToken: token };
  }

  async inspectForProcess(
    process: LocalInstallPeerProcessIdentity,
  ): Promise<ActiveOwnerSession | null> {
    const binding = this.handles.get(process.livenessToken);
    if (!binding || binding.handle.pid !== process.pid) {
      return null;
    }
    const { handle, uid } = binding;
    try {
      if (!(await handle.isAlive())) {
        return null;
      }
      const session = await this.logind.inspectForProcess(handle, uid);
      if (!(await handle.isAlive())) {
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }
}

export interface UnixInstallService {
  readonly abortSemantics: "confirmed-stop-or-lock-retained";
  execute(
    input: unknown,
    peer: LocalInstallPeerCredentials,
    signal: AbortSignal,
  ): Promise<InstallExecutionResult>;
}

export interface UnixInstallServerOptions {
  service: UnixInstallService;
  peerCredentials: LinuxUnixPeerCredentialProvider;
  activeOwner: LinuxLogindActiveOwnerSessionProvider;
  frameTimeoutMilliseconds?: number;
  executionTimeoutMilliseconds?: number;
  maxConnections?: number;
}

export class InstallerRequestGate {
  readonly maximum: number;
  active = 0;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error("Installer transport connection limit is invalid.");
    }
    this.maximum = maximum;
  }

  tryEnter(): (() => void) | null {
    if (this.active >= this.maximum) {
      return null;
    }
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }
}

export function rejectOverloadedUnixSocket(
  socket: Pick<Socket, "destroy">,
): void {
  // No Error argument: an overload is expected control flow and must not emit
  // an unhandled socket error before callers have installed a listener.
  socket.destroy();
}

export function parseUnixInstallWireFrame(
  input: Uint8Array,
): LocalInstallExecutionRequest {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_UNIX_INSTALL_FRAME_BYTES + FRAME_HEADER_BYTES) {
    throw new Error(
      "Installer IPC connection exceeded the bounded frame size.",
    );
  }
  if (bytes.length < FRAME_HEADER_BYTES) {
    throw new Error("Installer IPC connection ended before its frame header.");
  }
  const declared = bytes.readUInt32BE(0);
  if (declared === 0 || declared > MAX_UNIX_INSTALL_FRAME_BYTES) {
    throw new Error("Installer IPC frame length is invalid.");
  }
  if (bytes.length !== FRAME_HEADER_BYTES + declared) {
    throw new Error(
      "Installer IPC connection contains a partial or trailing frame.",
    );
  }
  return parseLocalInstallExecutionFrame(bytes.subarray(FRAME_HEADER_BYTES));
}

async function readSingleFrame(
  socket: Socket,
): Promise<LocalInstallExecutionRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let ended = false;

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > MAX_UNIX_INSTALL_FRAME_BYTES + FRAME_HEADER_BYTES) {
        socket.pause();
        fail(
          new Error(
            "Installer IPC connection exceeded the bounded frame size.",
          ),
        );
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      ended = true;
      cleanup();
      try {
        resolve(parseUnixInstallWireFrame(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => {
      if (!ended) {
        fail(new Error("Installer IPC connection closed before its frame."));
      }
    };

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function writeResponse(socket: Socket, value: unknown): void {
  if (socket.destroyed) {
    return;
  }
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length);
  socket.end(Buffer.concat([header, body]));
}

export function createUnixInstallServer(
  options: UnixInstallServerOptions,
): Server {
  if (options.service.abortSemantics !== "confirmed-stop-or-lock-retained") {
    throw new Error(
      "Installer transport requires confirmed cancellation or retained target locks.",
    );
  }
  const maximum = options.maxConnections ?? 8;
  const frameTimeoutMilliseconds =
    options.frameTimeoutMilliseconds ?? DEFAULT_FRAME_TIMEOUT_MILLISECONDS;
  const executionTimeoutMilliseconds =
    options.executionTimeoutMilliseconds ??
    DEFAULT_EXECUTION_TIMEOUT_MILLISECONDS;
  const gate = new InstallerRequestGate(maximum);
  if (
    !Number.isSafeInteger(frameTimeoutMilliseconds) ||
    frameTimeoutMilliseconds <= 0 ||
    frameTimeoutMilliseconds > 60_000
  ) {
    throw new Error("Installer transport frame timeout is invalid.");
  }
  if (
    !Number.isSafeInteger(executionTimeoutMilliseconds) ||
    executionTimeoutMilliseconds < MIN_EXECUTION_TIMEOUT_MILLISECONDS ||
    executionTimeoutMilliseconds > MAX_EXECUTION_TIMEOUT_MILLISECONDS
  ) {
    throw new Error("Installer transport execution timeout is invalid.");
  }
  const server = createServer({ allowHalfOpen: true }, async (socket) => {
    const leave = gate.tryEnter();
    if (!leave) {
      rejectOverloadedUnixSocket(socket);
      return;
    }
    let kernelProcess: KernelBoundPeerProcessHandle | undefined;
    const cancellation = new AbortController();
    const frameDeadline = setTimeout(
      () => socket.destroy(),
      frameTimeoutMilliseconds,
    );
    frameDeadline.unref();
    let executionDeadline: NodeJS.Timeout | undefined;
    try {
      // Native SO_PEERCRED + pidfd capture is deliberately synchronous: no
      // promise or request byte is observed before the kernel identity exists.
      const kernelPeer = options.peerCredentials.inspect(socket);
      kernelProcess = kernelPeer.process;
      const process = options.activeOwner.bindPeer(kernelPeer);
      const request = await readSingleFrame(socket);
      clearTimeout(frameDeadline);
      executionDeadline = setTimeout(() => {
        cancellation.abort(new Error("Installer execution timed out."));
        socket.destroy();
      }, executionTimeoutMilliseconds);
      executionDeadline.unref();
      const result = await options.service.execute(
        request,
        {
          transport: "unix",
          uid: kernelPeer.uid,
          gid: kernelPeer.gid,
          process,
        },
        cancellation.signal,
      );
      writeResponse(socket, { ok: true, result });
    } catch (error) {
      writeResponse(socket, {
        ok: false,
        error:
          error instanceof Error ? error.message : "Installer request failed.",
      });
    } finally {
      clearTimeout(frameDeadline);
      clearTimeout(executionDeadline);
      // The handle remains live across an ignored timeout, keeping identity
      // and target-lock checks possible until the handler actually settles.
      try {
        kernelProcess?.close();
      } catch {
        socket.destroy();
      }
      leave();
    }
  });
  server.maxConnections = maximum;
  return server;
}

export async function listenUnixInstallServer(
  server: Server,
  socketPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!socketPath.startsWith("/run/") || socketPath.includes("\0")) {
    throw new Error("Installer service socket must use an absolute /run path.");
  }
  if (
    environment.LISTEN_PID !== String(process.pid) ||
    environment.LISTEN_FDS !== "1" ||
    environment.LISTEN_FDNAMES !== "installer"
  ) {
    throw new Error(
      "Installer service requires exactly one named systemd AF_UNIX listener.",
    );
  }
  delete environment.LISTEN_PID;
  delete environment.LISTEN_FDS;
  delete environment.LISTEN_FDNAMES;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ fd: 3 }, () => {
      server.off("error", reject);
      if (server.address() !== socketPath) {
        server.close();
        reject(
          new Error(
            "Activated installer listener does not match its trusted AF_UNIX path.",
          ),
        );
        return;
      }
      resolve();
    });
  });
}
