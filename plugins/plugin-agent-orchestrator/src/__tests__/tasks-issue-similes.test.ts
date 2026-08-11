/**
 * Locks the verb-first GitHub issue hints owned by the TASKS action so Stage-1
 * retrieval keeps reaching the issue-management surface.
 */
import { buildActionCatalog } from "@elizaos/core/node";
import { describe, expect, it } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

const VERB_FIRST_GITHUB_ISSUE_SIMILES = [
  "CREATE_GITHUB_ISSUE",
  "CLOSE_GITHUB_ISSUE",
  "UPDATE_GITHUB_ISSUE",
  "GET_GITHUB_ISSUE",
] as const;

const tasksCatalog = buildActionCatalog([tasksAction]);

describe("TASKS GitHub issue similes", () => {
  it.each(VERB_FIRST_GITHUB_ISSUE_SIMILES)(
    "keeps %s in the TASKS parent catalog",
    (simile) => {
      expect(tasksCatalog.parentByName.get("TASKS")?.similes).toContain(simile);
    },
  );
});
