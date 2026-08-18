/** Verifies today-card todos reads use the bounded canonical UI client. */
import { afterEach, describe, expect, it, vi } from "vitest";

const { clientFetch } = vi.hoisted(() => ({
  clientFetch: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
    fetch: clientFetch,
    getBaseUrl: () => "http://test.local",
  },
}));

vi.mock("../../../api/app-shell-capabilities", () => ({
  supportsFullAppShellRoutes: () => true,
}));

import {
  fetchTodayTodos,
  TODAY_TODOS_JSON_TIMEOUT_MS,
} from "./today-todos-data";

describe("Today todos JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(TODAY_TODOS_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(fetchTodayTodos()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(new Error("Todos request failed (503)"));

    await expect(fetchTodayTodos()).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful todos GET", async () => {
    clientFetch.mockResolvedValueOnce({ todos: [] });

    await expect(fetchTodayTodos()).resolves.toEqual([]);
    expect(clientFetch).toHaveBeenCalledWith("/api/lifeops/todos", undefined, {
      timeoutMs: TODAY_TODOS_JSON_TIMEOUT_MS,
    });
  });
});
