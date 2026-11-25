type PluginListenerHandle = { remove(): Promise<void> };

export type SurfaceProcessSharing = "isolated" | "shared";

export type SurfaceStorageSharing = "isolated" | "shared";

export interface SurfaceOwnerOptions {
  owner: string;
  session: string;
  epoch: number;
}

export type NativePageGuidance =
  | { kind: "hide" | "pause" }
  | {
      kind: "action-status";
      id: string;
      snapshotId: string;
      nodeId: string;
      action: "click" | "fill" | "select" | "scroll" | "follow";
    }
  | {
      kind: "show";
      id: string;
      snapshotId: string;
      nodeId: string;
      origin: string;
      expiresAt: number;
      text: string;
      detail?: string;
      assistantName?: string;
      tone?: "instruction" | "active" | "success";
      action?: "click" | "fill" | "select" | "scroll";
      keepClear?: string[];
      restore?: boolean;
    };

export type SurfaceLayer = "above-host" | "below-host";

interface SurfaceCreateBase extends SurfaceOwnerOptions {
  id: string;
  url?: string;
  process: SurfaceProcessSharing;
  storage: SurfaceStorageSharing;
  interceptNavigation?: boolean;
  answersRequests?: boolean;
  profileKey?: string;
  layer?: SurfaceLayer;
}

export type CreateSurfaceOptions = SurfaceCreateBase &
  (
    | { purpose?: undefined }
    | {
        purpose: "manual-sign-in";
        process: "isolated";
        storage: "isolated";
        profileKey?: never;
        interceptNavigation?: false;
        answersRequests?: false;
      }
  );

export interface NavigationRequestedEvent extends SurfaceIdOptions {
  url: string;
  redirect: boolean;
  userGesture: boolean;
  method?: string;
  newWindow?: boolean;
}

export interface DialogRequestedEvent extends SurfaceIdOptions {
  dialogId: string;
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultText?: string;
  url: string | null;
}

export interface DownloadRequestedEvent extends SurfaceIdOptions {
  requestId: string;
  url: string | null;
  fileName: string;
  mimeType: string;
  contentLength: number;
  pdf: boolean;
}

export interface DownloadFinishedEvent extends SurfaceIdOptions {
  requestId: string;
  status: "saved" | "failed";
  fileName: string;
  mimeType: string;
}

export interface FileChooserRequestedEvent extends SurfaceIdOptions {
  requestId: string;
  acceptTypes: string[];
  multiple: boolean;
  capture: boolean;
}

export type SitePermissionKind = "camera" | "microphone" | "location";

export interface SitePermissionRequestedEvent extends SurfaceIdOptions {
  requestId: string | null;
  origin: string | null;
  kinds: SitePermissionKind[];
  topFrame: boolean;
  androidPermissions: string[];
}

export interface SitePermissionWithdrawnEvent extends SurfaceIdOptions {
  requestId: string;
}

export type SitePermissionOutcome =
  | "granted"
  | "denied"
  | "android-refused"
  | "ended";

export interface SitePermissionAnswer {
  granted: boolean;
  outcome: SitePermissionOutcome;
}

export interface PageStartedEvent extends SurfaceIdOptions {
  url: string;
}

export interface FullscreenChangedEvent extends SurfaceIdOptions {
  active: boolean;
}

export interface ExternalLinkRequestedEvent extends SurfaceIdOptions {
  url: string;
  handoff: "send-to" | "dial" | "view" | "refuse";
  fallbackUrl: string | null;
}

export interface IdentityProviderRequestedEvent extends SurfaceIdOptions {
  requestId: string;
  provider: "google" | "facebook";
  url: string;
}

export interface SurfaceCrashedEvent extends SurfaceIdOptions {
  didCrash: boolean;
  url: string | null;
}

export interface NavigationChangedEvent
  extends SurfaceIdOptions,
    Partial<Omit<SurfaceState, keyof SurfaceOwnerOptions>> {}

export interface SurfaceClosedEvent extends SurfaceIdOptions {
  reason: "profile-purged";
}

export interface KeyboardChangedEvent {
  visible: boolean;
  height: number;
}

export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceCornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export interface SurfaceOuterClip extends SurfaceRect {
  cornerRadii: SurfaceCornerRadii;
}

export interface SetBoundsOptions extends SurfaceRect, SurfaceOwnerOptions {
  id: string;
  outerClip: SurfaceOuterClip;
}

export interface SurfaceOcclusionRect extends SurfaceRect {
  cornerRadius: number;
}

export interface SetOcclusionRectsOptions extends SurfaceOwnerOptions {
  id: string;
  rects: SurfaceOcclusionRect[];
}

export interface NavigateOptions extends SurfaceOwnerOptions {
  id: string;
  url: string;
}

export interface SurfaceIdOptions extends SurfaceOwnerOptions {
  id: string;
}

export interface PresentSurfaceOptions extends SurfaceOwnerOptions {
  id: string | null;
}

export interface ReconcileOwnerOptions extends SurfaceOwnerOptions {
  desiredIds: string[];
}

export interface SurfaceState {
  exists: boolean;
  foregrounded: boolean;
  paused?: boolean;
  currentUrl: string | null;
  process: SurfaceProcessSharing | null;
  storage: SurfaceStorageSharing | null;
  owner: string | null;
  session: string | null;
  epoch: number | null;
  title?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  progress?: number;
  pageError?: string | null;
  securityBlocked?: boolean;
  pageScale?: number | null;
}

export interface SurfaceStateWithId extends SurfaceState {
  id: string;
}

export interface SurfaceStateList {
  surfaces: SurfaceStateWithId[];
}

export interface NativePageRead {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export interface BrowserDockState {
  supported: boolean;
  embedded: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ElizaSurfaceManagerPlugin {
  getBrowserHelperEntryState(): Promise<{
    permissionGranted: boolean;
    visible: boolean;
    fullScreen: boolean;
  }>;
  requestBrowserHelperEntryPermission(): Promise<{ status: "dispatched" }>;
  hideBrowserDockWithEntry(options: {
    label: string;
    description: string;
  }): Promise<{ status: "requested" }>;
  restoreBrowserDockFromEntry(): Promise<{ status: "requested" }>;
  setBrowserDockVisible(options: {
    visible: boolean;
  }): Promise<{ status: "requested" }>;

  openDockedBrowser(options: { url: string; panelWidthDp?: number }): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
    status: "dispatched";
  }>;
  getBrowserDockState(): Promise<BrowserDockState>;

  presentBrowser(): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
  }>;

  openBrowser(options: { url: string }): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
    engine: "chromium";
    surface: "custom-tab";
  }>;
  createSurface(options: CreateSurfaceOptions): Promise<void>;
  setBounds(options: SetBoundsOptions): Promise<void>;
  setOcclusionRects(options: SetOcclusionRectsOptions): Promise<void>;
  navigate(options: NavigateOptions): Promise<void>;
  reloadSurface(options: SurfaceIdOptions): Promise<void>;
  stopLoading(options: SurfaceIdOptions): Promise<void>;
  goBack(options: SurfaceIdOptions): Promise<void>;
  goForward(options: SurfaceIdOptions): Promise<void>;
  answerDialog(
    options: SurfaceIdOptions & {
      dialogId: string;
      accept: boolean;
      text?: string;
    },
  ): Promise<void>;
  answerFileChooser(
    options: SurfaceIdOptions & { requestId: string; open: boolean },
  ): Promise<void>;
  answerSitePermission(
    options: SurfaceIdOptions & { requestId: string; grant: boolean },
  ): Promise<SitePermissionAnswer>;
  saveDownload(
    options: SurfaceIdOptions & { requestId: string },
  ): Promise<void>;
  openIdentityProvider(
    options: SurfaceIdOptions & { requestId: string },
  ): Promise<{ status: "dispatched" }>;
  openExternalLink(
    options: SurfaceIdOptions & { url: string },
  ): Promise<{ status: "dispatched" }>;
  purgeProfiles(
    options: SurfaceOwnerOptions &
      (
        | { profileKey: string; idleMs?: never; all?: never }
        | { idleMs: number; profileKey?: never; all?: never }
        | { all: true; profileKey?: never; idleMs?: never }
      ),
  ): Promise<{ purged: number; clean?: boolean }>;
  observeHistory(options: SurfaceIdOptions): Promise<{
    destinations: Array<{
      reference: string;
      direction: "back" | "forward";
      url: string;
      title: string;
    }>;
  }>;
  navigateHistory(options: SurfaceIdOptions & { reference: string }): Promise<{
    documentId: string;
    frameScope: "main";
    result: { dispatched: true; requiresReadback: true };
  }>;
  controlPage(
    options: SurfaceIdOptions & {
      documentId?: string;
      command: {
        subaction:
          | "snapshot"
          | "click"
          | "fill"
          | "select"
          | "scroll"
          | "follow"
          | "guide";
        statementRegions?: true;
        validateOnly?: boolean;
        guidance?: NativePageGuidance;
        snapshotId?: string;
        nodeId?: string;
        text?: string;
        direction?: "up" | "down" | "left" | "right";
        taskPolicy?: {
          origin: string;
          expiresAt: number;
          guidanceScope?: string;
          actionId?: string;
          expectedSelector?: string;
          assistantName?: string;
          commitPattern?: string;
          protectedValueKind?: "verification-code";
          commitGrant?: {
            grantId: string;
            selector?: string;
            requestTarget?:
              | { url: string; method: string }
              | { path: string; method: string };
            formHash?: string;
            valueHash?: string;
            expiresAt: number;
          };
          targets: Array<{
            selector: string;
            action:
              | "click"
              | "fill"
              | "fill-code"
              | "select"
              | "scroll"
              | "follow";
          }>;
        };
      };
    },
  ): Promise<{
    documentId: string;
    frameScope: "main";
    result: Record<string, unknown>;
  }>;
  readPage(
    options: SurfaceIdOptions & { selector?: string },
  ): Promise<NativePageRead>;
  addListener(
    eventName: "browserHelperReturned",
    listener: (event: { presentation: "full-screen" }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "browserHelperReturnFailed",
    listener: (event: { code: string }) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: "browserHelperWindowClosed",
    listener: (event: {
      reason: "website-opened" | "permission-revoked";
    }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "navigationChanged",
    listener: (event: NavigationChangedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "navigationRequested",
    listener: (event: NavigationRequestedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "dialogRequested",
    listener: (event: DialogRequestedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "downloadRequested",
    listener: (event: DownloadRequestedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "downloadFinished",
    listener: (event: DownloadFinishedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "fileChooserRequested",
    listener: (event: FileChooserRequestedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "sitePermissionRequested",
    listener: (event: SitePermissionRequestedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "sitePermissionWithdrawn",
    listener: (event: SitePermissionWithdrawnEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "pageStarted",
    listener: (event: PageStartedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "fullscreenChanged",
    listener: (event: FullscreenChangedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "externalLinkRequested",
    listener: (event: ExternalLinkRequestedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "identityProviderRequested",
    listener: (event: IdentityProviderRequestedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "surfaceCrashed",
    listener: (event: SurfaceCrashedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "surfaceClosed",
    listener: (event: SurfaceClosedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "keyboardChanged",
    listener: (event: KeyboardChangedEvent) => void,
  ): Promise<PluginListenerHandle>;
  presentSurface(options: PresentSurfaceOptions): Promise<void>;
  pauseSurface(options: SurfaceIdOptions): Promise<void>;
  resumeSurface(options: SurfaceIdOptions): Promise<void>;
  destroySurface(options: SurfaceIdOptions): Promise<void>;
  getSurfaceState(options: SurfaceIdOptions): Promise<SurfaceState>;
  listSurfaceStates(options: SurfaceOwnerOptions): Promise<SurfaceStateList>;
  reconcileOwner(options: ReconcileOwnerOptions): Promise<void>;
}
