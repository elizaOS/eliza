// @vitest-environment jsdom

/**
 * WIDGET_MATRIX gate (#9304).
 *
 * The weak smoke in `inline-registry.test.tsx` used `arrayContaining`, so a new
 * marker added to a parser/producer WITHOUT a renderer (or a renderer for a
 * marker no parser recognizes) slipped through. This gate locks the inline
 * widget matrix exactly:
 *   - `getInlineWidgets()` equals EXACTLY the documented built-in set (`task`
 *     is plugin-owned — registered by plugin-task-coordinator, not a UI
 *     built-in — so it is absent here and asserted absent).
 *   - every documented marker parses a representative reply into >=1 region and
 *     renders without throwing (a broken parse→render pipeline fails here).
 *   - the MessageContent-segment markers the agent is instructed to emit
 *     (`[CONFIG:...]`, code fences) are recognized by their segment parsers, so
 *     a marker the agent produces always has SOMETHING that renders it.
 *
 * Keep this in lockstep with WIDGET_MATRIX.md.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_RE, FENCED_CODE_RE } from "../message-parser-helpers";
// Side effect: registers the built-in inline widgets (choice / followups / form).
import "./inline-builtins";
import {
  getInlineWidget,
  getInlineWidgets,
  type InlineWidgetContext,
} from "./inline-registry";

// The canonical inline built-in set (WIDGET_MATRIX.md). `task` is intentionally
// NOT here — it is registered by plugin-task-coordinator's registerTaskWidget().
const BUILTIN_INLINE_KINDS = [
  "choice",
  "followups",
  "form",
  "workflow",
  "checklist",
  "background",
] as const;

// A representative marker per built-in, in the exact wire format its parser
// recognizes (see message-{choice,followups,form,workflow,checklist}-parser.ts).
const SAMPLE: Record<(typeof BUILTIN_INLINE_KINDS)[number], string> = {
  choice: "[CHOICE:pick id=c1]\nyes=Yes\nno=No\n[/CHOICE]",
  followups:
    "[FOLLOWUPS]\nreply:run it=Run it\nnavigate:/apps=Open apps\n[/FOLLOWUPS]",
  // FORM body must be JSON on its own lines: `[FORM]\n{...}\n[/FORM]`.
  form: '[FORM]\n{"id":"f1","title":"Sign up","fields":[{"name":"email","label":"Email","type":"text"}]}\n[/FORM]',
  workflow:
    '[WORKFLOW]\n{"id":"w1","title":"Deploy","steps":[{"label":"build","status":"done"},{"label":"push","status":"running"}]}\n[/WORKFLOW]',
  checklist:
    '[CHECKLIST]\n{"title":"Todos","items":[{"content":"read","status":"completed"},{"content":"edit","status":"in_progress"}]}\n[/CHECKLIST]',
  // A bare marker — the picker widget is self-contained state, no body.
  background: "[BACKGROUND]",
};

const ctx: InlineWidgetContext = {
  sendAction: vi.fn(),
  navigate: vi.fn(),
  prefillComposer: vi.fn(),
  submitForm: vi.fn(),
};

describe("inline-widget matrix gate (#9304)", () => {
  it("the registry contains EXACTLY the documented built-in inline kinds", () => {
    expect(
      getInlineWidgets()
        .map((w) => w.kind)
        .sort(),
    ).toEqual([...BUILTIN_INLINE_KINDS].sort());
  });

  it("`task` is plugin-owned and absent from the UI built-ins (documents the split)", () => {
    expect(getInlineWidget("task")).toBeUndefined();
  });

  for (const kind of BUILTIN_INLINE_KINDS) {
    it(`'${kind}' parses its marker into >=1 region and renders without throwing`, () => {
      const def = getInlineWidget(kind);
      expect(def, `${kind} must be registered`).toBeDefined();
      const regions = def?.parse(SAMPLE[kind]) ?? [];
      expect(regions.length, `${kind} parse`).toBeGreaterThanOrEqual(1);
      expect(() =>
        render(<div>{def?.render(regions[0]?.data, ctx, `k-${kind}`)}</div>),
      ).not.toThrow();
    });
  }

  it("the `[CONFIG:pluginId]` segment marker is recognized (renders in MessageContent)", () => {
    CONFIG_RE.lastIndex = 0;
    expect(CONFIG_RE.test("[CONFIG:@elizaos/plugin-wallet]")).toBe(true);
    CONFIG_RE.lastIndex = 0;
    expect(CONFIG_RE.test("[CONFIG:weather]")).toBe(true);
  });

  it("fenced code blocks are recognized by the code segment parser", () => {
    FENCED_CODE_RE.lastIndex = 0;
    expect(FENCED_CODE_RE.test("```ts\nconst a = 1;\n```")).toBe(true);
  });
});
