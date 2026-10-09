/** Exercise public-port ownership before Wrangler allocates internal listeners. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("owns the public listener before starting Wrangler and refuses premature traffic", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "wrangler-port-owner-"));
  try {
    const moduleDir = path.join(cwd, "node_modules/wrangler");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      path.join(moduleDir, "package.json"),
      JSON.stringify({ main: "index.cjs" }),
    );
    writeFileSync(
      path.join(moduleDir, "index.cjs"),
      `
const { EventEmitter } = require('node:events');
const { createServer, get } = require('node:http');
const assert = require('node:assert/strict');
exports.unstable_DevEnv = class extends EventEmitter {
  async startWorker() {
    // A same-port bind models an internal ephemeral listener taking this port.
    const probe = createServer();
    const outcome = await new Promise(resolve => {
      probe.once('error', error => resolve(error.code));
      probe.listen(Number(process.env.TEST_PUBLIC_PORT), '127.0.0.1', () => {
        probe.close(() => resolve('stolen'));
      });
    });
    assert.equal(outcome, 'EADDRINUSE');
    await new Promise((resolve, reject) => {
      get('http://127.0.0.1:' + process.env.TEST_PUBLIC_PORT + '/api/health', res => {
        assert.equal(res.statusCode, 503);
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
    console.log('PUBLIC_PORT_OWNED_BEFORE_WORKER');
    process.exit(0);
  }
};
`,
    );
    // The child reserves a fresh port, then launches the actual CLI in this fixture.
    const script = fileURLToPath(
      new URL("wrangler-direct-dev.ts", import.meta.url),
    );
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
const lease = createServer();
await new Promise(resolve => lease.listen(0, '127.0.0.1', resolve));
const port = lease.address().port;
await new Promise(resolve => lease.close(resolve));
const child = spawn(process.execPath, [${JSON.stringify(script)}, 'dev', '--ip', '127.0.0.1', '--port', String(port)], {
  stdio: 'inherit', env: { ...process.env, TEST_PUBLIC_PORT: String(port) }
});
child.on('exit', code => process.exit(code ?? 1));
`,
      ],
      { cwd, encoding: "utf8", timeout: 10_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("PUBLIC_PORT_OWNED_BEFORE_WORKER");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
