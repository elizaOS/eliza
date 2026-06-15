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
  uploaded: Date;
  etag: string;
};

const encoder = new TextEncoder();
const store = new Map<string, StoredObject>();
const multipartUploads = new Map<
  string,
  {
    key: string;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
    parts: Map<number, Uint8Array>;
  }
>();

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

function createEtag(bytes: Uint8Array): string {
  return `"local-${bytes.byteLength}-${Bun.hash(bytes)}"`;
}

function objectHead(key: string, object: StoredObject) {
  return {
    key,
    version: null,
    size: object.bytes.byteLength,
    etag: object.etag,
    httpEtag: object.etag,
    uploaded: object.uploaded,
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
    checksums: {},
  };
}

const blobBinding = {
  async get(key: string) {
    const object = store.get(key);
    if (!object) return null;
    return {
      ...objectHead(key, object),
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
    const bytes = await toBytes(value);
    store.set(key, {
      bytes,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      uploaded: new Date(),
      etag: createEtag(bytes),
    });
  },
  async delete(key: string) {
    store.delete(key);
  },
  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? "";
    const start = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const limit = Math.max(1, options?.limit ?? 1000);
    const matchingKeys = Array.from(store.keys())
      .filter((key) => key.startsWith(prefix))
      .sort();
    const page = matchingKeys.slice(start, start + limit);
    const next = start + page.length;
    const objects = page.flatMap((key) => {
      const object = store.get(key);
      return object ? [objectHead(key, object)] : [];
    });

    return {
      objects,
      truncated: next < matchingKeys.length,
      cursor: next < matchingKeys.length ? String(next) : undefined,
      delimitedPrefixes: [],
    };
  },
  async head(key: string) {
    const object = store.get(key);
    return object ? objectHead(key, object) : null;
  },
  async createMultipartUpload(
    key: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) {
    const uploadId = crypto.randomUUID();
    multipartUploads.set(uploadId, {
      key,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      parts: new Map(),
    });
    return this.resumeMultipartUpload(key, uploadId);
  },
  resumeMultipartUpload(key: string, uploadId: string) {
    const upload = multipartUploads.get(uploadId);
    if (!upload || upload.key !== key) {
      throw new Error(
        `[cloud-api-hono-dev] multipart upload not found: ${key} ${uploadId}`,
      );
    }

    return {
      key,
      uploadId,
      async uploadPart(
        partNumber: number,
        value: string | ArrayBuffer | ArrayBufferView | Blob,
      ) {
        const bytes = await toBytes(value);
        upload.parts.set(partNumber, bytes);
        return {
          partNumber,
          etag: createEtag(bytes),
        };
      },
      async complete(uploadedParts: Array<{ partNumber: number }>) {
        const orderedParts = uploadedParts
          .map((part) => upload.parts.get(part.partNumber))
          .filter((part): part is Uint8Array => part !== undefined);
        const totalBytes = orderedParts.reduce(
          (total, part) => total + part.byteLength,
          0,
        );
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of orderedParts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        store.set(key, {
          bytes,
          httpMetadata: upload.httpMetadata,
          customMetadata: upload.customMetadata,
          uploaded: new Date(),
          etag: createEtag(bytes),
        });
        multipartUploads.delete(uploadId);
        const completedObject = store.get(key);
        if (!completedObject) {
          throw new Error(
            `[cloud-api-hono-dev] multipart completion failed: ${key}`,
          );
        }
        return objectHead(key, completedObject);
      },
      async abort() {
        multipartUploads.delete(uploadId);
      },
    };
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
