export type DependencyId =
  | "adb"
  | "fastboot"
  | "libimobiledevice"
  | "sideloader";

export type DependencyStatus =
  | "checking"
  | "found"
  | "found-but-misconfigured"
  | "missing"
  | "installing"
  | "install-failed";

export interface Dependency {
  id: DependencyId;
  name: string;
  description: string;
  commands: string[]; // binary names to check, e.g. ["adb"]
  requiredFor: ("android" | "ios")[];
}

export interface DependencyCheckResult {
  id: DependencyId;
  status: DependencyStatus;
  foundPath?: string;
  version?: string;
  errorMessage?: string;
  manualInstructions?: ManualInstallInstructions;
}

export interface ManualInstallInstructions {
  title: string;
  steps: string[];
  url: string;
}
