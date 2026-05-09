export type AppReleaseStatus = {
  currentVersion?: string;
  latestVersion?: string | null;
  channel?: string | null;
  lastCheckAt?: string | number | null;
  updateAvailable?: boolean;
};

export type DesktopBuildInfo = {
  platform: string;
  arch: string;
  defaultRenderer: "native" | "cef";
  availableRenderers: Array<"native" | "cef">;
  cefVersion?: string;
  bunVersion?: string;
  runtime?: Record<string, unknown>;
};

export type DesktopUpdaterSnapshot = {
  currentVersion: string;
  currentHash?: string;
  channel?: string;
  baseUrl?: string;
  appBundlePath?: string | null;
  canAutoUpdate: boolean;
  autoUpdateDisabledReason?: string | null;
  updateAvailable: boolean;
  updateReady: boolean;
  latestVersion?: string | null;
  latestHash?: string | null;
  error?: string | null;
  lastStatus?: {
    status: string;
    message: string;
    timestamp: number;
  } | null;
};

export type DesktopSessionCookie = {
  name: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
};

export type DesktopSessionSnapshot = {
  partition: string;
  persistent: boolean;
  cookieCount: number;
  cookies: DesktopSessionCookie[];
};

export type DesktopReleaseNotesWindowInfo = {
  url: string;
  windowId: number | null;
  webviewId: number | null;
};

export type WebGpuBrowserStatus = {
  available: boolean;
  reason: string;
  renderer: string;
  chromeBetaPath: string | null;
  downloadUrl: string | null;
};

export type WgpuTagElement = HTMLElement & {
  runTest?: () => void;
  toggleTransparent?: (transparent?: boolean) => void;
  togglePassthrough?: (enabled?: boolean) => void;
  toggleHidden?: (hidden?: boolean) => void;
  on?: (event: "ready", listener: (event: CustomEvent) => void) => void;
  off?: (event: "ready", listener: (event: CustomEvent) => void) => void;
};

export const RELEASE_NOTES_PARTITION = "persist:app-release-notes";
export const SESSION_PARTITIONS = [
  { partition: "persist:default", label: "Default app session" },
  { partition: RELEASE_NOTES_PARTITION, label: "Release notes BrowserView" },
] as const;
