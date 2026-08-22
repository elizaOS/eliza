/**
 * Decides whether a cloud release may consume build or mutation capacity.
 *
 * Production, previews, manual staging releases, and forced rollbacks are
 * always admitted. Automatic staging releases are latest-wins among runs
 * eligible for this workflow.
 */

export function decideReleaseAdmission({
  eventName,
  targetEnvironment,
  ref,
  force,
  runId,
  latestEligibleRunId,
}) {
  if (
    eventName === "pull_request" ||
    eventName === "workflow_dispatch" ||
    targetEnvironment === "production" ||
    ref === "refs/heads/main" ||
    force
  ) {
    return { shouldDeploy: true, reason: "non-supersedable-release" };
  }

  if (!runId || !latestEligibleRunId) {
    throw new Error(
      "Automatic staging admission requires both runId and latestEligibleRunId",
    );
  }

  if (String(runId) !== String(latestEligibleRunId)) {
    return { shouldDeploy: false, reason: "superseded-staging-run" };
  }

  return { shouldDeploy: true, reason: "latest-eligible-staging-run" };
}
