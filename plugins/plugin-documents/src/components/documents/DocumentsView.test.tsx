// @vitest-environment jsdom

/**
 * Drives the unified DocumentsView (the single GUI/XR data wrapper) through the
 * rendered spatial DOM: the same component the bundle exports for both the "gui"
 * and "xr" modalities. It is a read-only document browser over the read-only
 * endpoints this plugin serves:
 *   GET {base}/api/documents          -> { documents, total, ... }
 *   GET {base}/api/documents/stats    -> { documentCount, fragmentCount }
 *   GET {base}/api/documents/search   -> { results, count, ... }
 *
 * The default fetchers hit those URLs via `client.getBaseUrl()`; every test here
 * injects the `fetchers` seam so the suite stays offline. We assert the rendered
 * spatial DOM across the four load states (loading / error / empty / populated)
 * plus the search round-trip and the open-document affordance.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `@elizaos/ui` is the giant renderer barrel; DocumentsView only touches
// `client.getBaseUrl()` (default fetcher seam, overridden in every test) and
// `client.sendChatMessage()` (open-document affordance). The spatial primitives
// come from the separate `@elizaos/ui/spatial` subpath, which is not mocked.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));

import { type DocumentsFetchers, DocumentsView } from "./DocumentsView.js";

// ---------------------------------------------------------------------------
// Wire fixtures — match the real route response shapes (routes.ts).
// ---------------------------------------------------------------------------

function presentedDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    filename: "Quarterly Plan.md",
    contentType: "text/markdown",
    fileSize: 4096,
    createdAt: Date.parse("2026-06-16T09:00:00.000Z"),
    fragmentCount: 7,
    source: "upload",
    scope: "global",
    provenance: { kind: "upload", label: "Manual upload" },
    canEditText: true,
    canDelete: true,
    ...overrides,
  };
}

function documentsList(documents = [presentedDocument()]) {
  return {
    ok: true,
    available: true,
    agentId: "agent-1",
    documents,
    total: documents.length,
    limit: 100,
    offset: 0,
  };
}

function documentsStats(documentCount = 1, fragmentCount = 7) {
  return { documentCount, fragmentCount, agentId: "agent-1" };
}

function searchResponse(query: string) {
  return {
    query,
    threshold: 0.3,
    results: [
      {
        id: "frag-1",
        text: "The quarterly plan covers hiring and runway.",
        similarity: 0.81,
        documentId: "doc-1",
        documentTitle: "Quarterly Plan.md",
        position: 0,
      },
    ],
    count: 1,
  };
}

function makeFetchers(
  overrides: Partial<DocumentsFetchers> = {},
): DocumentsFetchers {
  return {
    fetchDocuments: async () => documentsList(),
    fetchStats: async () => documentsStats(),
    fetchSearch: async (query: string) => searchResponse(query),
    ...overrides,
  };
}

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("DocumentsView — states", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchDocuments: () => never }),
      }),
    );
    expect(screen.getByText("Loading documents")).toBeTruthy();
  });

  it("renders the populated list with titles and the stats line", async () => {
    render(React.createElement(DocumentsView, { fetchers: makeFetchers() }));
    await screen.findByText("Quarterly Plan.md");
    expect(screen.getByText("Documents (1)")).toBeTruthy();
    // Stats line reflects the /stats counts.
    expect(screen.getByText("1 document · 7 fragments")).toBeTruthy();
    // Row meta renders the real presented fields (short content type + size).
    expect(screen.getByText(/markdown/)).toBeTruthy();
  });

  it("shows the empty state (no fabricated rows) when zero documents are stored", async () => {
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({
          fetchDocuments: async () => documentsList([]),
          fetchStats: async () => documentsStats(0, 0),
        }),
      }),
    );
    await screen.findByText("No documents yet");
    expect(screen.queryByText("Quarterly Plan.md")).toBeNull();
  });

  it("shows the error state with a Retry that refetches into populated", async () => {
    let attempt = 0;
    const fetchDocuments = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return documentsList();
    };
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchDocuments }),
      }),
    );
    await screen.findByText("boom");
    fireEvent.click(agent("retry"));
    await screen.findByText("Quarterly Plan.md");
  });

  it("refetches on the background poll (no manual Refresh button)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchDocuments = async () => {
        calls += 1;
        return documentsList();
      };
      render(
        React.createElement(DocumentsView, {
          fetchers: makeFetchers({ fetchDocuments }),
        }),
      );
      // Flush the initial mount load without firing the poll timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      expect(document.querySelector('[data-agent-id="refresh"]')).toBeNull();
      // Advancing past the poll interval triggers a quiet refetch.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DocumentsView — search", () => {
  it("runs a search on input and renders results from /api/documents/search", async () => {
    let searched: string | null = null;
    const fetchSearch = async (query: string) => {
      searched = query;
      return searchResponse(query);
    };
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchSearch }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");

    // Typing in the agent-addressable search field runs the search (no button).
    const input = agent("documents-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "quarterly" } });

    await screen.findByText(/quarterly plan covers hiring/i);
    expect(searched).toBe("quarterly");
    expect(screen.getByText("Results (1)")).toBeTruthy();
  });

  it("surfaces a search failure without dropping the document list", async () => {
    const fetchSearch = async () => {
      throw new Error("search exploded");
    };
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchSearch }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");

    const input = agent("documents-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "anything" } });

    await screen.findByText("Search failed");
    // The document list is still present underneath the failed search.
    expect(screen.getByText("Documents (1)")).toBeTruthy();
  });

  it("clears an active search back to the full list", async () => {
    render(React.createElement(DocumentsView, { fetchers: makeFetchers() }));
    await screen.findByText("Quarterly Plan.md");

    const input = agent("documents-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "quarterly" } });
    await screen.findByText("Results (1)");

    fireEvent.click(agent("clear-search"));
    await waitFor(() => {
      expect(screen.queryByText("Results (1)")).toBeNull();
    });
    expect(screen.getByText("Documents (1)")).toBeTruthy();
  });
});

describe("DocumentsView — open affordance", () => {
  it("routes open-document through the assistant chat (no fabricated nav)", async () => {
    render(React.createElement(DocumentsView, { fetchers: makeFetchers() }));
    await screen.findByText("Quarterly Plan.md");
    fireEvent.click(agent("open:doc-1"));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });
});
