/**
 * GET /api/my-agents/characters?search= must not 500 when a stored
 * character's bio jsonb array contains non-string entries (#13406).
 *
 * The POST handler in the same route file stores the request body verbatim
 * (no bio validation), so `bio: ["text", null, {…}]` is a state the API
 * itself can produce. The search filter then ran `b.toLowerCase()` on every
 * bio entry of every character, so ONE malformed row turned every console
 * search on the my-agents page into a 500. Real route module + real
 * repositories against in-process PGlite; the only mocked seam is
 * `requireUserOrApiKeyWithOrg` (same pattern as org-credentials-routes).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { Hono } from "hono";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-1111-4111-8111-111111111111";

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
      .values([{ id: ORG, name: "Org", slug: "org" }]);
    await dbWrite.insert(users).values([
      {
        id: USER,
        email: "owner@test.test",
        organization_id: ORG,
        role: "owner",
        steward_user_id: `steward-${USER}`,
      },
    ]);

    const route = (await import("../my-agents/characters/route")).default;
    app = new Hono<AppEnv>();
    app.route("/api/my-agents/characters", route);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[my-agents-characters-search-bio-guard.test] setup failed — failing.",
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

describe("GET /api/my-agents/characters?search= — non-string bio entries", () => {
  test("POST accepts a bio array containing non-string entries (the state the bug needs)", async () => {
    expect(pgliteReady).toBe(true);

    const good = await createCharacter({
      name: "Alpha Helper",
      bio: ["Alpha is a friendly research assistant"],
    });
    expect(good.status).toBe(200);

    // The front door itself stores this verbatim — no bio validation.
    const malformed = await createCharacter({
      name: "Bravo Bot",
      bio: ["greets users", null, { note: "structured entry" }],
    });
    expect(malformed.status).toBe(200);
  });

  test("search returns 200 and still matches string bios (was: 500 TypeError on the null entry)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await app.request(
      "/api/my-agents/characters?search=alpha",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { characters: Array<{ name: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.characters.map((c) => c.name)).toEqual(["Alpha Helper"]);
  });

  test("search matching a string entry of the malformed bio still finds it", async () => {
    expect(pgliteReady).toBe(true);

    const res = await app.request(
      "/api/my-agents/characters?search=greets",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { characters: Array<{ name: string }> };
    };
    expect(body.data.characters.map((c) => c.name)).toEqual(["Bravo Bot"]);
  });

  test("normal empty-search page load returns both characters", async () => {
    expect(pgliteReady).toBe(true);

    const res = await app.request("/api/my-agents/characters", {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { characters: Array<{ name: string }> };
    };
    expect(body.data.characters).toHaveLength(2);
  });
});

describe("POST /api/my-agents/characters — malformed name rejected as 400, never 500", () => {
  // A non-string `name` used to 500: with no username, create() calls
  // generateUniqueUsername(name) -> slugify(name).toLowerCase() -> TypeError
  // ("name.toLowerCase is not a function"), which inferStatusFromLegacyError
  // maps to 500. With a username supplied, slugify is skipped and the
  // non-string name would persist, then 500 the public discovery/list reads
  // (char.name.toLowerCase / localeCompare) for every viewer (#13637 / #13713).
  test("non-string name (number) returns 400, not 500", async () => {
    expect(pgliteReady).toBe(true);
    const res = await createCharacter({ name: 42, bio: ["x"] });
    expect(res.status).toBe(400);
  });

  test("object / array / null name all return 400", async () => {
    expect(pgliteReady).toBe(true);
    for (const bad of [{}, ["a"], null]) {
      const res = await createCharacter({ name: bad as never, bio: ["x"] });
      expect(res.status).toBe(400);
    }
  });

  test("missing name returns 400", async () => {
    expect(pgliteReady).toBe(true);
    const res = await createCharacter({ bio: ["x"] });
    expect(res.status).toBe(400);
  });

  test("empty / whitespace-only name returns 400", async () => {
    expect(pgliteReady).toBe(true);
    for (const bad of ["", "   "]) {
      const res = await createCharacter({ name: bad, bio: ["x"] });
      expect(res.status).toBe(400);
    }
  });

  test("non-string name is rejected even when a valid username is supplied (before persist)", async () => {
    expect(pgliteReady).toBe(true);
    const res = await createCharacter({
      name: 7,
      username: "valid-name-guard",
      bio: ["x"],
    });
    expect(res.status).toBe(400);
  });

  test("a normal string name still creates (200) — no over-rejection", async () => {
    expect(pgliteReady).toBe(true);
    const res = await createCharacter({
      name: "Charlie Helper",
      bio: ["hello"],
    });
    expect(res.status).toBe(200);
  });
});
