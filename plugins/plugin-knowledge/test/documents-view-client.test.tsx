// @vitest-environment jsdom
/**
 * DocumentsView default-fetcher tests. The document routes require an
 * authenticated caller (routes.ts answers 401 when no access context is
 * present), so the view's reads must go through the shared app client —
 * the selected agent's API base, credentials and transport — like the
 * shared client's own document methods and the assistant views fixed in
 * #34941/#35006, never through global fetch on `client.getBaseUrl()`.
 * The shared client and the spatial renderer are replaced at the module
 * boundary so the test reads the snapshot DocumentsView hands to its
 * renderer and records which transport the default fetchers used.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentsSnapshot } from "../src/components/documents/DocumentsSpatialView.tsx";

const snapshots: DocumentsSnapshot[] = [];
const clientFetch = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  client: {
    fetch: clientFetch,
    getBaseUrl: () => "https://agent.example",
  },
  dispatchChatPrefill: vi.fn(),
}));

vi.mock("../src/components/documents/DocumentsSpatialView.tsx", () => ({
  DocumentsSpatialView: (props: { snapshot: DocumentsSnapshot }) => {
    snapshots.push(props.snapshot);
    return null;
  },
}));

const { DocumentsView } = await import(
  "../src/components/documents/DocumentsView.tsx"
);

const LIST_WIRE = {
  ok: true,
  available: true,
  agentId: "agent-1",
  documents: [
    {
      id: "doc-1",
      filename: "notes.md",
      contentType: "text/markdown",
      fileSize: 2048,
      createdAt: 1_767_225_600_000,
    },
  ],
  total: 1,
  limit: 100,
  offset: 0,
};
const STATS_WIRE = { documentCount: 1, fragmentCount: 3, agentId: "agent-1" };

const globalFetch = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  const body = url.includes("/api/documents/stats") ? STATS_WIRE : LIST_WIRE;
  return { ok: true, status: 200, json: async () => body } as Response;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  snapshots.length = 0;
  clientFetch.mockReset();
  clientFetch.mockImplementation(async (path: string) =>
    path.startsWith("/api/documents/stats") ? STATS_WIRE : LIST_WIRE,
  );
  globalFetch.mockClear();
  vi.stubGlobal("fetch", globalFetch);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DocumentsView default fetchers", () => {
  it("loads the list and stats through the shared client, never global fetch", async () => {
    await act(async () => {
      root.render(<DocumentsView />);
    });

    const last = snapshots.at(-1);
    expect(last?.state).toBe("ready");
    expect(last?.documents).toEqual([
      { id: "doc-1", title: "notes.md", meta: expect.any(String) },
    ]);
    expect(last?.documentCount).toBe(1);
    expect(last?.fragmentCount).toBe(3);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(clientFetch).toHaveBeenCalledWith(
      "/api/documents?limit=100&offset=0",
      { method: "GET", signal: expect.any(AbortSignal) },
      { timeoutMs: 15_000 },
    );
    expect(clientFetch).toHaveBeenCalledWith(
      "/api/documents/stats",
      { method: "GET", signal: expect.any(AbortSignal) },
      { timeoutMs: 15_000 },
    );
  });
});
