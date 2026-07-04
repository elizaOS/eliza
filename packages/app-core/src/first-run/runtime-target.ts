/**
 * First-run runtime-target vocabulary shared by the onboarding flow. Defines the
 * `FirstRunRuntimeTarget` union ("" | local | remote | elizacloud |
 * elizacloud-hybrid), the `isElizaCloudFirstRunTarget` predicate (true for the
 * two elizacloud variants), and `activeServerKindToFirstRunRuntimeTarget`, which
 * maps the active server kind onto the persisted target — note the `cloud →
 * elizacloud` rename. All pure and dependency-free.
 */
export type FirstRunRuntimeTarget =
  | ""
  | "local"
  | "remote"
  | "elizacloud"
  | "elizacloud-hybrid";

export function isElizaCloudFirstRunTarget(
  target: FirstRunRuntimeTarget,
): boolean {
  return target === "elizacloud" || target === "elizacloud-hybrid";
}

export function activeServerKindToFirstRunRuntimeTarget(
  kind: "local" | "cloud" | "remote",
): Exclude<FirstRunRuntimeTarget, ""> {
  switch (kind) {
    case "local":
      return "local";
    case "cloud":
      return "elizacloud";
    case "remote":
      return "remote";
  }
}
