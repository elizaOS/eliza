/**
 * Status mapping for the relationships merge routes: an unknown merge
 * candidate is a 404 and a self-link is a 400, not a 500 or a 200. The route
 * contract runs for real against a stubbed relationships service.
 */
import type http from "node:http";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { RELATIONSHIP_MERGE_CANDIDATE_NOT_FOUND } from "@elizaos/plugin-assistant";
import { describe, expect, it, vi } from "vitest";
import { handleRelationshipsRoutes } from "./relationships-routes.ts";

const PERSON = "00000000-0000-4000-8000-000000000001";
const CANDIDATE = "00000000-0000-4000-8000-0000000000ff";

function notFound(): ElizaError {
  return new ElizaError("Merge candidate was not found.", {
    code: RELATIONSHIP_MERGE_CANDIDATE_NOT_FOUND,
  });
}

function routeCtx(method: string, pathname: string, body?: unknown) {
  const service = {
    getGraphSnapshot: vi.fn(),
    getPersonDetail: vi.fn(),
    getCandidateMerges: vi.fn(async () => []),
    acceptMerge: vi.fn(async () => {
      throw notFound();
    }),
    rejectMerge: vi.fn(async () => {
      throw notFound();
    }),
    proposeMerge: vi.fn(async () => CANDIDATE),
  };
  const ctx = {
    req: { url: pathname } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname,
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: vi.fn(async () => body) as never,
    runtime: {
      getService: (name: string) => (name === "relationships" ? service : null),
    } as unknown as IAgentRuntime,
  };
  return { ctx, service };
}

describe("relationships merge route statuses", () => {
  it.each(["accept", "reject"])(
    "answers 404 when %sing an unknown merge candidate",
    async (action) => {
      const { ctx } = routeCtx(
        "POST",
        `/api/relationships/candidates/${CANDIDATE}/${action}`,
      );

      await expect(handleRelationshipsRoutes(ctx)).resolves.toBe(true);

      expect(ctx.error).toHaveBeenCalledWith(
        ctx.res,
        "Merge candidate not found.",
        404,
      );
      expect(ctx.json).not.toHaveBeenCalled();
    },
  );

  it("rejects linking a person to themselves with a 400 before proposing a merge", async () => {
    const { ctx, service } = routeCtx(
      "POST",
      `/api/relationships/people/${PERSON}/link`,
      { targetEntityId: PERSON },
    );

    await expect(handleRelationshipsRoutes(ctx)).resolves.toBe(true);

    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "A person cannot be linked to themselves.",
      400,
    );
    expect(service.proposeMerge).not.toHaveBeenCalled();
  });

  it("rejects a case-variant self-link with a 400 before proposing a merge", async () => {
    const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const { ctx, service } = routeCtx(
      "POST",
      `/api/relationships/people/${upper}/link`,
      { targetEntityId: upper.toLowerCase() },
    );

    await expect(handleRelationshipsRoutes(ctx)).resolves.toBe(true);

    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "A person cannot be linked to themselves.",
      400,
    );
    expect(service.proposeMerge).not.toHaveBeenCalled();
  });
});
