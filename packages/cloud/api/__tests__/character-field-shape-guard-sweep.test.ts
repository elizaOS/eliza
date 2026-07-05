/**
 * Character fields are caller-supplied jsonb stored verbatim (no shape
 * validation), so every reader/writer must tolerate any JSON value in them.
 * This suite reproduces the remaining #13637-class latent 500s: the character
 * POST/PUT spreads of documents/knowledge, the username normalization in
 * updateForUser, the public discovery catalog's description mapping, and the
 * social-automation prompt helper's array spreads. Real route modules + real
 * repositories against in-process PGlite; the only mocked seams are
 * `requireUserOrApiKeyWithOrg` and the rate limiter (same pattern as
 * my-agents-characters-search-bio-guard).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { Hono } from "hono";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "bbbbbbbb-2222-4222-8222-222222222222";

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: USER,
    email: "owner@test.test",
    organization_id: ORG,
    organization: { id: ORG, name: "Org", is_active: true },
    is_active: true,
    role: "owner",
  })),
}));

// The discovery route attaches its rate limiter at module scope; the limiter
// needs Cloudflare bindings that don't exist in this harness and is not the
// surface under test.
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

beforeAll(async () => {
  try {
    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;

    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { elizaRoomCharactersTable } = await import(
      "@/db/schemas/eliza-room-characters"
    );
    const { agentTable } = await import("@/db/schemas/eliza");
    // In the deployed Worker, runtime-factory registers these actions at
    // boot; without them charactersService.updateForUser's cache invalidation
    // throws. Runtime-cache behavior is not under test here.
    const { registerRuntimeCacheActions } = await import(
      "@/lib/eliza/runtime-cache-registry"
    );
    registerRuntimeCacheActions({
      invalidateRuntime: async () => true,
      invalidateByOrganization: async () => 0,
    });

    const { pushSchema } = await import("@/db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        elizaRoomCharactersTable,
        agentTable,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite
      .insert(organizations)
      .values([{ id: ORG, name: "Org", slug: "org-shape-sweep" }]);
    await dbWrite.insert(users).values([
      {
        id: USER,
        email: "owner@test.test",
        organization_id: ORG,
        role: "owner",
        steward_user_id: `steward-${USER}`,
      },
    ]);

    const charactersRoute = (await import("../my-agents/characters/route"))
      .default;
    const characterByIdRoute = (
      await import("../my-agents/characters/[id]/route")
    ).default;
    const discoveryRoute = (await import("../v1/discovery/route")).default;
    app = new Hono<AppEnv>();
    app.route("/api/my-agents/characters", charactersRoute);
    app.route("/api/my-agents/characters/:id", characterByIdRoute);
    app.route("/api/v1/discovery", discoveryRoute);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[character-field-shape-guard-sweep.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
});

async function createCharacter(
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    "/api/my-agents/characters",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

async function updateCharacter(
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    `/api/my-agents/characters/${id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

describe("POST /api/my-agents/characters — non-array documents/knowledge", () => {
  test("create with non-iterable documents/knowledge stores the character (was: 500 TypeError on spread)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await createCharacter({
      name: "Spread Victim",
      bio: "has malformed knowledge",
      documents: 42,
      knowledge: { note: "an object, not an array" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; documents?: unknown };
    expect(body.id).toBeDefined();
    // Non-arrays contribute no document sources.
    expect(body.documents ?? []).toEqual([]);
  });

  test("create with a non-string username is rejected as 400 (was: 500 TypeError on toLowerCase)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await createCharacter({
      name: "Bad Create Username",
      bio: "valid",
      username: 42,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("validation_error");
  });

  test("create with falsy non-string usernames is rejected rather than generated", async () => {
    expect(pgliteReady).toBe(true);

    for (const username of [false, 0]) {
      const res = await createCharacter({
        name: `Bad Falsy Username ${String(username)}`,
        bio: "valid",
        username,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("validation_error");
    }
  });
});

describe("PUT /api/my-agents/characters/:id — malformed body fields", () => {
  test("update with non-iterable knowledge succeeds (was: 500 TypeError on spread)", async () => {
    expect(pgliteReady).toBe(true);

    const created = await createCharacter({
      name: "Updatable",
      bio: "starts valid",
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    // Control: a fully valid PUT must succeed in this harness, so a 500 below
    // can only come from the malformed field.
    const control = await updateCharacter(id, {
      name: "Updatable",
      bio: "fully valid control",
    });
    expect(control.status).toBe(200);

    const res = await updateCharacter(id, {
      name: "Updatable",
      bio: "still valid",
      knowledge: { note: 1 },
    });
    expect(res.status).toBe(200);
  });

  test("update with a non-string username is rejected as 400 (was: 500 TypeError on toLowerCase)", async () => {
    expect(pgliteReady).toBe(true);

    const created = await createCharacter({
      name: "Bad Username Target",
      bio: "valid",
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    const res = await updateCharacter(id, {
      name: "Bad Username Target",
      bio: "valid",
      username: 42,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("validation_error");
  });
});

describe("GET /api/v1/discovery — malformed public character bios", () => {
  test("the front door itself produces the malformed public state", async () => {
    expect(pgliteReady).toBe(true);

    // A bio that is neither string nor array — previously turned into a
    // non-string `description`, which getDiscoveryKey() .trim()s for EVERY
    // catalog request (no search needed).
    const objectBio = await createCharacter({
      name: "Object Bio Agent",
      bio: { oops: "not a string or array" },
      isPublic: true,
    });
    expect(objectBio.status).toBe(200);

    // A bio array with non-string entries — the search filter previously ran
    // b.toLowerCase() on each entry.
    const mixedBio = await createCharacter({
      name: "Alpha Malformed Agent",
      bio: ["greets warmly", null, { note: "structured entry" }],
      isPublic: true,
    });
    expect(mixedBio.status).toBe(200);
  });

  test("unfiltered catalog listing returns 200 (was: 500 TypeError in getDiscoveryKey on non-string description)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await app.request("/api/v1/discovery?types=agent", {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: Array<{ name: string; description: unknown }>;
    };
    const names = body.services.map((s) => s.name);
    expect(names).toContain("Object Bio Agent");
    expect(names).toContain("Alpha Malformed Agent");
    for (const service of body.services) {
      expect(typeof service.description).toBe("string");
    }
  });

  test("query search over a malformed bio array returns 200 and still matches", async () => {
    expect(pgliteReady).toBe(true);

    const res = await app.request(
      "/api/v1/discovery?types=agent&query=alpha",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: Array<{ name: string }>;
    };
    expect(body.services.map((s) => s.name)).toContain("Alpha Malformed Agent");
  });
});

describe("character-prompt-helper — non-array jsonb list fields", () => {
  test("buildCharacterSystemPrompt survives non-iterable style/topics/adjectives/postExamples (was: TypeError on spread)", async () => {
    expect(pgliteReady).toBe(true);

    // `{ length: 1 }` is the nastiest shape: truthy, passes `.length > 0`
    // checks, then throws on `[...x]` because it is not iterable.
    const created = await createCharacter({
      name: "Voice Agent",
      bio: "posts on social media",
      topics: { length: 2 },
      adjectives: 7,
      postExamples: { length: 1 },
      style: { all: { length: 1 }, post: 42, chat: ["ok"] },
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    const { buildCharacterSystemPrompt, getCharacterPromptContext } =
      await import("@/lib/services/character-prompt-helper");

    const context = await getCharacterPromptContext(id);
    expect(context).not.toBeNull();
    if (!context) throw new Error("unreachable");

    // Malformed shapes behave as empty, never crash the prompt build.
    expect(context.topics).toEqual([]);
    expect(context.adjectives).toEqual([]);
    expect(context.postExamples).toEqual([]);
    expect(context.postStyle).toEqual([]);
    expect(context.allStyle).toEqual([]);

    const prompt = buildCharacterSystemPrompt(context);
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Voice Agent");
  });
});
