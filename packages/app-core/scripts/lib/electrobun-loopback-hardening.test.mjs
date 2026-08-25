import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hardenElectrobunRpcSockets } from "./electrobun-loopback-hardening.mjs";

const VULNERABLE = `server = Bun.serve<{ webviewId: number }>({\n\tport,\n`;

function fixture(source = VULNERABLE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "electrobun-loopback-"));
  for (const dist of ["dist", "dist-linux-x64"]) {
    const dir = path.join(root, dist, "api", "bun", "core");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Socket.ts"), source);
  }
  return root;
}

test("hardens shared and downloaded platform RPC sockets idempotently", () => {
  const root = fixture();
  try {
    assert.equal(hardenElectrobunRpcSockets(root).length, 2);
    assert.equal(hardenElectrobunRpcSockets(root).length, 0);
    for (const dist of ["dist", "dist-linux-x64"]) {
      const source = fs.readFileSync(
        path.join(root, dist, "api", "bun", "core", "Socket.ts"),
        "utf8",
      );
      assert.match(source, /hostname: "127\.0\.0\.1",\n\tport,/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("fails closed when Electrobun changes the server shape", () => {
  const root = fixture("server = Bun.serve({ port });\n");
  try {
    assert.throws(
      () => hardenElectrobunRpcSockets(root),
      /cannot prove or patch loopback binding/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
