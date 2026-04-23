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

export interface SystemPlugin {
  getStatus(): Promise<SystemStatus>;
  openSettings(): Promise<void>;
}
