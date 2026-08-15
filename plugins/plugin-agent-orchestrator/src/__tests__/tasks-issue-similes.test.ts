/**
 * Exercises GitHub issue Stage-1 hints through the production action
 * promotion, retrieval, and tiering pipeline without invoking GitHub.
 */
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../../../packages/core/src/actions/promote-subactions.ts";
import {
  buildActionCatalog,
  type RuntimeActionLike,
} from "../../../../packages/core/src/runtime/action-catalog.ts";
import { retrieveActions } from "../../../../packages/core/src/runtime/action-retrieval.ts";
import { tierActionResults } from "../../../../packages/core/src/runtime/action-tiering.ts";
import { tasksAction } from "../actions/tasks.ts";

const GITHUB_ISSUE_STAGE1_ALIASES = [
  "GITHUB_ISSUES",
  "GITHUB_CREATE_ISSUE",
  "CREATE_GITHUB_ISSUE",
  "GITHUB_LIST_ISSUES",
  "LIST_GITHUB_ISSUES",
  "GITHUB_CLOSE_ISSUE",
  "CLOSE_GITHUB_ISSUE",
  "GITHUB_REOPEN_ISSUE",
  "REOPEN_GITHUB_ISSUE",
  "GITHUB_UPDATE_ISSUE",
  "UPDATE_GITHUB_ISSUE",
  "GITHUB_GET_ISSUE",
  "GET_GITHUB_ISSUE",
] as const;

const promotedTasksActions = promoteSubactionsToActions(tasksAction);

function retrieveIssueSurface(
  candidateAction: string,
  additionalActions: RuntimeActionLike[] = [],
) {
  const catalog = buildActionCatalog([
    ...promotedTasksActions,
    ...additionalActions,
  ]);
  const retrieval = retrieveActions({
    catalog,
    messageText: "manage the GitHub issues for this repository",
    candidateActions: [candidateAction],
  });
  const surface = tierActionResults({
    catalog,
    results: retrieval.results,
    narrowToCandidateActions: [candidateAction],
    queryTokens: retrieval.query.tokens,
  });

  return { retrieval, surface };
}

describe("TASKS GitHub issue retrieval", () => {
  it.each(GITHUB_ISSUE_STAGE1_ALIASES)(
    "routes %s to the selectable issue-management child",
    (candidateAction) => {
      const { retrieval, surface } = retrieveIssueSurface(candidateAction);
      const tasksResult = retrieval.results.find(
        (result) => result.name === "TASKS",
      );

      expect(tasksResult?.matchedBy).toContain("exact");
      expect(surface.sortedTierAParentNames).toContain("TASKS");
      expect(surface.exposedActionNames).toContain("TASKS_MANAGE_ISSUES");
    },
  );

  it("does not exact-route an alias claimed by multiple parents", () => {
    const { retrieval, surface } = retrieveIssueSurface("GITHUB_LIST_ISSUES", [
      {
        name: "REPOSITORY_ISSUES",
        description: "Inspect repository issue reports.",
        similes: ["GITHUB_LIST_ISSUES"],
      },
    ]);
    const collidedParents = surface.tierAParents.filter((parent) =>
      ["TASKS", "REPOSITORY_ISSUES"].includes(parent.name),
    );

    expect(retrieval.query.parentActionHints).not.toContain("TASKS");
    expect(retrieval.query.parentActionHints).not.toContain(
      "REPOSITORY_ISSUES",
    );
    expect(collidedParents.map((parent) => parent.name)).toEqual(
      expect.arrayContaining(["TASKS", "REPOSITORY_ISSUES"]),
    );
    expect(
      collidedParents.every(
        (parent) => !parent.result.matchedBy.includes("exact"),
      ),
    ).toBe(true);
  });
});
