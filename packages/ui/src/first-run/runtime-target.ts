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
