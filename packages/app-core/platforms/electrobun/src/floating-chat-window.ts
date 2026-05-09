/**
 * Floating Chat Window Manager for Electrobun
 *
 * Manages an always-on-top secondary BrowserWindow that provides a lightweight
 * chat interface while the user works in a native editor (VS Code, Cursor, etc.).
 *
 * Key characteristics:
 * - A single floating chat window is allowed at a time (singleton).
 * - The window is always-on-top so it stays visible over the native editor.
 * - It reconnects to the previous chat context if closed and reopened.
 * - Positioning defaults to the bottom-right corner of the primary screen.
 * - The window can be freely dragged and resized by the user.
 * - Closing the window marks it as hidden; it can be restored via tray or hotkey.
 *
 * WHY: When the user opens a workspace in a native editor, the app minimises its
 * main window. Without the floating chat the user loses the ability to talk to
 * the agent. This window bridges that gap without requiring the user to switch
 * back to the main the app window.
 */

import { BrowserWindow } from "electrobun/bun";
import { getBrandConfig } from "./brand-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FloatingChatStatus {
	open: boolean;
	visible: boolean;
	contextId: string | null;
	bounds: { x: number; y: number; width: number; height: number } | null;
}

// ---------------------------------------------------------------------------
// Default geometry
// ---------------------------------------------------------------------------

const FLOAT_WIDTH = 380;
const FLOAT_HEIGHT = 600;
const FLOAT_MARGIN = 24;

function resolveDefaultPosition(): { x: number; y: number } {
	// Fall back to a reasonable bottom-right estimate if we cannot query the
	// screen. The user can always drag the window to a preferred location.
	try {
		// Approximate 1080p; actual display query needs electrobun/bun Screen API.
		const screenWidth = 1920;
		const screenHeight = 1080;
		return {
			x: screenWidth - FLOAT_WIDTH - FLOAT_MARGIN,
			y: screenHeight - FLOAT_HEIGHT - FLOAT_MARGIN - 40, // 40 = taskbar
		};
	} catch {
		return { x: 1500, y: 400 };
	}
}

// ---------------------------------------------------------------------------
// FloatingChatWindowManager
// ---------------------------------------------------------------------------

type FloatingBrowserWindow = InstanceType<typeof BrowserWindow>;

class FloatingChatWindowManager {
	private window: FloatingBrowserWindow | null = null;
	private contextId: string | null = null;
	private isVisible = false;
	private lastBounds: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null = null;
	private rendererUrl = "";
	private preloadPath = "";

	/**
	 * Provide the renderer URL and preload script path once at startup.
	 * Must be called from index.ts after the main window renderer URL is resolved.
	 */
	configure(rendererUrl: string, preload: string): void {
		this.rendererUrl = rendererUrl;
		this.preloadPath = preload;
	}

	/**
	 * Opens (or shows) the floating chat window.
	 * If a window already exists it is focused; otherwise a new one is created.
	 */
	open(options?: {
		contextId?: string;
		x?: number;
		y?: number;
	}): FloatingChatStatus {
		if (options?.contextId) {
			this.contextId = options.contextId;
		}

		if (this.window) {
			this.show();
			return this.getStatus();
		}

		if (!this.rendererUrl) {
			throw new Error(
				"FloatingChatWindowManager is not configured — call configure() first",
			);
		}

		const pos = this.lastBounds
			? { x: this.lastBounds.x, y: this.lastBounds.y }
			: resolveDefaultPosition();
		const x = options?.x ?? pos.x;
		const y = options?.y ?? pos.y;

		// Build the renderer URL with shell=floating-chat so the React app
		// can render the compact floating-chat UI variant.
		const contextParam = this.contextId
			? `&context=${encodeURIComponent(this.contextId)}`
			: "";
		const url = `${this.rendererUrl}?shell=floating-chat${contextParam}`;

		// Electrobun BrowserWindow constructor: uses `frame` object for bounds.
		const win = new BrowserWindow({
			title: `${getBrandConfig().appName} Chat`,
			url,
			preload: this.preloadPath || null,
			frame: { x, y, width: FLOAT_WIDTH, height: FLOAT_HEIGHT },
			titleBarStyle: "hiddenInset",
			transparent: false,
		});

		// Set always-on-top after creation (Electrobun API, not a constructor option).
		try {
			win.setAlwaysOnTop(true);
		} catch {
			// Gracefully degrade if setAlwaysOnTop is not available in the build.
		}

		this.window = win;
		this.isVisible = true;

		win.on("close", () => {
			// Persist bounds for next open so the window reopens in the same spot.
			try {
				const { x: wx, y: wy } = win.getPosition();
				const { width: ww, height: wh } = win.getSize();
				this.lastBounds = { x: wx, y: wy, width: ww, height: wh };
			} catch {
				/* ignore */
			}
			this.window = null;
			this.isVisible = false;
		});

		return this.getStatus();
	}

	/** Shows the floating chat window if it exists. */
	show(): void {
		if (!this.window) return;
		try {
			this.window.show();
			this.window.focus();
			this.isVisible = true;
		} catch {
			/* ignore */
		}
	}

	/** Hides the floating chat window without closing it. */
	hide(): void {
		if (!this.window) return;
		try {
			const window = this.window as typeof this.window & {
				hide?: () => void;
			};
			// Electrobun uses minimize() as a hide fallback when hide() is absent.
			if (typeof window.hide === "function") {
				window.hide();
			} else {
				this.window.minimize();
			}
			this.isVisible = false;
		} catch {
			/* ignore */
		}
	}

	/** Closes and destroys the floating chat window. */
	close(): void {
		if (!this.window) return;
		try {
			const { x, y } = this.window.getPosition();
			const { width, height } = this.window.getSize();
			this.lastBounds = { x, y, width, height };
			this.window.close();
		} catch {
			/* ignore */
		}
		this.window = null;
		this.isVisible = false;
	}

	/**
	 * Updates the active chat context.
	 * The new context will be picked up the next time the window is opened.
	 */
	setContextId(contextId: string | null): void {
		this.contextId = contextId;
	}

	getStatus(): FloatingChatStatus {
		return {
			open: this.window !== null,
			visible: this.isVisible,
			contextId: this.contextId,
			bounds: this.lastBounds,
		};
	}

	isOpen(): boolean {
		return this.window !== null;
	}
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _manager: FloatingChatWindowManager | null = null;

export function getFloatingChatManager(): FloatingChatWindowManager {
	if (!_manager) {
		_manager = new FloatingChatWindowManager();
	}
	return _manager;
}
