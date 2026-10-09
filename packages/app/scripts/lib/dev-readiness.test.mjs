import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  DevelopmentReadinessError,
  waitForDevelopmentReady,
} from "./dev-process-lifecycle.ts";

// Real local HTTP startup; no model, credentials, external service or mock timers.
test("readiness observes a live child HTTP transition and releases the owned child", async (t) => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
  import http from 'node:http';
  let ready=false;
  const server=http.createServer((req,res)=>{res.statusCode=ready?200:503;res.end();});
  server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));
  process.stdin.once('data',()=>{ready=true});
 `,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  const [bytes] = await once(child.stdout, "data");
  const url = `http://127.0.0.1:${Number(String(bytes).trim())}`;
  let attempts = 0;
  await waitForDevelopmentReady(
    async (signal) => {
      const response = await fetch(url, { signal });
      await response.arrayBuffer();
      attempts++;
      if (!response.ok) child.stdin.write("ready");
      return response.ok;
    },
    {
      label: "Local HTTP child",
      timeoutMs: 5000,
      intervalMs: 10,
      alive: () => child.exitCode === null && child.signalCode === null,
    },
  );
  assert.ok(attempts >= 2);
});

test("abort or child exit during a healthy probe cannot admit readiness", async () => {
  const controller = new AbortController();
  const cancelled = new Error("caller cancelled");
  await assert.rejects(
    waitForDevelopmentReady(
      async (signal) => {
        assert.equal(signal.aborted, false);
        controller.abort(cancelled);
        return true;
      },
      {
        label: "child",
        timeoutMs: 1000,
        intervalMs: 10,
        signal: controller.signal,
      },
    ),
    (error) => error === cancelled,
  );
  let alive = true;
  await assert.rejects(
    waitForDevelopmentReady(
      async () => {
        alive = false;
        return true;
      },
      { label: "child", timeoutMs: 1000, intervalMs: 10, alive: () => alive },
    ),
    /child exited/,
  );
});

test("caller timeout cancels an outstanding real HTTP request", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  let observed;
  await assert.rejects(
    waitForDevelopmentReady(
      async (signal) => {
        observed = signal;
        await fetch(`http://127.0.0.1:${server.address().port}`, { signal });
        return true;
      },
      { label: "hung child", timeoutMs: 100, intervalMs: 10 },
    ),
    DevelopmentReadinessError,
  );
  assert.equal(observed.aborted, true);
});

test("pre-aborted and invalid durations never start a probe", async () => {
  const signal = AbortSignal.abort(new Error("already stopped"));
  let calls = 0;
  const probe = async () => {
    calls++;
    return true;
  };
  await assert.rejects(
    waitForDevelopmentReady(probe, {
      label: "child",
      timeoutMs: 100,
      intervalMs: 10,
      signal,
    }),
    /already stopped/,
  );
  for (const duration of [0, -1, NaN, Infinity, 2_147_483_648, 1.5]) {
    await assert.rejects(
      waitForDevelopmentReady(probe, {
        label: "child",
        timeoutMs: duration,
        intervalMs: 10,
      }),
      DevelopmentReadinessError,
    );
    await assert.rejects(
      waitForDevelopmentReady(probe, {
        label: "child",
        timeoutMs: 100,
        intervalMs: duration,
      }),
      DevelopmentReadinessError,
    );
  }
  assert.equal(calls, 0);
});

test("deadline during polling retains its typed failure", {
  timeout: 2000,
}, async () => {
  const started = performance.now();
  await assert.rejects(
    waitForDevelopmentReady(async () => false, {
      label: "unready child",
      timeoutMs: 25,
      intervalMs: 5000,
    }),
    (error) =>
      error instanceof DevelopmentReadinessError &&
      /unready child did not become ready/.test(error.message),
  );
  assert.ok(
    performance.now() - started < 1500,
    "deadline must interrupt the polling interval",
  );
});

test("deadline releases the waiter even when a probe ignores cancellation", {
  timeout: 2000,
}, async () => {
  let signal;
  await assert.rejects(
    waitForDevelopmentReady(
      (operation) => {
        signal = operation;
        return new Promise(() => {});
      },
      { label: "non-cooperating probe", timeoutMs: 25, intervalMs: 10 },
    ),
    DevelopmentReadinessError,
  );
  assert.equal(signal.aborted, true);
});
