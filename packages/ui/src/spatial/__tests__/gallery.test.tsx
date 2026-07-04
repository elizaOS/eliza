/**
 * Parity coverage rendering the gallery views to both GUI markup and TUI lines,
 * asserting the line-width contract. No live terminal.
 */
import { visibleWidth } from "@elizaos/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GALLERY } from "../gallery.tsx";
import { evaluateToSpatialTree, SpatialSurface } from "../index.ts";
import { renderViewToLines } from "../tui/index.ts";

describe("gallery — every screen archetype renders in every paradigm", () => {
  for (const screen of GALLERY) {
    describe(screen.id, () => {
      it("evaluates to an IR tree", () => {
        const tree = evaluateToSpatialTree(screen.view());
        expect(tree).toBeTruthy();
        expect(typeof tree.type).toBe("string");
      });

      it("renders to terminal lines honouring the width contract at 48/32/24", () => {
        for (const width of [48, 32, 24]) {
          const lines = renderViewToLines(screen.view(), width);
          expect(lines.length).toBeGreaterThan(0);
          for (const line of lines) {
            expect(visibleWidth(line)).toBe(width);
          }
        }
      });

      it("renders to GUI and XR DOM", () => {
        const gui = renderToStaticMarkup(
          <SpatialSurface modality="gui">{screen.view()}</SpatialSurface>,
        );
        const xr = renderToStaticMarkup(
          <SpatialSurface modality="xr">{screen.view()}</SpatialSurface>,
        );
        expect(gui).toContain('data-spatial-surface="gui"');
        expect(xr).toContain('data-spatial-surface="xr"');
        expect(gui.length).toBeGreaterThan(0);
      });
    });
  }
});
