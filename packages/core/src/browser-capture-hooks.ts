export interface BrowserCaptureConfig {
	url: string;
	width?: number;
	height?: number;
	fps?: number;
	quality?: number;
	overlayLayout?: string;
	theme?: string;
	avatarIndex?: number;
	destinationId?: string;
}

export interface BrowserCaptureHooks {
	frameFile: string;
	startBrowserCapture(config: BrowserCaptureConfig): Promise<void>;
	stopBrowserCapture(): Promise<void>;
}

const BROWSER_CAPTURE_HOOKS = Symbol.for("elizaos.browser-capture.hooks");

type BrowserCaptureHooksGlobal = typeof globalThis & {
	[BROWSER_CAPTURE_HOOKS]?: BrowserCaptureHooks;
};

function hooksGlobal(): BrowserCaptureHooksGlobal {
	return globalThis as BrowserCaptureHooksGlobal;
}

export function registerBrowserCaptureHooks(hooks: BrowserCaptureHooks): void {
	hooksGlobal()[BROWSER_CAPTURE_HOOKS] = hooks;
}

export function getBrowserCaptureHooks(): BrowserCaptureHooks | null {
	return hooksGlobal()[BROWSER_CAPTURE_HOOKS] ?? null;
}
