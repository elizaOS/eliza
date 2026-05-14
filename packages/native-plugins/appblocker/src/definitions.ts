export type AppBlockerPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "not-applicable";

export type AppBlockerSettingsTarget =
  | "screenTime"
  | "usageAccess"
  | "overlay"
  | "deviceSettings";

export interface AppBlockerCapabilities {
  canSelectApps: boolean;
  canBlockApps: boolean;
  canScheduleTimedBlocks: boolean;
  canUnblockEarly: boolean;
  requiresFamilyControls: boolean;
  requiresUsageAccess: boolean;
  requiresOverlay: boolean;
}

export interface AppBlockerPermissionResult {
  status: AppBlockerPermissionStatus;
  canRequest: boolean;
  canOpenSettings: boolean;
  settingsTarget: AppBlockerSettingsTarget | null;
  engine: AppBlockerStatus["engine"];
  capabilities: AppBlockerCapabilities;
  reason?: string;
}

export interface InstalledApp {
  packageName: string;
  displayName: string;
  tokenData?: string;
}

export interface SelectAppsResult {
  apps: InstalledApp[];
  cancelled: boolean;
}

export interface BlockAppsOptions {
  appTokens?: string[];
  packageNames?: string[];
  durationMinutes?: number | null;
}

export interface BlockAppsResult {
  success: boolean;
  endsAt: string | null;
  error?: string;
  blockedCount: number;
}

export interface UnblockAppsResult {
  success: boolean;
  error?: string;
}

export interface AppBlockerStatus {
  status: "active" | "inactive" | "unavailable";
  available: boolean;
  active: boolean;
  platform: string;
  engine: "family-controls" | "usage-stats-overlay" | "none";
  capabilities: AppBlockerCapabilities;
  blockedCount: number;
  blockedPackageNames: string[];
  endsAt: string | null;
  permissionStatus: AppBlockerPermissionStatus;
  canRequest: boolean;
  canOpenSettings: boolean;
  settingsTarget: AppBlockerSettingsTarget | null;
  reason?: string;
}

export interface AppBlockerPlugin {
  checkPermissions(): Promise<AppBlockerPermissionResult>;
  requestPermissions(): Promise<AppBlockerPermissionResult>;
  getInstalledApps(): Promise<{ apps: InstalledApp[] }>;
  selectApps(): Promise<SelectAppsResult>;
  blockApps(options: BlockAppsOptions): Promise<BlockAppsResult>;
  unblockApps(): Promise<UnblockAppsResult>;
  getStatus(): Promise<AppBlockerStatus>;
}
