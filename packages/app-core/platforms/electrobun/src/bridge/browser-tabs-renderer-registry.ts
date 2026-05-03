/**
 * Renderer-side registry that bridges bun-issued evaluate/get-tab-rect RPCs
 * to the <electrobun-webview> tag refs owned by the BrowserWorkspaceView
 * component.
 *
 * The Electroview RPC handlers (registered in electrobun-direct-rpc.ts) are
 * configured at preload time, before React mounts. They call into the
 * registry via the window-global below; BrowserWorkspaceView attaches a real
 * implementation when it mounts and detaches on unmount.
 *
 * The bun-side BrowserWorkspaceManager owns the OS screencapture; the
 * renderer just reports the tag's bounding rect in CSS pixels relative to
 * the renderer viewport.
 */

export type BrowserTabsRendererImpl = {
	evaluate: (
		id: string,
		script: string,
		timeoutMs: number,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	getTabRect: (id: string) => Promise<{
		x: number;
		y: number;
		width: number;
		height: number;
	} | null>;
};

const REGISTRY_KEY = "__ELIZA_BROWSER_TABS_REGISTRY__" as const;

declare global {
	interface Window {
		[REGISTRY_KEY]?: BrowserTabsRendererImpl;
	}
}

const NOT_ATTACHED: BrowserTabsRendererImpl = {
	evaluate: async (id) => ({
		ok: false,
		error: `BrowserWorkspaceView is not mounted — cannot evaluate tab ${id}`,
	}),
	getTabRect: async () => null,
};

export function getBrowserTabsRendererImpl(): BrowserTabsRendererImpl {
	if (typeof window === "undefined") return NOT_ATTACHED;
	return window[REGISTRY_KEY] ?? NOT_ATTACHED;
}

export function setBrowserTabsRendererImpl(
	impl: BrowserTabsRendererImpl | null,
): void {
	if (typeof window === "undefined") return;
	if (impl) {
		window[REGISTRY_KEY] = impl;
	} else {
		delete window[REGISTRY_KEY];
	}
}
