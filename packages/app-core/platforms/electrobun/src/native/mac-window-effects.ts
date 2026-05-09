import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
};

type LoadedMacEffectsLib = { symbols: MacEffectsSymbols; close(): void };
type MacEffectsLib = LoadedMacEffectsLib | null;

let _lib: MacEffectsLib | undefined;

function loadLib(): MacEffectsLib {
	const dylibPath = join(import.meta.dir, "../libMacWindowEffects.dylib");
	if (!existsSync(dylibPath)) {
		console.warn(
			`[MacEffects] Dylib not found at ${dylibPath}. Run 'bun run build:native-effects'.`,
		);
		return null;
	}
	try {
		// Cast to MacEffectsLib: bun:ffi does not infer symbol signatures from
		// FFIType descriptors at the TypeScript level.
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
		}) as MacEffectsLib;
	} catch (err) {
		console.warn("[MacEffects] Failed to load dylib:", err);
		return null;
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
