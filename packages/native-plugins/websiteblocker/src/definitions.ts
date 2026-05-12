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

export interface WebsiteBlockerPermissionResult {
  status: WebsiteBlockerPermissionStatus;
  canRequest: boolean;
  reason?: string;
}

export interface WebsiteBlockerStatus {
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
  canRequestPermission?: boolean;
  canOpenSystemSettings?: boolean;
  reason?: string;
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
  openSettings(): Promise<{ opened: boolean }>;
}
