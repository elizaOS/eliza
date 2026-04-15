export type AppBlockerPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "not-applicable";

export interface AppBlockerPermissionResult {
  status: AppBlockerPermissionStatus;
  canRequest: boolean;
  reason?: string;
}

export interface InstalledApp {
  /** Android: e.g. "com.twitter.android". iOS: empty (tokens are opaque). */
  packageName: string;
  /** Human-readable app name. */
  displayName: string;
  /** iOS: base64-encoded opaque FamilyControls ApplicationToken. Android: absent. */
  tokenData?: string;
}

export interface SelectAppsResult {
  /** iOS: apps selected via FamilyActivityPicker. Android: empty. */
  apps: InstalledApp[];
  /** True if the user cancelled the picker. */
  cancelled: boolean;
}

export interface BlockAppsOptions {
  /** iOS: base64-encoded FamilyControls ApplicationToken data from selectApps(). */
  appTokens?: string[];
  /** Android: package names to block. */
  packageNames?: string[];
  /** Block duration in minutes. null = indefinite until manually unblocked. */
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
  available: boolean;
  active: boolean;
  platform: string;
  engine: "family-controls" | "usage-stats-overlay" | "none";
  blockedCount: number;
  /** Android: blocked package names. iOS: empty (tokens are opaque). */
  blockedPackageNames: string[];
  endsAt: string | null;
  permissionStatus: AppBlockerPermissionStatus;
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
