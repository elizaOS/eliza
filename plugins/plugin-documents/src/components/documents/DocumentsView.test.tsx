// @vitest-environment jsdom

/**
 * Drives the DocumentsView GUI data wrapper through the rendered spatial DOM.
 * It is a read-only document browser over the read-only
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

// DocumentsView only touches the narrow `@elizaos/ui/api` client surface:
// `client.getBaseUrl()` (default fetcher seam, overridden in every test) and
// `client.sendChatMessage()` (open-document affordance). The spatial primitives
// come from the separate `@elizaos/ui/spatial` subpath, which is not mocked.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui/api", () => ({
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
    setPinned: async () => {},
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
    expect(screen.getByText("Loading")).toBeTruthy();
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
    await screen.findByText("None");
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

describe("DocumentsView — pin affordance", () => {
  it("optimistically flips the pin control, calls setPinned, and reloads", async () => {
    let listCalls = 0;
    const fetchDocuments = async () => {
      listCalls += 1;
      return documentsList([presentedDocument({ id: "doc-1", pinned: true })]);
    };
    const setPinned = vi.fn(async () => {});
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchDocuments, setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");
    // Pinned row renders the filled star.
    expect(agent("pin:doc-1").textContent).toContain("★");

    fireEvent.click(agent("pin:doc-1"));
    await waitFor(() => {
      // The next authoritative reload re-renders the still-pinned state
      // (fetchDocuments keeps returning pinned: true — the flip targeted
      // unpin, and the reload restores storage truth).
      expect(listCalls).toBeGreaterThan(1);
    });
    expect(setPinned).toHaveBeenCalledWith("doc-1", false);
  });

  it("sends pin=true for an unpinned row", async () => {
    const setPinned = vi.fn(async () => {});
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");
    expect(agent("pin:doc-1").textContent).toContain("☆");

    fireEvent.click(agent("pin:doc-1"));
    await waitFor(() => {
      expect(setPinned).toHaveBeenCalledWith("doc-1", true);
    });
  });

  it("rolls the optimistic flip back when both the mutation and the reload fail", async () => {
    // RP review round-1 P1: a rejected setPinned followed by a failing silent
    // reload must not leave the fabricated optimistic state on screen.
    const fetchDocuments = vi.fn(async () => {
      return documentsList([presentedDocument({ id: "doc-1", pinned: true })]);
    });
    const setPinned = vi.fn(async () => {
      throw new Error("pin denied");
    });
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchDocuments, setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");
    expect(agent("pin:doc-1").textContent).toContain("★");

    // Make every subsequent reload fail too (silent loads preserve state).
    fetchDocuments.mockRejectedValue(new Error("network down"));

    fireEvent.click(agent("pin:doc-1"));
    // The rollback restores the captured pre-toggle row (pinned), even though
    // no authoritative reload can ever arrive.
    await waitFor(() => {
      expect(agent("pin:doc-1").textContent).toContain("★");
    });
    expect(setPinned).toHaveBeenCalledWith("doc-1", false);
  });

  it("surfaces a visibly distinct error state when a pin toggle fails", async () => {
    const setPinned = vi.fn(async () => {
      throw new Error("403 from storage");
    });
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");
    fireEvent.click(agent("pin:doc-1"));
    await screen.findByText("Pin change failed");
    expect(screen.getByText(/403 from storage/)).toBeTruthy();
  });

  it("clears the pin error on retry", async () => {
    let fail = true;
    const setPinned = vi.fn(async () => {
      if (fail) throw new Error("nope");
    });
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");
    fireEvent.click(agent("pin:doc-1"));
    await screen.findByText("Pin change failed");
    fail = false;
    fireEvent.click(agent("retry"));
    await waitFor(() => {
      expect(screen.queryByText("Pin change failed")).toBeNull();
    });
  });

  it("ignores a second click while a toggle is inflight and keeps state consistent", async () => {
    // Toggles are serialized per document (RP review round-2): a second
    // click during an inflight toggle is ignored, so no rollback baseline can
    // ever be another toggle's optimistic state.
    const deferred: Array<(reason?: Error) => void> = [];
    const setPinned = vi.fn(
      async () => new Promise<never>((_, reject) => deferred.push(reject)),
    );
    const fetchDocuments = vi.fn(async () =>
      documentsList([presentedDocument({ id: "doc-1", pinned: true })]),
    );
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchDocuments, setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");

    // Toggle 1 (unpin) stays pending; toggle 2 must be ignored.
    fireEvent.click(agent("pin:doc-1")); // unpin -> deferred
    fireEvent.click(agent("pin:doc-1")); // ignored (inflight)
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(setPinned).toHaveBeenCalledTimes(1);

    // Toggle 1 rejects; rollback restores the pre-toggle pinned truth and
    // the reload re-affirms it. The rejection surfaces the visible error
    // state (single-delivery), and no fabricated unpinned state remains.
    deferred[0]?.(new Error("stale"));
    await waitFor(() => {
      expect(agent("pin:doc-1").textContent).toContain("★");
      expect(screen.getByText("Pin change failed")).toBeTruthy();
    });
  });

  it("reloads from storage after a failed toggle instead of keeping the optimistic flip", async () => {
    let listCalls = 0;
    const fetchDocuments = async () => {
      listCalls += 1;
      return documentsList([presentedDocument({ id: "doc-1" })]);
    };
    const setPinned = vi.fn(async () => {
      throw new Error("pin denied");
    });
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchDocuments, setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");
    fireEvent.click(agent("pin:doc-1"));
    await waitFor(() => {
      expect(listCalls).toBeGreaterThan(1);
    });
    // The authoritative reload keeps the unpinned state — no fabricated pin.
    expect(agent("pin:doc-1").textContent).toContain("☆");
  });

  it("does not reverse an older toggle's authoritative reload on a newer rejection", async () => {
    // RP review round-1 must-fix repro: (1) start pinned, (2) unpin succeeds
    // and its silent reload lands authoritative pinned:false, (3) a second
    // toggle (pin) is issued and later rejects, with its own reload also
    // failing — the late rejection must NOT re-add the pin bit the
    // authoritative reload removed.
    let call = 0;
    let resolveDeferredReload: (() => void) | undefined;
    const fetchDocuments = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return documentsList([
          presentedDocument({ id: "doc-1", pinned: true }),
        ]);
      }
      if (call > 2) {
        // Any reload after the deferred one fails outright — no further
        // authoritative state can arrive once the race is set up.
        throw new Error("network down");
      }
      // Toggle 1's silent reload: authoritative unpinned truth, but deferred
      // so it lands only when the test chooses — WHILE toggle 2 is pending.
      return new Promise((resolve) => {
        resolveDeferredReload = () =>
          resolve(documentsList([presentedDocument({ id: "doc-1" })]));
      }) as never;
    });
    const setPinned = vi.fn(async (_id: string, pinned: boolean) => {
      if (pinned) {
        // Toggle 2 (pin) stays pending until the test rejects it.
        await new Promise<never>((_, reject) => {
          rejectPinToggle2 = reject as () => void;
        });
      }
    });
    let rejectPinToggle2: (() => void) | undefined;
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchDocuments, setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");
    // Toggle 1: unpin succeeds; its silent reload is deferred (pending).
    fireEvent.click(agent("pin:doc-1"));
    await waitFor(() => {
      expect(setPinned).toHaveBeenCalledWith("doc-1", false);
    });
    // Toggle 2: pin is issued and stays pending — under the visible-pending
    // contract the control shows the inflight glyph, not the optimistic star.
    fireEvent.click(agent("pin:doc-1"));
    await waitFor(() => {
      expect(setPinned).toHaveBeenLastCalledWith("doc-1", true);
    });
    expect(agent("pin:doc-1").textContent).toContain("⋯");
    // Now toggle 1's deferred reload lands the authoritative unpinned truth
    // while toggle 2 is still pending. The pending glyph still masks the
    // control; the authoritative truth itself is asserted after the rejection.
    resolveDeferredReload?.();
    await waitFor(() => {
      expect(agent("pin:doc-1").textContent).toContain("⋯");
    });
    // Toggle 2's late rejection must not reverse that authoritative state.
    rejectPinToggle2?.(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The row must still reflect the authoritative unpinned truth — the late
    // rejection may not re-add the pin bit.
    expect(agent("pin:doc-1").textContent).toContain("☆");
  });

  it("serializes per-document toggles so overlapping double rejection cannot fabricate state", async () => {
    // RP review round-2 must-fix repro: with concurrent toggles, the second
    // toggle captured the first's OPTIMISTIC value as its rollback baseline;
    // when both rejected and every reload failed, the fabricated optimistic
    // state stayed on screen. Toggles for one document are now serialized —
    // a click while a toggle is inflight is ignored.
    // First (initial) load must succeed for render; only later loads fail.
    let initial = true;
    const fetchDocuments = vi.fn(async () => {
      if (initial) {
        initial = false;
        return documentsList([presentedDocument({ id: "doc-1" })]);
      }
      throw new Error("network down");
    });
    let rejectToggle: ((reason: Error) => void) | undefined;
    const setPinned = vi.fn(
      async () =>
        new Promise<void>((_, reject) => {
          rejectToggle = reject;
        }),
    );
    render(
      React.createElement(DocumentsView, {
        fetchers: makeFetchers({ fetchDocuments, setPinned }),
      }),
    );
    await screen.findByText("Quarterly Plan.md");

    // Toggle 1: pin — stays pending (deferred rejection); visible pending
    // contract shows the inflight glyph while the mutation runs.
    fireEvent.click(agent("pin:doc-1"));
    await waitFor(() => {
      expect(setPinned).toHaveBeenCalledWith("doc-1", true);
    });
    expect(agent("pin:doc-1").textContent).toContain("⋯");
    // Toggle 2 while inflight: MUST be ignored (serialized).
    fireEvent.click(agent("pin:doc-1"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(setPinned).toHaveBeenCalledTimes(1);

    // Toggle 1 rejects; reload fails. Rollback restores the captured
    // pre-toggle truth: unpinned.
    rejectToggle?.(new Error("denied"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agent("pin:doc-1").textContent).toContain("☆");
  });
});
