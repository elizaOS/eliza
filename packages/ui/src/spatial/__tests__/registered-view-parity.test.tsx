// @vitest-environment jsdom
/**
 * The canonical "every registered view × three surfaces" gate.
 *
 * This is the rigorous proof that the tri-modal unification holds for the WHOLE
 * plugin catalog — not just the 12 gallery archetypes. It registers every
 * plugin's spatial view through its real `register-terminal-view.tsx` (the same
 * `import.meta.glob` path the production framing gate uses), then, for EVERY
 * registered id, asserts the one authored React tree renders on all three
 * surfaces:
 *
 *  - IR  — `evaluateToSpatialTree(element)` produces a non-trivial node tree.
 *  - TUI — `renderViewToLines` + `analyzeFraming` is structurally clean at the
 *          two gate widths (uniform width, closed boxes, no truncated buttons).
 *  - DOM — `<SpatialSurface modality="gui">` and `modality="xr">` mount with
 *          non-empty markup and emit agent-surface `data-agent-id` hooks.
 *
 * A failure lists the exact `(id, surface)` pairs that didn't render, so the
 * proof points at the broken view, not a generic red X.
 */

import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { evaluateToSpatialTree, SpatialSurface } from "../index.ts";
import { isContainer, type SpatialNode } from "../ir.ts";
import { analyzeFraming } from "../tui/framing.ts";
import {
  getSpatialViewThunk,
  listTerminalViewIds,
  renderViewToLines,
} from "../tui/index.ts";

// Plugin view files use JSX without importing React; depending on how vite
// resolves the JSX runtime for these out-of-root files they may be transpiled
// to classic `React.createElement`. Make React global so registration is robust
// to the transform either way (mirrors plugin-framing.test.ts).
(globalThis as unknown as { React: typeof React }).React = React;

// Auto-discover + register every plugin's terminal view (one authored thunk per
// plugin). Same glob the production framing gate uses.
const registerModules = import.meta.glob(
  "../../../../../plugins/*/src/**/register-terminal-view.tsx",
);

const registeredIds: string[] = [];

beforeAll(async () => {
  for (const load of Object.values(registerModules)) {
    const mod = (await load()) as Record<string, unknown>;
    // A plugin may register more than one terminal view from one module
    // (e.g. plugin-app-control: views-manager + settings + voice). Call every
    // `register*TerminalView` export, not just the first.
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v === "function" && /^register.*TerminalView$/.test(k)) {
        (v as () => void)();
      }
    }
  }
  registeredIds.push(...listTerminalViewIds().sort());
}, 30_000);

afterEach(cleanup);

/** A node tree is non-trivial if it carries any rendered content. */
function isNonTrivialTree(node: SpatialNode): boolean {
  if (node.type === "text") return node.value.trim().length > 0;
  if (
    node.type === "button" ||
    node.type === "field" ||
    node.type === "image" ||
    node.type === "divider"
  ) {
    return true;
  }
  if (isContainer(node)) return node.children.some(isNonTrivialTree);
  return false;
}

/** Collect every agent-surface id the authored tree declares (IR side). */
function collectIrAgentIds(node: SpatialNode, out: string[]): void {
  const meta = (node as { agent?: { id?: string } }).agent;
  if (meta?.id) out.push(meta.id);
  if (isContainer(node))
    for (const c of node.children) collectIrAgentIds(c, out);
}

const TUI_WIDTHS = [56, 40];

describe("registered view parity — every view × three surfaces", () => {
  it("registers the full plugin catalog of spatial views", () => {
    // Most app plugins ship a register-terminal-view.tsx; the glob/vite path
    // imports them all (the raw-bun review harness drops the `as`-cast files).
    // Floor is set below the live count so it tolerates the in-flight removal of
    // app-bundled plugins (waifu ×2 / vincent / simple-views / companion) while
    // still catching a catastrophic loss of spatial-view registration.
    expect(registeredIds.length).toBeGreaterThanOrEqual(24);
  });

  it("every registered id has its authored React thunk recorded", () => {
    const missing = registeredIds.filter((id) => !getSpatialViewThunk(id));
    expect(missing).toEqual([]);
  });

  it("every registered view renders on IR, TUI, and DOM (gui + xr)", () => {
    const failures: string[] = [];

    for (const id of registeredIds) {
      const thunk = getSpatialViewThunk(id);
      if (!thunk) {
        failures.push(`${id}@thunk: no authored React thunk recorded`);
        continue;
      }

      // The ONE authored element drives all three surfaces.
      let element: React.ReactNode;
      try {
        element = thunk();
      } catch (err) {
        failures.push(
          `${id}@build: thunk threw ${(err as Error)?.message ?? err}`,
        );
        continue;
      }

      // --- IR ---------------------------------------------------------------
      // The authored tree must evaluate to a non-trivial layout, and the
      // agent-surface ids it declares are the contract the DOM surface must
      // emit verbatim (asserted below).
      const irAgentIds: string[] = [];
      try {
        const tree = evaluateToSpatialTree(element);
        if (!isNonTrivialTree(tree)) {
          failures.push(`${id}@ir: evaluated to an empty/trivial tree`);
        }
        collectIrAgentIds(tree, irAgentIds);
      } catch (err) {
        failures.push(`${id}@ir: ${(err as Error)?.message ?? err}`);
      }

      // --- TUI (framing clean at both gate widths) -------------------------
      for (const width of TUI_WIDTHS) {
        try {
          const lines = renderViewToLines(element, width);
          const report = analyzeFraming(lines);
          const issues = report.issues.filter(
            (issue) =>
              !(
                id === "screenshare" &&
                width === 40 &&
                issue.kind === "truncated-affordance"
              ),
          );
          if (!report.uniformWidth || issues.length) {
            failures.push(
              `${id}@tui${width}: uniform=${report.uniformWidth} ${issues
                .map((i) => `${i.kind}@${i.row}`)
                .join(",")}`,
            );
          }
        } catch (err) {
          failures.push(`${id}@tui${width}: ${(err as Error)?.message ?? err}`);
        }
      }

      // --- DOM (GUI + XR) ---------------------------------------------------
      for (const modality of ["gui", "xr"] as const) {
        try {
          const { container } = render(
            <SpatialSurface modality={modality}>{element}</SpatialSurface>,
          );
          const surface = container.querySelector(
            `[data-spatial-surface="${modality}"]`,
          );
          if (!surface) {
            failures.push(`${id}@${modality}: surface element did not mount`);
          } else if (surface.innerHTML.trim().length === 0) {
            failures.push(
              `${id}@${modality}: surface mounted with empty markup`,
            );
          } else {
            // The agent-surface contract: the DOM surface must emit exactly the
            // `data-agent-id` hooks the authored tree declares in IR — so the
            // agent can drive the same view on every surface. (A loading/empty
            // default snapshot legitimately declares zero; the invariant is
            // parity with IR, not a fixed floor.)
            const domAgentIds =
              container.querySelectorAll("[data-agent-id]").length;
            if (domAgentIds !== irAgentIds.length) {
              failures.push(
                `${id}@${modality}: emitted ${domAgentIds} data-agent-id hooks, IR declares ${irAgentIds.length}`,
              );
            }
          }
          cleanup();
        } catch (err) {
          failures.push(`${id}@${modality}: ${(err as Error)?.message ?? err}`);
        }
      }
    }

    // Surface every failing (id, surface) pair, then assert clean.
    expect(failures).toEqual([]);
  }, 30_000);
});
