import { beforeAll, describe, expect, test } from "bun:test";

import { api, bearerHeaders, getBaseUrl, isServerReachable, url } from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;

function shouldRunAuthed(): boolean {
  return serverReachable && hasTestApiKey;
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-j-documents] ${getBaseUrl()} did not respond to /api/health. Tests will skip.`,
    );
  }
  if (!hasTestApiKey) {
    console.warn("[group-j-documents] TEST_API_KEY is not set; auth-gated tests will skip.");
  }
});

describe("Group J - /api/v1/documents", () => {
  test("auth gate: missing credentials returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/v1/documents");
    expect(res.status).toBe(401);
  });

  test("validation: missing text content returns 400", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/v1/documents",
      { filename: "empty.txt" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("text document lifecycle: create, list, query, delete", async () => {
    if (!shouldRunAuthed()) return;
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

    const list = await api.get("/api/v1/documents", { headers: bearerHeaders() });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { documents?: Array<{ id?: string }> };
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
    if (!shouldRunAuthed()) return;
    const marker = `documents-file-${crypto.randomUUID()}`;
    const form = new FormData();
    form.append(
      "files",
      new File([`file body ${marker}`], `${marker}.txt`, { type: "text/plain" }),
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
      await api.delete(`/api/v1/documents/${body.documents[0].id}`, { headers: bearerHeaders() });
    }
  });

  test("pre-upload route is live and supports cleanup when object storage is configured", async () => {
    if (!shouldRunAuthed()) return;
    const form = new FormData();
    form.append("files", new File(["pending file"], "pending.txt", { type: "text/plain" }));

    const res = await fetch(url("/api/v1/documents/pre-upload"), {
      method: "POST",
      headers: { Authorization: bearerHeaders().Authorization },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    expect(res.status).not.toBe(501);
    expect([200, 503]).toContain(res.status);

    if (res.status === 200) {
      const body = (await res.json()) as { files?: Array<{ blobUrl?: string }> };
      const blobUrl = body.files?.[0]?.blobUrl;
      expect(blobUrl).toBeTruthy();
      const deleted = await api.delete("/api/v1/documents/pre-upload", {
        headers: bearerHeaders(),
        body: { blobUrl },
      });
      expect(deleted.status).toBe(200);
    }
  });

  test("submit route validates required character and file payload", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/v1/documents/submit", {}, { headers: bearerHeaders() });
    expect(res.status).toBe(400);
  });
});
