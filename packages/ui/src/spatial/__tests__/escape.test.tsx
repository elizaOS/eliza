/**
 * Unit coverage for the Escape primitive (raw passthrough) across GUI + spatial
 * evaluation. Static-markup renders, no live terminal.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Escape,
  evaluateToSpatialTree,
  SpatialSurface,
  Text,
} from "../index.ts";
import type { SpatialBoxNode } from "../ir.ts";
import { renderViewToLines } from "../tui/index.ts";

/**
 * The DOM-escape primitive renders real DOM (canvas/WebGL/chart/`<audio>`) in
 * GUI/XR and a spatial-primitive fallback in TUI — one authored view, both
 * surfaces. These tests pin both halves of that contract.
 */
describe("Escape — the DOM-escape primitive", () => {
  it("GUI/DOM: renders its real DOM children inside a data-spatial-kind=escape box", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <Escape tui={<Text>chart in app</Text>}>
          <canvas data-testid="x" />
        </Escape>
      </SpatialSurface>,
    );
    expect(html).toContain('data-spatial-kind="escape"');
    expect(html).toContain("<canvas");
    expect(html).toContain('data-testid="x"');
    // The TUI fallback must NOT leak into the DOM surface.
    expect(html).not.toContain("chart in app");
  });

  it("TUI/IR: evaluates to the `tui` fallback, never the DOM children", () => {
    const tree = evaluateToSpatialTree(
      <Escape tui={<Text>chart in app</Text>}>
        <canvas data-testid="x" />
      </Escape>,
    ) as SpatialBoxNode;
    expect(tree.type).toBe("box");
    expect(tree.direction).toBe("column");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({
      type: "text",
      value: "chart in app",
    });
    // The DOM children (the canvas) must not appear anywhere in the IR.
    expect(JSON.stringify(tree)).not.toContain("canvas");

    // And it renders to terminal lines carrying the fallback text.
    const lines = renderViewToLines(
      <Escape tui={<Text>chart in app</Text>}>
        <canvas />
      </Escape>,
      40,
    );
    expect(lines.join("\n")).toContain("chart in app");
  });

  it("TUI/IR: with no `tui` fallback, emits the placeholder inside the escape box (metadata preserved)", () => {
    const tree = evaluateToSpatialTree(
      <Escape agent="pnl-chart">
        <canvas />
      </Escape>,
    ) as SpatialBoxNode;
    expect(tree.type).toBe("box");
    expect(tree.direction).toBe("column");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({
      type: "text",
      value: "[interactive view — open in app]",
    });
    // Same box metadata the with-`tui` path preserves — agent id survives even
    // when there is no authored fallback.
    expect(tree.agent).toMatchObject({ id: "pnl-chart" });
  });

  it("carries agent metadata onto the escape box fallback", () => {
    const tree = evaluateToSpatialTree(
      <Escape agent="pnl-chart" tui={<Text>P&L</Text>}>
        <canvas />
      </Escape>,
    ) as SpatialBoxNode;
    expect(tree.agent).toMatchObject({ id: "pnl-chart" });
  });
});
