import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hardenElectrobunRpcSockets } from "./electrobun-loopback-hardening.mjs";

const VULNERABLE = `const startPort = 50000;\nconst endPort = 65535;\nserver = Bun.serve<{ webviewId: number }>({\n\tport,\n});\nreturn { rpcServer: server, rpcPort: port };\n`;
const LEGACY = `const configuredPort = Number.parseInt(Bun.env.ELECTROBUN_RPC_PORT ?? "", 10);\nconst hasConfiguredPort =\n\tNumber.isInteger(configuredPort) &&\n\tconfiguredPort >= 1 &&\n\tconfiguredPort <= 65535;\nconst startPort = hasConfiguredPort ? configuredPort : 50000;\n// An explicit port is an ownership contract. Do not silently let a\n// second native app drift onto the next port.\nconst endPort = hasConfiguredPort ? startPort : 65535;\nserver = Bun.serve<{ webviewId: number }>({\n\thostname: "127.0.0.1",\n\tport,\n});\nreturn { rpcServer: server, rpcPort: port };\n`;

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
      assert.match(source, /Bun\.env\.ELIZA_ELECTROBUN_RENDERER_RPC_PORT/);
      assert.doesNotMatch(source, /Bun\.env\.ELECTROBUN_RPC_PORT/);
      assert.match(
        source,
        /const endPort = hasConfiguredPort \? startPort : 65535;/,
      );
      assert.match(
        source,
        /configured renderer RPC port \$\{configuredPort\} is unavailable/,
      );
      assert.doesNotMatch(source, /const startPort = 50000;/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("treats a configured renderer RPC port as an exclusive lease", () => {
  const root = fixture();
  try {
    hardenElectrobunRpcSockets(root);
    const source = fs.readFileSync(
      path.join(root, "dist", "api", "bun", "core", "Socket.ts"),
      "utf8",
    );
    assert.match(
      source,
      /const startPort = hasConfiguredPort \? configuredPort : 50000;/,
    );
    assert.match(
      source,
      /const endPort = hasConfiguredPort \? startPort : 65535;/,
    );
    assert.match(source, /hasConfiguredPort && server === null/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrates the launcher-colliding legacy environment variable", () => {
  const root = fixture(LEGACY);
  try {
    assert.equal(hardenElectrobunRpcSockets(root).length, 2);
    assert.equal(hardenElectrobunRpcSockets(root).length, 0);
    const source = fs.readFileSync(
      path.join(root, "dist", "api", "bun", "core", "Socket.ts"),
      "utf8",
    );
    assert.match(source, /Bun\.env\.ELIZA_ELECTROBUN_RENDERER_RPC_PORT/);
    assert.doesNotMatch(source, /Bun\.env\.ELECTROBUN_RPC_PORT/);
    assert.match(source, /hasConfiguredPort && server === null/);
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
