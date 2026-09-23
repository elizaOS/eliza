/**
 * Process-level coverage for the Storybook static server error boundary. A
 * malformed URL must not reflect parser exception text into an HTML response.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { stopServer } from "./stop-server.mjs";

async function unusedPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate static-server port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`static server exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // error-policy:J5 the bounded readiness loop observes the same state.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("static server did not become ready");
}

async function rawGet(port, path) {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("static server returns inert generic text for malformed URL encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "eliza-static-boundary-"));
  const port = await unusedPort();
  await writeFile(join(root, "index.html"), "<!doctype html><p>ready</p>");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./serve-static.mjs", import.meta.url)),
      root,
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForServer(`http://127.0.0.1:${port}/`, child);
    const response = await fetch(`http://127.0.0.1:${port}/%ZZ`);
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.equal(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(body, "Bad Request");
    assert.doesNotMatch(body, /URI|stack|%ZZ|<script>/i);
  } finally {
    await stopServer(child, "static server");
    await rm(root, { recursive: true, force: true });
  }
});

test("static server rejects encoded traversal into a root-prefix sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "eliza-static-root-"));
  const sibling = `${root}-secret`;
  const port = await unusedPort();
  await mkdir(sibling);
  await writeFile(join(root, "index.html"), "<!doctype html><p>ready</p>");
  await writeFile(join(sibling, "private.json"), '{"token":"secret"}');
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./serve-static.mjs", import.meta.url)),
      root,
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForServer(`http://127.0.0.1:${port}/`, child);
    const siblingName = sibling.slice(sibling.lastIndexOf("/") + 1);
    const response = await rawGet(
      port,
      `/%2e%2e%2f${encodeURIComponent(siblingName)}/private.json`,
    );

    assert.equal(response.status, 403);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.body, "forbidden");
    assert.doesNotMatch(response.body, /token|secret/);
  } finally {
    await stopServer(child, "static server");
    await rm(root, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  }
});


test("cleanup terminates promptly when the server child already exited", async () => {
  // #32375: a child that dies before cleanup must not hang the test lane on
  // `kill(); await once("exit")` — the exit event has already fired.
  const root = await mkdtemp(join(tmpdir(), "eliza-static-early-exit-"));
  const port = await unusedPort();
  await writeFile(join(root, "index.html"), "<!doctype html><p>ready</p>");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./serve-static.mjs", import.meta.url)),
      root,
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForServer(`http://127.0.0.1:${port}/`, child);
    // Kill and WAIT for the exit event to fire before cleanup runs.
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    // Child is now fully exited; the old cleanup would hang here forever.
    const start = Date.now();
    await stopServer(child, "static server");
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1_000, `cleanup on an exited child took ${elapsed}ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Give the child a moment to install its SIGTERM handler.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const start = Date.now();
  await stopServer(child, "stubborn server");
  const elapsed = Date.now() - start;
  assert.ok(child.exitCode !== null || child.signalCode !== null, "child must be gone");
  assert.ok(elapsed < 10_000, `escalation took ${elapsed}ms`);
});
