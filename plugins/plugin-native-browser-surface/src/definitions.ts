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

/**
 * Where the native page sits relative to the host WebView.
 *
 * - `above-host` (default): the page is drawn over the host. Host chrome over the
 *   page shows through holes cut with `setOcclusionRects`.
 * - `below-host` (Android only; iOS rejects it with `UNSUPPORTED`): the page is drawn
 *   under the host, so the host draws its own chrome, corners and shadows over it with
 *   no holes. This is a drawing-quality change, not a memory or CPU saving: both
 *   WebViews stay live, and the transparent host is blended over the page every frame
 *   the page draws. Measure frame time before adopting it on a device.
 *
 *   The host must be transparent where the page shows: its WebView background
 *   (`WebView.setBackgroundColor(Color.TRANSPARENT)`), every view between the
 *   WebView and its nearest `FrameLayout` ancestor, and its page CSS over the page
 *   rect. The page is clipped only to the outer clip's rectangle, so the host paints
 *   the rounded corners.
 *
 *   `setOcclusionRects` names the host-owned rects. A touch, hover, mouse or drag
 *   event that starts on the page outside them goes to the website for the whole
 *   gesture; any other stays with the host. The page takes no input until the first
 *   `setOcclusionRects` call after `createSurface` (an empty list is fine), and the
 *   host must await `setOcclusionRects` before it shows new interactive chrome over
 *   the page, or a tap there can reach the website. A gesture on a page that is hidden
 *   mid-gesture is cancelled. A drag carried to the page has no local state.
 *
 *   Captures draw the page alone, so host pixels over it never appear; host-owned
 *   rects and everything outside the outer clip are masked as in the default layer.
 *   Put host nodes over the page in `aria-hidden` so TalkBack reaches the website's
 *   own nodes there.
 */
export type SurfaceLayer = "above-host" | "below-host";

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
   * Android: this owner answers the page's dialogs (`dialogRequested`), file inputs
   * (`fileChooserRequested`) and camera, microphone and location requests
   * (`sitePermissionRequested`), so they wait for its answer while it listens for the
   * event. Without it a dialog is cancelled at once, a file input gets no files and a site
   * permission is denied, whatever any other owner listens for; `interceptNavigation` does
   * not hold them. Fixed for the life of the surface: a
   * repeated `createSurface` with a different value rejects. Default false.
   */
  answersRequests?: boolean;
  /**
   * Android, isolated storage only: one persistent profile per owner and key (for
   * example a signed-in account id, 1 to 128 of `A-Z a-z 0-9 . _ : @ -`), so website
   * sign-ins survive across openings. The profile name is a digest, never the key.
   * Remove it with `purgeProfiles`. Without a key every surface gets a fresh profile
   * that is cleared when it closes and deleted once Android releases it. A keyed profile
   * accepts third-party cookies, so embedded sign-ins work there as in a browser.
   */
  profileKey?: string;
  /** Default `above-host`. Fixed for the life of the surface. */
  layer?: SurfaceLayer;
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
 * The page is paused until `answerDialog`. Dialogs wait only on a surface created with
 * `answersRequests` while a `dialogRequested` listener exists; any other surface's,
 * `interceptNavigation` ones included, are dismissed at once, so no page freezes on a
 * dialog nobody shows. Nothing is ever accepted for the person: a dialog of a hidden,
 * paused, closed or navigating surface is dismissed (cancelled). A dismissed
 * `beforeunload` dialog keeps the page and drops the navigation.
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
 * The page asked for a file. Nothing is downloaded until `saveDownload` names `requestId`;
 * a later request replaces this one without an event, and the page navigating or the
 * surface being hidden or closed ends it (`saveDownload` then rejects `DOWNLOAD_NOT_PENDING`). `url` is http(s)
 * only and can carry access tokens: keep it out of models, threads and logs.
 */
export interface DownloadRequestedEvent extends SurfaceIdOptions {
  requestId: string;
  url: string | null;
  fileName: string;
  mimeType: string;
  /** -1 when unknown. */
  contentLength: number;
  pdf: boolean;
}

/** A `saveDownload` ended. `saved` files are in the device's Downloads. */
export interface DownloadFinishedEvent extends SurfaceIdOptions {
  requestId: string;
  status: "saved" | "failed";
  fileName: string;
  mimeType: string;
}

/**
 * Android: a file input of a shown page waits for `answerFileChooser`; the page gets no
 * file until then. Reported only for a surface created with `answersRequests` while the
 * host listens; otherwise, and when the surface is paused, the input gets no files at once.
 * Hiding, navigating or closing the surface answers it with no files.
 */
export interface FileChooserRequestedEvent extends SurfaceIdOptions {
  requestId: string;
  /** The input's `accept` MIME types (extensions are dropped); empty means any file. */
  acceptTypes: string[];
  multiple: boolean;
  /** The input asks for a new photo or recording (`capture`); the picker offers files only. */
  capture: boolean;
}

/** Website access to device sensors a host may grant. */
export type SitePermissionKind = "camera" | "microphone" | "location";

/**
 * Android: a shown page asked for the camera, microphone or location. A request from the
 * https page's own origin waits for `answerSitePermission` and is never remembered; the
 * page withdrawing it, or hiding, navigating or closing the surface, ends it and sends
 * `sitePermissionWithdrawn`. One `answerSitePermission` answers every kind in `kinds`.
 * Another origin's request is already denied and reported with `topFrame: false` and no `requestId`, so the host can say it
 * was blocked. Reported only for a surface created with `answersRequests` while the host
 * listens; kinds the host app declares no Android permission for are never offered.
 */
export interface SitePermissionRequestedEvent extends SurfaceIdOptions {
  requestId: string | null;
  origin: string | null;
  kinds: SitePermissionKind[];
  /**
   * The requesting origin is the page's own top-level origin. WebView names only the
   * requesting origin, never the frame, so a same-origin embedded frame also counts as
   * the page and an embedded frame of another origin does not.
   */
  topFrame: boolean;
  /**
   * Android runtime permissions the host app does not hold yet, for example
   * `android.permission.CAMERA`. `answerSitePermission({ grant: true })` asks Android for
   * them itself, so the person sees Android's own dialog after the host's.
   */
  androidPermissions: string[];
}

/**
 * Android: a held `sitePermissionRequested` request ended without the host's answer. Either
 * the page withdrew it (WebView already cancelled it; the plugin answers nothing), or the
 * page navigated or the surface was hidden, reconciled or closed and the plugin denied it.
 * Close its prompt; `answerSitePermission` would reject `SITE_PERMISSION_CLOSED`, and a
 * grant already waiting on Android's dialog resolves `outcome: "ended"`.
 */
export interface SitePermissionWithdrawnEvent extends SurfaceIdOptions {
  requestId: string;
}

/**
 * Why `answerSitePermission` resolved as it did. Only `granted` gives the page anything.
 * - `granted`: the page has every requested kind.
 * - `denied`: the host answered `grant: false`.
 * - `android-refused`: Android's runtime permission dialog was shown and a permission is
 *   still missing.
 * - `ended`: the request ended unanswered: the page withdrew it, navigating, hiding or
 *   closing ended it while Android asked, the page left the requesting origin, or Android
 *   could not ask (no dialog could open, or it returned no answer because another
 *   permission request was already showing).
 */
export type SitePermissionOutcome =
  | "granted"
  | "denied"
  | "android-refused"
  | "ended";

/** Result of `answerSitePermission`; `granted` is `outcome === "granted"`. */
export interface SitePermissionAnswer {
  granted: boolean;
  outcome: SitePermissionOutcome;
}

/**
 * Android: the surface's main frame started loading a new document (WebView's
 * `onPageStarted`; frames and same-document moves never send it, an error page does).
 * What the previous page waited on has ended first, so every `sitePermissionWithdrawn`
 * this start caused arrives before it. A camera or microphone grant's autoplay ends here.
 */
export interface PageStartedEvent extends SurfaceIdOptions {
  url: string;
}

/**
 * Android: a page's fullscreen view (usually video) opened above the host, or closed.
 * Leaving it restores the host's system bars as they were before.
 */
export interface FullscreenChangedEvent extends SurfaceIdOptions {
  active: boolean;
}

/**
 * A tapped link that belongs to another app (`tel:`, `mailto:`, `sms:`, `smsto:`,
 * `geo:`, `market:`, `intent:`).
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
 * Facebook's OAuth dialog). It is not loaded; the host opens it in a full browser with
 * `openIdentityProvider`.
 */
export interface IdentityProviderRequestedEvent extends SurfaceIdOptions {
  requestId: string;
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

/**
 * A native page change. On Android the event also carries the `getSurfaceState` fields
 * (`currentUrl`, `title`, `canGoBack`, `canGoForward`, `progress` and the rest) as they
 * were when it was sent. Every listener receives every surface's events, so use the
 * fields only when `exists` is true and `owner`, `session` and `epoch` match your own
 * identity (`getSurfaceState` checks that for you). They are a snapshot: one taken before
 * a command the host has not seen settle can be older than that command, and a title
 * or progress that changes later sends no event. iOS sends only the surface id and
 * owner; read `getSurfaceState` when the fields are absent.
 */
export interface NavigationChangedEvent
  extends SurfaceIdOptions,
    Partial<Omit<SurfaceState, keyof SurfaceOwnerOptions>> {}

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
  /** Android: `pauseSurface` paused the page and `resumeSurface` has not run since. */
  paused?: boolean;
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
  /**
   * Android: the page's certificate was refused (it is never passed), so the surface shows
   * an error page in its place. Show a security block over it.
   */
  securityBlocked?: boolean;
  /** Android: text zoom in percent. */
  textZoom?: number | null;
  /**
   * Android: pinch zoom in CSS pixels per density-independent pixel: 1 is the page's own
   * mobile size, below 1 a wide page shown whole, above 1 zoomed in.
   */
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
   * For a `below-host` surface nothing is cut out: the rects are where the host
   * receives input and where captures are masked, and the page takes no input until
   * the first call.
   */
  setOcclusionRects(options: SetOcclusionRectsOptions): Promise<void>;
  /** Load a URL in an existing surface. */
  navigate(options: NavigateOptions): Promise<void>;
  /** Reload an existing surface's current page. */
  reloadSurface(options: SurfaceIdOptions): Promise<void>;
  /**
   * Android: stops the current page load where it is; a no-op when nothing is loading.
   * `navigationChanged` follows so the host re-reads `progress`.
   */
  stopLoading(options: SurfaceIdOptions): Promise<void>;
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
   * Android: answer a `fileChooserRequested` file input once. `open: true` shows the
   * system document picker (one picker at a time, else `FILE_CHOOSER_BUSY`); the files
   * the person picks go to the page. `open: false` gives it no files.
   */
  answerFileChooser(
    options: SurfaceIdOptions & { requestId: string; open: boolean },
  ): Promise<void>;
  /**
   * Android: answer a `sitePermissionRequested` request once. `grant: true` first asks
   * Android for any of the event's `androidPermissions` the app still lacks; the page is
   * granted only if Android allowed them all and it is still at the requesting origin,
   * and is denied otherwise. Resolves with what the page got and why
   * (`SitePermissionOutcome`). A camera or microphone grant lets the current page play
   * media without a gesture, as Chrome does while a page captures, until the next
   * `pageStarted`. A request already answered or withdrawn rejects
   * `SITE_PERMISSION_CLOSED`.
   */
  answerSitePermission(
    options: SurfaceIdOptions & { requestId: string; grant: boolean },
  ): Promise<SitePermissionAnswer>;
  /**
   * Android 10+: save the `downloadRequested` file to Downloads once the person said yes,
   * with the surface's cookie only for the requesting page's exact origin. Resolves once
   * started; `downloadFinished` follows. A `blob:` file rejects `DOWNLOAD_UNSUPPORTED`.
   */
  saveDownload(
    options: SurfaceIdOptions & { requestId: string },
  ): Promise<void>;
  /**
   * Android: open the `identityProviderRequested` sign-in page in the person's browser
   * (a Custom Tab): the default browser, or another when the default is this app or
   * Android would ask. It is sent to that browser by package, so it never comes back into
   * this app; with no other browser it rejects `IDENTITY_BROWSER_UNAVAILABLE`. The
   * address never comes back from the host.
   */
  openIdentityProvider(
    options: SurfaceIdOptions & { requestId: string },
  ): Promise<{ status: "dispatched" }>;
  /**
   * Android: open the other-app link the person just tapped (`externalLinkRequested`)
   * with a fresh Intent, once: a later tap replaces it (`EXTERNAL_LINK_NOT_PENDING` for the
   * earlier address). Rejects `EXTERNAL_APP_UNAVAILABLE` when no other app handles it.
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
   * `all: true` purges every keyed and ephemeral profile of any owner and closes their
   * surfaces; use it to sign the device out of every website. `profileKey` and `all`
   * resolve after the cookies are removed, with `clean` true when no purged profile still
   * holds a cookie; `idleMs` resolves at once, without `clean`. Data is cleared at once;
   * the profile directory goes once Android releases it.
   */
  purgeProfiles(
    options: SurfaceOwnerOptions &
      (
        | { profileKey: string; idleMs?: never; all?: never }
        | { idleMs: number; profileKey?: never; all?: never }
        | { all: true; profileKey?: never; idleMs?: never }
      ),
  ): Promise<{ purged: number; clean?: boolean }>;
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
          /** The host's commit words (a regular expression source, flags `iu`). */
          commitPattern?: string;
          /** The one commit the person said yes to, spent by the task bindings. */
          commitGrant?: {
            grantId: string;
            selector?: string;
            requestTarget?:
              | { url: string; method: string }
              | { path: string; method: string };
            formHash?: string;
            expiresAt: number;
          };
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
  /** Signals a native page change; see `NavigationChangedEvent` for the state it carries. */
  addListener(
    eventName: "navigationChanged",
    listener: (event: NavigationChangedEvent) => void,
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
  /** Atomically hide all siblings, then present the requested surface or host. */
  presentSurface(options: PresentSurfaceOptions): Promise<void>;
  /**
   * Android: call `WebView.onPause()` on one surface. Chromium then treats the page as
   * hidden: it stops drawing, `requestAnimationFrame` and CSS animations, and runs
   * timers about once a second. JavaScript still runs, and history and page state stay.
   * A surface that `presentSurface` hid is already treated as hidden, so this matters
   * for a page that stays shown but is covered, for example a `below-host` page under
   * an opaque host screen. It frees no memory. The surface keeps its visibility, and
   * `presentSurface` does not resume it; call `resumeSurface` before the person sees it
   * again. While it is paused, `captureSurface`, `controlPage`, `observeHistory` and
   * `navigateHistory` reject; `goBack`, `goForward`, `navigate` and `reloadSurface` still
   * run, and `readPage` still reads. Pausing also cancels held page dialogs and ends
   * fullscreen, refuses new dialogs, file inputs and site permission requests, takes focus
   * and the keyboard from the page, and stops sending it touches. Held file inputs and
   * site permission requests stay open, since the system picker or the host's Android
   * permission prompt may be what covers the page.
   * Repeating the call does nothing. iOS rejects with `UNSUPPORTED`, so a cross-platform
   * caller must catch it; web rejects as unavailable. The process-wide
   * `WebView.pauseTimers()` is never called, as it would also stop the host WebView.
   */
  pauseSurface(options: SurfaceIdOptions): Promise<void>;
  /** Android: call `WebView.onResume()` on a paused surface. iOS rejects with `UNSUPPORTED`. */
  resumeSurface(options: SurfaceIdOptions): Promise<void>;
  /** Tear a surface down and release its native renderer and storage resources. */
  destroySurface(options: SurfaceIdOptions): Promise<void>;
  /** Introspect a surface's live state — for debugging and instrumented tests. */
  getSurfaceState(options: SurfaceIdOptions): Promise<SurfaceState>;
  /** List surfaces owned by this exact JS-realm session. */
  listSurfaceStates(options: SurfaceOwnerOptions): Promise<SurfaceStateList>;
  /** Destroy prior-realm/orphan surfaces before this session starts issuing work. */
  reconcileOwner(options: ReconcileOwnerOptions): Promise<void>;
}
