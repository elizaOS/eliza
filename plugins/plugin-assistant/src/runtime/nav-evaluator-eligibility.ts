import type { PlannerTrajectory } from "@elizaos/core";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Restricts model classification only; never converts replies or waives receipt validation. */
export function isDeliveredNavigationOnlyTurn(
  trajectory: PlannerTrajectory,
): boolean {
  if (
    trajectory.plannedQueue?.length ||
    trajectory.archivedSteps?.length ||
    trajectory.outcomeIntents?.length !== 1
  )
    return false;
  const executed = trajectory.steps.filter((step) => !step.terminalOnly);
  if (executed.length !== 1) return false;
  const step = executed[0],
    result = step.result,
    call = step.toolCall;
  if (
    !call ||
    !["VIEWS", "VIEWS_SHOW"].includes(call.name) ||
    result?.success !== true ||
    result.transcriptVisibility !== "internal" ||
    result.modelReplyRequired !== true ||
    result.effectReceipts?.length ||
    result.userFacingEffectReceiptIds?.length
  )
    return false;
  const nav = result.data?.navigation,
    values = result.data?.values,
    view = result.data?.view;
  if (
    !record(nav) ||
    !record(values) ||
    !record(view) ||
    nav.effect !== "view_navigation" ||
    nav.status !== "delivered" ||
    typeof nav.handoffId !== "string" ||
    !nav.handoffId.trim()
  )
    return false;
  if (
    values.completedActionDelivered !== true ||
    values.completedActionHandoffId !== nav.handoffId ||
    values.viewId !== nav.viewId ||
    view.id !== nav.viewId ||
    view.label !== nav.label ||
    values.viewPath !== nav.path
  )
    return false;
  const wanted = call.params?.view;
  if (
    typeof wanted !== "string" ||
    !wanted.trim() ||
    ![nav.viewId, nav.label].some(
      (v) =>
        typeof v === "string" &&
        v.trim().toLowerCase() === wanted.trim().toLowerCase(),
    )
  )
    return false;
  const stepId = call.params?.navigationStepId;
  return typeof stepId === "string"
    ? stepId.length > 0 && nav.stepId === stepId
    : nav.stepId === null;
}
