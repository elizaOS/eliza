// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `@elizaos/ui` is the giant renderer barrel; DocumentsView only touches
// `client.getBaseUrl()` (default fetcher seam, overridden in every test).
// `@elizaos/ui/agent-surface` is mocked to an inert hook so the instrumented
// refresh button + search input render outside a provider.
vi.mock("@elizaos/ui", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
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

function documentsStats() {
  return { documentCount: 1, fragmentCount: 7, agentId: "agent-1" };
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

afterEach(() => {
  cleanup();
});

describe("DocumentsView", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(
      <DocumentsView
        fetchers={makeFetchers({ fetchDocuments: () => never })}
      />,
    );
    expect(screen.getByTestId("documents-loading")).toBeTruthy();
  });

  it("renders the populated list with title, type, size, fragments and stats", async () => {
    render(<DocumentsView fetchers={makeFetchers()} />);
    expect(await screen.findByTestId("documents-populated")).toBeTruthy();
    expect(screen.getByTestId("documents-list")).toBeTruthy();
    expect(screen.getByTestId("documents-stats")).toBeTruthy();
    expect(screen.getByText("Quarterly Plan.md")).toBeTruthy();
    // Stats line reflects /stats counts (scoped to the stats element since the
    // row metadata also prints a "7 fragments" label).
    const stats = screen.getByTestId("documents-stats");
    expect(stats.textContent).toMatch(/1 document/);
    expect(stats.textContent).toMatch(/7 fragments/);
    // Row metadata renders the real presented fields (short content type + size).
    expect(screen.getByText(/markdown/)).toBeTruthy();
  });

  it("shows the empty state (no fabricated rows) when zero documents are stored", async () => {
    render(
      <DocumentsView
        fetchers={makeFetchers({
          fetchDocuments: async () => documentsList([]),
          fetchStats: async () => ({
            documentCount: 0,
            fragmentCount: 0,
            agentId: "agent-1",
          }),
        })}
      />,
    );
    expect(await screen.findByTestId("documents-empty")).toBeTruthy();
    expect(screen.getByText(/No documents yet/i)).toBeTruthy();
    expect(screen.queryByTestId("documents-list")).toBeNull();
  });

  it("shows the error state with a Retry that refetches into the populated state", async () => {
    let attempt = 0;
    const fetchDocuments = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return documentsList();
    };
    render(<DocumentsView fetchers={makeFetchers({ fetchDocuments })} />);
    expect(await screen.findByTestId("documents-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("documents-populated")).toBeTruthy();
  });

  it("refetches when the header refresh control is activated", async () => {
    let calls = 0;
    const fetchDocuments = async () => {
      calls += 1;
      return documentsList();
    };
    render(<DocumentsView fetchers={makeFetchers({ fetchDocuments })} />);
    await screen.findByTestId("documents-populated");
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it("runs a search and renders the results from /api/documents/search", async () => {
    let searched: string | null = null;
    const fetchSearch = async (query: string) => {
      searched = query;
      return searchResponse(query);
    };
    render(<DocumentsView fetchers={makeFetchers({ fetchSearch })} />);
    await screen.findByTestId("documents-populated");

    const input = screen.getByRole("searchbox", { name: /search documents/i });
    fireEvent.change(input, { target: { value: "quarterly" } });
    fireEvent.click(
      screen.getByRole("button", { name: /^search documents$/i }),
    );

    expect(await screen.findByTestId("documents-search-results")).toBeTruthy();
    expect(searched).toBe("quarterly");
    expect(screen.getByText(/quarterly plan covers hiring/i)).toBeTruthy();
  });

  it("surfaces a search failure without dropping the document list", async () => {
    const fetchSearch = async () => {
      throw new Error("search exploded");
    };
    render(<DocumentsView fetchers={makeFetchers({ fetchSearch })} />);
    await screen.findByTestId("documents-populated");

    const input = screen.getByRole("searchbox", { name: /search documents/i });
    fireEvent.change(input, { target: { value: "anything" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByTestId("documents-search-error")).toBeTruthy();
    // The document list is still present underneath the failed search.
    expect(screen.getByTestId("documents-list")).toBeTruthy();
  });
});
