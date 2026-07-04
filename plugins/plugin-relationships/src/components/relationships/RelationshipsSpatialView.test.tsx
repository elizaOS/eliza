/**
 * Relationships spatial view tests render deterministic HTML and TUI markup
 * without a live runtime.
 */
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
  type EntityNode,
  type KindFilter,
  type RelationshipsSnapshot,
  RelationshipsSpatialView,
} from "./RelationshipsSpatialView.tsx";

const FILTERS: KindFilter[] = [
  { kind: "person", label: "People" },
  { kind: "organization", label: "Organizations" },
];

function node(overrides: Partial<EntityNode> & { id: string }): EntityNode {
  return {
    kind: "person",
    kindLabel: "People",
    name: `Entity ${overrides.id}`,
    identityLine: "",
    edges: [],
    ...overrides,
  };
}

const snapshot: RelationshipsSnapshot = {
  state: "ready",
  filters: FILTERS,
  nodes: [
    node({
      id: "self",
      name: "Owner",
      edges: [
        {
          id: "rel-pat",
          toName: "Pat Doe",
          meta: "colleague_of · last Jun 10",
        },
      ],
    }),
    node({
      id: "ent-pat",
      name: "Pat Doe",
      identityLine: "discord:pat#1",
    }),
    node({
      id: "ent-acme",
      kind: "organization",
      kindLabel: "Organizations",
      name: "Acme Corp",
    }),
  ],
};

const view = <RelationshipsSpatialView snapshot={snapshot} />;

describe("RelationshipsSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    // The width contract (every line === width, no overflow) holds at both
    // widths; full untruncated node names only fit at the wider terminal, so the
    // content assertions are scoped to width 54 (narrow terminals ellipsize long
    // names + kind labels, which is the intended graceful degradation).
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      expect(lines.join("\n")).not.toContain("Relationships");
    }
    const flat = renderViewToLines(view, 54).join("\n");
    expect(flat).toContain("Owner");
    expect(flat).toContain("Pat Doe");
    expect(flat).toContain("Acme Corp");
  });

  it("GUI + XR: renders DOM with the surface marker and node content, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Owner");
      expect(html).toContain("Acme Corp");
      expect(html).toContain('data-agent-id="rel-self"');
      expect(html).toContain('data-agent-id="rel-ent-acme"');
      // Each node carries an Open control addressed by entity id.
      expect(html).toContain('data-agent-id="open-self"');
    }
  });

  it("loading state renders a quiet loading line", () => {
    const loading: RelationshipsSnapshot = {
      state: "loading",
      nodes: [],
      filters: [],
    };
    const lines = renderViewToLines(
      <RelationshipsSpatialView snapshot={loading} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    expect(lines.join("\n")).toContain("Loading relationships");
  });

  it("empty state renders the add-someone affordance", () => {
    const empty: RelationshipsSnapshot = {
      state: "empty",
      nodes: [],
      filters: FILTERS,
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <RelationshipsSpatialView snapshot={empty} />
      </SpatialSurface>,
    );
    expect(html).toContain("None");
    expect(html).toContain('data-agent-id="add"');
  });

  it("error state renders the message and a Retry control", () => {
    const error: RelationshipsSnapshot = {
      state: "error",
      nodes: [],
      filters: FILTERS,
      error: "boom",
    };
    const lines = renderViewToLines(
      <RelationshipsSpatialView snapshot={error} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("boom");
    expect(flat).toContain("Retry");

    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <RelationshipsSpatialView snapshot={error} />
      </SpatialSurface>,
    );
    expect(html).toContain('data-agent-id="retry"');
  });

  it("ready state renders the kind filter chips and edge meta", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    expect(html).toContain('data-agent-id="relationships-kind-all"');
    expect(html).toContain('data-agent-id="relationships-kind-person"');
    expect(html).toContain('data-agent-id="relationships-kind-organization"');
    expect(html).toContain("colleague_of");
    expect(html).toContain("discord:pat#1");
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "relationships-test",
      () => view,
    );
    try {
      const component = getTerminalView("relationships-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Acme Corp");
    } finally {
      unregister();
    }
  });
});
