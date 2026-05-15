export type OnboardingServerTarget =
  | ""
  | "local"
  | "remote"
  | "elizacloud"
  | "elizacloud-hybrid";

export function isElizaCloudOnboardingTarget(
  target: OnboardingServerTarget,
): boolean {
  return target === "elizacloud" || target === "elizacloud-hybrid";
}

export function activeServerKindToOnboardingServerTarget(
  kind: "local" | "cloud" | "remote",
): Exclude<OnboardingServerTarget, ""> {
  switch (kind) {
    case "local":
      return "local";
    case "cloud":
      return "elizacloud";
    case "remote":
      return "remote";
  }
}
