/**
 * Coordinator for the native-hosted wallpaper: decides WHEN the image
 * wallpaper leaves the DOM and lives below the WebView instead, and pipes the
 * pixels across the bridge as pre-downsampled bytes.
 *
 * Why temporal scoping exists: CSS `backdrop-filter` can only sample WebView
 * pixels — the moment the wallpaper is hosted natively, every CSS glass
 * surface in the app (menus, cards, the mid-drag chat sheet) blurs a
 * transparent hole instead of the wallpaper. So the wallpaper is native ONLY
 * while a native glass region actually needs it (the chat sheet anchored at
 * rest); the rest of the time the DOM paints it and the app composites
 * normally, keeping the WebView's opaque fast path. Consumers hold a lease:
 * `acquireNativeBackdrop()` pipes the pixels (invisible behind the still-
 * painted DOM), `activateNativeBackdrop()` flips the store so the DOM
 * wallpaper hides in the same React commit that makes the consumer's surface
 * transparent, and `releaseNativeBackdrop()` restores DOM paint immediately
 * and clears the native layer a couple of frames later (the native copy covers
 * the swap, so no frame ever shows the window background).
 *
 * The image crosses the bridge as bytes the page already loaded — downsampled
 * to screen scale on a canvas and flattened onto the wallpaper color — never
 * as a URL. That keeps every network, cookie, and scheme concern in the
 * renderer where the browser's own security model applies (the #16656 review
 * found the URL-based design forwarded the iOS cookie jar to arbitrary
 * wallpaper origins).
 */

import { useSyncExternalStore } from "react";
import { clearNativeBackdrop, setNativeBackdrop } from "./native-bridge";

export interface NativeWallpaperSource {
  /** Absolute, renderer-loadable URL (AppBackground resolves it). */
  imageUrl: string;
  /** Wallpaper underlay color — also the flatten color for alpha images. */
  color: string;
}

/**
 * Proof of a held backdrop lease. Activation revalidates `epoch` against the
 * live store so a wallpaper change that lands between `acquireNativeBackdrop`
 * and `activateNativeBackdrop` (a region attach in flight) can never promote
 * stale native pixels behind a hidden DOM. `released` makes release
 * exactly-once so a double teardown cannot free someone else's lease.
 */
export interface NativeBackdropLease {
  readonly epoch: number;
  released: boolean;
}

let source: NativeWallpaperSource | null = null;
let active = false;
let holders = 0;
/** Bumped on every source change / release so stale async work self-cancels. */
let epoch = 0;
let encoded: { key: string; promise: Promise<string | null> } | null = null;
/** Key of the wallpaper the native side currently holds — lets a rapid
 *  re-acquire (drag → settle) skip re-sending the same bytes. */
let installed: string | null = null;
let pendingClear: number | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Last decision the backdrop/anchor machinery took, as a short slug — the
 * observable half of the J4 degrades in this module. Silent CSS fallback is
 * correct product behavior, but "why is this device on CSS?" must be
 * answerable from the outside: ChatOverlay appends this to its
 * `chat-glass-tier:` AX probe, which is exactly what the on-device XCUITest
 * (and a human with the Accessibility Inspector) reads.
 */
let diag = "idle";

export function nativeGlassDiag(): string {
  return diag;
}

export function setNativeGlassDiag(next: string): void {
  if (diag === next) return;
  diag = next;
  notify();
}

/** Store subscription (also the seam `useNativeBackdropActive` rides on).
 *  Anchors use it to tear down when the backdrop force-deactivates. */
export function subscribeNativeBackdrop(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * True only while the native host owns the wallpaper pixels. AppBackground
 * stops painting the DOM image (keeping the legibility scrim) exactly while
 * this is true; native glass tiers require it.
 */
export function useNativeBackdropActive(): boolean {
  return useSyncExternalStore(
    subscribeNativeBackdrop,
    isNativeBackdropActive,
    () => false,
  );
}

/** Live view of {@link nativeGlassDiag} for probe rendering. */
export function useNativeGlassDiag(): string {
  return useSyncExternalStore(
    subscribeNativeBackdrop,
    nativeGlassDiag,
    () => "idle",
  );
}

export function isNativeBackdropActive(): boolean {
  return active;
}

/**
 * AppBackground publishes the current image-wallpaper source here (null for
 * shader/color modes). A change while a consumer holds the backdrop re-pipes
 * the new image in place; a change to null deactivates — consumers observe
 * the store flip and fall back to CSS.
 */
export function setNativeWallpaperSource(
  next: NativeWallpaperSource | null,
): void {
  const changed =
    (source === null) !== (next === null) ||
    source?.imageUrl !== next?.imageUrl ||
    source?.color !== next?.color;
  if (!changed) return;
  source = next;
  epoch += 1;
  encoded = null;
  if (!active) {
    // Pre-activation holders now carry a stale lease (activation will refuse
    // it); wake subscribers so an anchor waiting on its region attach can
    // observe the change instead of discovering it only at activate time.
    if (holders > 0) notify();
    return;
  }
  if (!next) {
    deactivate();
    return;
  }
  // Live re-pipe: the DOM stays hidden and the native side swaps layers
  // insert-then-remove, so the wallpaper never gaps during the exchange.
  const currentEpoch = epoch;
  void pipe(next, currentEpoch).then((applied) => {
    if (currentEpoch !== epoch || !active) return;
    if (!applied) deactivate();
  });
}

/** Encode + send one wallpaper to native; records what native now holds. */
async function pipe(
  target: NativeWallpaperSource,
  targetEpoch: number,
): Promise<boolean> {
  const key = `${target.imageUrl}|${target.color}`;
  const imageBase64 = await encodeSource(target);
  if (imageBase64 === null) {
    // encodeSource already recorded the specific encode-error diag.
    return false;
  }
  if (targetEpoch !== epoch) {
    setNativeGlassDiag("stale-encode");
    return false;
  }
  const applied = await setNativeBackdrop({
    imageBase64,
    color: target.color,
  });
  if (!applied) {
    setNativeGlassDiag("native-refused-backdrop");
    return false;
  }
  if (targetEpoch !== epoch) {
    setNativeGlassDiag("stale-backdrop");
    return false;
  }
  installed = key;
  return true;
}

/**
 * Pipe the current wallpaper below the WebView and take a lease on it. The
 * DOM keeps painting throughout — the native copy is invisible until
 * `activateNativeBackdrop()`. Resolves null (no lease) when there is no
 * image wallpaper, encoding fails, or the native host refuses.
 */
export async function acquireNativeBackdrop(): Promise<NativeBackdropLease | null> {
  const requested = source;
  const requestedEpoch = epoch;
  if (!requested) {
    setNativeGlassDiag("no-image-wallpaper");
    return null;
  }
  // Cancel a scheduled clear first: a drag → settle cycle inside the clear's
  // two-frame grace re-leases the layer native still holds.
  pendingClear = null;
  const key = `${requested.imageUrl}|${requested.color}`;
  if (installed !== key) {
    const applied = await pipe(requested, requestedEpoch);
    if (!applied) return null;
  }
  if (requestedEpoch !== epoch) {
    setNativeGlassDiag("stale-acquire");
    return null;
  }
  holders += 1;
  setNativeGlassDiag("backdrop-leased");
  return { epoch: requestedEpoch, released: false };
}

/**
 * Flip the store: the DOM wallpaper hides in the same React commit that the
 * calling surface uses to go transparent, so the handoff is atomic — there is
 * never a frame with neither paint. Call only after `acquireNativeBackdrop()`
 * resolved a lease (and after any dependent native work, e.g. region attach,
 * acknowledged). Returns false — and the caller must tear down — when the
 * wallpaper changed while that dependent work was in flight: the pixels
 * native holds no longer match the DOM, so hiding the DOM over them would
 * flash the previous wallpaper.
 */
export function activateNativeBackdrop(lease: NativeBackdropLease): boolean {
  if (lease.released || lease.epoch !== epoch || holders === 0) {
    setNativeGlassDiag("stale-lease");
    return false;
  }
  if (!active) {
    active = true;
    notify();
  }
  return true;
}

/**
 * Drop a lease (exactly once — later calls with the same lease are no-ops).
 * The store flips immediately (DOM wallpaper repaints this commit); the
 * native layer is cleared two frames later so the native copy covers the
 * swap-back, then the WebView regains its opaque backing.
 */
export function releaseNativeBackdrop(lease: NativeBackdropLease): void {
  if (lease.released) return;
  lease.released = true;
  if (holders === 0) return;
  holders -= 1;
  if (holders > 0) return;
  deactivate();
}

function deactivate(): void {
  epoch += 1;
  if (active) {
    active = false;
    notify();
  }
  const clearEpoch = epoch;
  pendingClear = clearEpoch;
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16);
  raf(() =>
    raf(() => {
      if (pendingClear !== clearEpoch) return;
      pendingClear = null;
      installed = null;
      void clearNativeBackdrop();
    }),
  );
}

/**
 * Downsample + flatten the wallpaper to screen scale and return base64 bytes.
 * Runs entirely in the renderer: the browser enforces CORS/taint rules, so a
 * cross-origin image the page may display but not read simply yields null and
 * the caller stays on the CSS tier. Cached per (url, color) — wallpapers
 * change rarely and re-anchoring must not re-decode.
 */
type WallpaperEncoder = (
  target: NativeWallpaperSource,
) => Promise<string | null>;

/**
 * Hard area cap on the encode canvas. The long-side screen bound alone still
 * admits a huge square image on a high-dpr display (7680² ≈ 59M px on a 2x 4K
 * monitor); the native decoders refuse anything above their own 18M px
 * budget, so the renderer stays safely below it.
 */
const MAX_ENCODE_PIXELS = 16_000_000;

/** Test seam: jsdom has no real image decode/canvas readback. */
let encoderOverride: WallpaperEncoder | null = null;
export function setNativeBackdropEncoderForTests(
  encoder: WallpaperEncoder | null,
): void {
  encoderOverride = encoder;
  encoded = null;
}

function encodeSource(target: NativeWallpaperSource): Promise<string | null> {
  const key = `${target.imageUrl}|${target.color}`;
  if (encoded?.key === key) return encoded.promise;
  if (encoderOverride) {
    const promise = encoderOverride(target);
    encoded = { key, promise };
    return promise;
  }
  const promise = (async () => {
    try {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.src = target.imageUrl;
      await image.decode();
      const scaleBound = Math.ceil(
        Math.max(window.screen.width, window.screen.height) *
          (window.devicePixelRatio || 1),
      );
      const largest = Math.max(image.naturalWidth, image.naturalHeight);
      if (largest === 0) {
        setNativeGlassDiag("encode-error:empty-image");
        return null;
      }
      const area = image.naturalWidth * image.naturalHeight;
      const areaScale =
        area > MAX_ENCODE_PIXELS ? Math.sqrt(MAX_ENCODE_PIXELS / area) : 1;
      const scale = Math.min(1, scaleBound / largest, areaScale);
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        setNativeGlassDiag("encode-error:no-2d-context");
        return null;
      }
      // JPEG has no alpha channel — flatten transparency onto the wallpaper
      // color so the native copy matches the DOM composite exactly.
      context.fillStyle = target.color;
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      const comma = dataUrl.indexOf(",");
      if (comma === -1) {
        setNativeGlassDiag("encode-error:no-data-url");
        return null;
      }
      return dataUrl.slice(comma + 1);
    } catch (error) {
      // error-policy:J4 explicit degrade — an undecodable or CORS-tainted
      // wallpaper keeps the DOM paint and the CSS tier; never a black region.
      // The diag probe carries the error name so a device lane can tell a
      // decode failure from a taint/security refusal without a debugger.
      setNativeGlassDiag(
        `encode-error:${error instanceof Error ? error.name : "unknown"}`,
      );
      return null;
    }
  })();
  encoded = { key, promise };
  return promise;
}

/** Test seam: reset every module-level state slot between cases. */
export function resetNativeBackdropForTests(): void {
  source = null;
  active = false;
  holders = 0;
  epoch += 1;
  encoded = null;
  installed = null;
  pendingClear = null;
  listeners.clear();
}
