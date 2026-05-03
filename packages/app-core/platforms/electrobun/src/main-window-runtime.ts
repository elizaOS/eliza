import type { BrowserWindow } from "electrobun/bun";
import type { WebviewEvalRpc } from "./types.js";

type TitleBarStyle = "hidden" | "hiddenInset" | "default";

export interface MainWindowRuntimeSnapshot {
	present: boolean;
	windowId: number | null;
	webviewId: number | null;
	url: string | null;
	titleBarStyle: TitleBarStyle | null;
	transparent: boolean | null;
	vibrancyEnabled: boolean | null;
	shadowEnabled: boolean | null;
	bounds: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null;
}

let currentWindow: BrowserWindow | null = null;
let currentWindowMeta: Omit<
	MainWindowRuntimeSnapshot,
	"present" | "windowId" | "webviewId" | "url" | "bounds"
> = {
	titleBarStyle: null,
	transparent: null,
	vibrancyEnabled: null,
	shadowEnabled: null,
};

export function setCurrentMainWindow(
	window: BrowserWindow,
	meta: {
		titleBarStyle: TitleBarStyle;
		transparent: boolean;
	},
): void {
	currentWindow = window;
	currentWindowMeta = {
		...currentWindowMeta,
		titleBarStyle: meta.titleBarStyle,
		transparent: meta.transparent,
	};
}

export function clearCurrentMainWindow(window?: BrowserWindow | null): void {
	if (window && currentWindow && currentWindow.id !== window.id) {
		return;
	}
	currentWindow = null;
}

export function updateCurrentMainWindowEffectsState(state: {
	vibrancyEnabled?: boolean | null;
	shadowEnabled?: boolean | null;
}): void {
	currentWindowMeta = {
		...currentWindowMeta,
		...(typeof state.vibrancyEnabled !== "undefined"
			? { vibrancyEnabled: state.vibrancyEnabled }
			: {}),
		...(typeof state.shadowEnabled !== "undefined"
			? { shadowEnabled: state.shadowEnabled }
			: {}),
	};
}

export function getCurrentMainWindowSnapshot(): MainWindowRuntimeSnapshot {
	if (!currentWindow) {
		return {
			present: false,
			windowId: null,
			webviewId: null,
			url: null,
			bounds: null,
			...currentWindowMeta,
		};
	}

	const position = currentWindow.getPosition();
	const size = currentWindow.getSize();

	return {
		present: true,
		windowId: currentWindow.id ?? null,
		webviewId: currentWindow.webviewId ?? null,
		url:
			(currentWindow.webview as { url?: string | null } | undefined)?.url ??
			null,
		bounds: {
			x: position.x ?? 0,
			y: position.y ?? 0,
			width: size.width,
			height: size.height,
		},
		...currentWindowMeta,
	};
}

export async function evaluateInCurrentMainWindow(
	script: string,
): Promise<unknown> {
	if (!currentWindow) {
		throw new Error("main window is not available");
	}

	const rpc = currentWindow.webview.rpc as WebviewEvalRpc | undefined;
	const evaluator = rpc?.requestProxy?.evaluateJavascriptWithResponse;
	if (!evaluator) {
		throw new Error("main window webview does not support JS evaluation");
	}

	return await evaluator({ script });
}
