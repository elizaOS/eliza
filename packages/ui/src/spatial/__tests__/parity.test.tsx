import { visibleWidth } from "@elizaos/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type AgentProfile, AgentProfileView } from "../example.tsx";
import { evaluateToSpatialTree, SpatialSurface } from "../index.ts";
import type { SpatialBoxNode } from "../ir.ts";
import { renderViewToLines } from "../tui/index.ts";

const profile: AgentProfile = {
  name: "Ada",
  status: "online",
  model: "eliza-1",
  skills: ["research", "coding", "scheduling", "memory"],
};

/** The ONE source of truth — the same element drives all three assertions. */
const view = <AgentProfileView profile={profile} />;

describe("tri-modal parity — one view, three modalities", () => {
  it("IR: the authored view evaluates to a stable layout tree", () => {
    const tree = evaluateToSpatialTree(view) as SpatialBoxNode;
    expect(tree.type).toBe("box");
    expect(tree.title).toBe("Agent");
    expect(tree.border).toBe("round");
    // Card > [HStack(name/status), Field, Divider, List, HStack(buttons)]
    const kinds = tree.children.map((c) => c.type);
    expect(kinds).toEqual(["box", "field", "divider", "box", "box"]);

    // The header row carries name + status; default (collapsed) shows 2 skills.
    const header = tree.children[0] as SpatialBoxNode;
    expect(header.direction).toBe("row");
    const skillList = tree.children[3] as SpatialBoxNode;
    expect(skillList.children).toHaveLength(2);
  });

  it("TUI: renders to terminal lines that honour the width contract (40 + 24)", () => {
    for (const width of [40, 24]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Agent"); // title in the border
      expect(flat).toContain("Ada"); // name
      expect(flat).toContain("online"); // status
      expect(flat).toContain("eliza-1"); // model field
      expect(flat).toContain("research"); // first skill
      expect(flat).toContain("Configure"); // button
      expect(flat).toMatch(/╭|╰/); // round border drawn
    }
  });

  it("GUI: renders DOM carrying content, structure and agent hooks", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    expect(html).toContain('data-spatial-surface="gui"');
    expect(html).toContain('data-spatial-kind="box"');
    expect(html).toContain("Ada");
    expect(html).toContain("eliza-1");
    expect(html).toContain("research");
    // Agent-surface hooks are emitted so the agent can drive the same view.
    expect(html).toContain('data-agent-id="toggle-skills"');
    expect(html).toContain('data-agent-id="model-field"');
  });

  it("XR: same structure as GUI, spatially scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );

    expect(xr).toContain('data-spatial-surface="xr"');
    // Same content as GUI…
    expect(xr).toContain("Ada");
    expect(xr).toContain("research");
    // …but the heading is scaled up for headset legibility (1.5rem → 1.875rem).
    expect(gui).toContain("1.5rem");
    expect(xr).toContain("1.875rem");
    expect(xr).not.toContain("font-size:1.5rem;");
  });

  it("GUI and TUI agree on visible content (single source of truth)", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const tuiText = renderViewToLines(view, 48).join("\n");
    for (const token of [
      "Ada",
      "online",
      "eliza-1",
      "research",
      "coding",
      "Configure",
    ]) {
      expect(html).toContain(token);
      expect(tuiText).toContain(token);
    }
  });
});
