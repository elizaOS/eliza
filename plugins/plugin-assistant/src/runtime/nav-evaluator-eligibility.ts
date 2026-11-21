import type { PlannerStep, PlannerTrajectory } from "@elizaos/core";
import { findViewActionHandoff } from "@elizaos/core/protocol";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Read the canonical view action's corroborating receipt, registry entry and wire handoff. */
export function readViewNavigationReceipt(step: PlannerStep) {
  const { toolCall: call, result } = step;
  if (
    step.terminalOnly ||
    (call?.name !== "VIEWS_SHOW" && call?.name !== "VIEWS") ||
    result?.success !== true ||
    result.transcriptVisibility !== "internal" ||
    result.modelReplyRequired !== true
  )
    return;
  const navigation = result.data?.navigation;
  const view = result.data?.view;
  const handoff = findViewActionHandoff([
    { success: true, actionName: call.name, values: result.data?.values },
  ]);
  if (!handoff || !record(navigation) || !record(view)) return;
  const { status, label } = navigation;
  if (
    navigation.effect !== "view_navigation" ||
    (status !== "prepared" && status !== "delivered") ||
    handoff.viewId !== navigation.viewId ||
    view.id !== handoff.viewId ||
    !handoff.completedActionHandoffId ||
    navigation.handoffId !== handoff.completedActionHandoffId ||
    navigation.path !== handoff.viewPath ||
    typeof label !== "string" ||
    (view.label !== undefined && label !== view.label)
  )
    return;
  if (
    status === "prepared"
      ? !handoff.navigationPrepared ||
        handoff.completedActionDelivered ||
        !handoff.navigationBinding ||
        handoff.navigationBinding.installationId !== view.installationId ||
        (result.data?.awaitingDeviceExecution !== true &&
          (!record(result.data?.values) ||
            result.data.values.awaitingDeviceExecution !== true))
      : handoff.navigationPrepared || !handoff.completedActionDelivered
  )
    return;
  return {
    status,
    label,
    navigation,
    handoff,
    installationId: view.installationId,
    registryLabel: view.label,
  };
}

function matchesNavigationStep(
  receipt: NonNullable<ReturnType<typeof readViewNavigationReceipt>>,
  step: PlannerStep,
) {
  const wanted = step.toolCall?.params?.view;
  const stepId = step.toolCall?.params?.navigationStepId;
  return (
    typeof wanted === "string" &&
    wanted.trim().length > 0 &&
    [
      receipt.handoff.viewId,
      receipt.label,
      receipt.navigation.resolvedAlias,
    ].some(
      (name) =>
        typeof name === "string" &&
        name.trim().toLowerCase() === wanted.trim().toLowerCase(),
    ) &&
    (typeof stepId === "string"
      ? stepId.length > 0 && receipt.navigation.stepId === stepId
      : receipt.navigation.stepId === null)
  );
}

/** Look only at this turn's verified handoff, never a model citation or view snapshot. */
export function requiredViewNavigationStatus(
  trajectory: PlannerTrajectory,
): "not-required" | "missing" | "prepared" | "delivered" {
  const required = (trajectory.modelBaseContext ?? trajectory.context).metadata
    ?.requiredViewNavigation;
  if (required === undefined) return "not-required";
  if (
    !record(required) ||
    typeof required.viewId !== "string" ||
    !required.viewId ||
    typeof required.clientId !== "string" ||
    !required.clientId ||
    typeof required.installationId !== "string" ||
    !required.installationId
  )
    return "missing";
  // Only the last validated handoff reaches the renderer. A prepared handoff
  // from an archived step is not eligible for a new renderer claim.
  for (const step of [
    ...trajectory.archivedSteps,
    ...trajectory.steps,
  ].reverse()) {
    const receipt = readViewNavigationReceipt(step);
    if (!receipt) continue;
    if (
      receipt.handoff.viewId !== required.viewId ||
      receipt.installationId !== required.installationId ||
      receipt.registryLabel !== receipt.label ||
      !receipt.handoff.viewPath ||
      !matchesNavigationStep(receipt, step)
    )
      return "missing";
    if (receipt.status === "delivered") return "delivered";
    return receipt.handoff.navigationBinding?.clientId === required.clientId &&
      trajectory.steps.includes(step)
      ? "prepared"
      : "missing";
  }
  return "missing";
}

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
  const step = executed[0];
  if (
    step.result?.effectReceipts?.length ||
    step.result?.userFacingEffectReceiptIds?.length
  )
    return false;
  const receipt = readViewNavigationReceipt(step);
  return (
    receipt?.status === "delivered" &&
    receipt.registryLabel === receipt.label &&
    matchesNavigationStep(receipt, step)
  );
}
