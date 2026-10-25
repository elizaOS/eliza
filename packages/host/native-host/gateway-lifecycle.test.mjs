import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startGatewayLifecycle } from "./gateway-lifecycle.mjs";

async function fixture(t, { failure, startupFailure } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const handles = [];
  let server;
  const resource = async (name, method) => {
    if (startupFailure === name) throw new Error(`start ${name}`);
    const handle = await open(join(root, name), "a+");
    handles.push(handle);
    events.push(`start ${name}`);
    return {
      [method]: async () => {
        events.push(`stop ${name}`);
        await handle.writeFile("closed\n");
        await handle.close();
        if (failure === name) throw new Error(`stop ${name}`);
      },
    };
  };
  const options = {
    port: 0,
    createHelper: () => resource("helper", "close"),
    createTaskGateway: () => resource("tasks", "close"),
    startCapture: async () => {
      const capture = await resource("capture", "stop");
      if (failure === "capture-sync") {
        const stop = capture.stop;
        capture.stop = () => {
          // A synchronous failure before returning a promise must not skip tasks.
          void stop();
          throw new Error("stop capture synchronously");
        };
      }
      return capture;
    },
    createReputation: async () => ({
      ...(await resource("reputation", "stop")),
      start() {
        if (startupFailure === "reputation-start")
          throw new Error("start reputation");
      },
    }),
    createServer: () => {
      if (startupFailure === "server") throw new Error("start server");
      server = createServer(async (_request, response) => {
        await handles[1].writeFile("request\n");
        response.end("ready");
      });
      t.after(() => new Promise((resolve) => server.close(resolve)));
      return server;
    },
  };
  return {
    options,
    events,
    root,
    get server() {
      return server;
    },
  };
}

for (const failure of [
  undefined,
  "reputation",
  "capture",
  "capture-sync",
  "tasks",
  "helper",
]) {
  test(`real HTTP host releases every resource once after ${failure ?? "normal shutdown"}`, async (t) => {
    const f = await fixture(t, { failure });
    const observed = [];
    const lifecycle = await startGatewayLifecycle({
      ...f.options,
      onCleanupError: (error) => observed.push(error),
    });
    const response = await fetch(
      `http://127.0.0.1:${lifecycle.server.address().port}`,
    );
    assert.equal(await response.text(), "ready");
    assert.equal(await readFile(join(f.root, "tasks"), "utf8"), "request\n");
    const first = lifecycle.close();
    assert.equal(lifecycle.close(), first);
    if (failure) await assert.rejects(first, AggregateError);
    else await first;
    assert.deepEqual(f.events.slice(-4), [
      "stop reputation",
      "stop capture",
      "stop tasks",
      "stop helper",
    ]);
    assert.equal(lifecycle.server.listening, false);
    for (const name of ["helper", "tasks", "capture", "reputation"]) {
      assert.match(await readFile(join(f.root, name), "utf8"), /closed/);
    }
    assert.equal(observed.length, failure ? 1 : 0);
  });
}

for (const startupFailure of [
  "tasks",
  "capture",
  "reputation",
  "reputation-start",
  "server",
]) {
  test(`startup rollback closes acquired files after ${startupFailure} failure`, async (t) => {
    const f = await fixture(t, { startupFailure, failure: "helper" });
    await assert.rejects(startGatewayLifecycle(f.options), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.cause.message, /start/);
      return true;
    });
    const acquired = f.events
      .filter((event) => event.startsWith("start "))
      .map((event) => event.slice(6));
    assert.deepEqual(
      f.events.filter((event) => event.startsWith("stop ")),
      acquired.toReversed().map((name) => `stop ${name}`),
    );
    for (const name of acquired)
      assert.equal(await readFile(join(f.root, name), "utf8"), "closed\n");
  });
}

test("occupied HTTP port rolls back all resources and preserves EADDRINUSE", async (t) => {
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const f = await fixture(t);
  await assert.rejects(
    startGatewayLifecycle({ ...f.options, port: occupied.address().port }),
    { code: "EADDRINUSE" },
  );
  assert.deepEqual(f.events.slice(-4), [
    "stop reputation",
    "stop capture",
    "stop tasks",
    "stop helper",
  ]);
});

test("external HTTP close triggers cleanup even when its observer throws", async (t) => {
  const f = await fixture(t, { failure: "tasks" });
  const lifecycle = await startGatewayLifecycle({
    ...f.options,
    onCleanupError() {
      throw new Error("observer");
    },
  });
  await new Promise((resolve) => lifecycle.server.close(resolve));
  await assert.rejects(lifecycle.close(), AggregateError);
  assert.deepEqual(f.events.slice(-4), [
    "stop reputation",
    "stop capture",
    "stop tasks",
    "stop helper",
  ]);
});
