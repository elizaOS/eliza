import { getBrandConfig } from "./brand-config";

export type DetachedSurface =
	| "chat"
	| "browser"
	| "release"
	| "triggers"
	| "plugins"
	| "connectors"
	| "cloud";
export type ManagedSurface = DetachedSurface | "settings" | "app";

export interface ManagedWindowSnapshot {
	id: string;
	surface: ManagedSurface;
	title: string;
	singleton: boolean;
	alwaysOnTop: boolean;
}

export interface ManagedWindowFrame {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ManagedWindowLike {
	focus(): void;
	setAlwaysOnTop(flag: boolean): void;
	on(event: "close" | "focus" | "resize" | "move", handler: () => void): void;
	/**
	 * Optional — when present, used to capture window position+size for
	 * per-slug bounds persistence. Mocks may omit this.
	 */
	getFrame?: () => ManagedWindowFrame;
	webview: {
		on(event: "dom-ready", handler: () => void): void;
		loadURL?: (url: string) => void;
		toggleDevTools?: () => void;
		openDevTools?: () => void;
	};
}

/**
 * Persistence backend for per-slug window bounds. Wired by the bun entry
 * via SurfaceWindowManagerOptions; tests can pass an in-memory store.
 *
 * **Why injected**: keeps surface-windows.ts free of fs / Utils.paths
 * dependencies so it stays pure and unit-testable.
 */
export interface BoundsStore {
	load(slug: string): ManagedWindowFrame | null;
	save(slug: string, frame: ManagedWindowFrame): void;
}

export interface CreateManagedWindowOptions {
	title: string;
	url: string;
	preload: string;
	frame: ManagedWindowFrame;
	titleBarStyle: "default";
	transparent: boolean;
}

interface ManagedWindowRecord extends ManagedWindowSnapshot {
	window: ManagedWindowLike;
	slug?: string;
}

interface SurfaceWindowManagerOptions {
	createWindow: (options: CreateManagedWindowOptions) => ManagedWindowLike;
	resolveRendererUrl: () => Promise<string>;
	readPreload: () => string;
	wireRpc: (window: ManagedWindowLike) => void;
	injectApiBase: (window: ManagedWindowLike) => void;
	onWindowFocused?: (window: ManagedWindowLike) => void;
	onRegistryChanged?: () => void;
	/**
	 * Optional per-slug bounds persistence. When supplied, slug-keyed
	 * window launches restore the user's last position+size and save
	 * updates on resize/move (debounced 500ms inside this manager).
	 */
	boundsStore?: BoundsStore;
}

const SURFACE_LABELS: Record<ManagedSurface, string> = {
	chat: "Chat",
	browser: "Browser",
	release: "Release Center",
	triggers: "Heartbeats",
	plugins: "Plugins",
	connectors: "Connectors",
	cloud: "Cloud",
	settings: "Settings",
	app: "App",
};

const SURFACE_FRAMES: Record<ManagedSurface, ManagedWindowFrame> = {
	chat: { x: 120, y: 110, width: 1180, height: 840 },
	browser: { x: 140, y: 100, width: 1320, height: 900 },
	release: { x: 160, y: 100, width: 1260, height: 920 },
	triggers: { x: 160, y: 140, width: 1080, height: 780 },
	plugins: { x: 180, y: 160, width: 1180, height: 860 },
	connectors: { x: 200, y: 180, width: 1180, height: 860 },
	cloud: { x: 220, y: 140, width: 1280, height: 900 },
	settings: { x: 180, y: 120, width: 1240, height: 900 },
	app: { x: 180, y: 120, width: 1280, height: 900 },
};

export function isDetachedSurface(value: string): value is DetachedSurface {
	return (
		value === "chat" ||
		value === "browser" ||
		value === "release" ||
		value === "triggers" ||
		value === "plugins" ||
		value === "connectors" ||
		value === "cloud"
	);
}

function isManagedSurface(value: string): value is ManagedSurface {
	return value === "settings" || value === "app" || isDetachedSurface(value);
}

function ordinalTitle(surface: ManagedSurface, ordinal: number): string {
	// Cloud windows reference "Eliza Cloud" (the service), not the app brand.
	const base =
		surface === "cloud"
			? "Eliza Cloud"
			: `${getBrandConfig().appName} ${SURFACE_LABELS[surface]}`;
	return ordinal <= 1 ? base : `${base} ${ordinal}`;
}

function normalizeSettingsTabHint(tabHint?: string): string | undefined {
	if (!tabHint) return undefined;
	return tabHint.replace(/^open-settings-/, "") || undefined;
}

export function buildSurfaceShellQuery(
	surface: ManagedSurface,
	tabHint?: string,
	browse?: string,
): string {
	if (surface === "settings") {
		const normalizedTab = normalizeSettingsTabHint(tabHint);
		return normalizedTab
			? `?shell=settings&tab=${encodeURIComponent(normalizedTab)}`
			: "?shell=settings";
	}
	const base = `?shell=surface&tab=${encodeURIComponent(surface)}`;
	if (surface === "browser" && browse?.trim()) {
		return `${base}&browse=${encodeURIComponent(browse.trim())}`;
	}
	return base;
}

export function buildSurfaceWindowRendererUrl(
	rendererUrl: string,
	surface: ManagedSurface,
	tabHint?: string,
	browse?: string,
): string {
	const renderer = new URL(rendererUrl);
	renderer.search = buildSurfaceShellQuery(surface, tabHint, browse);
	renderer.hash = "";
	return renderer.toString();
}

export function buildAppWindowRendererUrl(
	rendererUrl: string,
	routePath: string,
): string {
	const renderer = new URL(rendererUrl);
	const route = new URL(routePath, "http://eliza.local");
	const appRoute = `${route.pathname}${route.search}${route.hash}`;
	renderer.searchParams.set("appWindow", "1");
	renderer.hash = appRoute;
	return renderer.toString();
}

export class SurfaceWindowManager {
	private readonly createWindowFn: SurfaceWindowManagerOptions["createWindow"];
	private readonly resolveRendererUrlFn: SurfaceWindowManagerOptions["resolveRendererUrl"];
	private readonly readPreloadFn: SurfaceWindowManagerOptions["readPreload"];
	private readonly wireRpcFn: SurfaceWindowManagerOptions["wireRpc"];
	private readonly injectApiBaseFn: SurfaceWindowManagerOptions["injectApiBase"];
	private readonly onWindowFocused?: SurfaceWindowManagerOptions["onWindowFocused"];
	private readonly onRegistryChanged?: SurfaceWindowManagerOptions["onRegistryChanged"];
	private readonly boundsStore?: BoundsStore;
	private readonly windows = new Map<string, ManagedWindowRecord>();
	private readonly pendingSurfaceWindows = new Map<
		string,
		Promise<ManagedWindowSnapshot>
	>();
	private counter = 0;

	constructor(options: SurfaceWindowManagerOptions) {
		this.createWindowFn = options.createWindow;
		this.resolveRendererUrlFn = options.resolveRendererUrl;
		this.readPreloadFn = options.readPreload;
		this.wireRpcFn = options.wireRpc;
		this.injectApiBaseFn = options.injectApiBase;
		this.onWindowFocused = options.onWindowFocused;
		this.onRegistryChanged = options.onRegistryChanged;
		this.boundsStore = options.boundsStore;
	}

	listWindows(surface?: ManagedSurface): ManagedWindowSnapshot[] {
		const windows = Array.from(this.windows.values())
			.filter((entry) => (surface ? entry.surface === surface : true))
			.map(({ id, surface: entrySurface, title, singleton, alwaysOnTop }) => ({
				id,
				surface: entrySurface,
				title,
				singleton,
				alwaysOnTop,
			}));

		return windows.sort((left, right) => {
			if (left.surface === right.surface) {
				return left.title.localeCompare(right.title);
			}
			return left.surface.localeCompare(right.surface);
		});
	}

	async openSettingsWindow(tabHint?: string): Promise<ManagedWindowSnapshot> {
		const existing = Array.from(this.windows.values()).find(
			(entry) => entry.surface === "settings",
		);
		if (existing) {
			existing.window.focus();
			return this.toSnapshot(existing);
		}
		return this.createManagedWindow("settings", tabHint, true);
	}

	async openSurfaceWindow(
		surface: DetachedSurface,
		browse?: string,
		alwaysOnTop = false,
	): Promise<ManagedWindowSnapshot> {
		const key = `${surface}:${surface === "browser" ? (browse?.trim() ?? "") : ""}`;
		const pending = this.pendingSurfaceWindows.get(key);
		if (pending) return pending;

		const task = this.openSurfaceWindowOnce(surface, browse, alwaysOnTop);
		this.pendingSurfaceWindows.set(key, task);
		try {
			return await task;
		} finally {
			if (this.pendingSurfaceWindows.get(key) === task) {
				this.pendingSurfaceWindows.delete(key);
			}
		}
	}

	private async openSurfaceWindowOnce(
		surface: DetachedSurface,
		browse?: string,
		alwaysOnTop = false,
	): Promise<ManagedWindowSnapshot> {
		const existing = Array.from(this.windows.values()).find(
			(entry) => entry.surface === surface,
		);
		if (existing) {
			if (alwaysOnTop && !existing.alwaysOnTop) {
				existing.window.setAlwaysOnTop(true);
				existing.alwaysOnTop = true;
			}
			existing.window.focus();
			this.notifyRegistryChanged();
			return this.toSnapshot(existing);
		}

		const seed = surface === "browser" ? browse : undefined;
		return this.createManagedWindow(
			surface,
			undefined,
			false,
			seed,
			undefined,
			undefined,
			alwaysOnTop,
		);
	}

	async openAppWindow(options: {
		slug?: string;
		title: string;
		path: string;
		alwaysOnTop?: boolean;
	}): Promise<ManagedWindowSnapshot> {
		return this.createManagedWindow(
			"app",
			undefined,
			false,
			undefined,
			options.path,
			options.title,
			options.alwaysOnTop === true,
			options.slug,
		);
	}

	findWindowBySlug(slug: string): ManagedWindowSnapshot | undefined {
		for (const entry of this.windows.values()) {
			if (entry.slug === slug) {
				return this.toSnapshot(entry);
			}
		}
		return undefined;
	}

	focusWindow(id: string): boolean {
		const existing = this.windows.get(id);
		if (!existing) return false;
		existing.window.focus();
		this.notifyRegistryChanged();
		return true;
	}

	setWindowAlwaysOnTop(id: string, flag: boolean): boolean {
		const existing = this.windows.get(id);
		if (!existing) return false;
		existing.window.setAlwaysOnTop(flag);
		existing.alwaysOnTop = flag;
		this.notifyRegistryChanged();
		return true;
	}

	/**
	 * Invoke `fn` for every open managed window (settings + detached surfaces).
	 * WHY: when the embedded API port changes, `injectApiBase` must reach each
	 * webview—not only `BrowserWindow`—so RPC and `fetch` targets stay consistent.
	 */
	forEachWindow(fn: (window: ManagedWindowLike) => void): void {
		for (const { window } of this.windows.values()) {
			fn(window);
		}
	}

	private toSnapshot(entry: ManagedWindowRecord): ManagedWindowSnapshot {
		return {
			id: entry.id,
			surface: entry.surface,
			title: entry.title,
			singleton: entry.singleton,
			alwaysOnTop: entry.alwaysOnTop,
		};
	}

	private async createManagedWindow(
		surface: ManagedSurface,
		tabHint: string | undefined,
		singleton: boolean,
		browse?: string,
		routePath?: string,
		titleOverride?: string,
		alwaysOnTop = false,
		slug?: string,
	): Promise<ManagedWindowSnapshot> {
		if (!isManagedSurface(surface)) {
			throw new Error(`Unsupported surface: ${surface}`);
		}

		// Slug-based dedupe: re-launch by slug focuses the existing window
		// instead of spawning a duplicate. WHY: lets every launch entry point
		// (UI, app menu, tray) share one window per app — Ghost-style.
		if (slug) {
			for (const entry of this.windows.values()) {
				if (entry.slug === slug) {
					if (alwaysOnTop && !entry.alwaysOnTop) {
						entry.window.setAlwaysOnTop(true);
						entry.alwaysOnTop = true;
					}
					entry.window.focus();
					this.notifyRegistryChanged();
					return this.toSnapshot(entry);
				}
			}
		}

		const rendererUrl = await this.resolveRendererUrlFn();
		const preload = this.readPreloadFn();
		const existingCount = this.listWindows(surface).length;
		const title = titleOverride
			? titleOverride
			: singleton
				? ordinalTitle(surface, 1)
				: ordinalTitle(surface, existingCount + 1);
		const url = routePath
			? buildAppWindowRendererUrl(rendererUrl, routePath)
			: buildSurfaceWindowRendererUrl(rendererUrl, surface, tabHint, browse);
		const id = slug ? `${surface}_${slug}` : `${surface}_${++this.counter}`;

		// Restore previously-saved frame for this slug, falling back to the
		// surface's default position+size on first launch or when persistence
		// is unavailable. WHY: per-app windows should remember where the user
		// put them last (Ghost-style UX).
		const savedFrame =
			slug && this.boundsStore ? this.boundsStore.load(slug) : null;
		const frame = savedFrame ?? SURFACE_FRAMES[surface];

		const window = this.createWindowFn({
			title,
			url,
			preload,
			frame,
			titleBarStyle: "default",
			transparent: false,
		});
		if (alwaysOnTop) {
			window.setAlwaysOnTop(true);
		}

		const record: ManagedWindowRecord = {
			id,
			surface,
			title,
			singleton,
			alwaysOnTop,
			window,
			slug,
		};

		this.windows.set(id, record);
		this.wireRpcFn(window);
		this.onWindowFocused?.(window);
		window.webview.on("dom-ready", () => {
			this.injectApiBaseFn(window);
		});
		setTimeout(() => {
			window.webview.loadURL?.(url);
		}, 0);
		window.on("close", () => {
			this.windows.delete(id);
			this.notifyRegistryChanged();
		});
		window.on("focus", () => {
			this.onWindowFocused?.(window);
			this.notifyRegistryChanged();
		});

		// Per-slug bounds persistence. WHY: getFrame() polls the OS, so we
		// debounce 500ms to avoid disk thrash during a drag/resize gesture.
		if (slug && this.boundsStore && typeof window.getFrame === "function") {
			const store = this.boundsStore;
			let saveTimer: ReturnType<typeof setTimeout> | null = null;
			const scheduleSave = () => {
				if (saveTimer) clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					saveTimer = null;
					try {
						const current = window.getFrame?.();
						if (current) store.save(slug, current);
					} catch {
						/* ignore — never let bounds save break the window */
					}
				}, 500);
			};
			window.on("resize", scheduleSave);
			window.on("move", scheduleSave);
		}

		this.notifyRegistryChanged();
		return this.toSnapshot(record);
	}

	private notifyRegistryChanged(): void {
		this.onRegistryChanged?.();
	}
}
