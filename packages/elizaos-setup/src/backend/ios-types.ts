export interface IosDevice {
  udid: string;
  name: string;
  model: string;
  osVersion: string;
  architecture: "arm64" | "arm64e" | "armv7" | "unknown";
  connectionType: "usb" | "wifi" | "unknown";
}

export type IosInstallStepId =
  | "detect-device"
  | "authenticate"
  | "verify-2fa"
  | "download-ipa"
  | "sign-ipa"
  | "install-ipa"
  | "complete";

export type IosInstallStepStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "waiting-user";

export interface IosInstallStep {
  id: IosInstallStepId;
  label: string;
  status: IosInstallStepStatus;
  detail?: string;
}

export interface IosApp {
  id: string;
  name: string;
  version: string;
  ipaUrl: string;
  description: string;
  iconUrl?: string;
  minOsVersion?: string;
}

export interface IosInstallRequest {
  deviceUdid: string;
  appId: string;
  appleId: string;
  // password intentionally NOT included — passed as env var to subprocess
}

export interface IosInstallPlan {
  device: IosDevice;
  app: IosApp;
  steps: IosInstallStep[];
  requiresAppleId: boolean;
  regionNotice?: "eu-dma" | "japan-sca" | "worldwide";
}

export interface IosAuthState {
  status:
    | "idle"
    | "authenticating"
    | "awaiting-2fa"
    | "authenticated"
    | "failed";
  appleId?: string;
  errorMessage?: string;
}

export interface IosBackend {
  listDevices(): Promise<IosDevice[]>;
  listApps(): Promise<IosApp[]>;
  getRegionNotice(): Promise<"eu-dma" | "japan-sca" | "worldwide">;
  createInstallPlan(request: IosInstallRequest): Promise<IosInstallPlan>;
  authenticate(appleId: string, password: string): Promise<IosAuthState>;
  submit2fa(code: string): Promise<IosAuthState>;
  executeInstallPlan(
    plan: IosInstallPlan,
    onProgress: (
      stepId: IosInstallStepId,
      status: IosInstallStepStatus,
      detail?: string,
    ) => void,
  ): Promise<void>;
}
