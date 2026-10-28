/**
 * Public API of the `ElizaSurfaceManager` Capacitor plugin (#15245): the native
 * bridge that layers one isolated web surface per Browser tab on the mobile
 * shell and masks it around host-rendered overlays. The renderer never imports
 * this package directly — `@elizaos/ui`'s
 * `capacitor-native-surface-shell.ts` models the same method set structurally
 * and calls it through the Capacitor `Plugins` registry — but the shapes here
 * are the source of truth for both native implementations (iOS `WKWebView` on a
 * dedicated `WKProcessPool` + `WKWebsiteDataStore`; Android platform-managed
 * out-of-app `WebView` renderer + androidx.webkit `Profile`).
 *
 * The load-bearing invariant every method upholds: an independent surface always
 * carries an EXPLICIT process + storage policy. `createSurface` rejects when
 * either field is absent — there is no implicit platform default, because a
 * defaulted storage partition is exactly the cross-surface leak the isolation
 * epic closes.
 */

import type { PluginListenerHandle } from "@capacitor/core";

/**
 * Native renderer policy. `isolated` means a dedicated pool on iOS and a
 * verified out-of-app sandboxed renderer on Android, which the OS may reuse
 * across sibling WebViews. `shared` selects the plugin pool on iOS and leaves
 * Android renderer placement to the platform.
 */
export type SurfaceProcessSharing = "isolated" | "shared";

/** Website-data-store sharing for a surface — its own store, or the host's. */
export type SurfaceStorageSharing = "isolated" | "shared";

export interface SurfaceOwnerOptions {
  /** Stable product owner across renderer reloads. */
  owner: string;
  /** Unique JS-realm token fencing stale commands after a renderer reload. */
  session: string;
  /** Monotonic renderer epoch; native rejects every command from older epochs. */
  epoch: number;
}

/** Fixed host annotation requests. Approval controls remain in the trusted host. */
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

export interface CreateSurfaceOptions extends SurfaceOwnerOptions {
  /** Stable per-surface id (the Browser tab's surface id). */
  id: string;
  /** Initial URL to load, when known. */
  url?: string;
  /** Explicit renderer-process policy. Required — no default. */
  process: SurfaceProcessSharing;
  /** Explicit storage policy. Required — no default. */
  storage: SurfaceStorageSharing;
  /**
   * Android: the page may navigate within its own origin, but a main-frame navigation to
   * another origin (a cross-origin redirect included) is cancelled before any request and
   * reported as `navigationRequested`. The host loads it with `navigate()` once its own
   * check allows it. Non-web schemes and addresses with credentials are refused in this
   * callback. A main-frame request WebView sends without that callback (a POST form
   * submission, a page's own history move) is answered locally with an empty 204 unless
   * its origin is the committed page's or one the host approved through `navigate`,
   * `createSurface`, `goBack` or `goForward` for the length of that navigation (the https
   * upgrade of either included); it is reported with its `method` and never replayed. So a
   * blocked host never receives the request. A server redirect of an address the host
   * loaded goes on without asking again only within the approved origin or its upgrade. A tapped new window is
   * reported with `newWindow: true`. Subframes are not intercepted. Default false: the
   * page navigates by itself, and a tapped new window opens in place. `setTaskOrigins`
   * lets the page move between the origins of a task the host extended.
   */
  interceptNavigation?: boolean;
  /**
   * Android, isolated storage only: one persistent profile per owner and key (for
   * example a signed-in account id, 1 to 128 of `A-Z a-z 0-9 . _ : @ -`), so website
   * sign-ins survive across openings. The profile name is a digest, never the key.
   * Remove it with `purgeProfiles`. Without a key every surface gets a fresh profile
   * that is cleared when it closes and deleted once Android releases it.
   */
  profileKey?: string;
}

/** A cross-origin main-frame navigation an intercepting surface held for the host. */
export interface NavigationRequestedEvent extends SurfaceIdOptions {
  /** The address the page asked for; nothing has been requested from it yet. */
  url: string;
  /** A server redirect of the page's current navigation, not a new one. */
  redirect: boolean;
  /** Whether the person's gesture started the navigation. */
  userGesture: boolean;
  /** `GET`, or the method of a held submission. `navigate()` always loads with GET. */
  method?: string;
  /** A window the person tapped to open; it loads in this surface if allowed. */
  newWindow?: boolean;
}

/**
 * A JavaScript dialog (`alert`, `confirm`, `prompt`, leave-page) waiting for the host.
 * The page is paused until `answerDialog`. Only surfaces created with
 * `interceptNavigation: true` hold dialogs; any other surface dismisses them at once.
 * Nothing is ever accepted for the person: a dialog of a hidden, closed or navigating
 * surface is dismissed (cancelled).
 */
export interface DialogRequestedEvent extends SurfaceIdOptions {
  dialogId: string;
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  /** Website text, plain and bounded. Show it as the website's words, never Grace's. */
  message: string;
  /** Prompt only: the page's suggested answer. */
  defaultText?: string;
  url: string | null;
}

/**
 * The page asked for a file. Nothing is downloaded. `url` is http(s) only and can carry
 * access tokens: keep it out of models, threads and logs.
 */
export interface DownloadRequestedEvent extends SurfaceIdOptions {
  url: string | null;
  fileName: string;
  mimeType: string;
  /** -1 when unknown. */
  contentLength: number;
  pdf: boolean;
}

/**
 * A tapped link that belongs to another app (`tel:`, `mailto:`, `market:`, `intent:`).
 * The page stays where it is. `openExternalLink` opens it after the host asks; `dial`
 * only opens the dialer. `refuse` links cannot open; `fallbackUrl` is an https page an
 * `intent:` link offered instead, which the host may check and `navigate` to.
 */
export interface ExternalLinkRequestedEvent extends SurfaceIdOptions {
  url: string;
  handoff: "send-to" | "dial" | "view" | "refuse";
  fallbackUrl: string | null;
}

/**
 * A sign-in page that refuses embedded WebViews (Google's `disallowed_useragent`,
 * Facebook's OAuth dialog). It is not loaded; the host opens it in a full browser.
 */
export interface IdentityProviderRequestedEvent extends SurfaceIdOptions {
  provider: "google" | "facebook";
  url: string;
}

/**
 * The page's renderer crashed or Android reclaimed it. The surface is already closed and
 * its id is free; the host app keeps running. Recreate it to show `url` again.
 */
export interface SurfaceCrashedEvent extends SurfaceIdOptions {
  didCrash: boolean;
  url: string | null;
}

/** A surface closed by the plugin, for example when its keyed profile was purged. */
export interface SurfaceClosedEvent extends SurfaceIdOptions {
  reason: "profile-purged";
}

/** Options for a masked page screenshot. */
export interface CaptureSurfaceOptions extends SurfaceIdOptions {
  /** Long edge in pixels, 256 to 2048. Default 1024. Never scaled up. */
  maxEdge?: number;
  /** JPEG quality, 30 to 90. Default 70. */
  quality?: number;
  /**
   * Up to 32 more CSS selectors to cover, for values the host knows are secret.
   * Password, `cc-*`, `one-time-code`, `current-password` and `new-password`
   * fields are always covered.
   */
  maskSelectors?: string[];
  /** Cover every frame the page cannot read (payment fields often live there). Default true. */
  maskFrames?: boolean;
}

/**
 * A masked JPEG of the visible page. Covers are placed before the copy and removed
 * right after; host chrome is painted over. Send it only where the host's retention
 * rules allow, and never store it in a thread or task journal.
 */
export interface SurfaceCapture {
  mimeType: "image/jpeg";
  /** Base64 JPEG bytes. */
  data: string;
  width: number;
  height: number;
  maskedFields: number;
  maskedFrames: number;
  url: string | null;
}

/** The on-screen keyboard opened or closed. `height` is in host CSS pixels. */
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

/** Actual host-space rounded clip enclosing the native page. */
export interface SurfaceOuterClip extends SurfaceRect {
  cornerRadii: SurfaceCornerRadii;
}

export interface SetBoundsOptions extends SurfaceRect, SurfaceOwnerOptions {
  id: string;
  /**
   * Computed host clip in CSS pixels. It travels atomically with the page rect
   * so a responsive radius change never requires recreating the WebView.
   */
  outerClip: SurfaceOuterClip;
}

/**
 * Rounded host-space region where the native page yields to React chrome.
 * Coordinates use the same host CSS-pixel space as {@link SetBoundsOptions}.
 */
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

/** Debug/test introspection of a single surface's live state. */
export interface SurfaceState {
  exists: boolean;
  foregrounded: boolean;
  currentUrl: string | null;
  process: SurfaceProcessSharing | null;
  storage: SurfaceStorageSharing | null;
  owner: string | null;
  session: string | null;
  epoch: number | null;
  /** Android: the page title as plain bounded text. */
  title?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Android: load progress, 0 to 100. */
  progress?: number;
  /** Android: the main-frame load error of the current page, if any. */
  pageError?: string | null;
  /** Android: text zoom in percent. */
  textZoom?: number | null;
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
  /** Legacy-client compatibility flag; consumers reject incomplete reads. */
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
  /** Resize an existing host-owned Android split without navigation. Request receipt only. */
  setBrowserDockVisible(options: {
    visible: boolean;
  }): Promise<{ status: "requested" }>;

  /** Android: explicit navigation with a requested right helper pane. Dispatch is not proof of a split. */
  openDockedBrowser(options: { url: string; panelWidthDp?: number }): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
    status: "dispatched";
  }>;
  /** Actual host activity embedding/bounds. No browser tab or task authority is implied. */
  getBrowserDockState(): Promise<BrowserDockState>;

  /** Android: present the build-pinned browser without a URL or new website tab.
   * Dispatch receipt only; callers must re-observe before any task action.
   * Requires an explicit user interaction. Other platforms reject as unavailable.
   */
  presentBrowser(): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
  }>;

  /**
   * Android: open a website in installed full Chromium with browser-owned
   * storage and permissions. Resolves on dispatch, not page load. This is not
   * an isolated native surface and rejects if Chromium is unavailable.
   */
  openBrowser(options: { url: string }): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
    engine: "chromium";
    surface: "custom-tab";
  }>;
  /**
   * Create a native web surface with the given EXPLICIT process/storage policy.
   * Rejects when `process` or `storage` is missing, or when the platform cannot
   * honour the requested isolation (e.g. Android without multi-profile support).
   */
  createSurface(options: CreateSurfaceOptions): Promise<void>;
  /** Position a surface over the host webview, in host CSS pixels. */
  setBounds(options: SetBoundsOptions): Promise<void>;
  /**
   * Punch rounded regions out of the native layer so host-rendered overlays can
   * paint and receive input without hiding or resizing the underlying page.
   */
  setOcclusionRects(options: SetOcclusionRectsOptions): Promise<void>;
  /** Load a URL in an existing surface. */
  navigate(options: NavigateOptions): Promise<void>;
  /** Reload an existing surface's current page. */
  reloadSurface(options: SurfaceIdOptions): Promise<void>;
  /** Move back in this surface's own history; never replays after a lost reply. */
  goBack(options: SurfaceIdOptions): Promise<void>;
  /** Android: move forward in this surface's own history. */
  goForward(options: SurfaceIdOptions): Promise<void>;
  /** Android: answer a `dialogRequested` dialog once. `accept: false` cancels it. */
  answerDialog(
    options: SurfaceIdOptions & {
      dialogId: string;
      accept: boolean;
      /** Prompt answer, at most 2000 characters. */
      text?: string;
    },
  ): Promise<void>;
  /**
   * Android: open the other-app link the person just tapped (`externalLinkRequested`)
   * with a fresh Intent. Rejects for any other address, and when no app handles it.
   */
  openExternalLink(
    options: SurfaceIdOptions & { url: string },
  ): Promise<{ status: "dispatched" }>;
  /**
   * Android, intercepting surfaces only: the exact HTTPS origins of the host's running
   * task after it extended the task (for example `https://www.ssa.gov` and
   * `https://secure.login.gov`) once its own safety check passed. A page on one of them
   * may then move to another, a POST included, without a `navigationRequested` hold;
   * any other origin is still held. At most 16. `[]` ends the extension. Nothing is
   * ever added without this call, and it does not survive the surface.
   */
  setTaskOrigins(
    options: SurfaceIdOptions & { origins: string[] },
  ): Promise<void>;
  /** Android: page text size in percent, 50 to 300 (100 is the page's own size). */
  setTextZoom(options: SurfaceIdOptions & { percent: number }): Promise<void>;
  /**
   * Android: sign this isolated surface out of every website (cookies, storage,
   * cache). Rejects `SHARED_STORAGE` for a surface on the host's own store.
   */
  clearSurfaceStorage(options: SurfaceIdOptions): Promise<void>;
  /**
   * Android: delete keyed profiles. `profileKey` purges that key now and closes its
   * surfaces (`surfaceClosed`); use it on account sign-out. `idleMs` (at least one
   * hour) purges every keyed profile unused for that long that no surface has open.
   * Data is cleared at once; the profile directory goes once Android releases it.
   */
  purgeProfiles(
    options: SurfaceOwnerOptions &
      (
        | { profileKey: string; idleMs?: never }
        | { idleMs: number; profileKey?: never }
      ),
  ): Promise<{ purged: number }>;
  /**
   * Android 8+: masked screenshot of the visible foreground page for a vision
   * fallback. Rejects (`CAPTURE_MASK_FAILED`, `CAPTURE_STALE`, `CAPTURE_UNAVAILABLE`,
   * `UNSUPPORTED`) rather than return an image it could not mask.
   */
  captureSurface(options: CaptureSurfaceOptions): Promise<SurfaceCapture>;
  /** Android host-only observation of adjacent same-origin history entries. */
  observeHistory(options: SurfaceIdOptions): Promise<{
    destinations: Array<{
      reference: string;
      direction: "back" | "forward";
      url: string;
      title: string;
    }>;
  }>;
  /**
   * Android host-only one-shot dispatch using a fresh observed entry reference.
   * Task authorization and preview are required at the trusted caller. A receipt
   * does not prove arrival; changed/hidden/paused history refuses before dispatch.
   */
  navigateHistory(options: SurfaceIdOptions & { reference: string }): Promise<{
    documentId: string;
    frameScope: "main";
    result: { dispatched: true; requiresReadback: true };
  }>;
  /**
   * Android isolated-world main-frame observation/input. Host-only: task policy
   * must come from the trusted task authorizer, never page or model output.
   * Effects require the documentId and snapshot references from a fresh read.
   * A dispatch receipt requires readback and does not prove website success.
   */
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
        /** Check the target without consuming the snapshot or dispatching input. */
        validateOnly?: boolean;
        guidance?: NativePageGuidance;
        snapshotId?: string;
        nodeId?: string;
        text?: string;
        direction?: "up" | "down" | "left" | "right";
        taskPolicy?: {
          origin: string;
          expiresAt: number;
          /** Host task binding revision and the visible action preview identity. */
          guidanceScope?: string;
          actionId?: string;
          expectedSelector?: string;
          assistantName?: string;
          targets: Array<{
            selector: string;
            action: "click" | "fill" | "select" | "scroll" | "follow";
          }>;
        };
      };
    },
  ): Promise<{
    documentId: string;
    frameScope: "main";
    result: Record<string, unknown>;
  }>;
  /** Read visible text from this foreground native page, never the host DOM. */
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
  /** Signals a native page change; consumers read current state before applying it. */
  addListener(
    eventName: "navigationChanged",
    listener: (event: SurfaceIdOptions) => void,
  ): Promise<PluginListenerHandle>;
  /** An intercepting surface held a cross-origin navigation; `navigate()` to allow it. */
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
  /** Atomically hide all siblings, then present the requested surface or host. */
  presentSurface(options: PresentSurfaceOptions): Promise<void>;
  /** Tear a surface down and release its native renderer and storage resources. */
  destroySurface(options: SurfaceIdOptions): Promise<void>;
  /** Introspect a surface's live state — for debugging and instrumented tests. */
  getSurfaceState(options: SurfaceIdOptions): Promise<SurfaceState>;
  /** List surfaces owned by this exact JS-realm session. */
  listSurfaceStates(options: SurfaceOwnerOptions): Promise<SurfaceStateList>;
  /** Destroy prior-realm/orphan surfaces before this session starts issuing work. */
  reconcileOwner(options: ReconcileOwnerOptions): Promise<void>;
}
