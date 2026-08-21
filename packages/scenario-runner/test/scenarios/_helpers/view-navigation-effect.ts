/**
 * Asserts the internal VIEWS navigation receipt returned by direct action turns.
 * Visible acknowledgement prose belongs to the post-tool model path instead.
 */

import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";

export type ExpectedViewNavigationEffect = {
  viewId: string;
  label: string;
  path: string;
};

export function expectAcceptedViewNavigationEffect(
  execution: ScenarioTurnExecution,
  expected: ExpectedViewNavigationEffect,
): string | undefined {
  const expectedReceipt = JSON.stringify({
    effect: "view_navigation",
    status: "accepted",
    viewId: expected.viewId,
    label: expected.label,
    path: expected.path,
  });
  if (execution.responseText !== expectedReceipt) {
    return `expected canonical navigation receipt ${expectedReceipt}, saw ${JSON.stringify(execution.responseText)}`;
  }

  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "VIEWS",
  );
  if (action?.result?.text !== expectedReceipt) {
    return `expected VIEWS result.text canonical navigation receipt ${expectedReceipt}, saw ${JSON.stringify(action?.result?.text)}`;
  }
  const responseBody =
    execution.responseBody &&
    typeof execution.responseBody === "object" &&
    !Array.isArray(execution.responseBody)
      ? (execution.responseBody as Record<string, unknown>)
      : {};
  if (responseBody.transcriptVisibility !== "internal") {
    return `expected navigation receipt transcriptVisibility=internal, saw ${String(responseBody.transcriptVisibility)}`;
  }
  if (responseBody.modelReplyRequired !== true) {
    return `expected navigation to require one user-facing model reply, saw ${String(responseBody.modelReplyRequired)}`;
  }
  if (
    "userFacingText" in responseBody ||
    "verifiedUserFacing" in responseBody
  ) {
    return "expected internal navigation receipt not to claim user-facing prose";
  }
  return undefined;
}
