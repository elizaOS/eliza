export type OnboardingServerTarget =
  | ""
  | "local"
  | "remote"
  | "elizacloud"
  | "elizacloud-hybrid";
export declare function isElizaCloudOnboardingTarget(
  target: OnboardingServerTarget,
): boolean;
export declare function activeServerKindToOnboardingServerTarget(
  kind: "local" | "cloud" | "remote",
): Exclude<OnboardingServerTarget, "">;
//# sourceMappingURL=server-target.d.ts.map
