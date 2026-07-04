/**
 * Cross-list view-id drift guard (#8797).
 *
 * Four+ independent per-view lists describe the view system, each owned by a
 * different module:
 *   - BUILTIN_VIEWS              (packages/agent/src/api/builtin-views.ts)
 *   - MATCHER_VIEW_IDS/VIEW_NOUNS (plugin-app-control view-command-matcher)
 *   - INTENT_VIEW_IDS            (plugin-app-control views-show resolveIntentView)
 *   - CONTEXT_VIEWS             (plugin-app-control view-context evaluator)
 *   - view action affinity      (this package's view-action-affinity)
 *
 * Nothing previously asserted they agree on the set of view ids, so a change to
 * one (rename a view, add a contextual surface) could silently leave the others
 * stale. This test fails when they drift: every contextual/intent view must be
 * reachable by the rigid matcher, every user-facing builtin must have matcher
 * nouns, and host/plugin action affinity must be structurally sound.
 */
import { describe, expect, it } from "vitest";
import { MATCHER_VIEW_IDS } from "../../../../plugins/plugin-app-control/src/actions/view-command-matcher.ts";
import { INTENT_VIEW_IDS } from "../../../../plugins/plugin-app-control/src/actions/views-show.ts";
import { CONTEXT_VIEWS } from "../../../../plugins/plugin-app-control/src/evaluators/view-context.ts";
import { BUILTIN_VIEWS } from "../api/builtin-views.ts";
import { registerBuiltinViews } from "../api/views-registry.ts";
import { viewActionAffinityMap } from "./view-action-affinity.ts";

const MATCHER = new Set<string>(MATCHER_VIEW_IDS);

describe("view-id drift guard (#8797)", () => {
  it("MATCHER_VIEW_IDS has no duplicates", () => {
    expect(MATCHER_VIEW_IDS.length).toBe(MATCHER.size);
  });

  it("every CONTEXT_VIEWS id is reachable by the rigid matcher", () => {
    // A contextual inference ("fix the login bug" → task-coordinator) must also
    // be reachable by an explicit command, or the two paths disagree on what is
    // navigable.
    const missing = CONTEXT_VIEWS.filter((id) => !MATCHER.has(id));
    expect(
      missing,
      `CONTEXT_VIEWS not in MATCHER_VIEW_IDS: ${missing}`,
    ).toEqual([]);
  });

  it("every resolveIntentView target is reachable by the rigid matcher", () => {
    const missing = INTENT_VIEW_IDS.filter((id) => !MATCHER.has(id));
    expect(
      missing,
      `INTENT_VIEW_IDS not in MATCHER_VIEW_IDS: ${missing}`,
    ).toEqual([]);
  });

  it("every user-facing builtin view has at least one matcher noun", () => {
    // developerOnly + tutorial views are not voice/command navigable by design;
    // everything else a user can land on should be matcher-resolvable.
    const userFacing = BUILTIN_VIEWS.filter(
      (v) => !v.developerOnly && v.id !== "tutorial",
    ).map((v) => v.id);
    const missing = userFacing.filter((id) => !MATCHER.has(id));
    expect(
      missing,
      `user-facing builtin views without matcher nouns: ${missing}`,
    ).toEqual([]);
  });

  it("view action affinity entries are non-empty action lists", () => {
    registerBuiltinViews();
    for (const [viewId, actions] of Object.entries(viewActionAffinityMap())) {
      expect(Array.isArray(actions), `${viewId} actions not array`).toBe(true);
      expect(actions.length, `${viewId} has empty action list`).toBeGreaterThan(
        0,
      );
    }
  });
});
