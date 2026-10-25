// Exercises cloud API test e2e group k affiliate.test behavior with deterministic Worker route fixtures.
import { afterAll, describe, expect, test } from "bun:test";

import {
  affiliateBearerHeaders,
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

const createdCharacterIds: string[] = [];

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-k-affiliate] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-k-affiliate] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
// bearerHeaders()/affiliateBearerHeaders() still throw inside tests if the
// key vanishes mid-run — no silent fallback.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

afterAll(async () => {
  for (const id of createdCharacterIds) {
    await api
      .delete(`/api/my-agents/characters/${id}`, {
        headers: affiliateBearerHeaders(),
      })
      .catch(() => undefined);
  }
});

describeE2E("Group K — /api/affiliate/create-character", () => {
  test("OPTIONS returns CORS metadata", async () => {
    const res = await fetch(`${getBaseUrl()}/api/affiliate/create-character`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  test("POST rejects missing auth without returning a migration fallback", async () => {
    const res = await api.post("/api/affiliate/create-character", {
      character: { name: "Missing Auth Affiliate Character" },
      affiliateId: "worker-e2e",
    });
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(501);
    const body = (await res.json()) as { details?: unknown };
    expect(body.details).toBeUndefined();
  });

  test("standard API key can create because active keys have full access", async () => {
    const res = await api.post(
      "/api/affiliate/create-character",
      {
        character: {
          name: `Standard Key Affiliate Character ${Date.now()}`,
          bio: "Created by Worker e2e through the standard API key path.",
        },
        affiliateId: "worker-e2e",
      },
      { headers: bearerHeaders() },
    );
    const responseText = await res.text();
    if (res.status !== 201) {
      throw new Error(`Expected 201, got ${res.status}: ${responseText}`);
    }
    expect(res.status).toBe(201);
    expect(res.status).not.toBe(501);
    const body = JSON.parse(responseText) as {
      success?: boolean;
      characterId?: string;
    };
    expect(body.success).toBe(true);
    expect(body.characterId).toBeTruthy();
    createdCharacterIds.push(body.characterId!);
  });

  test("affiliate API key creates a real character", async () => {
    const res = await api.post(
      "/api/affiliate/create-character",
      {
        character: {
          name: `Worker Affiliate Character ${Date.now()}`,
          bio: "Created by Worker e2e through the affiliate API.",
          topics: ["testing", "affiliate"],
          adjectives: ["verifiable"],
        },
        affiliateId: "worker-e2e",
        sessionId: `session-${Date.now()}`,
        metadata: {
          source: "worker-e2e",
          imageUrls: ["https://example.com/avatar.png"],
        },
      },
      { headers: affiliateBearerHeaders() },
    );
    const responseText = await res.text();
    if (res.status !== 201) {
      throw new Error(`Expected 201, got ${res.status}: ${responseText}`);
    }
    expect(res.status).toBe(201);
    const body = JSON.parse(responseText) as {
      success?: boolean;
      characterId?: string;
      redirectUrl?: string;
      character?: { id?: string; name?: string; avatarUrl?: string };
    };
    expect(body.success).toBe(true);
    expect(body.characterId).toBeTruthy();
    expect(body.character?.id).toBe(body.characterId);
    expect(body.character?.avatarUrl).toBe("https://example.com/avatar.png");
    expect(body.redirectUrl).toContain(`/chat/${body.characterId}`);
    createdCharacterIds.push(body.characterId!);
  });
});
