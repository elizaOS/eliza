/**
 * Group J — /api/v1/documents (live e2e).
 *
 * Every status assertion pins the single status the Worker contract promises
 * for the CI lane (wrangler dev + PGlite bridge — run-e2e-batches.mjs), which
 * always binds object storage (`BLOB` in wrangler.toml). A target without the
 * binding is a broken deployment and must FAIL, not pass through tolerance.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass.
 */

import { describe, expect, test } from "bun:test";

import {
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
  url,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-j-documents] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-j-documents] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

describeE2E("Group J - /api/v1/documents", () => {
  test("auth gate: missing credentials returns 401", async () => {
    const res = await api.get("/api/v1/documents");
    expect(res.status).toBe(401);
  });

  test("validation: missing text content returns 400", async () => {
    const res = await api.post(
      "/api/v1/documents",
      { filename: "empty.txt" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("text document lifecycle: create, list, query, delete", async () => {
    const marker = `documents-e2e-${crypto.randomUUID()}`;
    const create = await api.post(
      "/api/v1/documents",
      {
        filename: `${marker}.txt`,
        content: `This document contains the searchable marker ${marker}.`,
      },
      { headers: bearerHeaders() },
    );
    expect(create.status).toBe(200);
    const created = (await create.json()) as { document?: { id?: string } };
    const documentId = created.document?.id;
    expect(documentId).toBeTruthy();

    const list = await api.get("/api/v1/documents", {
      headers: bearerHeaders(),
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      documents?: Array<{ id?: string }>;
    };
    expect(listed.documents?.some((doc) => doc.id === documentId)).toBe(true);

    const query = await api.post(
      "/api/v1/documents/query",
      { query: marker, limit: 3 },
      { headers: bearerHeaders() },
    );
    expect(query.status).toBe(200);
    const queried = (await query.json()) as {
      results?: Array<{ id?: string; similarity?: number }>;
    };
    expect(queried.results?.[0]?.id).toBe(documentId);
    expect(queried.results?.[0]?.similarity).toBeGreaterThan(0);

    const deleted = await api.delete(`/api/v1/documents/${documentId}`, {
      headers: bearerHeaders(),
    });
    expect(deleted.status).toBe(200);
  });

  test("file upload stores documents without the Node runtime", async () => {
    const marker = `documents-file-${crypto.randomUUID()}`;
    const form = new FormData();
    form.append(
      "files",
      new File([`file body ${marker}`], `${marker}.txt`, {
        type: "text/plain",
      }),
    );

    const res = await fetch(url("/api/v1/documents/upload-file"), {
      method: "POST",
      headers: { Authorization: bearerHeaders().Authorization },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      successCount?: number;
      documents?: Array<{ id?: string }>;
    };
    expect(body.successCount).toBe(1);
    expect(body.documents?.[0]?.id).toBeTruthy();

    if (body.documents?.[0]?.id) {
      await api.delete(`/api/v1/documents/${body.documents[0].id}`, {
        headers: bearerHeaders(),
      });
    }
  });

  test("pre-upload stores a pending blob and cleans it up", async () => {
    const form = new FormData();
    form.append(
      "files",
      new File(["pending file"], "pending.txt", { type: "text/plain" }),
    );

    const res = await fetch(url("/api/v1/documents/pre-upload"), {
      method: "POST",
      headers: { Authorization: bearerHeaders().Authorization },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    // The `BLOB` R2 binding is declared in wrangler.toml, so every
    // wrangler-served target has object storage: the contract is 200. (The
    // route's 503 exists only for a misconfigured deploy — that must fail.)
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files?: Array<{ blobUrl?: string }>;
    };
    const blobUrl = body.files?.[0]?.blobUrl;
    expect(blobUrl).toBeTruthy();
    const deleted = await api.delete("/api/v1/documents/pre-upload", {
      headers: bearerHeaders(),
      body: { blobUrl },
    });
    expect(deleted.status).toBe(200);
  });

  test("submit route validates required character and file payload", async () => {
    const res = await api.post(
      "/api/v1/documents/submit",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });
});
