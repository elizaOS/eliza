type WindowFrame = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type DevtoolsRefreshWindow = {
	getFrame?: () => WindowFrame;
	setFrame?: (x: number, y: number, width: number, height: number) => void;
};

export type ScheduleFn = (callback: () => void, delayMs: number) => unknown;

const DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS = [0, 32, 96, 220, 900] as const;

/**
 * WKWebView devtools can leave the main content inset/blank after dock/undock.
 * Re-applying the current frame alone is sometimes a no-op, so briefly nudge
 * the height by 1 px and then restore the original frame.
 */
export function scheduleDevtoolsLayoutRefresh(
	window: DevtoolsRefreshWindow | null | undefined,
	schedule: ScheduleFn = (callback, delayMs) => setTimeout(callback, delayMs),
): void {
	if (
		!window ||
		typeof window.getFrame !== "function" ||
		typeof window.setFrame !== "function"
	) {
		return;
	}

	let originalFrame: WindowFrame;
	try {
		const frame = window.getFrame();
		if (!frame) return;
		originalFrame = frame;
	} catch {
		return;
	}

	for (const delayMs of DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS) {
		schedule(() => {
			try {
				const shouldNudge = delayMs === 32;
				const nextHeight = shouldNudge
					? Math.max(1, originalFrame.height - 1)
					: originalFrame.height;
				window.setFrame?.(
					originalFrame.x,
					originalFrame.y,
					originalFrame.width,
					nextHeight,
				);
			} catch {
				// Devtools/layout refresh is best-effort only.
			}
		}, delayMs);
	}
}

export { DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS };
