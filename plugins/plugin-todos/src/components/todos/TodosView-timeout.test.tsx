/**
 * @vitest-environment jsdom
 *
 * Behavioral TodosView todos-JSON deadline. Executes getTodosJsonWithFetch
 * under abort — not a source-grep of TodosView.tsx.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

vi.mock("./TodosSpatialView.tsx", () => ({
  EMPTY_LANES: { today: [], upcoming: [], someday: [] },
  TodosSpatialView: () => null,
}));

import {
  getTodosJsonWithFetch,
  TODOS_VIEW_JSON_TIMEOUT_MS,
  TodosView,
} from "./TodosView.js";

const URL = "http://test.local/api/lifeops/todos";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected todos-view abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("TodosView todos JSON deadline", () => {
  it("aborts the active request on unmount", () => {
    let signal: AbortSignal | undefined;
    const view = render(
      <TodosView
        fetchers={{
          fetchTodos: (nextSignal) => {
            signal = nextSignal;
            return new Promise(() => {});
          },
        }}
      />,
    );
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps a documented UI JSON budget", () => {
    expect(TODOS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled todos GET at the injected deadline", async () => {
    await expect(
      getTodosJsonWithFetch(URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed todos GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(getTodosJsonWithFetch(URL, fetchImpl, 1_000)).rejects.toThrow(
      "503",
    );
  });

  it("uses the injected fetch for a successful todos GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ todos: [] });
    };

    const body = await getTodosJsonWithFetch<{ todos: unknown[] }>(
      URL,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(body.todos).toEqual([]);
  });

  it("composes a caller abort signal with the deadline", async () => {
    const controller = new AbortController();
    const request = getTodosJsonWithFetch(
      URL,
      stallUntilAborted(),
      1_000,
      controller.signal,
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
