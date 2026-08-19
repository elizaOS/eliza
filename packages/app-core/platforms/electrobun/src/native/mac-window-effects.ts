/**
 * Loads the native macOS bridge used by the Electrobun host for window effects,
 * security-scoped files, onboarding notifications, and permission APIs. Calls
 * execute in the signed app process so macOS binds protected resources to the
 * same bundle identity shown to the user.
 */
import { CString, dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { join } from "node:path";
import { assertDlopenPathAllowed } from "@elizaos/core";
import { resolveNativeLibraryCandidate } from "../../../../src/platform/native-library-policy";

/**
 * Typed interface for the symbols loaded from libMacWindowEffects.dylib.
 * Bun's dlopen does not infer symbol call signatures from FFIType descriptors,
 * so we declare the expected signature explicitly.
 */
type MacEffectsSymbols = {
  enableWindowVibrancy(ptr: Pointer): boolean;
  setWindowInteractiveMaterialSize(
    ptr: Pointer,
    width: number,
    height: number,
  ): boolean;
  setWindowShadowEnabled(ptr: Pointer, enabled: boolean): boolean;
  setWindowTrafficLightsPosition(ptr: Pointer, x: number, y: number): boolean;
  setNativeWindowDragRegion(ptr: Pointer, x: number, height: number): boolean;
  disableWindowBackForwardNavigationGestures(ptr: Pointer): boolean;
  orderOutWindow(ptr: Pointer): boolean;
  makeKeyAndOrderFrontWindow(ptr: Pointer): boolean;
  isAppActive(): boolean;
  isWindowKey(ptr: Pointer): boolean;
  createSecurityScopedBookmark(path: Pointer): Pointer | null;
  startAccessingSecurityScopedBookmark(bookmark: Pointer): Pointer | null;
  stopAccessingSecurityScopedBookmarks(): void;
  freeNativeCString(value: Pointer): void;
  elizaOnboardingNotificationPost(title: Pointer, body: Pointer): boolean;
  elizaOnboardingGetChoice(): number;
  elizaOnboardingNotificationDismiss(): void;
  checkNotificationPermission(): number;
  requestNotificationPermission(): number;
  elizaFnMonitorStart(): number;
  elizaFnMonitorStop(): void;
  elizaFnMonitorPoll(): number;
  elizaFnMonitorIsHealthy(): boolean;
  elizaFnMonitorIsFnDown(): boolean;
  elizaFnSystemUsageType(): number;
};

type LoadedMacEffectsLib = { symbols: MacEffectsSymbols; close(): void };
type MacEffectsLib = LoadedMacEffectsLib | null;

const MAC_EFFECTS_DYLIB = "libMacWindowEffects.dylib";

let _lib: MacEffectsLib | undefined;

function loadLib(): MacEffectsLib {
  const defaultDylibPath = join(import.meta.dir, "../", MAC_EFFECTS_DYLIB);
  const dylibPath = resolveNativeLibraryCandidate(
    { label: "bundled Mac window effects library", path: defaultDylibPath },
    {
      expectedBasename: MAC_EFFECTS_DYLIB,
      moduleDir: import.meta.dir,
      warn: (message) => console.warn(`[MacEffects] ${message}`),
    },
  );
  if (!dylibPath) {
    console.warn(
      `[MacEffects] Dylib not found at ${defaultDylibPath}. Run 'bun run build:native-effects'.`,
    );
    return null;
  }
  // Store-build invariant: every bun:ffi dlopen path must resolve inside the
  // app bundle. Direct builds and non-darwin platforms short-circuit. Throws
  // on a path that escapes the .app/Contents/ root before reaching the OS
  // loader so failures are diagnosable at the JS layer instead of via opaque
  // dyld errors.
  assertDlopenPathAllowed(dylibPath);

  try {
    // Cast to MacEffectsLib: bun:ffi does not infer symbol signatures from
    // FFIType descriptors at the TypeScript level.
    return dlopen(dylibPath, {
      enableWindowVibrancy: { args: [FFIType.ptr], returns: FFIType.bool },
      setWindowInteractiveMaterialSize: {
        args: [FFIType.ptr, FFIType.f64, FFIType.f64],
        returns: FFIType.bool,
      },
      setWindowShadowEnabled: {
        args: [FFIType.ptr, FFIType.bool],
        returns: FFIType.bool,
      },
      setWindowTrafficLightsPosition: {
        args: [FFIType.ptr, FFIType.f64, FFIType.f64],
        returns: FFIType.bool,
      },
      setNativeWindowDragRegion: {
        args: [FFIType.ptr, FFIType.f64, FFIType.f64],
        returns: FFIType.bool,
      },
      disableWindowBackForwardNavigationGestures: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      orderOutWindow: { args: [FFIType.ptr], returns: FFIType.bool },
      makeKeyAndOrderFrontWindow: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      isAppActive: { args: [], returns: FFIType.bool },
      isWindowKey: { args: [FFIType.ptr], returns: FFIType.bool },
      createSecurityScopedBookmark: {
        args: [FFIType.ptr],
        returns: FFIType.ptr,
      },
      startAccessingSecurityScopedBookmark: {
        args: [FFIType.ptr],
        returns: FFIType.ptr,
      },
      stopAccessingSecurityScopedBookmarks: {
        args: [],
        returns: FFIType.void,
      },
      freeNativeCString: { args: [FFIType.ptr], returns: FFIType.void },
      elizaOnboardingNotificationPost: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      elizaOnboardingGetChoice: { args: [], returns: FFIType.i32 },
      elizaOnboardingNotificationDismiss: {
        args: [],
        returns: FFIType.void,
      },
      checkNotificationPermission: { args: [], returns: FFIType.i32 },
      requestNotificationPermission: { args: [], returns: FFIType.i32 },
      elizaFnMonitorStart: { args: [], returns: FFIType.i32 },
      elizaFnMonitorStop: { args: [], returns: FFIType.void },
      elizaFnMonitorPoll: { args: [], returns: FFIType.i32 },
      elizaFnMonitorIsHealthy: { args: [], returns: FFIType.bool },
      elizaFnMonitorIsFnDown: { args: [], returns: FFIType.bool },
      elizaFnSystemUsageType: { args: [], returns: FFIType.i32 },
    }) as MacEffectsLib;
  } catch (err) {
    console.warn("[MacEffects] Failed to load dylib:", err);
    return null;
  }
}

function cStringBuffer(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const buffer = Buffer.alloc(bytes.byteLength + 1);
  bytes.copy(buffer);
  return buffer;
}

function takeNativeString(
  lib: LoadedMacEffectsLib,
  value: Pointer | null,
): string | null {
  if (!value) return null;
  try {
    return new CString(value).toString();
  } finally {
    lib.symbols.freeNativeCString(value);
  }
}

function getLib(): LoadedMacEffectsLib | null {
  if (process.platform !== "darwin") return null;
  if (_lib === undefined) {
    _lib = loadLib();
  }
  return _lib;
}

export function enableVibrancy(ptr: Pointer): boolean {
  return getLib()?.symbols.enableWindowVibrancy(ptr) ?? false;
}

export function setWindowInteractiveMaterialSize(
  ptr: Pointer,
  width: number,
  height: number,
): boolean {
  return (
    getLib()?.symbols.setWindowInteractiveMaterialSize(ptr, width, height) ??
    false
  );
}

export function setWindowShadow(ptr: Pointer, enabled: boolean): boolean {
  return getLib()?.symbols.setWindowShadowEnabled(ptr, enabled) ?? false;
}

export function setTrafficLightsPosition(
  ptr: Pointer,
  x: number,
  y: number,
): boolean {
  return getLib()?.symbols.setWindowTrafficLightsPosition(ptr, x, y) ?? false;
}

/**
 * @param height Pass `0` for thickness derived from the window's NSScreen (backing
 *   scale + very wide displays). Pass a positive value (points) to pin depth. The same
 *   value sizes the top drag strip and the right/bottom/corner resize overlay views
 *   (native, above WKWebView).
 */
export function setNativeDragRegion(
  ptr: Pointer,
  x: number,
  height: number,
): boolean {
  return getLib()?.symbols.setNativeWindowDragRegion(ptr, x, height) ?? false;
}

/**
 * Force the macOS two-finger trackpad swipe back/forward history gesture OFF on
 * the window's WKWebView(s). WKWebView defaults
 * `allowsBackForwardNavigationGestures` to NO, but the shell owns horizontal
 * swipe UI (chat-sheet dismiss, pager row-swipes) that the native gesture would
 * hijack, so the flag is pinned NO explicitly rather than trusted to a default.
 * Idempotent; WKWebView is often inserted after first layout, so call it from
 * every restack pass. Returns true once at least one WKWebView received the flag.
 */
export function disableBackForwardNavigationGestures(ptr: Pointer): boolean {
  return (
    getLib()?.symbols.disableWindowBackForwardNavigationGestures(ptr) ?? false
  );
}

/** Hide the window — removes it from screen AND from Cmd+Tab / Mission Control */
export function orderOut(ptr: Pointer): boolean {
  return getLib()?.symbols.orderOutWindow(ptr) ?? false;
}

/** Show the window and bring it to focus */
export function makeKeyAndOrderFront(ptr: Pointer): boolean {
  return getLib()?.symbols.makeKeyAndOrderFrontWindow(ptr) ?? false;
}

/** Returns true if the current app is the active foreground macOS application */
export function isAppActive(): boolean {
  return getLib()?.symbols.isAppActive() ?? false;
}

/** Returns true if the window is currently the key (focused) window */
export function isKeyWindow(ptr: Pointer): boolean {
  return getLib()?.symbols.isWindowKey(ptr) ?? false;
}

export function createSecurityScopedBookmark(path: string): string | null {
  const lib = getLib();
  if (!lib || !path.trim()) return null;
  const pathBuffer = cStringBuffer(path);
  const result = lib.symbols.createSecurityScopedBookmark(ptr(pathBuffer));
  return takeNativeString(lib, result);
}

export function startAccessingSecurityScopedBookmark(
  bookmark: string,
): string | null {
  const lib = getLib();
  if (!lib || !bookmark.trim()) return null;
  const bookmarkBuffer = cStringBuffer(bookmark);
  const result = lib.symbols.startAccessingSecurityScopedBookmark(
    ptr(bookmarkBuffer),
  );
  return takeNativeString(lib, result);
}

export function stopAccessingSecurityScopedBookmarks(): void {
  getLib()?.symbols.stopAccessingSecurityScopedBookmarks();
}

/**
 * Onboarding notification choice codes returned by getOnboardingChoice().
 * 0 = pending, 1 = local-on-device, 2 = local-cloud-ai, 3 = eliza-cloud, 4 = dismissed.
 */
export type OnboardingChoice = 0 | 1 | 2 | 3 | 4;

/** Post a native macOS notification with onboarding action buttons. */
export function postOnboardingNotification(
  title: string,
  body: string,
): boolean {
  const lib = getLib();
  if (!lib) return false;
  const titleBuf = cStringBuffer(title);
  const bodyBuf = cStringBuffer(body);
  return lib.symbols.elizaOnboardingNotificationPost(
    ptr(titleBuf),
    ptr(bodyBuf),
  );
}

/** Poll the onboarding notification choice. */
export function getOnboardingChoice(): OnboardingChoice {
  return (getLib()?.symbols.elizaOnboardingGetChoice() ??
    0) as OnboardingChoice;
}

/** Dismiss the onboarding notification if still showing. */
export function dismissOnboardingNotification(): void {
  getLib()?.symbols.elizaOnboardingNotificationDismiss();
}

/** Read the authorization bound to the signed Electrobun app process. */
export function checkNotificationPermission(): number | null {
  const lib = getLib();
  return lib ? lib.symbols.checkNotificationPermission() : null;
}

/** Begin authorization on the signed Electrobun app process. */
export function requestNotificationPermission(): number | null {
  const lib = getLib();
  return lib ? lib.symbols.requestNotificationPermission() : null;
}

// ── Fn-key hold monitor (push-to-talk quasimode, #20483) ──────────────────

/** Outcome of starting the fn monitor. `permission-missing` means macOS
 *  refused the listen-only event tap — Accessibility (or Input Monitoring)
 *  trust has not been granted to this app bundle. */
export type FnMonitorStartResult =
  | "started"
  | "permission-missing"
  | "failed"
  | "unavailable";

/** One drained modifier-key transition. `up-chord` is a release where another
 *  key was pressed mid-fn-hold (fn+arrow etc.); `both-options` is a one-shot
 *  event when both physical Option keys become held. */
export type FnMonitorEvent = "down" | "up" | "up-chord" | "both-options";

export function startFnMonitor(): FnMonitorStartResult {
  const lib = getLib();
  if (!lib) return "unavailable";
  switch (lib.symbols.elizaFnMonitorStart()) {
    case 0:
      return "started";
    case 1:
      return "permission-missing";
    default:
      return "failed";
  }
}

export function stopFnMonitor(): void {
  getLib()?.symbols.elizaFnMonitorStop();
}

/** Drain one queued fn transition; null when the queue is empty. */
export function pollFnMonitor(): FnMonitorEvent | null {
  const lib = getLib();
  if (!lib) return null;
  switch (lib.symbols.elizaFnMonitorPoll()) {
    case 1:
      return "down";
    case 2:
      return "up";
    case 3:
      return "up-chord";
    case 4:
      return "both-options";
    default:
      return null;
  }
}

/** False while started means the tap was disabled out from under us (secure
 *  input, tap timeout) and the monitor needs a stop/start cycle. */
export function isFnMonitorHealthy(): boolean {
  return getLib()?.symbols.elizaFnMonitorIsHealthy() ?? false;
}

/** Physical fn key state right now — resync anchor after queue overflow. */
export function isFnKeyDown(): boolean {
  return getLib()?.symbols.elizaFnMonitorIsFnDown() ?? false;
}

/** The system "Press 🌐 key to..." action (com.apple.HIToolbox
 *  AppleFnUsageType): 0 none, 1 input source, 2 emoji, 3 dictation. macOS
 *  defaults to 2 when the key was never configured; a bare fn tap fires it
 *  and a listen-only tap cannot swallow it, so callers surface a "set it to
 *  Do Nothing" hint when this is not 0. */
export function getFnSystemUsageType(): number {
  const lib = getLib();
  if (!lib) return -1;
  const value = lib.symbols.elizaFnSystemUsageType();
  return value === -1 ? 2 : value;
}
