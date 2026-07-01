// @vitest-environment jsdom
//
// Behavioral coverage for the person-scoped Documents panel of the rolodex
// (`/rolodex` → RelationshipsWorkspaceView → RelationshipsPersonSummary/detail
// panels). The people LIST, selection, search/filter, empty/loading/error and
// the destructive identity-merge confirm path already have dedicated suites
// (RelationshipsWorkspaceView.test / RelationshipsCandidateMergesPanel.test);
// the documents sub-panel had ZERO coverage. It owns real behaviour worth
// pinning: a per-entity fan-out to the documents API with an exact query
// payload, cross-entity dedup + newest-first ordering of the rendered list,
// the loading/error/empty states, an overflow disclosure past the preview
// limit, an "Open" action that navigates to the documents page, and a re-fetch
// that only fires when the selected person's member entity set actually
// changes.
//
// The only real seam is the typed API client (`client.listDocuments`). We mock
// exactly that and assert the query that reaches it + the resulting DOM. The
// translator resolves to the real test translator (NODE_ENV=test), and
// useAgentElement / navigation run for real — so we exercise the shipped wiring.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "../../../api/client-types-chat";
import type { RelationshipsPersonDetail } from "../../../api/client-types-relationships";

// ── boundary mock ───────────────────────────────────────────────────────
const listDocuments = vi.fn();

vi.mock("../../../api/client", () => ({
  client: {
    listDocuments: (...args: unknown[]) => listDocuments(...args),
  },
}));

import { RelationshipsDocumentsPanel } from "./RelationshipsPersonPanels";

// ── fixtures ────────────────────────────────────────────────────────────
function makeDoc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc-1",
    filename: "notes.md",
    contentType: "text/markdown",
    fileSize: 10,
    createdAt: 1_000,
    fragmentCount: 1,
    scope: "user-private",
    source: "upload",
    provenance: { kind: "upload" } as DocumentRecord["provenance"],
    canEditText: false,
    canDelete: false,
    ...overrides,
  };
}

/** Only the fields the Documents panel reads off the person detail matter. */
function makePerson(memberEntityIds: string[]): RelationshipsPersonDetail {
  return {
    groupId: "g-1",
    primaryEntityId: memberEntityIds[0] ?? "e-1",
    memberEntityIds,
    displayName: "Ada Lovelace",
    aliases: [],
    platforms: ["twitter"],
    identities: [],
    emails: [],
    phones: [],
    websites: [],
    preferredCommunicationChannel: null,
    categories: [],
    tags: [],
    factCount: 0,
    relationshipCount: 0,
    isOwner: false,
    profiles: [],
    facts: [],
    recentConversations: [],
    relevantMemories: [],
    relationships: [],
    identityEdges: [],
    userPersonalityPreferences: [],
  } as RelationshipsPersonDetail;
}

/** A promise plus its resolve/reject handles — controls in-flight timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function docButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

beforeEach(() => {
  listDocuments.mockReset();
  listDocuments.mockResolvedValue({ documents: [], total: 0, limit: 100, offset: 0 });
});

afterEach(() => cleanup());

describe("RelationshipsDocumentsPanel", () => {
  it("fetches documents per member entity with the exact user-private scoped query", async () => {
    render(<RelationshipsDocumentsPanel person={makePerson(["e-1", "e-2"])} />);

    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
    // One scoped call per member entity, each pinned to that entity id.
    expect(listDocuments).toHaveBeenCalledWith({
      scope: "user-private",
      scopedToEntityId: "e-1",
      limit: 100,
    });
    expect(listDocuments).toHaveBeenCalledWith({
      scope: "user-private",
      scopedToEntityId: "e-2",
      limit: 100,
    });
  });

  it("renders the newest document first and dedups the same id seen across entities", async () => {
    // e-1 returns older+shared, e-2 returns newer+the SAME shared doc. The panel
    // must fold the duplicate into one row and float the newest to the top.
    const older = makeDoc({ id: "older", filename: "older.md", createdAt: 100 });
    const shared = makeDoc({ id: "shared", filename: "shared.md", createdAt: 200 });
    const newer = makeDoc({ id: "newer", filename: "newer.md", createdAt: 999 });
    listDocuments.mockImplementation((query: { scopedToEntityId: string }) =>
      Promise.resolve({
        documents:
          query.scopedToEntityId === "e-1" ? [older, shared] : [newer, shared],
        total: 0,
        limit: 100,
        offset: 0,
      }),
    );

    const { container } = render(
      <RelationshipsDocumentsPanel person={makePerson(["e-1", "e-2"])} />,
    );

    await waitFor(() =>
      expect(container.textContent).toContain("newer.md"),
    );

    const text = container.textContent ?? "";
    // Dedup: the shared filename appears exactly once despite two responses.
    expect(text.split("shared.md").length - 1).toBe(1);
    // Newest-first ordering across the merged set (createdAt desc).
    expect(text.indexOf("newer.md")).toBeLessThan(text.indexOf("shared.md"));
    expect(text.indexOf("shared.md")).toBeLessThan(text.indexOf("older.md"));
  });

  it("shows the loading state until the fetch resolves", async () => {
    const gate = deferred<{ documents: DocumentRecord[] }>();
    listDocuments.mockReturnValue(gate.promise);

    const { container } = render(
      <RelationshipsDocumentsPanel person={makePerson(["e-1"])} />,
    );

    expect(container.textContent).toContain("Loading documents");

    gate.resolve({ documents: [makeDoc({ filename: "ready.md" })] });
    await waitFor(() => expect(container.textContent).toContain("ready.md"));
    expect(container.textContent).not.toContain("Loading documents");
  });

  it("surfaces the real error message and renders no document rows on failure", async () => {
    listDocuments.mockRejectedValue(new Error("documents store offline"));

    const { container } = render(
      <RelationshipsDocumentsPanel person={makePerson(["e-1"])} />,
    );

    await waitFor(() =>
      expect(container.textContent).toContain("documents store offline"),
    );
    // A failed load must not leave any openable document rows behind.
    expect(docButtons(container)).toHaveLength(0);
  });

  it("shows the empty state when the person has documents-capable entities but none exist", async () => {
    listDocuments.mockResolvedValue({ documents: [] });

    const { container } = render(
      <RelationshipsDocumentsPanel person={makePerson(["e-1"])} />,
    );

    await waitFor(() => expect(container.textContent).toContain("No documents"));
    expect(docButtons(container)).toHaveLength(0);
  });

  it("does NOT hit the API when the person has no member entities (adversarial empty set)", async () => {
    const { container } = render(
      <RelationshipsDocumentsPanel person={makePerson([])} />,
    );

    await waitFor(() => expect(container.textContent).toContain("No documents"));
    // Empty/whitespace entity ids are filtered out before any fetch.
    expect(listDocuments).not.toHaveBeenCalled();
  });

  it("filters blank/whitespace entity ids before fetching (adversarial input)", async () => {
    render(<RelationshipsDocumentsPanel person={makePerson(["e-1", "   ", ""])} />);

    await waitFor(() => expect(listDocuments).toHaveBeenCalled());
    // Only the one real entity id produces a call; the blanks are dropped.
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(listDocuments).toHaveBeenCalledWith({
      scope: "user-private",
      scopedToEntityId: "e-1",
      limit: 100,
    });
  });

  it("Open navigates to the documents page via history + popstate", async () => {
    listDocuments.mockResolvedValue({
      documents: [makeDoc({ id: "d1", filename: "resume.md" })],
    });
    const pushState = vi.spyOn(window.history, "pushState");
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);

    const { container } = render(
      <RelationshipsDocumentsPanel person={makePerson(["e-1"])} />,
    );

    await waitFor(() => expect(container.textContent).toContain("resume.md"));
    const open = docButtons(container)[0];
    expect(open).toBeTruthy();
    fireEvent.click(open);

    expect(pushState).toHaveBeenCalledWith(null, "", "/character/documents");
    expect(popstate).toHaveBeenCalledTimes(1);

    window.removeEventListener("popstate", popstate);
    pushState.mockRestore();
  });

  it("collapses documents past the preview limit behind an overflow disclosure", async () => {
    const docs = Array.from({ length: 6 }, (_, i) =>
      makeDoc({ id: `d${i}`, filename: `file-${i}.md`, createdAt: 1000 - i }),
    );
    listDocuments.mockResolvedValue({ documents: docs });

    const { container } = render(
      <RelationshipsDocumentsPanel person={makePerson(["e-1"])} />,
    );

    await waitFor(() => expect(container.textContent).toContain("file-0.md"));
    // PANEL_PREVIEW_LIMIT is 4 → the remaining 2 live under a "+2" disclosure.
    const summary = container.querySelector("details > summary");
    expect(summary).toBeTruthy();
    expect(summary?.textContent).toContain("+2");
    // The panel header count still reflects the full deduped set.
    expect(container.textContent).toContain("file-5.md");
  });

  it("re-fetches only when the selected person's member entity set changes (idempotent re-render)", async () => {
    listDocuments.mockResolvedValue({
      documents: [makeDoc({ filename: "a.md" })],
    });
    const person = makePerson(["e-1"]);

    const { container, rerender } = render(
      <RelationshipsDocumentsPanel person={person} />,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    // Re-render with a DIFFERENT object but the SAME member entity set: the
    // memberEntityKey is unchanged, so no redundant fetch fires.
    rerender(<RelationshipsDocumentsPanel person={makePerson(["e-1"])} />);
    await Promise.resolve();
    expect(listDocuments).toHaveBeenCalledTimes(1);

    // Selecting a genuinely different person (new entity set) triggers a refetch.
    rerender(<RelationshipsDocumentsPanel person={makePerson(["e-9"])} />);
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
    expect(listDocuments).toHaveBeenLastCalledWith({
      scope: "user-private",
      scopedToEntityId: "e-9",
      limit: 100,
    });
    expect(container).toBeTruthy();
  });
});
