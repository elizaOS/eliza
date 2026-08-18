/**
 * @vitest-environment jsdom
 *
 * TodosView todos JSON through the canonical ElizaClient seam.
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

vi.mock("./TodosSpatialView.tsx", () => ({
  EMPTY_LANES: { today: [], upcoming: [], someday: [] },
  TodosSpatialView: () => null,
}));

import {
  getTodosJsonWithClient,
  TODOS_VIEW_JSON_TIMEOUT_MS,
} from "./TodosView.js";

const PATH = "/api/lifeops/todos";

describe("TodosView todos JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(TODOS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(
      getTodosJsonWithClient(PATH, { fetch: clientFetch }, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 10,
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(new Error("Todos request failed (503)"));

    await expect(
      getTodosJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful todos GET", async () => {
    clientFetch.mockResolvedValueOnce({ todos: [] });

    await expect(
      getTodosJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).resolves.toEqual({ todos: [] });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 1_000,
    });
  });
});
