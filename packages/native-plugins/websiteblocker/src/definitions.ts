export type WebsiteBlockerPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "not-applicable";

export type WebsiteBlockerEngine =
  | "hosts-file"
  | "vpn-dns"
  | "network-extension"
  | "content-blocker";

export type WebsiteBlockerElevationMethod =
  | "osascript"
  | "pkexec"
  | "powershell-runas"
  | "vpn-consent"
  | "system-settings"
  | null;

export type WebsiteBlockerSettingsTarget =
  | "vpn"
  | "contentBlocker"
  | "systemSettings"
  | "runtime";

export interface WebsiteBlockerPermissionResult {
  status: WebsiteBlockerPermissionStatus;
  canRequest: boolean;
  canOpenSettings: boolean;
  settingsTarget: WebsiteBlockerSettingsTarget | null;
  engine: WebsiteBlockerEngine;
  reason?: string;
}

export interface WebsiteBlockerStatus {
  status: "active" | "inactive" | "unavailable";
  available: boolean;
  active: boolean;
  hostsFilePath: string | null;
  endsAt: string | null;
  websites: string[];
  requestedWebsites: string[];
  blockedWebsites: string[];
  allowedWebsites: string[];
  matchMode: "exact" | "subdomain";
  canUnblockEarly: boolean;
  requiresElevation: boolean;
  engine: WebsiteBlockerEngine;
  platform: string;
  supportsElevationPrompt: boolean;
  elevationPromptMethod: WebsiteBlockerElevationMethod;
  permissionStatus?: WebsiteBlockerPermissionStatus;
  canRequest?: boolean;
  canOpenSettings?: boolean;
  settingsTarget?: WebsiteBlockerSettingsTarget | null;
  canRequestPermission?: boolean;
  canOpenSystemSettings?: boolean;
  reason?: string;
}

export interface WebsiteBlockerOpenSettingsResult {
  opened: boolean;
  target: WebsiteBlockerSettingsTarget;
  actualTarget: WebsiteBlockerSettingsTarget;
  reason: string | null;
}

export interface StartWebsiteBlockOptions {
  websites?: string[] | string;
  durationMinutes?: number | string | null;
  text?: string;
}

export type StartWebsiteBlockResult =
  | {
      success: true;
      endsAt: string | null;
      request: {
        websites: string[];
        durationMinutes: number | null;
      };
    }
  | {
      success: false;
      error: string;
      status?: {
        active: boolean;
        endsAt: string | null;
        websites: string[];
        requiresElevation: boolean;
      };
    };

export type StopWebsiteBlockResult =
  | {
      success: true;
      removed: boolean;
      status: {
        active: boolean;
        endsAt: string | null;
        websites: string[];
        canUnblockEarly: boolean;
        requiresElevation: boolean;
      };
    }
  | {
      success: false;
      error: string;
      status?: {
        active: boolean;
        endsAt: string | null;
        websites: string[];
        canUnblockEarly: boolean;
        requiresElevation: boolean;
      };
    };

export interface WebsiteBlockerPlugin {
  getStatus(): Promise<WebsiteBlockerStatus>;
  startBlock(
    options: StartWebsiteBlockOptions,
  ): Promise<StartWebsiteBlockResult>;
  stopBlock(): Promise<StopWebsiteBlockResult>;
  checkPermissions(): Promise<WebsiteBlockerPermissionResult>;
  requestPermissions(): Promise<WebsiteBlockerPermissionResult>;
  openSettings(): Promise<WebsiteBlockerOpenSettingsResult>;
}
