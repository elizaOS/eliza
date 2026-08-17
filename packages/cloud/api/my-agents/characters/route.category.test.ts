/**
 * GET /api/my-agents/characters `category` is character-catalog category
 * identity, not leftover tax on my-agents sortBy. Stock develop cast
 * unknown tokens as CategoryId and passed them to
 * userCharactersRepository.search, so `category=ASSISTANT` silently
 * returned an empty character catalog.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { CATEGORY_IDS } from "@/lib/constants/character-categories";

const search = mock(
  async (
    _filters: { category?: string },
    _userId: string,
    _organizationId: string,
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

describe("GET /api/my-agents/characters catalog category identity", () => {
  beforeEach(() => {
    search.mockClear();
    count.mockClear();
  });

  test.each(["", "?category="])(
    "accepts %s as an unfiltered character catalog",
    async (query) => {
      const response = await listCharacters(query);
      expect(response.status).toBe(200);
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][0]).toMatchObject({
        category: undefined,
        source: "cloud",
      });
    },
  );

  test.each([...CATEGORY_IDS])(
    "accepts category=%s as a character catalog",
    async (category) => {
      const response = await listCharacters(`?category=${category}`);
      expect(response.status).toBe(200);
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][0]).toMatchObject({
        category,
        source: "cloud",
      });
    },
  );

  test.each(["ASSISTANT", "bot", "foo", "1e2"])(
    "rejects category=%s before catalog search",
    async (token) => {
      const response = await listCharacters(
        `?category=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/category/i);
      expectNoSearch();
    },
  );
});
