import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type CreateApiKeyResponse = {
  apiKey?: {
    id?: string;
    key_prefix?: string;
    key?: string;
  };
  plainKey?: string;
};

type ListApiKeysResponse = {
  keys?: Array<Record<string, unknown>>;
};

type ApiKeyListShape = { apiKeys?: unknown[]; keys?: unknown[] } | unknown[];

type ApiKeyErrorResponse = {
  error?: unknown;
};

/**
 * API Keys E2E Tests
 *
 * Root: GET (list), POST (create)
 * [id]: DELETE (revoke), [id]/regenerate: POST
 */

describe("API Keys API", () => {
  test("GET /api/v1/api-keys requires authentication", async () => {
    const response = await api.get("/api/v1/api-keys");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/api-keys returns key list with auth", async () => {
    const response = await api.get("/api/v1/api-keys", {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<ApiKeyListShape>(response);
    const keys = Array.isArray(body) ? body : (body.apiKeys ?? body.keys ?? []);
    expect(Array.isArray(keys)).toBe(true);
  });

  test("POST /api/v1/api-keys requires authentication", async () => {
    const response = await api.post("/api/v1/api-keys", {
      name: "test-key",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/api-keys rejects invalid authenticated payloads", async () => {
    const response = await api.post(
      "/api/v1/api-keys",
      {
        name: "",
        rate_limit: 0,
      },
      { authenticated: true },
    );

    expect(response.status).toBe(400);
    const body = await readJson<ApiKeyErrorResponse>(response);
    expect(body.error).toBeTruthy();
  });

  test("POST exposes one-time secret but GET only returns redacted key metadata", async () => {
    const keyName = `redaction-${Date.now()}`;
    const createResponse = await api.post(
      "/api/v1/api-keys",
      {
        name: keyName,
        description: "redaction regression test",
        permissions: ["test:read"],
        rate_limit: 100,
      },
      { authenticated: true },
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as CreateApiKeyResponse;
    const createdId = created.apiKey?.id;
    const plainKey = created.plainKey;
    const keyPrefix = created.apiKey?.key_prefix;

    expect(typeof createdId).toBe("string");
    expect(typeof plainKey).toBe("string");
    expect(plainKey).toStartWith("eliza_");
    expect(keyPrefix).toBe(plainKey?.slice(0, keyPrefix?.length));
    expect(created.apiKey).not.toHaveProperty("key");

    try {
      const listResponse = await api.get("/api/v1/api-keys", {
        authenticated: true,
      });
      expect(listResponse.status).toBe(200);

      const listed = (await listResponse.json()) as ListApiKeysResponse;
      const listedKey = listed.keys?.find((candidate) => candidate.id === createdId);

      expect(listedKey).toBeDefined();
      expect(listedKey).not.toHaveProperty("key");
      expect(listedKey).not.toHaveProperty("plainKey");
      expect(listedKey).not.toHaveProperty("key_hash");
      expect(listedKey?.key_prefix).toBe(keyPrefix);
      expect(JSON.stringify(listedKey)).not.toContain(plainKey!);
    } finally {
      if (createdId) {
        await api.del(`/api/v1/api-keys/${createdId}`, { authenticated: true });
      }
    }
  });

  test("DELETE /api/v1/api-keys/[id] requires authentication", async () => {
    const response = await api.del("/api/v1/api-keys/00000000-0000-4000-8000-000000000000");
    expect([401, 403]).toContain(response.status);
  });
});
