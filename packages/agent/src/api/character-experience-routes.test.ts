/** Verifies the Character Experience view's HTTP contract. */

import { describe, expect, it, vi } from "vitest";
import { handleCharacterRoutes } from "./character-routes.ts";

const EXPERIENCE_ID = "00000000-0000-4000-8000-000000000001";

function context(options: {
  method?: string;
  pathname?: string;
  url?: string;
  body?: Record<string, unknown> | null;
  service?: Record<string, unknown> | null;
}) {
  const json = vi.fn();
  const error = vi.fn();
  const service = options.service ?? {
    listExperiences: vi.fn().mockResolvedValue([]),
    getExperience: vi.fn().mockResolvedValue(null),
    updateExperience: vi.fn().mockResolvedValue(null),
    deleteExperience: vi.fn().mockResolvedValue(false),
    getExperienceGraph: vi.fn().mockResolvedValue({ nodes: [], links: [] }),
    dedupeDuplicateExperiences: vi.fn().mockResolvedValue({ groups: [] }),
  };
  return {
    json,
    error,
    service,
    ctx: {
      req: { url: options.url ?? options.pathname } as never,
      res: {} as never,
      method: options.method ?? "GET",
      pathname: options.pathname ?? "/api/character/experiences",
      state: {
        runtime: {
          getService: vi.fn(() => service),
        },
        agentName: "Eliza",
      },
      readJsonBody: vi.fn().mockResolvedValue(options.body ?? null),
      json,
      error,
      pickRandomNames: () => ["Eliza"],
      validateCharacter: () => ({ success: true as const }),
    } as never,
  };
}

describe("Character Experience routes", () => {
  it("lists a paged, embedding-redacted wire record", async () => {
    const record = {
      id: EXPERIENCE_ID,
      learning: "Keep the useful part.",
      embedding: [1, 2, 3],
    };
    const service = {
      listExperiences: vi.fn().mockResolvedValue([record]),
    };
    const { ctx, json } = context({
      url: "/api/character/experiences?limit=10&offset=0",
      service,
    });

    await expect(handleCharacterRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(expect.anything(), {
      data: [
        {
          id: EXPERIENCE_ID,
          learning: "Keep the useful part.",
          embeddingDimensions: 3,
        },
      ],
      total: 1,
    });
  });

  it("returns a designed 503 when the service is unavailable", async () => {
    const { ctx, error } = context({ service: null });
    (
      ctx as { state: { runtime: { getService: () => null } } }
    ).state.runtime.getService = () => null;

    await expect(handleCharacterRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Experience service is not available.",
      503,
    );
  });

  it("rejects malformed pagination instead of silently coercing it", async () => {
    const { ctx, error } = context({
      url: "/api/character/experiences?limit=10oops",
    });

    await expect(handleCharacterRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Invalid experience query.",
      400,
    );
  });

  it("serves a single experience and reports an honest 404", async () => {
    const service = {
      getExperience: vi
        .fn()
        .mockResolvedValueOnce({ id: EXPERIENCE_ID, embedding: [] })
        .mockResolvedValueOnce(null),
    };
    const first = context({
      pathname: `/api/character/experiences/${EXPERIENCE_ID}`,
      service,
    });
    await expect(handleCharacterRoutes(first.ctx)).resolves.toBe(true);
    expect(first.json).toHaveBeenCalledWith(expect.anything(), {
      data: { id: EXPERIENCE_ID, embeddingDimensions: 0 },
    });

    const second = context({
      pathname: `/api/character/experiences/${EXPERIENCE_ID}`,
      service,
    });
    await expect(handleCharacterRoutes(second.ctx)).resolves.toBe(true);
    expect(second.error).toHaveBeenCalledWith(
      expect.anything(),
      "Experience not found.",
      404,
    );
  });
});
