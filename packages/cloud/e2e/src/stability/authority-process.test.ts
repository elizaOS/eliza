/** Exercises readiness failures against real child processes that keep running after malformed output. */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import {
  authorityPortClosed,
  stopAuthority,
  waitForAuthorityReady,
} from "./authority-process.ts";

test("an open TCP listener that never answers HTTP cannot prove authority closure", async () => {
  const sockets = new Set<Socket>();
  let accepted = 0;
  let receivedBytes = 0;
  const server = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("data", (bytes) => {
      receivedBytes += bytes.length;
    });
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("TCP fixture did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const connection = once(server, "connection");
    expect(await authorityPortClosed(url)).toBe(false);
    await connection;
    expect(server.listening).toBe(true);
    expect(accepted).toBe(1);
    expect(receivedBytes).toBe(0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  expect(receivedBytes).toBe(0);
  expect(await authorityPortClosed(url)).toBe(true);
});

for (const record of ["not-json", JSON.stringify({ type: "ready", url: 42 })]) {
  test(`invalid readiness stops its owned child before rejecting: ${record}`, async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(`${record}\n`)}); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } },
    );
    try {
      await expect(waitForAuthorityReady(child)).rejects.toThrow();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    }
  });
}

test("valid readiness transfers a live loopback authority and teardown closes it", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("authority-ready")}); process.stdout.write(JSON.stringify({type:"ready",url:"http://127.0.0.1:"+server.port})+"\\n");`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } },
  );
  try {
    const url = await waitForAuthorityReady(child);
    expect(await (await fetch(url)).text()).toBe("authority-ready");
    await stopAuthority(child);
    await expect(
      fetch(url, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  } finally {
    await stopAuthority(child);
  }
});

test("silent startup deadline closes the owned process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  try {
    await expect(waitForAuthorityReady(child, 100)).rejects.toThrow("deadline");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    await stopAuthority(child);
  }
});

test("spawn failure rejects without leaving a readiness timer", async () => {
  const child = spawn("/definitely-absent-authority-binary", [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await expect(waitForAuthorityReady(child)).rejects.toThrow("could not start");
  expect(child.pid).toBeUndefined();
});
