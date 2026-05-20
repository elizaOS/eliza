#!/usr/bin/env node
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Readable } from "node:stream";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const host = process.env.API_DEV_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.API_DEV_PORT || "8787", 10);

function asArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  if (typeof value === "string") return new TextEncoder().encode(value).buffer;
  if (value === null || value === undefined) return new ArrayBuffer(0);
  throw new TypeError(`Unsupported R2 test object value: ${typeof value}`);
}

function createMemoryR2Bucket() {
  const objects = new Map();
  return {
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
        async text() {
          return new TextDecoder().decode(object.body);
        },
        async arrayBuffer() {
          return object.body.slice(0);
        },
      };
    },
    async put(key, value, options = {}) {
      const body =
        value instanceof Blob
          ? await value.arrayBuffer()
          : asArrayBuffer(value);
      objects.set(key, {
        body,
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
      });
      return { key };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function createExecutionContext() {
  const pending = [];
  return {
    passThroughOnException() {},
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    },
    drain() {
      void Promise.allSettled(pending);
    },
  };
}

const workerUrl = pathToFileURL(
  path.join(repoRoot, "packages/cloud-api/src/index.ts"),
).href;
const worker = (await import(workerUrl)).default;
const env = {
  ...process.env,
  API_DEV_PORT: String(port),
  BLOB: createMemoryR2Bucket(),
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const requestUrl = new URL(
      incoming.url ?? "/",
      `http://${incoming.headers.host ?? `${host}:${port}`}`,
    );
    const method = incoming.method ?? "GET";
    const request = new Request(requestUrl, {
      method,
      headers: incoming.headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : Readable.toWeb(incoming),
      duplex: "half",
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    outgoing.writeHead(
      response.status,
      response.statusText,
      Object.fromEntries(response.headers),
    );
    if (response.body) {
      Readable.fromWeb(response.body).pipe(outgoing);
    } else {
      outgoing.end();
    }
    ctx.drain();
  } catch (error) {
    console.error("[cloud-api-e2e] request failed", error);
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, { "Content-Type": "application/json" });
    }
    outgoing.end(JSON.stringify({ error: "cloud-api-e2e request failed" }));
  }
});

await new Promise((resolve) => {
  server.listen(port, host, resolve);
});
console.log(`[cloud-api-e2e] listening on http://${host}:${port}`);

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await new Promise(() => undefined);
