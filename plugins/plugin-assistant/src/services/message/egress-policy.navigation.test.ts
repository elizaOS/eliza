/** Registered-view assertions require current UI evidence or the latest delivery. */
import type { ActionResult } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { evaluatePlannedReplyEgress } from "./egress-policy.ts";

const views = [
  { id: "chat", label: "Home" },
  { id: "notes", label: "Notes" },
  { id: "calendar", label: "Calendar" },
];
function delivered(viewId: string, handoffId: string): ActionResult {
  const view = views.find((entry) => entry.id === viewId);
  if (!view) throw new Error("Unknown fixture view");
  return {
    success: true,
    transcriptVisibility: "internal",
    values: {
      completedActionDelivered: true,
      completedActionHandoffId: handoffId,
      viewId,
    },
    data: {
      view,
      navigation: {
        effect: "view_navigation",
        status: "delivered",
        viewId,
        label: view.label,
        handoffId,
      },
    },
  };
}
function check(
  reply: string,
  currentViewId: string | null = "chat",
  actionResults: ActionResult[] = [],
) {
  return evaluatePlannedReplyEgress({
    reply,
    providers: { VIEW_NAVIGATION: { data: { views, currentViewId } } },
    actionResults,
    actions: [],
  });
}
describe("navigation reply grounding", () => {
  it("rejects the captured leading Notes confirmation before a compound answer", () => {
    // isolated-model-trial/step-1790409433162-tjz9ol.json, handler call 0:
    // no navigation candidate/intent, current view chat, and no delivery.
    const reply =
      "Notes open. Latest note: “Input audit September 25” – The audit token is amber. Next calendar event: “Input audit September 26” today, 10:00–10:15 AM. No changes made.";
    expect(check(reply)).toEqual({
      verdict: "reject",
      kind: "view_navigation",
    });
  });

  it.each([
    "Notes is open.",
    "Opened Notes.",
    "You're on Notes.",
    "Notes open.",
    "Notes open. Latest note: example.",
    "Notes is open. Latest note: example.",
    "Notes are now open!\nLatest note: example.",
    "Opened Notes. Latest note: example.",
    "You're on Notes. Latest note: example.",
    "Done. Notes open. Latest note: example.",
    "Notes open. Which note would you like?",
  ])("rejects unsupported confirmation %s", (reply) => {
    expect(check(reply)).toEqual({
      verdict: "reject",
      kind: "view_navigation",
    });
  });
  it.each([
    "Hello!",
    "Notes is not open.",
    "If Notes is open, select a note.",
    "You said: ‘Notes is open.’",
    "“Notes is open.”",
    "Notes was open earlier.",
    "The door is open.",
    "Home.",
    "Notes open? Latest note: example.",
    "Is Notes open? Latest note: example.",
    "Notes is open, right?",
    "Notes is not open. Latest note: example.",
    "Do not open Notes. Latest note: example.",
    "If Notes is open, select a note. Latest note: example.",
    "Notes would be open. Latest note: example.",
    "“Notes open.” Latest note: example.",
    '"Opened Notes." Latest note: example.',
    "You said: ‘Notes open.’ Latest note: example.",
    "Notes open-source tools are useful.",
    "Notes are open to interpretation.",
    "Notebook open. Latest note: example.",
  ])(
    "preserves conversation, quotations, and non-view statements: %s",
    (reply) => {
      expect(check(reply)).toEqual({ verdict: "allow" });
    },
  );
  it("allows current view identity but does not infer a new delivery", () => {
    expect(check("Notes is open.", "notes")).toEqual({ verdict: "allow" });
    expect(check("Home is open.")).toEqual({ verdict: "allow" });
    expect(check("Opened Notes.", "notes")).toEqual({
      verdict: "reject",
      kind: "view_navigation",
    });
    expect(check("Notes open. Latest note: example.", "notes")).toEqual({
      verdict: "allow",
    });
    expect(check("Opened Notes. Latest note: example.", "notes")).toEqual({
      verdict: "reject",
      kind: "view_navigation",
    });
  });
  it("accepts the latest delivered view and rejects superseded delivery", () => {
    const results = [
      delivered("notes", "first"),
      delivered("calendar", "second"),
    ];
    expect(check("Calendar is open.", "chat", results)).toEqual({
      verdict: "allow",
    });
    expect(check("Notes is open.", "chat", results)).toEqual({
      verdict: "reject",
      kind: "view_navigation",
    });
    expect(check("Opened Notes.", "chat", [results[0]])).toEqual({
      verdict: "allow",
    });
    expect(check("Notes open. Latest note: example.", "chat", results)).toEqual(
      {
        verdict: "reject",
        kind: "view_navigation",
      },
    );
    expect(
      check("Calendar open. Next event: example.", "chat", results),
    ).toEqual({
      verdict: "allow",
    });
    expect(
      check("Opened Notes. Latest note: example.", "chat", [results[0]]),
    ).toEqual({
      verdict: "allow",
    });
  });
  it.each(["handoff", "view", "failed", "unconfirmed", "visible"])(
    "rejects %s receipt evidence",
    (kind) => {
      const result = delivered("notes", "current");
      if (kind === "handoff")
        result.values = { ...result.values, completedActionHandoffId: "stale" };
      if (kind === "view") result.data = { ...result.data, view: views[2] };
      if (kind === "failed") result.success = false;
      if (kind === "unconfirmed")
        result.values = { ...result.values, completedActionDelivered: false };
      if (kind === "visible") delete result.transcriptVisibility;
      expect(check("Notes is open.", "chat", [result])).toEqual({
        verdict: "reject",
        kind: "view_navigation",
      });
      expect(
        check("Notes open. Latest note: example.", "chat", [result]),
      ).toEqual({
        verdict: "reject",
        kind: "view_navigation",
      });
    },
  );
});
