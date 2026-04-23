export type AndroidRoleName = "home" | "dialer" | "sms" | "assistant";

export interface AndroidRoleStatus {
  role: AndroidRoleName;
  androidRole: string;
  held: boolean;
  holders: string[];
  available: boolean;
}

export interface SystemStatus {
  packageName: string;
  roles: AndroidRoleStatus[];
}

export interface AndroidRoleRequestResult {
  role: AndroidRoleName;
  held: boolean;
  resultCode: number;
}

export interface SystemPlugin {
  getStatus(): Promise<SystemStatus>;
  requestRole(options: {
    role: AndroidRoleName;
  }): Promise<AndroidRoleRequestResult>;
  openSettings(): Promise<void>;
}
