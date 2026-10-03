import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import * as path from "node:path";
export const BODY_LIMIT = 10 * 1024 * 1024,
  FRAME_LIMIT = 6 * BODY_LIMIT + 1024 * 1024;
export const TRANSPORT_DEADLINE_MS = 600_000;
const GLOBAL_LIMIT = 64 * 1024 * 1024,
  CONNECTION_LIMIT = 4,
  HEADER_LIMIT = 64 * 1024,
  WRITE_LIMIT = 12 * 1024 * 1024;
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function statOwned(
  file: string,
  kind: "directory" | "file" | "socket",
  mode: number,
) {
  const s = fs.lstatSync(file);
  requireValue(
    s.uid === process.getuid?.() &&
      !s.isSymbolicLink() &&
      (s.mode & 0o777) === mode,
    "Private IPC ownership/mode mismatch",
  );
  requireValue(
    kind === "directory"
      ? s.isDirectory()
      : kind === "socket"
        ? s.isSocket()
        : s.isFile(),
    "Private IPC type mismatch",
  );
  return s;
}
function identity(s: fs.Stats) {
  return `${s.dev}:${s.ino}`;
}
export function endpoint(env = process.env) {
  requireValue(
    env.ELIZA_LOCAL_AGENT_TRANSPORT === "filesystem-v1",
    "Private IPC mode required",
  );
  requireValue(!env.ELIZA_LOCAL_AGENT_SOCKET, "Ambiguous legacy IPC mode");
  const home = env.HOME,
    value = env.ELIZA_LOCAL_AGENT_SOCKET_PATH;
  requireValue(
    home && value && path.isAbsolute(home) && path.isAbsolute(value),
    "Private IPC path required",
  );
  const canonical = fs.realpathSync(home);
  statOwned(canonical, "directory", 0o700);
  requireValue(
    value === path.join(canonical, "ipc", "a.sock") &&
      Buffer.byteLength(value) <= 100,
    "Unexpected private IPC path",
  );
  statOwned(path.dirname(value), "directory", 0o700);
  requireValue(
    fs.realpathSync(path.dirname(value)) === path.dirname(value),
    "Private IPC directory alias",
  );
  if (!absent(value)) statOwned(value, "socket", 0o600);
  return value;
}
function readGeneration(file: string) {
  requireValue(
    statOwned(file, "file", 0o600).size <= 4096,
    "Oversized IPC generation",
  );
  const bytes = fs.readFileSync(file);
  requireValue(bytes.length <= 4096, "Oversized IPC generation");
  const v = JSON.parse(bytes.toString("utf8"));
  requireValue(
    typeof v.generation === "string" &&
      /^[0-9a-f-]{36}$/.test(v.generation) &&
      Number.isInteger(v.pid) &&
      v.pid > 0 &&
      typeof v.inode === "string",
    "Invalid IPC generation",
  );
  return v;
}
function absent(file: string) {
  try {
    fs.lstatSync(file);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}
/** Automatic recovery only when the exact recorded process is definitely gone. PID reuse refuses. */
function recover(file: string, marker: string) {
  if (absent(file) && absent(marker)) return;
  requireValue(
    !absent(file) && !absent(marker),
    "Incomplete IPC generation; explicit recovery required",
  );
  const old = readGeneration(marker),
    s = statOwned(file, "socket", 0o600);
  requireValue(identity(s) === old.inode, "IPC inode changed");
  let gone = false;
  try {
    process.kill(old.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") gone = true;
    else throw e;
  }
  requireValue(gone, "Existing IPC process may be active; never unlink");
  requireValue(
    identity(statOwned(file, "socket", 0o600)) === old.inode &&
      readGeneration(marker).generation === old.generation,
    "IPC changed during recovery",
  );
  fs.unlinkSync(file);
  fs.unlinkSync(marker);
}
export interface PrivateConnection {
  write(frame: unknown): void;
  close(): void;
  readonly aborted: AbortSignal;
}
export async function startPrivateServer(
  dispatch: (
    frame: {
      method: string;
      payload: {
        path: string;
        body?: string;
        headers?: Record<string, string>;
      };
      stream?: boolean;
    },
    connection: PrivateConnection,
  ) => Promise<void>,
  env = process.env,
  policy: { transportDeadlineMs?: number } = {},
) {
  const transportDeadline = policy.transportDeadlineMs ?? TRANSPORT_DEADLINE_MS;
  requireValue(
    Number.isInteger(transportDeadline) &&
      transportDeadline > 0 &&
      transportDeadline <= TRANSPORT_DEADLINE_MS,
    "Invalid transport deadline",
  );
  const file = endpoint(env),
    marker = `${file}.generation`,
    lock = `${file}.lock`;
  const lockFd = fs.openSync(lock, "wx", 0o600),
    lockIdentity = identity(fs.fstatSync(lockFd));
  let server: Server | undefined,
    owned: { generation: string; inode: string; pid: number } | undefined;
  const sockets = new Set<Socket>();
  let bufferedTotal = 0,
    activeConnections = 0,
    closing = false;
  function removeLock() {
    fs.closeSync(lockFd);
    requireValue(
      identity(statOwned(lock, "file", 0o600)) === lockIdentity,
      "IPC startup lock changed",
    );
    fs.unlinkSync(lock);
  }
  try {
    recover(file, marker);
    server = createServer((socket) => {
      if (closing || activeConnections >= CONNECTION_LIMIT) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      activeConnections++;
      let parts: Buffer[] = [],
        size = 0,
        admitted = false,
        released = false;
      const abort = new AbortController();
      const release = () => {
        if (released) return;
        released = true;
        activeConnections--;
        bufferedTotal -= size;
        parts = [];
        size = 0;
      };
      const timer = setTimeout(() => socket.destroy(), 10000);
      timer.unref();
      let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
      socket.once("close", () => {
        clearTimeout(timer);
        clearTimeout(dispatchTimer);
        if (!admitted) release();
        sockets.delete(socket);
        abort.abort();
      });
      socket.on("error", () => {});
      socket.once("end", () => {
        abort.abort();
        if (!admitted) socket.destroy();
      });
      const connection: PrivateConnection = {
        aborted: abort.signal,
        close: () => socket.end(),
        write(frame) {
          const data = `${JSON.stringify(frame)}\n`,
            bytes = Buffer.byteLength(data);
          if (
            bytes > 10 * 1024 * 1024 ||
            socket.writableLength + bytes > WRITE_LIMIT
          ) {
            socket.destroy();
            throw Error("Private IPC response exceeds bounded write budget");
          }
          if (socket.destroyed)
            throw Error(
              "Private IPC disconnected; effect outcome may be unknown",
            );
          socket.write(data);
        },
      };
      socket.on("data", (chunk) => {
        if (admitted) {
          socket.destroy();
          return;
        }
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          newline = b.indexOf(10),
          take = newline < 0 ? b.length : newline;
        if (newline >= 0 && newline !== b.length - 1) {
          socket.destroy();
          return;
        }
        if (size + take > FRAME_LIMIT || bufferedTotal + take > GLOBAL_LIMIT) {
          socket.destroy();
          return;
        }
        // Copy only retained bytes: a tiny slice must not retain an arbitrarily large underlying chunk.
        parts.push(Buffer.from(b.subarray(0, take)));
        size += take;
        bufferedTotal += take;
        if (newline < 0) return;
        admitted = true;
        clearTimeout(timer); // keep reading to observe EOF and reject extra frames
        try {
          const raw = Buffer.concat(parts, size);
          const line = new TextDecoder("utf-8", { fatal: true }).decode(raw);
          const frame = JSON.parse(line);
          requireValue(
            frame && typeof frame === "object" && !Array.isArray(frame),
            "Invalid IPC frame",
          );
          requireValue(
            frame.method === "http_request" ||
              frame.method === "http_request_stream",
            "Unsupported IPC method",
          );
          requireValue(
            (frame.method === "http_request_stream") ===
              (frame.stream === true),
            "Inconsistent IPC stream method",
          );
          const payload = frame.payload;
          requireValue(
            payload && typeof payload === "object" && !Array.isArray(payload),
            "Invalid IPC payload",
          );
          requireValue(
            typeof payload.path === "string" && payload.path.length <= 8192,
            "Invalid IPC route",
          );
          requireValue(
            payload.body === undefined || typeof payload.body === "string",
            "Invalid IPC body",
          );
          requireValue(
            payload.body === undefined ||
              Buffer.byteLength(payload.body) <= BODY_LIMIT,
            "IPC body too large",
          );
          requireValue(
            Buffer.byteLength(JSON.stringify(payload.headers ?? {})) <=
              HEADER_LIMIT,
            "IPC headers too large",
          );
          // Deadline closes transport only; the dispatcher has no cancellation contract.
          dispatchTimer = setTimeout(() => {
            abort.abort();
            socket.destroy();
          }, transportDeadline);
          dispatchTimer.unref();
          // Retain the reservation through dispatch: concurrent parsed requests cannot evade global accounting.
          parts = [];
          void dispatch(frame, connection)
            .then(
              () => socket.end(),
              () => socket.destroy(),
            )
            .finally(() => {
              clearTimeout(dispatchTimer);
              release();
            });
        } catch {
          release();
          socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(file, resolve);
    });
    fs.chmodSync(file, 0o600);
    const s = statOwned(file, "socket", 0o600);
    owned = { generation: randomUUID(), inode: identity(s), pid: process.pid };
    fs.writeFileSync(marker, JSON.stringify(owned), {
      flag: "wx",
      mode: 0o600,
    });
    removeLock();
  } catch (error) {
    // Never delete a foreign/stale endpoint to hide a failed start. Close only our created server.
    if (server?.listening) server.close();
    try {
      removeLock();
    } catch {}
    throw error;
  }
  return {
    file,
    generation: owned?.generation,
    async stop() {
      if (closing) return;
      closing = true;
      requireValue(
        identity(statOwned(file, "socket", 0o600)) === owned?.inode &&
          readGeneration(marker).generation === owned?.generation,
        "IPC endpoint replaced; refuse cleanup",
      );
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
      if (!absent(file)) {
        requireValue(
          identity(statOwned(file, "socket", 0o600)) === owned?.inode,
          "IPC endpoint changed on stop",
        );
        fs.unlinkSync(file);
      }
      requireValue(
        readGeneration(marker).generation === owned?.generation,
        "IPC generation changed on stop",
      );
      fs.unlinkSync(marker);
    },
  };
}
