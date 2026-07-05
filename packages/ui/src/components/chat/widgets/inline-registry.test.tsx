// @vitest-environment jsdom

/**
 * The inline-widget registry is the plugin-extensible seam for chat-reply
 * widgets: a plugin registers a `kind` with a `parse` + `render`, and any reply
 * carrying that marker renders the plugin's React with no edit to
 * `MessageContent`. These tests exercise that contract directly — register a
 * widget, parse a reply, render the match — plus confirm the built-ins
 * (loaded as a side effect) are present.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./inline-builtins";
import {
  getInlineWidget,
  getInlineWidgets,
  type InlineWidgetContext,
  registerInlineWidget,
} from "./inline-registry";

afterEach(cleanup);

const noopCtx: InlineWidgetContext = {
  sendAction: vi.fn(),
  navigate: vi.fn(),
  prefillComposer: vi.fn(),
  submitForm: vi.fn(),
};

describe("inline-widget registry", () => {
  it("ships EXACTLY the built-in widgets after side-effect import", () => {
    // Exact-set, not arrayContaining: a new built-in registered without a
    // matrix entry (or a built-in dropped) must fail here. See the dedicated
    // WIDGET_MATRIX gate in inline-registry.matrix.test.tsx. `task` is owned by
    // the orchestrator plugin (registerTaskWidget), not a UI built-in.
    expect(
      getInlineWidgets()
        .map((w) => w.kind)
        .sort(),
    ).toEqual(["checklist", "choice", "followups", "form", "workflow"]);
  });

  it("lets a plugin register a new marker and render it end to end", () => {
    const MARKER = /\[GAUGE:(\d{1,3})\]/g;
    registerInlineWidget<{ start: number; end: number; pct: number }>({
      kind: "gauge",
      parse: (text) => {
        MARKER.lastIndex = 0;
        const out: Array<{ start: number; end: number; pct: number }> = [];
        let m = MARKER.exec(text);
        while (m) {
          out.push({
            start: m.index,
            end: m.index + m[0].length,
            pct: Number(m[1]),
          });
          m = MARKER.exec(text);
        }
        return out.map((r) => ({ start: r.start, end: r.end, data: r }));
      },
      keyFor: (d) => `gauge:${d.pct}`,
      render: (d, _ctx, key) => (
        <div key={key} data-testid="gauge" data-pct={d.pct}>
          {d.pct}%
        </div>
      ),
    });

    const def = getInlineWidget("gauge");
    expect(def).toBeDefined();

    const matches = def?.parse("progress [GAUGE:42] now") ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.data).toMatchObject({ pct: 42 });

    render(def?.render(matches[0]?.data, noopCtx, "k"));
    const node = screen.getByTestId("gauge");
    expect(node.getAttribute("data-pct")).toBe("42");
    expect(node.textContent).toBe("42%");
  });

  it("returns undefined for an unregistered kind", () => {
    expect(getInlineWidget("does-not-exist")).toBeUndefined();
  });
});
