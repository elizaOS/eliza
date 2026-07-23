/**
 * Decides whether a cloud release may consume build or mutation capacity.
 *
 * Production, previews, and forced rollbacks are always admitted. Automatic
 * staging releases are latest-wins: only the current develop SHA proceeds.
 */

export function decideReleaseAdmission({
  eventName,
  targetEnvironment,
  ref,
  force,
  runSha,
  currentDevelopSha,
}) {
  if (
    eventName === "pull_request" ||
    targetEnvironment === "production" ||
    ref === "refs/heads/main" ||
    force
  ) {
    return { shouldDeploy: true, reason: "non-supersedable-release" };
  }

  if (!runSha || !currentDevelopSha) {
    throw new Error(
      "Automatic staging admission requires both runSha and currentDevelopSha",
    );
  }

  if (runSha !== currentDevelopSha) {
    return { shouldDeploy: false, reason: "superseded-staging-sha" };
  }

  return { shouldDeploy: true, reason: "current-staging-sha" };
}
