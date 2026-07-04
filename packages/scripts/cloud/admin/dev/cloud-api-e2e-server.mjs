#!/usr/bin/env node
// Drives cloud admin cloud admin dev cloud api e2e server automation with explicit environment and CI invariants.
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

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
    async drain() {
      while (pending.length > 0) {
        const batch = pending.splice(0);
        await Promise.allSettled(batch);
      }
    },
  };
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filteredRequestHeaders(incomingHeaders) {
  const headers = new Headers();
  const connectionHeader = incomingHeaders.connection;
  const connectionTokens = new Set(
    (Array.isArray(connectionHeader)
      ? connectionHeader.join(",")
      : (connectionHeader ?? "")
    )
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );

  for (const [name, value] of Object.entries(incomingHeaders)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || connectionTokens.has(lowerName)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  return headers;
}

const workerUrl = pathToFileURL(
  path.join(repoRoot, "packages/cloud/api/src/index.ts"),
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
      headers: filteredRequestHeaders(incoming.headers),
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : Readable.toWeb(incoming),
      duplex: "half",
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await ctx.drain();
    outgoing.writeHead(
      response.status,
      response.statusText,
      Object.fromEntries(response.headers),
    );
    if (response.body) {
      await pipeline(Readable.fromWeb(response.body), outgoing);
    } else {
      outgoing.end();
    }
  } catch (error) {
    console.error("[cloud-api-e2e] request failed", error);
    if (outgoing.headersSent) {
      outgoing.destroy(error instanceof Error ? error : undefined);
      return;
    }
    outgoing.writeHead(500, { "Content-Type": "application/json" });
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
