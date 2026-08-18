/**
 * @vitest-environment jsdom
 *
 * Behavioral RelationshipsView graph-JSON deadline. Executes
 * getRelationshipsJsonWithFetch under abort — not a source-grep of
 * RelationshipsView.tsx.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

vi.mock("./RelationshipsSpatialView.tsx", () => ({
  EMPTY_RELATIONSHIPS: { state: "loading", nodes: [], filters: [] },
  RelationshipsSpatialView: () => null,
}));

import {
  getRelationshipsJsonWithFetch,
  RELATIONSHIPS_VIEW_JSON_TIMEOUT_MS,
  RelationshipsView,
} from "./RelationshipsView.js";

const URL = "http://test.local/api/lifeops/entities";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected relationships-view abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("RelationshipsView graph JSON deadline", () => {
  it("aborts active graph requests on unmount", () => {
    const signals: AbortSignal[] = [];
    const stalled = (signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<never>(() => {});
    };
    const view = render(
      <RelationshipsView
        fetchers={{
          fetchEntities: stalled,
          fetchRelationships: stalled,
        }}
      />,
    );
    view.unmount();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps a documented UI JSON budget", () => {
    expect(RELATIONSHIPS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled graph GET at the injected deadline", async () => {
    await expect(
      getRelationshipsJsonWithFetch(URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed graph GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(
      getRelationshipsJsonWithFetch(URL, fetchImpl, 1_000, "Entities"),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful graph GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ entities: [] });
    };

    const body = await getRelationshipsJsonWithFetch<{ entities: unknown[] }>(
      URL,
      fetchImpl,
      1_000,
      "Entities",
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(body.entities).toEqual([]);
  });

  it("composes a caller abort signal with the deadline", async () => {
    const controller = new AbortController();
    const request = getRelationshipsJsonWithFetch(
      URL,
      stallUntilAborted(),
      1_000,
      "Entities",
      controller.signal,
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
