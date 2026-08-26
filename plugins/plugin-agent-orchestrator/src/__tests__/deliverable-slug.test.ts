/** Deterministic unit tests for deliverableSlugFromLabel, the pure normalizer
 * that turns a planner lane label into the served /apps/<slug>/ directory
 * name. Table-driven; each row pins a live-observed shape (mangled lane text
 * from a multi-part ask, clause-boundary chops, explicit "called X" names) so
 * a regression names the incident it reintroduces. No runtime, no mocks. */
import { describe, expect, it } from "vitest";
import { deliverableSlugFromLabel } from "../actions/tasks.js";

describe("deliverableSlugFromLabel", () => {
  const table: Array<{ name: string; label: string; expected: string }> = [
    // Lane-splitter residue: a multi-part ask's lane text starts mid-phrase
    // (live 2026-08-26: "build me a tip calculator page and a word counter
    // page, deploy both" served and-deploy-a-tip-calculator and
    // and-deploy-a-word-counter).
    {
      name: "strips leading conjunction/verb residue from a split lane",
      label: "and deploy a tip calculator page",
      expected: "tip-calculator",
    },
    {
      name: "strips residue on the sibling lane too",
      label: "and deploy a word counter page",
      expected: "word-counter",
    },
    {
      name: "handles residue without a trailing kind word",
      label: "and deploy a tip calculator",
      expected: "tip-calculator",
    },
    {
      name: "strips stacked leading fillers",
      label: "also please build me a word counter page",
      expected: "word-counter",
    },
    // The whole two-pager ask as ONE label (collapsed lane): the first
    // deliverable names the slug; the conjunction clause is cut.
    {
      name: "cuts at the conjunction that introduces a second deliverable",
      label:
        "build me a tip calculator page and a word counter page, deploy both",
      expected: "tip-calculator",
    },
    // A conjunction INSIDE a name is kept (not followed by a filler token).
    {
      name: "keeps a conjunction that is part of the name",
      label: "make me a drag and drop page",
      expected: "drag-and-drop",
    },
    // Explicit names win over derivation (and stay byte-identical).
    {
      name: "explicit called-name wins over derivation",
      label: "build a tiny app called sky-card: retro landing card",
      expected: "sky-card",
    },
    {
      name: "explicit called-name with trailing colon",
      label: "called demo-hello:",
      expected: "demo-hello",
    },
    {
      name: "quoted multi-word called-name is slugified verbatim",
      label: 'make a page called "Sky Card" with a gradient',
      expected: "sky-card",
    },
    {
      // If the explicit-name regex misfired on "so-called", the slug would be
      // just "retro"; the derived phrase proves it did not.
      name: "so-called is not an explicit name",
      label: "build a so-called retro page",
      expected: "so-called-retro",
    },
    // A planner label that is already the explicit kebab name passes through
    // (single-app asks with user-given names must be untouched).
    {
      name: "kebab name passes through",
      label: "sky-card",
      expected: "sky-card",
    },
    // Clause boundaries (live 2026-08-22: tip-calculator-page-with-input).
    {
      name: "stops at the first clause boundary",
      label:
        "Build a tip calculator page with input for bill amount, tip percentage, and number of people",
      expected: "tip-calculator",
    },
    {
      name: "stops at a that-clause",
      label:
        "Build a word counter page that counts words, characters, and lines",
      expected: "word-counter",
    },
    {
      name: "treats lone w as a boundary",
      label: "Build an interactive magic 8 ball page w shake animation",
      expected: "magic-8-ball",
    },
    // Trailing deliverable-kind noise is dropped; identity tokens are kept.
    {
      name: "drops trailing page",
      label: "dice-roll-page",
      expected: "dice-roll",
    },
    {
      name: "drops trailing page after a name with stopwords",
      label: "Game of Life page",
      expected: "game-of-life",
    },
    // A kind word is kept when it is all that is left.
    { name: "keeps a lone kind word", label: "page", expected: "page" },
  ];

  it.each(table)("$name", ({ label, expected }) => {
    expect(deliverableSlugFromLabel(label)).toBe(expected);
  });

  it("never cuts inside a token and stays within 48 chars", () => {
    const long = deliverableSlugFromLabel(
      "extraordinarily comprehensive multiplication flashcards trainer page",
    );
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.split("-").every((t) => t.length > 0)).toBe(true);
  });
});
