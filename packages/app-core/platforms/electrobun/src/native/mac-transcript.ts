/**
 * Bun FFI wrapper for the native macOS transcript renderer
 * (native/macos/transcript-view.mm → src/libMacTranscriptView.dylib). Hands
 * the serialized eliza.native-transcript/v1 frame JSON to a real AppKit list
 * mounted over the chat-overlay window's WKWebView, and drains widget-action
 * strings back — the exact strings the DOM widgets pass to sendActionMessage,
 * so the app-side handler cannot tell which renderer produced them.
 *
 * Spike surface (default OFF): every entry point is gated on
 * `ELIZA_DESKTOP_NATIVE_TRANSCRIPT=1` via `shouldEnableNativeTranscript`, the
 * pure decision twin of `shouldEnableNativeGlass`. Actions are poll-drained
 * (`takePendingTranscriptAction`) rather than pushed through a C callback,
 * matching the dylib layer's established native→JS convention
 * (elizaOnboardingGetChoice in mac-window-effects.ts).
 */
import { CString, dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { join } from "node:path";
import { assertDlopenPathAllowed } from "@elizaos/core";
import { resolveNativeLibraryCandidate } from "../../../../src/platform/native-library-policy";

/**
 * Whether the desktop shell should render the chat transcript with the native
 * AppKit renderer instead of the DOM one. Opt-in via
 * `ELIZA_DESKTOP_NATIVE_TRANSCRIPT=1` and macOS-only (the renderer dylib
 * exists only on darwin). Default OFF: this is a spike surface — the DOM
 * transcript remains the product renderer until widget parity lands.
 */
export function shouldEnableNativeTranscript(
  env: Record<string, string | undefined> = process.env,
  platform: typeof process.platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  const normalized = env.ELIZA_DESKTOP_NATIVE_TRANSCRIPT?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/** Viewport-anchored mount rect, CSS-pixel style: origin at the content
 *  view's top-left (the dylib converts to AppKit coordinates). */
export interface NativeTranscriptViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Typed interface for the symbols loaded from libMacTranscriptView.dylib.
 * Bun's dlopen does not infer symbol call signatures from FFIType
 * descriptors, so the expected signatures are declared explicitly (same
 * pattern as MacEffectsSymbols).
 */
type MacTranscriptSymbols = {
  transcriptShow(
    window: Pointer,
    frameJson: Pointer,
    x: number,
    y: number,
    w: number,
    h: number,
  ): boolean;
  transcriptSetTranscript(window: Pointer, frameJson: Pointer): boolean;
  transcriptHide(window: Pointer): boolean;
  transcriptTakePendingAction(): Pointer | null;
  transcriptFreeCString(value: Pointer): void;
};

type LoadedMacTranscriptLib = { symbols: MacTranscriptSymbols; close(): void };
type MacTranscriptLib = LoadedMacTranscriptLib | null;

const MAC_TRANSCRIPT_DYLIB = "libMacTranscriptView.dylib";

let _lib: MacTranscriptLib | undefined;

function loadLib(): MacTranscriptLib {
  const defaultDylibPath = join(import.meta.dir, "../", MAC_TRANSCRIPT_DYLIB);
  const dylibPath = resolveNativeLibraryCandidate(
    { label: "bundled Mac transcript renderer", path: defaultDylibPath },
    {
      expectedBasename: MAC_TRANSCRIPT_DYLIB,
      moduleDir: import.meta.dir,
      warn: (message) => console.warn(`[MacTranscript] ${message}`),
    },
  );
  if (!dylibPath) {
    console.warn(
      `[MacTranscript] Dylib not found at ${defaultDylibPath}. Run 'bun run build:native-transcript'.`,
    );
    return null;
  }
  // Store-build invariant: every bun:ffi dlopen path must resolve inside the
  // app bundle (same policy as mac-window-effects.ts).
  assertDlopenPathAllowed(dylibPath);

  try {
    // Cast: bun:ffi does not infer symbol signatures from FFIType descriptors
    // at the TypeScript level.
    return dlopen(dylibPath, {
      transcriptShow: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.f64,
          FFIType.f64,
          FFIType.f64,
          FFIType.f64,
        ],
        returns: FFIType.bool,
      },
      transcriptSetTranscript: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      transcriptHide: { args: [FFIType.ptr], returns: FFIType.bool },
      transcriptTakePendingAction: { args: [], returns: FFIType.ptr },
      transcriptFreeCString: { args: [FFIType.ptr], returns: FFIType.void },
    }) as MacTranscriptLib;
  } catch (err) {
    // error-policy:J4 capability probe — a host without the renderer dylib
    // (or the non-darwin placeholder file) is honestly "no native
    // transcript"; callers stay on the DOM renderer.
    console.warn("[MacTranscript] Failed to load dylib:", err);
    return null;
  }
}

function getLib(): LoadedMacTranscriptLib | null {
  if (!shouldEnableNativeTranscript()) return null;
  if (_lib === undefined) {
    _lib = loadLib();
  }
  return _lib;
}

function cStringBuffer(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const buffer = Buffer.alloc(bytes.byteLength + 1);
  bytes.copy(buffer);
  return buffer;
}

/**
 * Mount (or re-frame) the native transcript over the window at `rect` and
 * render `frameJson`. Idempotent full-frame replace — the dylib rebuilds the
 * row stack (message-id diffing is post-spike work).
 */
export function showNativeTranscript(
  window: Pointer,
  frameJson: string,
  rect: NativeTranscriptViewRect,
): boolean {
  const lib = getLib();
  if (!lib) return false;
  const jsonBuffer = cStringBuffer(frameJson);
  return lib.symbols.transcriptShow(
    window,
    ptr(jsonBuffer),
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );
}

/** Replace the transcript content while mounted; false when not mounted. */
export function setNativeTranscript(
  window: Pointer,
  frameJson: string,
): boolean {
  const lib = getLib();
  if (!lib) return false;
  const jsonBuffer = cStringBuffer(frameJson);
  return lib.symbols.transcriptSetTranscript(window, ptr(jsonBuffer));
}

/** Unmount the native transcript list (the DOM renderer shows through again). */
export function hideNativeTranscript(window: Pointer): boolean {
  return getLib()?.symbols.transcriptHide(window) ?? false;
}

/**
 * Drain one pending widget-action string (FIFO), or null when idle. The
 * returned string is byte-for-byte what the DOM widget would have passed to
 * sendActionMessage (choice values, `[form:submit …]`, `__permission_card__:…`)
 * — feed it into the SAME channel, never a second one.
 */
export function takePendingTranscriptAction(): string | null {
  const lib = getLib();
  if (!lib) return null;
  const value = lib.symbols.transcriptTakePendingAction();
  if (!value) return null;
  try {
    return new CString(value).toString();
  } finally {
    lib.symbols.transcriptFreeCString(value);
  }
}
