/**
 * Real-action retrieval regression for workflow requests competing with the
 * main-chat PAGE_DELEGATE umbrella. This runs core's production catalog and
 * retrieval functions against the actual registered Action objects.
 */
import { buildActionCatalog } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { workflowAction } from "../../../../plugins/plugin-workflow/src/actions/workflow.ts";
import { retrieveActions } from "../../../core/src/runtime/action-retrieval.ts";
import { pageDelegateAction } from "../../src/actions/page-action-groups.ts";

const CREATE_WORKFLOW_REQUEST =
  "Create a workflow named Computer Smithers Proof with a Manual Trigger, then a Set node that assigns a literal, and keep it inactive.";

function retrieveWorkflowRequest(options?: {
  candidateActions?: string[];
  parentActionHints?: string[];
}) {
  return retrieveActions({
    catalog: buildActionCatalog([pageDelegateAction, workflowAction]),
    messageText: CREATE_WORKFLOW_REQUEST,
    candidateActions: options?.candidateActions ?? [],
    parentActionHints: options?.parentActionHints,
    selectedContexts: ["automation"],
    limit: 2,
  });
}

describe("workflow action retrieval", () => {
  it("ranks direct WORKFLOW above PAGE_DELEGATE for a natural create request", () => {
    const response = retrieveWorkflowRequest();
    const names = response.results.map((result) => result.name);

    expect(names[0]).toBe("WORKFLOW");
    expect(names).toContain("PAGE_DELEGATE");
    expect(response.results[0]?.score).toBeGreaterThan(
      response.results.find((result) => result.name === "PAGE_DELEGATE")
        ?.score ?? 0,
    );
  });

  it("keeps WORKFLOW first when Stage 1 supplies the canonical exact hints", () => {
    const response = retrieveWorkflowRequest({
      candidateActions: ["WORKFLOW"],
      parentActionHints: ["WORKFLOW"],
    });

    expect(response.results[0]?.name).toBe("WORKFLOW");
    expect(response.results[0]?.stageScores.exact).toBe(1);
  });

  it("resolves the observed WORKFLOW_CREATE candidate alias to WORKFLOW", () => {
    const response = retrieveWorkflowRequest({
      candidateActions: ["WORKFLOW_CREATE"],
    });

    expect(response.results[0]?.name).toBe("WORKFLOW");
    expect(response.results[0]?.stageScores.exact).toBe(1);
  });
});
