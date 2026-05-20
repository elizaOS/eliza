#!/usr/bin/env bun
/**
 * Local Hono server for the mock cloud E2E harness.
 *
 * The production Cloud API still runs as a Cloudflare Worker. This launcher is
 * intentionally scoped to local/mock tests where we need deterministic process
 * startup and the same Hono route graph, but not Wrangler's dev proxy/runtime.
 */

import { createApp } from "../../../../cloud-api/src/bootstrap-app";

type StoredObject = {
  bytes: Uint8Array;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

const encoder = new TextEncoder();
const store = new Map<string, StoredObject>();

async function toBytes(
  value: string | ArrayBuffer | ArrayBufferView | Blob | null,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await value.arrayBuffer());
}

const blobBinding = {
  async get(key: string) {
    const object = store.get(key);
    if (!object) return null;
    return {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      async text() {
        return new TextDecoder().decode(object.bytes);
      },
      async arrayBuffer() {
        return object.bytes.buffer.slice(
          object.bytes.byteOffset,
          object.bytes.byteOffset + object.bytes.byteLength,
        );
      },
    };
  },
  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | null,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) {
    store.set(key, {
      bytes: await toBytes(value),
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    });
  },
  async delete(key: string) {
    store.delete(key);
  },
};

function executionContext(): ExecutionContext {
  return {
    waitUntil(promise) {
      Promise.resolve(promise).catch((error) => {
        console.error("[cloud-api-hono-dev] waitUntil failed", error);
      });
    },
    passThroughOnException() {},
  } as ExecutionContext;
}

const port = Number.parseInt(process.env.API_DEV_PORT || "8787", 10);
const hostname = process.env.API_DEV_HOST || "127.0.0.1";
const app = createApp();
const env = {
  ...process.env,
  BLOB: blobBinding,
};

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health") {
        return Response.json(
          {
            status: "ok",
            timestamp: Date.now(),
            region: "local-hono",
          },
          { headers: { "Cache-Control": "no-store, max-age=0" } },
        );
      }
      return await app.fetch(request, env, executionContext());
    } catch (error) {
      console.error("[cloud-api-hono-dev] unhandled request error", error);
      return Response.json(
        { success: false, error: "internal_error" },
        { status: 500 },
      );
    }
  },
});

console.log(
  `[cloud-api-hono-dev] listening on http://${hostname}:${server.port}`,
);

const shutdown = () => {
  server.stop(true);
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
