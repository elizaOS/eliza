/**
 * GET /api/my-agents/characters `sortBy`/`order` is character-catalog sort
 * identity, not leftover database-rows page tax. Stock develop cast unknown
 * tokens and the repository defaulted unknown sortBy onto popularity_score
 * instead of the advertised newest listing.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const search = mock(
  async (
    _filters: unknown,
    _userId: string,
    _organizationId: string,
    _sortOptions: { sortBy: string; order: string },
  ) => [],
);
const count = mock(async () => 0);

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: { search, count },
}));
mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {},
}));
mock.module("@/lib/services/discord", () => ({
  discordService: {},
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { debug: () => undefined, error: () => undefined },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/my-agents/characters", route);

function listCharacters(query = "") {
  return app.request(`/api/my-agents/characters${query}`);
}

function expectNoSearch() {
  expect(search).not.toHaveBeenCalled();
  expect(count).not.toHaveBeenCalled();
}

describe("GET /api/my-agents/characters catalog sort identity", () => {
  beforeEach(() => {
    search.mockClear();
    count.mockClear();
  });

  test.each([
    ["", "newest", "desc"],
    ["?sortBy=", "newest", "desc"],
    ["?order=", "newest", "desc"],
    ["?sortBy=newest", "newest", "desc"],
    ["?sortBy=popularity", "popularity", "desc"],
    ["?sortBy=name", "name", "desc"],
    ["?sortBy=updated", "updated", "desc"],
    ["?order=asc", "newest", "asc"],
    ["?order=desc", "newest", "desc"],
    ["?sortBy=name&order=asc", "name", "asc"],
  ])("accepts %s as sortBy=%s order=%s", async (query, sortBy, order) => {
    const response = await listCharacters(query);
    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][3]).toMatchObject({
      sortBy,
      order,
      pinFeatured: false,
    });
  });

  test.each(["popular", "NEWEST", "foo", "1e2", "newest "])(
    "rejects sortBy=%s before catalog search",
    async (token) => {
      const response = await listCharacters(
        `?sortBy=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/sortBy/i);
      expectNoSearch();
    },
  );

  test.each(["ASC", "descending", "foo", "1e2"])(
    "rejects order=%s before catalog search",
    async (token) => {
      const response = await listCharacters(
        `?order=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/order/i);
      expectNoSearch();
    },
  );
});
