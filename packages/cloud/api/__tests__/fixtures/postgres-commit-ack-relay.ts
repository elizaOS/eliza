/** Real local PG16 protocol relay for one explicitly armed COMMIT reply loss. */
import { Buffer } from "node:buffer";
import net from "node:net";

export type CommitFault =
  | "before_send"
  | "after_commit"
  | "after_commit_unreadable";

// https://www.postgresql.org/docs/16/protocol-message-formats.html
function readFrames(
  pending: Buffer,
  chunk: Buffer | string,
  dispatch: (kind: string, body: Buffer, frame: Buffer) => void,
): Buffer {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  let remaining = pending.length ? Buffer.concat([pending, bytes]) : bytes;
  while (remaining.length >= 5) {
    const end = 1 + remaining.readUInt32BE(1);
    if (end < 5) throw new Error("Invalid native PostgreSQL test frame");
    if (remaining.length < end) break;
    dispatch(
      String.fromCharCode(remaining[0]!),
      remaining.subarray(5, end),
      remaining.subarray(0, end),
    );
    remaining = remaining.subarray(end);
  }
  return remaining;
}

export async function postgresCommitAckRelay(upstream: {
  host: string;
  port: number;
}) {
  const sessions = new Set<{ pid: number; close(): void }>();
  const armed = new Map<number, CommitFault>();
  const dropped = new Map<number, CommitFault>();
  const droppedObservations = new Set<number>();
  let obscureObservation: number | undefined;
  const server = net.createServer((frontend) => {
    const backend = net.createConnection(upstream);
    let initialized = false;
    let dropping: CommitFault | undefined;
    let closed = false;
    let completed = false;
    let requests: Buffer = Buffer.alloc(0);
    let replies: Buffer = Buffer.alloc(0);
    const session = {
      pid: 0,
      close() {
        if (closed) return;
        closed = true;
        sessions.delete(session);
        frontend.destroy();
        backend.destroy();
      },
    };
    sessions.add(session);
    for (const socket of [frontend, backend]) {
      socket.setNoDelay(true);
      socket.on("error", session.close);
      socket.on("close", session.close);
    }
    frontend.on("data", (chunk) => {
      // The SSL-disabled startup message is not an ordinary framed query.
      // SCRAM is forwarded unchanged and no credential payload is retained.
      if (!initialized) {
        backend.write(chunk);
        return;
      }
      requests = readFrames(requests, chunk, (kind, body, frame) => {
        if (closed) return;
        if (
          obscureObservation !== undefined &&
          (kind === "Q" || kind === "P") &&
          /organization_subscription_authorities[\s\S]+for share/i.test(
            body.toString(),
          )
        ) {
          droppedObservations.add(obscureObservation);
          obscureObservation = undefined;
          session.close();
          return;
        }
        const fault = armed.get(session.pid);
        if (
          kind === "Q" &&
          fault &&
          /^commit;?$/i.test(body.subarray(0, -1).toString().trim())
        ) {
          armed.delete(session.pid);
          if (fault === "before_send") {
            dropped.set(session.pid, fault);
            session.close();
            return;
          }
          dropping = fault;
        }
        backend.write(frame);
      });
    });
    backend.on("data", (chunk) => {
      replies = readFrames(replies, chunk, (kind, body, frame) => {
        if (kind === "K") session.pid = body.readInt32BE(0);
        if (kind === "Z") initialized = true;
        if (!dropping) {
          frontend.write(frame);
          return;
        }
        if (kind === "C") completed = body.toString() === "COMMIT\0";
        if (kind === "Z") {
          // The server committed and is idle. Withhold both success frames
          // from the driver and destroy this exact connection.
          if (completed && body.toString() === "I") {
            dropped.set(session.pid, dropping);
            if (dropping === "after_commit_unreadable")
              obscureObservation = session.pid;
          }
          session.close();
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Native PostgreSQL relay did not get a loopback port");
  return {
    port: address.port,
    arm(pid: number, fault: CommitFault) {
      if (![...sessions].some((session) => session.pid === pid))
        throw new Error(
          "COMMIT acknowledgement loss requires an active recovery session",
        );
      armed.set(pid, fault);
    },
    didDrop: (pid: number, fault: CommitFault) => dropped.get(pid) === fault,
    didDropObservation: (pid: number) => droppedObservations.has(pid),
    async close() {
      for (const session of sessions) session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
