/** Render tests for the documents spatial view over the TUI surface (deterministic static markup). */
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type DocumentCard,
  type DocumentsSnapshot,
  DocumentsSpatialView,
  EMPTY_DOCUMENTS_SNAPSHOT,
} from "./DocumentsSpatialView.tsx";

function card(overrides: Partial<DocumentCard> & { id: string }): DocumentCard {
  return {
    title: `Document ${overrides.id}`,
    meta: "",
    ...overrides,
  };
}

const snapshot: DocumentsSnapshot = {
  state: "ready",
  documentCount: 2,
  fragmentCount: 9,
  documents: [
    card({
      id: "d1",
      title: "Quarterly Plan",
      meta: "markdown · 4 KB · Jun 16",
    }),
    card({
      id: "d2",
      title: "Onboarding Notes",
      meta: "plain · 1 KB · Jun 18",
    }),
  ],
  query: "",
  search: { kind: "idle" },
};

const view = <DocumentsSpatialView snapshot={snapshot} />;

describe("DocumentsSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Quarterly Plan");
      expect(flat).toContain("Onboarding Notes");
      expect(flat).toContain("document");
      expect(flat).toContain("fragment");
    }
  });

  it("GUI + XR: renders DOM with the surface marker and document content", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Quarterly Plan");
      expect(html).toContain("Onboarding Notes");
      expect(html).toContain('data-agent-id="doc-d1"');
      expect(html).toContain('data-agent-id="open:d1"');
      // The search field is addressable by the agent (search-on-change).
      expect(html).toContain('data-agent-id="documents-search"');
    }
  });

  it("loading state renders a quiet loading line", () => {
    const lines = renderViewToLines(
      <DocumentsSpatialView snapshot={EMPTY_DOCUMENTS_SNAPSHOT} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    expect(lines.join("\n")).toContain("Loading");
  });

  it("empty state renders the honest no-documents affordance", () => {
    const empty: DocumentsSnapshot = {
      state: "empty",
      documents: [],
      documentCount: 0,
      fragmentCount: 0,
      query: "",
      search: { kind: "idle" },
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <DocumentsSpatialView snapshot={empty} />
      </SpatialSurface>,
    );
    expect(html).toContain("None");
  });

  it("error state renders the message and a Retry control", () => {
    const error: DocumentsSnapshot = {
      state: "error",
      documents: [],
      documentCount: 0,
      fragmentCount: 0,
      query: "",
      search: { kind: "idle" },
      error: "boom",
    };
    const lines = renderViewToLines(
      <DocumentsSpatialView snapshot={error} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("boom");
    expect(flat).toContain("Retry");

    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <DocumentsSpatialView snapshot={error} />
      </SpatialSurface>,
    );
    expect(html).toContain('data-agent-id="retry"');
  });

  it("renders search results with addressable open controls", () => {
    const withResults: DocumentsSnapshot = {
      ...snapshot,
      search: {
        kind: "results",
        query: "plan",
        hits: [
          {
            id: "frag-1",
            title: "Quarterly Plan",
            snippet: "The quarterly plan covers hiring and runway.",
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <DocumentsSpatialView snapshot={withResults} />
      </SpatialSurface>,
    );
    expect(html).toContain("The quarterly plan covers hiring");
    expect(html).toContain('data-agent-id="hit-frag-1"');
    expect(html).toContain('data-agent-id="open:frag-1"');
    expect(html).toContain('data-agent-id="clear-search"');
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "documents-test",
      () => view,
    );
    try {
      const component = getTerminalView("documents-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Quarterly Plan");
    } finally {
      unregister();
    }
  });
});
