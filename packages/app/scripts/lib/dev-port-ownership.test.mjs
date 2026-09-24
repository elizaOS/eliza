/** Real TCP listeners verify collision rejection preserves the existing server. */
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { test } from "node:test";
import { allocateFirstFreeLoopbackPort } from "./allocate-loopback-port.mjs";
import { assertDevPortsAvailable } from "./dev-port-ownership.mjs";

test("occupied port remains alive after startup is rejected", async () => {
  const server = createServer((socket) => socket.end("existing owner"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      allocateFirstFreeLoopbackPort(port, { maxHops: 1 }),
      /No free TCP port/,
    );
    await assert.rejects(
      assertDevPortsAvailable([port]),
      /No existing process was stopped/,
    );
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("error", reject);
      socket.once("data", (data) => {
        socket.destroy();
        resolve(data.toString());
      });
    });
    assert.equal(response, "existing owner");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assertDevPortsAvailable([port]);
});

test("invalid or duplicate ports cannot start a stack", async () => {
  for (const ports of [[0], [65536], [1.2], [21461, 21461]]) {
    await assert.rejects(assertDevPortsAvailable(ports));
  }
});

test("allocation rejects malformed ranges and non-collision bind errors", async () => {
  for (const port of [0, 65536, 1.2, NaN, Infinity]) {
    await assert.rejects(
      allocateFirstFreeLoopbackPort(port),
      /Invalid preferred port/,
    );
  }
  for (const maxHops of [0, -1, 1.2, Infinity, NaN]) {
    await assert.rejects(
      allocateFirstFreeLoopbackPort(12345, { maxHops }),
      /Invalid port search length/,
    );
  }
  await assert.rejects(
    allocateFirstFreeLoopbackPort(12345, { host: "203.0.113.1" }),
    { code: "EADDRNOTAVAIL" },
  );
});
