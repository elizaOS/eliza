/** Exercises Node's real HTTP adapter so Bun's native server cannot mask streaming and teardown regressions. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFetchServer } from "../../src/fetch-server.ts";

test("delivers streaming bytes before the response producer finishes", async () => {
  let producer;
  const server = await startFetchServer(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            producer = controller;
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }),
      ),
  );
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 1500);
  try {
    const response = await fetch(`http://${server.hostname}:${server.port}`, {
      signal: abort.signal,
    });
    const reader = response.body.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "first",
    );
    producer.enqueue(new TextEncoder().encode("second"));
    producer.close();
    producer = undefined;
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "second",
    );
    assert.equal((await reader.read()).done, true);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    producer?.close();
    await server.stop();
  }
});

test("stop interrupts active streams and cancels their producer and request", async () => {
  let requestSignal;
  let cancelled = false;
  const server = await startFetchServer((request) => {
    requestSignal = request.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("open"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 1500);
  try {
    const response = await fetch(`http://${server.hostname}:${server.port}`, {
      signal: abort.signal,
    });
    const reader = response.body.getReader();
    await reader.read();
    const next = reader.read();
    const rejected = assert.rejects(next);
    await server.stop();
    await rejected;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.equal(requestSignal.aborted, true);
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
});

test("translates handler failures and rejects bodies interrupted after headers", async () => {
  let producer;
  const server = await startFetchServer((request) => {
    if (new URL(request.url).pathname === "/handler")
      throw new Error("fixture unavailable");
    return new Response(
      new ReadableStream({
        start(controller) {
          producer = controller;
          controller.enqueue(new TextEncoder().encode("partial"));
        },
      }),
    );
  });
  try {
    const baseUrl = `http://${server.hostname}:${server.port}`;
    const failed = await fetch(`${baseUrl}/handler`);
    assert.equal(failed.status, 500);
    assert.equal(await failed.text(), "fixture unavailable");
    const streamed = await fetch(`${baseUrl}/stream`);
    const reader = streamed.body.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "partial",
    );
    const rejected = assert.rejects(reader.read());
    producer.error(new Error("fixture stream failed"));
    await rejected;
  } finally {
    await server.stop();
  }
});
