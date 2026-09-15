/** Real TCP listeners verify collision rejection preserves the existing server. */
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { test } from "node:test";
import { assertDevPortsAvailable } from "./dev-port-ownership.mjs";

test("occupied port remains alive after startup is rejected", async () => {
  const server = createServer((socket) => socket.end("existing owner"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
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
