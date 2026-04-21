export type OnboardingServerTarget = "" | "local" | "remote" | "elizacloud";

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
