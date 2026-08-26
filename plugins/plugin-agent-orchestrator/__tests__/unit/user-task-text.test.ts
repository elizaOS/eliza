/**
 * Verifies composeUserTaskBody + userTaskFromInitialTask.
 * The compose/derive pair is one contract: the verbatim ask a create merges
 * into the "--- User Task ---" body must round-trip COMPLETE through the
 * section slicer so successors (redirects, respawns, lane scoping) derive
 * from the user's actual words, never just the planner's short label (live
 * 2026-08-21, task 5c6d85c0 "demo-hello": the builder saw only "demo-hello
 * page" while the verifier graded the verbatim gradient/date ask).
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  composeUserTaskBody,
  USER_TASK_MARKER,
  userTaskFromInitialTask,
  VERBATIM_REQUEST_HEADING,
} from "../../src/services/user-task-text.ts";

const VERBATIM =
  "build a tiny app called demo-hello: a page that says hello with a nice gradient and the current date, deploy it";

describe("composeUserTaskBody", () => {
  it("prefixes the short planner label onto the complete verbatim ask", () => {
    const body = composeUserTaskBody("demo-hello page", VERBATIM);
    expect(body.startsWith("demo-hello page")).toBe(true);
    expect(body).toContain(VERBATIM_REQUEST_HEADING);
    // PROMPT-INTEGRITY: the verbatim ask survives COMPLETE, not summarized.
    expect(body).toContain(VERBATIM);
  });

  it("returns the task unchanged when there is no verbatim request", () => {
    expect(composeUserTaskBody("demo-hello page", undefined)).toBe(
      "demo-hello page",
    );
    expect(composeUserTaskBody("demo-hello page", "   ")).toBe(
      "demo-hello page",
    );
  });

  it("returns the verbatim ask alone when the task text is blank", () => {
    expect(composeUserTaskBody("  ", VERBATIM)).toBe(VERBATIM);
  });

  it("does not duplicate when the task already contains the verbatim ask", () => {
    const full = `Build this now.\n${VERBATIM}\nUse the apps route.`;
    expect(composeUserTaskBody(full, VERBATIM)).toBe(full.trim());
  });

  it("uses the verbatim ask alone when it already contains the task text", () => {
    expect(composeUserTaskBody("a page that says hello", VERBATIM)).toBe(
      VERBATIM,
    );
  });

  it("containment is whitespace- and case-insensitive", () => {
    const spaced = VERBATIM.replace(/\s+/g, "  ").toUpperCase();
    expect(composeUserTaskBody(spaced, VERBATIM)).toBe(spaced.trim());
  });
});

describe("composeUserTaskBody → userTaskFromInitialTask round trip", () => {
  it("a successor derives the label AND the complete verbatim ask from the User Task section", () => {
    const body = composeUserTaskBody("demo-hello page", VERBATIM);
    const childPrompt = [
      "--- Swarm Coordination ---",
      "Named coding sub-agent in a task swarm.",
      USER_TASK_MARKER,
      body,
      "--- Publishing web apps (custom host) ---",
      "Trailing guidance that must NOT leak into successors.",
    ].join("\n");

    const derived = userTaskFromInitialTask(childPrompt);
    expect(derived).toBe(body);
    expect(derived).toContain("demo-hello page");
    expect(derived).toContain(VERBATIM);
    expect(derived).not.toContain("Publishing web apps");
  });
});
