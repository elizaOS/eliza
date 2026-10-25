import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client-types-core";
import { searchKnowledgeForCombinedSearch } from "./hash-search";

function httpError(status: number): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/documents/search",
    message: `HTTP ${status}`,
    status,
  });
}

describe("searchKnowledgeForCombinedSearch", () => {
  it("passes results through", async () => {
    await expect(
      searchKnowledgeForCombinedSearch(async () => ({ results: [1] }), {
        isNative: true,
      }),
    ).resolves.toEqual({ unavailable: false, result: { results: [1] } });
  });

  it("reports Knowledge unavailable for a 404 on a native device", async () => {
    await expect(
      searchKnowledgeForCombinedSearch(
        async () => {
          throw httpError(404);
        },
        { isNative: true },
      ),
    ).resolves.toEqual({ unavailable: true, result: null });
  });

  it("still throws a 404 off-device", async () => {
    const err = httpError(404);
    await expect(
      searchKnowledgeForCombinedSearch(
        async () => {
          throw err;
        },
        { isNative: false },
      ),
    ).rejects.toBe(err);
  });

  it("still throws other failures on a native device", async () => {
    const serverError = httpError(500);
    await expect(
      searchKnowledgeForCombinedSearch(
        async () => {
          throw serverError;
        },
        { isNative: true },
      ),
    ).rejects.toBe(serverError);
    const plain = new Error("network down");
    await expect(
      searchKnowledgeForCombinedSearch(
        async () => {
          throw plain;
        },
        { isNative: true },
      ),
    ).rejects.toBe(plain);
  });
});
