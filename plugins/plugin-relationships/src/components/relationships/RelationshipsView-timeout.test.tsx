/**
 * @vitest-environment jsdom
 *
 * RelationshipsView graph JSON through the canonical ElizaClient seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { clientFetch } = vi.hoisted(() => ({
  clientFetch: vi.fn(),
}));

vi.mock("@elizaos/ui/api", () => ({
  client: {
    fetch: clientFetch,
    getBaseUrl: () => "http://test.local",
  },
}));

vi.mock("./RelationshipsSpatialView.tsx", () => ({
  EMPTY_RELATIONSHIPS: { state: "loading", nodes: [], filters: [] },
  RelationshipsSpatialView: () => null,
}));

import {
  getRelationshipsJsonWithClient,
  RELATIONSHIPS_VIEW_JSON_TIMEOUT_MS,
} from "./RelationshipsView.js";

const PATH = "/api/lifeops/entities";

describe("RelationshipsView graph JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(RELATIONSHIPS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(
      getRelationshipsJsonWithClient(PATH, { fetch: clientFetch }, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 10,
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new Error("Entities request failed (503)"),
    );

    await expect(
      getRelationshipsJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful graph GET", async () => {
    clientFetch.mockResolvedValueOnce({ entities: [] });

    await expect(
      getRelationshipsJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).resolves.toEqual({ entities: [] });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 1_000,
    });
  });
});
