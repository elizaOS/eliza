import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { startLocalAgentServer } from "../src/android/private-dispatch.ts";
import {
  BODY_LIMIT,
  startPrivateServer,
  TRANSPORT_DEADLINE_MS,
} from "../src/android/private-ipc.ts";

function fixture() {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir(), "ipc-test-")),
  );
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, "ipc"), { mode: 0o700 });
  return {
    home,
    file: path.join(home, "ipc", "a.sock"),
    env: {
      HOME: home,
      ELIZA_LOCAL_AGENT_TRANSPORT: "filesystem-v1",
      ELIZA_LOCAL_AGENT_SOCKET_PATH: path.join(home, "ipc", "a.sock"),
    },
  };
}
const frame = (body = "") =>
  Buffer.from(
    `${JSON.stringify({ method: "http_request", payload: { method: "POST", path: "/fixture", body } })}\n`,
  );
function request(file: string, bytes: Buffer, split = 65536, finish = true) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(file);
    let output = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Error("Test socket deadline"));
    }, 3000);
    socket.on("data", (b) => (output += b));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
    socket.on("connect", async () => {
      for (let i = 0; i < bytes.length && !socket.destroyed; i += split) {
        if (!socket.write(bytes.subarray(i, i + split)))
          await new Promise<void>((r) => {
            const done = () => {
              socket.off("drain", done);
              socket.off("close", done);
              r();
            };
            socket.once("drain", done);
            socket.once("close", done);
          });
      }
      if (finish) socket.end();
    });
  });
}
test("real private socket preserves escaped 10MiB body, rejects malformed frames and restarts", async () => {
  const f = fixture();
  let calls = 0;
  const dispatch = async (
    value: { payload: { body?: string } },
    c: { write: (v: unknown) => void },
  ) => {
    calls++;
    c.write({ bytes: Buffer.byteLength(value.payload.body ?? "") });
  };
  let server = await startPrivateServer(dispatch, f.env);
  try {
    expect(JSON.parse(await request(f.file, frame("hello"), 1)).bytes).toBe(5);
    expect(
      JSON.parse(await request(f.file, frame("\0".repeat(BODY_LIMIT)))).bytes,
    ).toBe(BODY_LIMIT);
    const before = calls;
    for (const invalid of [
      frame("x".repeat(BODY_LIMIT + 1)),
      Buffer.from([255, 10]),
      Buffer.from("{"),
      Buffer.concat([frame(), frame()]),
    ])
      expect(await request(f.file, invalid)).toBe("");
    expect(calls).toBe(before);
    await expect(startPrivateServer(dispatch, f.env)).rejects.toThrow("active");
    expect(JSON.parse(await request(f.file, frame("alive"))).bytes).toBe(5);
    await server.stop();
    server = await startPrivateServer(dispatch, f.env);
    expect(JSON.parse(await request(f.file, frame("restart"))).bytes).toBe(7);
    await expect(
      startPrivateServer(dispatch, {
        ...f.env,
        ELIZA_LOCAL_AGENT_SOCKET: "legacy",
      }),
    ).rejects.toThrow("Ambiguous");
  } finally {
    await server.stop();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
}, 15000);
test("actual production wrapper retains disconnected dispatch reservations until settlement", async () => {
  const f = fixture();
  let calls = 0;
  const pending: Array<() => void> = [];
  const server = await startLocalAgentServer(
    {} as IAgentRuntime,
    async () => {
      calls++;
      await new Promise<void>((r) => pending.push(r));
      return { status: 200, body: "done" };
    },
    undefined,
    f.env,
    { transportDeadlineMs: 25 },
  );
  try {
    expect(TRANSPORT_DEADLINE_MS).toBe(600000);
    await Promise.all(
      Array.from({ length: 4 }, () => request(f.file, frame(), 65536, false)),
    );
    expect(calls).toBe(4);
    expect(await request(f.file, frame())).toBe("");
    expect(calls).toBe(4);
    pending.splice(0).forEach((r) => {
      r();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    pending.splice(0).forEach((r) => {
      r();
    });
    await server.stop();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
test("admitted peer disconnect is observed without waiting for another frame", async () => {
  const f = fixture();
  let aborts = 0;
  const server = await startPrivateServer(async (_frame, c) => {
    await new Promise<void>((r) => {
      if (c.aborted.aborted) r();
      else c.aborted.addEventListener("abort", () => r(), { once: true });
    });
    aborts++;
  }, f.env);
  try {
    for (let i = 0; i < 8; i++) {
      await request(f.file, frame());
      expect(aborts).toBe(i + 1);
    }
  } finally {
    await server.stop();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

/** Every asynchronous diagnostic is bounded; no sleep is used as evidence. */
async function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = 3000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("actual child crash recovers only its dead generation; live PID and changed inode are preserved", async () => {
  const f = fixture();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...f.env };
  delete childEnv.ELIZA_LOCAL_AGENT_SOCKET;
  const child = spawn(
    process.execPath,
    [
      "--eval",
      `import {startPrivateServer} from ${JSON.stringify(fileURLToPath(new URL("../src/android/private-ipc.ts", import.meta.url)))}; await startPrivateServer(async()=>{}); console.log('READY');`,
    ],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let server: Awaited<ReturnType<typeof startPrivateServer>> | undefined;
  try {
    const [ready] = await bounded(
      once(child.stdout, "data"),
      "child did not announce ready",
    );
    expect(String(ready)).toBe("READY\n");
    const marker = `${f.file}.generation`;
    const original = fs.readFileSync(marker, "utf8");
    const old = JSON.parse(original);
    expect(old.pid).toBe(child.pid);
    await expect(startPrivateServer(async () => {}, f.env)).rejects.toThrow(
      "active",
    );
    expect(fs.readFileSync(marker, "utf8")).toBe(original);
    child.kill("SIGKILL");
    await bounded(exited, "owned child did not exit");
    expect(fs.lstatSync(f.file).isSocket()).toBe(true);
    fs.writeFileSync(
      marker,
      JSON.stringify({ ...old, inode: "changed:inode" }),
    );
    await expect(startPrivateServer(async () => {}, f.env)).rejects.toThrow(
      "inode",
    );
    expect(fs.lstatSync(f.file).ino.toString()).toBe(old.inode.split(":")[1]);
    // A PID reused by a live process must never be interpreted as the dead generation.
    fs.writeFileSync(marker, JSON.stringify({ ...old, pid: process.pid }));
    await expect(startPrivateServer(async () => {}, f.env)).rejects.toThrow(
      "active",
    );
    fs.writeFileSync(marker, original);
    server = await startPrivateServer(async () => {}, f.env);
    expect(server.generation).not.toBe(old.generation);
    await server.stop();
    server = undefined;
    expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    fs.symlinkSync(tmpdir(), f.file);
    await expect(startPrivateServer(async () => {}, f.env)).rejects.toThrow(
      /ownership|type/,
    );
    fs.unlinkSync(f.file);
    fs.chmodSync(path.dirname(f.file), 0o755);
    await expect(startPrivateServer(async () => {}, f.env)).rejects.toThrow(
      "mode",
    );
    fs.chmodSync(path.dirname(f.file), 0o700);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await bounded(exited, "child cleanup deadline");
    }
    if (server) await server.stop();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
}, 10000);

test("aggregate encoded intake is bounded across real sockets and releases on disconnect", async () => {
  const f = fixture();
  let calls = 0;
  const server = await startPrivateServer(async (_frame, c) => {
    calls++;
    c.write({ ok: true });
  }, f.env);
  const held: Socket[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const socket = connect(f.file);
      held.push(socket);
      socket.on("error", () => {});
      await bounded(once(socket, "connect"), "connect deadline");
      const block = Buffer.alloc(1024 * 1024, 32);
      for (let n = 0; n < 17 && !socket.destroyed; n++)
        if (!socket.write(block))
          await bounded(
            new Promise<void>((resolve) => {
              const done = () => {
                socket.off("drain", done);
                socket.off("close", done);
                resolve();
              };
              socket.once("drain", done);
              socket.once("close", done);
            }),
            "intake write deadline",
          );
    }
    if (!held[3].destroyed)
      await bounded(
        once(held[3], "close"),
        "global cap did not refuse fourth17MiB frame",
      );
    expect(held[3].destroyed).toBe(true);
    expect(calls).toBe(0);
    for (const socket of held) socket.destroy();
    // Yield I/O phases, then prove release with a real accepted request (not timing alone).
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(JSON.parse(await request(f.file, frame("small"))).ok).toBe(true);
    expect(calls).toBe(1);
  } finally {
    for (const socket of held) socket.destroy();
    await server.stop();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
}, 10000);

test("incomplete startup lock refuses explicitly and preserves all evidence", async () => {
  const f = fixture();
  const lock = `${f.file}.lock`;
  fs.writeFileSync(lock, "", { mode: 0o600 });
  const inode = fs.lstatSync(lock).ino;
  try {
    await expect(startPrivateServer(async () => {}, f.env)).rejects.toThrow();
    expect(fs.lstatSync(lock).ino).toBe(inode);
    expect(fs.existsSync(f.file)).toBe(false);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
