import { CString, dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { join } from "node:path";
<<<<<<< HEAD
import { resolveNativeLibraryCandidate } from "@elizaos/app-core/platform/native-library-policy";
=======
import { assertDlopenPathAllowed } from "@elizaos/core";
>>>>>>> 604eeb67f0 (feat(electrobun): assertDlopenPathAllowed before libMacWindowEffects load)

/**
 * Typed interface for the symbols loaded from libMacWindowEffects.dylib.
 * Bun's dlopen does not infer symbol call signatures from FFIType descriptors,
 * so we declare the expected signature explicitly.
 */
type MacEffectsSymbols = {
	enableWindowVibrancy(ptr: Pointer): boolean;
	ensureWindowShadow(ptr: Pointer): boolean;
	setWindowTrafficLightsPosition(ptr: Pointer, x: number, y: number): boolean;
	setNativeWindowDragRegion(ptr: Pointer, x: number, height: number): boolean;
	orderOutWindow(ptr: Pointer): boolean;
	makeKeyAndOrderFrontWindow(ptr: Pointer): boolean;
	isAppActive(): boolean;
	isWindowKey(ptr: Pointer): boolean;
	createSecurityScopedBookmark(path: Pointer): Pointer | null;
	startAccessingSecurityScopedBookmark(bookmark: Pointer): Pointer | null;
	stopAccessingSecurityScopedBookmarks(): void;
	freeNativeCString(value: Pointer): void;
};

type LoadedMacEffectsLib = { symbols: MacEffectsSymbols; close(): void };
type MacEffectsLib = LoadedMacEffectsLib | null;

const MAC_EFFECTS_DYLIB = "libMacWindowEffects.dylib";

let _lib: MacEffectsLib | undefined;

function loadLib(): MacEffectsLib {
<<<<<<< HEAD
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
=======
	// `import.meta.dir` resolves to a path inside the built app bundle's
	// `Contents/Resources` tree at runtime, so the joined dylib path is
	// always bundle-local. `assertDlopenPathAllowed` enforces this invariant
	// in store builds — required for the Mac App Store entitlement profile
	// (library-validation enabled).
	const dylibPath = join(import.meta.dir, "../libMacWindowEffects.dylib");
	if (!existsSync(dylibPath)) {
>>>>>>> 604eeb67f0 (feat(electrobun): assertDlopenPathAllowed before libMacWindowEffects load)
		console.warn(
			`[MacEffects] Dylib not found at ${defaultDylibPath}. Run 'bun run build:native-effects'.`,
		);
		return null;
	}
	try {
		// Cast to MacEffectsLib: bun:ffi does not infer symbol signatures from
		// FFIType descriptors at the TypeScript level.
		assertDlopenPathAllowed(dylibPath);
		return dlopen(dylibPath, {
			enableWindowVibrancy: { args: [FFIType.ptr], returns: FFIType.bool },
			ensureWindowShadow: { args: [FFIType.ptr], returns: FFIType.bool },
			setWindowTrafficLightsPosition: {
				args: [FFIType.ptr, FFIType.f64, FFIType.f64],
				returns: FFIType.bool,
			},
			setNativeWindowDragRegion: {
				args: [FFIType.ptr, FFIType.f64, FFIType.f64],
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

export function ensureShadow(ptr: Pointer): boolean {
	return getLib()?.symbols.ensureWindowShadow(ptr) ?? false;
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
