/**
 * @vitest-environment jsdom
 *
 * Behavioral DocumentsView documents-JSON deadline. Executes
 * getDocumentsJsonWithFetch under abort — not a source-grep of DocumentsView.tsx.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

vi.mock("./DocumentsSpatialView.tsx", () => ({
  DocumentsSpatialView: () => null,
}));

import {
  DOCUMENTS_VIEW_JSON_TIMEOUT_MS,
  DocumentsView,
  getDocumentsJsonWithFetch,
} from "./DocumentsView.js";

const URL = "http://test.local/api/documents/stats";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected documents-view abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("DocumentsView documents JSON deadline", () => {
  it("aborts active list requests on unmount", () => {
    const signals: AbortSignal[] = [];
    const stalled = (signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<never>(() => {});
    };
    const view = render(
      <DocumentsView
        fetchers={{
          fetchDocuments: stalled,
          fetchStats: stalled,
          fetchSearch: stalled,
        }}
      />,
    );
    view.unmount();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps a documented UI JSON budget", () => {
    expect(DOCUMENTS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled documents GET at the injected deadline", async () => {
    await expect(
      getDocumentsJsonWithFetch(URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed documents GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(
      getDocumentsJsonWithFetch(URL, fetchImpl, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful documents GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        documentCount: 0,
        fragmentCount: 0,
        agentId: "agent-1",
      });
    };

    const body = await getDocumentsJsonWithFetch<{
      documentCount: number;
      fragmentCount: number;
      agentId: string;
    }>(URL, fetchImpl, 1_000);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(body).toEqual({
      documentCount: 0,
      fragmentCount: 0,
      agentId: "agent-1",
    });
  });

  it("composes a caller abort signal with the deadline", async () => {
    const controller = new AbortController();
    const request = getDocumentsJsonWithFetch(
      URL,
      stallUntilAborted(),
      1_000,
      controller.signal,
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
