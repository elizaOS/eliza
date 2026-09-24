/**
 * Parser-parity contract (#9304).
 *
 * The UI ships its OWN per-marker parsers (`message-{choice,form,followups}-
 * parser.ts`) AND `@elizaos/core` ships a canonical
 * `findInteractionRegions` whose docstring claims the UI parsers are "a
 * faithful superset" so "the exact same agent output renders identically on
 * every surface." The audit found they had DIVERGED with no test guarding it.
 *
 * This contract feeds an identical corpus to BOTH implementations and:
 *   1. asserts they AGREE on the common, well-formed CHOICE + FOLLOWUPS cases
 *      (region count, scope, options, kinds) — so a future edit to either side
 *      that breaks parity fails here; and
 *   2. PINS the known FORM field-name divergence (UI `^[A-Za-z][\w-]*$` vs core
 *      `^[\w.-]+$`) while requiring both parsers to reject Object-prototype
 *      keys that would be hazardous for plain-object form state.
 *
 * If/when the UI parsers are made to delegate to core, the divergence assertion
 * flips to agreement and this file documents that the contract is now exact.
 */

import { findInteractionRegions } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { findChoiceRegions } from "./message-choice-parser";
import { findFollowupsRegions } from "./message-followups-parser";
import { findFormRegions } from "./message-form-parser";

type NormChoice = {
  scope: string;
  allowCustom: boolean;
  options: Array<{ value: string; label: string }>;
};
type NormFollowup = { kind: string; payload: string; label: string };

function coreChoices(text: string): NormChoice[] {
  return findInteractionRegions(text)
    .map((r) => r.block)
    .filter(
      (b): b is Extract<typeof b, { kind: "choice" }> => b.kind === "choice",
    )
    .map((b) => ({
      scope: b.scope,
      allowCustom: b.allowCustom ?? false,
      options: b.options.map((o) => ({ value: o.value, label: o.label })),
    }));
}
function uiChoices(text: string): NormChoice[] {
  return findChoiceRegions(text).map((m) => ({
    scope: m.scope,
    allowCustom: m.allowCustom,
    options: m.options.map((o) => ({ value: o.value, label: o.label })),
  }));
}
function coreFollowups(text: string): NormFollowup[][] {
  return findInteractionRegions(text)
    .map((r) => r.block)
    .filter(
      (b): b is Extract<typeof b, { kind: "followups" }> =>
        b.kind === "followups",
    )
    .map((b) =>
      b.options.map((o) => ({
        kind: o.kind,
        payload: o.payload,
        label: o.label,
      })),
    );
}
function uiFollowups(text: string): NormFollowup[][] {
  return findFollowupsRegions(text).map((m) =>
    m.options.map((o) => ({
      kind: o.kind,
      payload: o.payload,
      label: o.label,
    })),
  );
}

const CHOICE_CORPUS = [
  "[CHOICE:pick id=c1]\nyes=Yes\nno=No\n[/CHOICE]",
  "[CHOICE:route id=c2 allow_custom]\na=Option A\nb=Option B\nc=Option C\n[/CHOICE]",
  "Pick one:\n[CHOICE:app-create id=x]\nnew=Create new\nuse=Use existing\n[/CHOICE]\nthanks",
  // label containing '=' (split on first '=')
  "[CHOICE:eq id=c3]\nurl=https://x.test/?a=b\n[/CHOICE]",
];

const FOLLOWUPS_CORPUS = [
  "[FOLLOWUPS]\nreply:run it=Run it\nnavigate:/apps=Open apps\nprompt:Draft a reply=Draft\n[/FOLLOWUPS]",
  "[FOLLOWUPS]\nyes please=Yes\nno thanks=No\n[/FOLLOWUPS]",
];

describe("parser parity — UI per-marker parsers vs @elizaos/core findInteractionRegions (#9304)", () => {
  it("CHOICE: both impls agree on count, scope, allowCustom, and options", () => {
    for (const text of CHOICE_CORPUS) {
      expect(uiChoices(text), `UI choices for: ${text.slice(0, 30)}`).toEqual(
        coreChoices(text),
      );
    }
  });

  it("FOLLOWUPS: both impls agree on count, kind, payload, and label", () => {
    for (const text of FOLLOWUPS_CORPUS) {
      expect(
        uiFollowups(text),
        `UI followups for: ${text.slice(0, 30)}`,
      ).toEqual(coreFollowups(text));
    }
  });

  it("both impls find ZERO regions in plain prose and in malformed markers", () => {
    for (const text of [
      "just a normal reply with no markers",
      "[CHOICE:scope]\n[/CHOICE]", // no options → rejected by both
      "[FORM]\nnot json\n[/FORM]",
    ]) {
      expect(uiChoices(text)).toEqual(coreChoices(text));
      expect(findFormRegions(text)).toHaveLength(0);
    }
  });

  it("FORM: both impls accept date/time/datetime field types identically (#14323)", () => {
    const text =
      '[FORM]\n{"id":"sched","title":"T","fields":[{"name":"day","type":"date"},{"name":"at","type":"time"},{"name":"exact","type":"datetime"}]}\n[/FORM]';
    const ui = findFormRegions(text).map((r) =>
      r.form.fields.map((f) => ({ name: f.name, type: f.type })),
    );
    const core = findInteractionRegions(text)
      .map((r) => r.block)
      .filter(
        (b): b is Extract<typeof b, { kind: "form" }> => b.kind === "form",
      )
      .map((b) => b.fields.map((f) => ({ name: f.name, type: f.type })));
    expect(ui).toEqual(core);
    expect(ui).toEqual([
      [
        { name: "day", type: "date" },
        { name: "at", type: "time" },
        { name: "exact", type: "datetime" },
      ],
    ]);
  });

  // KNOWN DIVERGENCE (tracked debt, #9304): an UNKNOWN field type is coerced to
  // "text" by the UI parser, but core DROPS the field (`FIELD_TYPES.has` →
  // null) — and a form whose only field is dropped is rejected entirely.
  // Pinned so reconciling it is a conscious edit, not silent drift.
  it("FORM unknown-field-type divergence is still present and tracked", () => {
    const text =
      '[FORM]\n{"id":"f","fields":[{"name":"x","type":"color"}]}\n[/FORM]';
    const ui = findFormRegions(text);
    expect(ui).toHaveLength(1);
    expect(ui[0].form.fields[0].type).toBe("text");
    const core = findInteractionRegions(text)
      .map((r) => r.block)
      .filter(
        (b): b is Extract<typeof b, { kind: "form" }> => b.kind === "form",
      );
    expect(core).toHaveLength(0);
  });

  // KNOWN DIVERGENCE (tracked debt, #9304): the core FORM field-name regex
  // (`^[\w.-]+$`) accepts dotted / leading-digit names; the UI's
  // (`^[A-Za-z][\w-]*$`) rejects them. This test PINS that difference so any
  // reconciliation is a conscious edit. When the UI is made to delegate to
  // core, replace this with an equality assertion.
  it("FORM field-name regex divergence is still present and tracked", () => {
    const dotted =
      '[FORM]\n{"id":"f","title":"T","fields":[{"name":"a.b","label":"A","type":"text"}]}\n[/FORM]';
    const ui = findFormRegions(dotted);
    const core = findInteractionRegions(dotted)
      .map((r) => r.block)
      .filter((b) => b.kind === "form");
    // UI drops the field (none valid) → no region; core accepts the dotted name.
    expect(ui).toHaveLength(0);
    expect(core).toHaveLength(1);
  });

  it("FORM inherited Object field names are rejected by both parsers", () => {
    const unsafe =
      '[FORM]\n{"id":"f","fields":[{"name":"constructor","type":"text"},{"name":"hasOwnProperty","type":"text"}]}\n[/FORM]';
    const ui = findFormRegions(unsafe);
    const core = findInteractionRegions(unsafe)
      .map((r) => r.block)
      .filter((b) => b.kind === "form");
    expect(ui).toHaveLength(0);
    expect(core).toHaveLength(0);
  });
});
