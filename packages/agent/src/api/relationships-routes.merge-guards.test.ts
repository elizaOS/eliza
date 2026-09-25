/**
 * Exercises merge-candidate error translation and self-link rejection at the
 * relationships HTTP handler boundary with a deterministic graph-service
 * fixture; database state transitions are covered by the assistant PGlite suite.
 */
import { ElizaError, type IAgentRuntime, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  handleRelationshipsRoutes,
  type RelationshipsRouteContext,
} from "./relationships-routes.ts";

const CANDIDATE = "00000000-0000-4000-8000-000000000001" as UUID;
const SOURCE = "00000000-0000-4000-8000-000000000002" as UUID;
const TARGET = "00000000-0000-4000-8000-000000000003" as UUID;

type MergeMethod = "acceptMerge" | "rejectMerge";

function createHarness(options?: {
  body?: unknown;
  mergeMethod?: MergeMethod;
  mergeError?: Error;
}): {
  context: RelationshipsRouteContext;
  error: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  proposeMerge: ReturnType<typeof vi.fn>;
  response: object;
} {
  const error = vi.fn();
  const json = vi.fn();
  const proposeMerge = vi.fn(async () => CANDIDATE);
  const acceptMerge = vi.fn(async () => undefined);
  const rejectMerge = vi.fn(async () => undefined);
  if (options?.mergeMethod && options.mergeError) {
    const method =
      options.mergeMethod === "acceptMerge" ? acceptMerge : rejectMerge;
    method.mockRejectedValue(options.mergeError);
  }
  const service = {
    getGraphSnapshot: vi.fn(),
    getPersonDetail: vi.fn(),
    getCandidateMerges: vi.fn(),
    acceptMerge,
    rejectMerge,
    proposeMerge,
  };
  const runtime = {
    getService: vi.fn(() => service),
  } as unknown as IAgentRuntime;
  const response = {};
  return {
    context: {
      req: { url: "/" },
      res: response,
      method: "POST",
      pathname: "/",
      json,
      error,
      readJsonBody: vi.fn(async () => options?.body ?? null),
      runtime,
    } as unknown as RelationshipsRouteContext,
    error,
    json,
    proposeMerge,
    response,
  };
}

describe("relationships merge route guards", () => {
  it.each([
    ["acceptMerge" as const, "RELATIONSHIPS_MERGE_CANDIDATE_NOT_FOUND", 404],
    [
      "rejectMerge" as const,
      "RELATIONSHIPS_MERGE_CANDIDATE_ALREADY_RESOLVED",
      409,
    ],
  ])(
    "maps %s domain failures to the expected HTTP status",
    async (method, code, status) => {
      const failure = new ElizaError("merge failed", { code });
      const harness = createHarness({
        mergeMethod: method,
        mergeError: failure,
      });
      harness.context.pathname = `/api/relationships/candidates/${CANDIDATE}/${method === "acceptMerge" ? "accept" : "reject"}`;

      await expect(handleRelationshipsRoutes(harness.context)).resolves.toBe(
        true,
      );

      expect(harness.error).toHaveBeenCalledWith(
        harness.response,
        "merge failed",
        status,
      );
      expect(harness.json).not.toHaveBeenCalled();
    },
  );

  it("rejects a self-link before proposing a merge", async () => {
    const harness = createHarness({ body: { targetEntityId: SOURCE } });
    harness.context.pathname = `/api/relationships/people/${SOURCE}/link`;

    await expect(handleRelationshipsRoutes(harness.context)).resolves.toBe(
      true,
    );

    expect(harness.error).toHaveBeenCalledWith(
      harness.response,
      "Cannot link an entity to itself.",
      400,
    );
    expect(harness.proposeMerge).not.toHaveBeenCalled();
  });

  it("rethrows an unrecognized service failure", async () => {
    const failure = new Error("database unavailable");
    const harness = createHarness({
      body: { targetEntityId: TARGET },
      mergeMethod: "acceptMerge",
      mergeError: failure,
    });
    harness.context.pathname = `/api/relationships/candidates/${CANDIDATE}/accept`;

    await expect(handleRelationshipsRoutes(harness.context)).rejects.toBe(
      failure,
    );
    expect(harness.error).not.toHaveBeenCalled();
    expect(harness.json).not.toHaveBeenCalled();
  });
});
