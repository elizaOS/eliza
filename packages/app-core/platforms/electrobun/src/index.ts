import fs from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { resolveApiToken, resolveDesktopApiPort } from "@elizaos/shared";
import Electrobun, {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	BuildConfig,
	Updater,
	Utils,
	WGPU,
	webgpu,
} from "electrobun/bun";
import {
	resolveDesktopRuntimeMode,
	resolveInitialApiBase,
	resolveRendererFacingApiBase,
} from "./api-base";
import {
	buildApplicationMenu,
	findAppMenuEntryBySlug,
	getAppMenuEntries,
	parseSettingsWindowAction,
} from "./application-menu";
import { setApplicationMenuActionHandler } from "./application-menu-action-registry";
import { showBackgroundNoticeOnce } from "./background-notice";
import { getBrandConfig } from "./brand-config";
import { startBrowserWorkspaceBridgeServer } from "./browser-workspace-bridge-server";
import { readNavigationEventUrl } from "./cloud-auth-window";
import { startDesktopTestBridgeServer } from "./desktop-test-bridge-server";
import { scheduleDevtoolsLayoutRefresh } from "./devtools-layout";
import { getFloatingChatManager } from "./floating-chat-window";
import * as apiBaseOwner from "./lifecycle/api-base-owner";
import {
	markDesktopSessionStale,
	primeDesktopSessionAuth,
} from "./lifecycle/desktop-session-prime";
import { logger } from "./logger";
import {
	resolveBootstrapShellRenderer,
	resolveBootstrapViewRenderer,
	resolveMainWindowPartition,
	shouldForceMainWindowCef,
} from "./main-window-session";
import {
	buildMainMenuResetApiCandidates,
	pickReachableMenuResetApiBase,
	runMainMenuResetAfterApiBaseResolved,
} from "./menu-reset-from-main";
import {
	configureDesktopLocalApiAuth,
	getAgentManager,
	getDiagnosticLogPath,
	getStartupDiagnosticLogTail,
	getStartupDiagnosticsSnapshot,
	getStartupStatusPath,
} from "./native/agent";
import { getDesktopManager } from "./native/desktop";
import { disposeNativeModules, initializeNativeModules } from "./native/index";
import {
	enableVibrancy,
	ensureShadow,
	setNativeDragRegion,
	setTrafficLightsPosition,
} from "./native/mac-window-effects";
import { getPermissionManager } from "./native/permissions";
import { checkWebGpuSupport } from "./native/webgpu-browser-support";
import { printElectrobunDevSettingsBanner } from "./print-electrobun-dev-settings-banner";
import { resolveRendererAsset } from "./renderer-static";
import {
	buildBunRpcHandlers,
	wireBrowserWorkspaceCaller,
} from "./rpc-handlers";
import type { ElizaDesktopRPCSchema } from "./rpc-schema";
import {
	readResolvedPreloadScript,
	resolveRendererAssetDir,
} from "./runtime-layout";
import { mergeRuntimePermissionStates } from "./runtime-permissions";
import { startScreenshotDevServer } from "./screenshot-dev-server";
import { recordStartupPhase, resolveStartupBundlePath } from "./startup-trace";
import {
	type BoundsStore,
	isDetachedSurface,
	type ManagedWindowFrame,
	type ManagedWindowLike,
	SurfaceWindowManager,
} from "./surface-windows";
import type { SendToWebview } from "./types.js";
import {
	resolveDesktopBundleVersion,
	shouldResetWindowsCefProfile,
	shouldWriteWindowsCefProfileMarker,
} from "./windows-cef-profile";

const BRAND = getBrandConfig();
const CONFIG_EXPORT_FILE_NAME = BRAND.configExportFileName;
const STARTUP_CRASH_REPORT_FILE = "startup-crash-report-latest.md";
const STARTUP_CRASH_PROMPT_MARKER_FILE = "startup-crash-last-prompted.txt";

import {
	isAgentReady,
	onAgentReadyChange,
	setAgentReady,
} from "./agent-ready-state";
import {
	clearCurrentMainWindow,
	setCurrentMainWindow,
	updateCurrentMainWindowEffectsState,
} from "./main-window-runtime";
import {
	isStewardLocalEnabled,
	onStewardStatusChange,
	resetSteward,
	restartSteward,
	setStewardSendToWebview,
	startSteward,
	stopSteward,
} from "./native/steward";

function resolveDesktopAppIconPath(): string {
	return path.join(
		import.meta.dir,
		process.platform === "win32"
			? "../assets/appIcon.ico"
			: "../assets/appIcon.png",
	);
}

function shouldUseBrowserDevtoolsFallback(): boolean {
	return false;
}

function setupApplicationMenu(): void {
	const isMac = process.platform === "darwin";
	const menu = buildApplicationMenu({
		isMac,
		browserEnabled: false,
		detachedWindows: surfaceWindowManager?.listWindows() ?? [],
		agentReady: isAgentReady(),
	});
	ApplicationMenu.setApplicationMenu(
		menu as Parameters<typeof ApplicationMenu.setApplicationMenu>[0],
	);
}

onAgentReadyChange(() => setupApplicationMenu());

function summarizeDesktopActionError(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : fallback;
	const trimmed = message.trim();
	if (!trimmed) return fallback;
	return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function buildApiRequestHeaders(contentType?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (contentType) {
		headers["Content-Type"] = contentType;
	}
	let apiToken = resolveApiToken(process.env);
	if (!apiToken) {
		const rt = resolveDesktopRuntimeMode(
			process.env as Record<string, string | undefined>,
		);
		if (rt.mode === "local") {
			apiToken = configureDesktopLocalApiAuth().trim();
		}
	}
	if (apiToken) {
		headers.Authorization = `Bearer ${apiToken}`;
	}
	return headers;
}

function resolveLoopbackApiBase(): string | null {
	const port = getAgentManager().getStatus().port;
	if (typeof port === "number" && port > 0) {
		return `http://127.0.0.1:${port}`;
	}
	return resolveInitialApiBase(process.env);
}

/**
 * Picks a loopback API base the main process can actually reach.
 *
 * **WHY:** `resolveLoopbackApiBase()` falls back to `resolveInitialApiBase`,
 * which in **external** mode is `ELIZA_DESKTOP_API_BASE` (often :31337). If that
 * dev server is down but the **embedded** agent is still running on a dynamic
 * port, menu Reset must not blindly POST to the dead env URL.
 */
async function resolveReachableApiBaseForMainReset(): Promise<string | null> {
	const candidates = buildMainMenuResetApiCandidates({
		embeddedPort: getAgentManager().getStatus().port,
		configuredBase: resolveInitialApiBase(process.env),
	});
	if (candidates.length === 0) {
		return null;
	}
	const base = await pickReachableMenuResetApiBase({
		candidates,
		fetchImpl: fetch,
		buildHeaders: buildApiRequestHeaders,
	});
	if (base) {
		logger.info(
			`[Main][reset] Using reachable API base ${base} (tried: ${candidates.join(", ")})`,
		);
	} else {
		logger.warn(
			`[Main][reset] No reachable API base among candidates (tried: ${candidates.join(", ")})`,
		);
	}
	return base;
}

/**
 * App menu "Reset the app…" — confirm + HTTP reset + restart in the **main process**.
 *
 * **WHY not renderer `fetch`:** after native `showMessageBox`, WKWebView may not run
 * network/bridge work on the same turn, so reset appeared hung. **WHY push
 * `menu-reset-app-applied`:** renderer must still run the same local wipe as
 * Settings (`completeResetLocalStateAfterServerWipe`); main only supplies a fresh
 * `/api/status` snapshot as `agentStatus`. Orchestration core: `menu-reset-from-main.ts`.
 *
 * @see `docs/apps/desktop-main-process-reset.md`
 */
async function resetTheAppFromApplicationMenu(): Promise<void> {
	logger.info(
		`[Main][reset] App menu: Reset ${BRAND.appName} — confirm + POST /api/agent/reset + restart (main process)`,
	);
	await getDesktopManager()
		.showWindow()
		.catch((err: unknown) => {
			logger.warn(
				`[Main][reset] showWindow failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		});

	const autoConfirm =
		process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS === "1" ||
		process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_RESET === "1";
	const response = autoConfirm
		? 0
		: await Utils.showMessageBox({
				type: "warning",
				title: "Reset Agent",
				message:
					"This will reset the agent: config, cloud keys, and local agent database (conversations / memory).",
				detail:
					"Downloaded GGUF embedding models are kept. You will return to the onboarding wizard.",
				buttons: ["Reset", "Cancel"],
				defaultId: 0,
				cancelId: 1,
			}).then((box) =>
				box && typeof box === "object" && "response" in box
					? (box as { response: number }).response
					: typeof box === "number"
						? box
						: 1,
			);
	if (response !== 0) {
		logger.info("[Main][reset] User cancelled native confirm");
		return;
	}

	const apiBase = await resolveReachableApiBaseForMainReset();
	if (!apiBase) {
		Utils.showNotification({
			title: "Reset Failed",
			body: `Could not reach the ${BRAND.appName} API (tried embedded port and ELIZA_DESKTOP_API_BASE / defaults). Start the agent or dev server, or fix your API base env.`,
		});
		return;
	}

	try {
		const runtimeMode = resolveDesktopRuntimeMode(
			process.env as Record<string, string | undefined>,
		);

		await runMainMenuResetAfterApiBaseResolved({
			apiBase,
			fetchImpl: fetch,
			buildHeaders: buildApiRequestHeaders,
			useEmbeddedRestart: runtimeMode.mode === "local",
			restartEmbeddedClearingLocalDb: async () => {
				const status = await getAgentManager().restartClearingLocalDb();
				return { port: status.port ?? undefined };
			},
			pushEmbeddedApiBaseToRenderer: (port, apiToken) => {
				if (currentWindow) {
					const base = port
						? resolveRendererFacingApiBase(
								process.env as Record<string, string | undefined>,
								port,
							)
						: (resolveLoopbackApiBase() ??
							resolveInitialApiBase(
								process.env as Record<string, string | undefined>,
							) ??
							apiBase);
					if (base) {
						apiBaseOwner.notifyChange(currentWindow, base, apiToken);
					}
				}
			},
			getLocalApiAuthToken: () => configureDesktopLocalApiAuth(),
			postExternalAgentRestart: async () => {
				try {
					await fetch(`${apiBase}/api/agent/restart`, {
						method: "POST",
						headers: buildApiRequestHeaders(),
					});
				} catch {
					/* 409 / race while restarting — poll below */
				}
			},
			resolveApiBaseForStatusPoll: () => resolveLoopbackApiBase() ?? apiBase,
			sendMenuResetAppliedToRenderer: (payload) => {
				sendToActiveRenderer("desktopTrayMenuClick", payload);
			},
		});
		logger.info(
			"[Main][reset] Pushed menu-reset-app-applied to renderer with /api/status snapshot",
		);
	} catch (err) {
		logger.error(
			`[Main][reset] Main-process reset failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		Utils.showNotification({
			title: "Reset Failed",
			body: summarizeDesktopActionError(err, "Reset failed"),
		});
	}
}

const MAC_TRAFFIC_LIGHTS_X = 14;
const MAC_TRAFFIC_LIGHTS_Y = 12;
/** Left inset of the drag strip so it clears the traffic lights. */
const MAC_NATIVE_DRAG_REGION_X = 92;
/**
 * Native titlebar drag height. The native layer keeps resize bands thin
 * separately and only installs drag views in safe title/empty zones so
 * titlebar buttons continue to receive clicks.
 */
const MAC_NATIVE_DRAG_REGION_HEIGHT = 38;

/**
 * Vibrancy, shadow, traffic lights, and native chrome layout. Re-calls native
 * layout whenever the window or webview subtree may have reordered so the drag
 * view stays above WKWebView.
 */
function applyMacOSWindowEffects(win: BrowserWindow): void {
	if (process.platform !== "darwin") return;

	const ptr = (win as { ptr?: unknown }).ptr;
	if (!ptr) {
		logger.warn("[MacEffects] win.ptr unavailable — skipping native effects");
		return;
	}

	const vibrancyEnabled = enableVibrancy(
		ptr as Parameters<typeof enableVibrancy>[0],
	);
	const shadowEnabled = ensureShadow(ptr as Parameters<typeof ensureShadow>[0]);
	updateCurrentMainWindowEffectsState({
		vibrancyEnabled,
		shadowEnabled,
	});

	const alignButtons = () =>
		setTrafficLightsPosition(
			ptr as Parameters<typeof setTrafficLightsPosition>[0],
			MAC_TRAFFIC_LIGHTS_X,
			MAC_TRAFFIC_LIGHTS_Y,
		);
	const alignDragRegion = () =>
		setNativeDragRegion(
			ptr as Parameters<typeof setNativeDragRegion>[0],
			MAC_NATIVE_DRAG_REGION_X,
			MAC_NATIVE_DRAG_REGION_HEIGHT,
		);

	const alignChrome = () => {
		alignButtons();
		alignDragRegion();
	};

	alignChrome();
	setTimeout(alignChrome, 120);
	const chromeRefreshTimer = setInterval(alignChrome, 1000);

	win.on("resize", alignChrome);
	win.on("focus", alignChrome);
	win.on("blur", () => {
		alignChrome();
		setTimeout(alignChrome, 80);
		setTimeout(alignChrome, 240);
		setTimeout(alignChrome, 700);
	});
	// Display (NSScreen) changes without a resize edge case — depth uses window.screen.
	win.on("move", alignChrome);
	win.on("close", () => clearInterval(chromeRefreshTimer));

	// WKWebView is often inserted or reordered after first layout; restack native
	// views so drag/resize strips stay hit-testable above the page.
	try {
		win.webview.on("dom-ready", () => {
			alignChrome();
			setTimeout(alignChrome, 50);
			setTimeout(alignChrome, 300);
		});
	} catch {
		// webview may not accept listeners yet in some embed paths
	}
}

interface WindowState {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Fresh-install default: a generous 1440x900 window centered-ish
 * near the top-left of the primary display. Maximize-on-launch (see
 * createMainWindow) then expands this to fill the screen on every
 * boot, so this default only matters for brand-new installs on
 * systems where maximize() hasn't registered yet.
 */
const DEFAULT_WINDOW_STATE: WindowState = {
	x: 60,
	y: 60,
	width: 1440,
	height: 900,
};

/**
 * Marker value we stamp into the saved state when we'd like the next
 * launch to open maximized. Kept as a synthetic "pending-maximize" flag
 * rather than a real bool so it piggybacks on the existing
 * width/height/x/y schema without a migration.
 */
const MAXIMIZE_ON_LAUNCH_SENTINEL = 1;

interface PersistedWindowState extends WindowState {
	/** When truthy, call win.maximize() right after creation. */
	shouldMaximize?: number;
}

function loadWindowState(statePath: string): PersistedWindowState {
	try {
		if (fs.existsSync(statePath)) {
			const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
			if (typeof data.width === "number" && typeof data.height === "number") {
				const state = { ...DEFAULT_WINDOW_STATE, ...data };
				// Discard state saved while the window was minimized.  On Windows,
				// minimized windows report position (-32000, -32000) and a tiny
				// size, which makes the window invisible on next launch.
				if (state.width < 200 || state.height < 200 || state.x < -16000) {
					return {
						...DEFAULT_WINDOW_STATE,
						shouldMaximize: MAXIMIZE_ON_LAUNCH_SENTINEL,
					};
				}
				return state;
			}
		}
	} catch {}
	// No saved state → first launch. Open at the default 1440×900 window
	// size (centered-ish near top-left) instead of maximizing. Maximizing on
	// first launch buries the welcome content in a vast empty workspace and
	// gives a "this is overwhelming" impression. The user can always
	// maximize themselves; subsequent launches restore their last size.
	return { ...DEFAULT_WINDOW_STATE };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleStateSave(statePath: string, win: BrowserWindow): void {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		try {
			const { x, y } = win.getPosition();
			const { width, height } = win.getSize();
			// Skip saving when the window is minimized — Windows reports
			// position (-32000, -32000) and a collapsed size, which would make
			// the window invisible on next launch.
			if (width < 200 || height < 200 || x < -16000) return;
			const dir = path.dirname(statePath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				statePath,
				JSON.stringify({ x, y, width, height }),
				"utf8",
			);
		} catch {}
	}, 500);
}

/**
 * Per-slug app-window bounds persistence. Survives across launches so an
 * app re-opened later restores to the user's last position+size.
 *
 * **WHY a separate file from `window-state.json`**: the main window is
 * singleton (one record); app windows are slug-keyed (one record per app).
 * Mixing them would couple unrelated lifecycles.
 */
function createAppWindowBoundsStore(): BoundsStore {
	const storePath = path.join(Utils.paths.userData, "app-window-bounds.json");
	type Blob = Record<string, ManagedWindowFrame>;
	let cache: Blob | null = null;

	function isFrame(value: unknown): value is ManagedWindowFrame {
		if (!value || typeof value !== "object") return false;
		const f = value as Record<string, unknown>;
		return (
			typeof f.x === "number" &&
			typeof f.y === "number" &&
			typeof f.width === "number" &&
			typeof f.height === "number" &&
			f.width >= 200 &&
			f.height >= 200 &&
			f.x > -16000 &&
			f.y > -16000
		);
	}

	function readCache(): Blob {
		if (cache) return cache;
		try {
			if (fs.existsSync(storePath)) {
				const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
				if (raw && typeof raw === "object") {
					const next: Blob = {};
					for (const [slug, frame] of Object.entries(raw)) {
						if (isFrame(frame)) next[slug] = frame;
					}
					cache = next;
					return next;
				}
			}
		} catch {
			/* ignore — corrupt or missing file just yields empty cache */
		}
		cache = {};
		return cache;
	}

	function writeCache(): void {
		if (!cache) return;
		try {
			const dir = path.dirname(storePath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(storePath, JSON.stringify(cache), "utf8");
		} catch {
			/* ignore — bounds save must never break the window */
		}
	}

	return {
		load: (slug) => {
			const blob = readCache();
			return blob[slug] ?? null;
		},
		save: (slug, frame) => {
			if (!isFrame(frame)) return;
			const blob = readCache();
			blob[slug] = frame;
			writeCache();
		},
	};
}

let currentWindow: BrowserWindow | null = null;
let currentSendToWebview: SendToWebview | null = null;
let surfaceWindowManager: SurfaceWindowManager | null = null;
let rendererUrlPromise: Promise<string> | null = null;
let backgroundWindowPromise: Promise<void> | null = null;
let isQuitting = false;

function requestAppQuit(): void {
	isQuitting = true;
	Utils.quit();
}

const cleanupFns: Array<() => void | Promise<void>> = [];
let lastFocusedWindow: ManagedWindowLike | null = null;
const macOpenedDevtoolsWindowIds = new Set<number>();

async function openBrowserDevtoolsFallback(
	targetWindow: ManagedWindowLike | BrowserWindow | null,
): Promise<void> {
	const currentUrl = (
		targetWindow?.webview as { url?: string | null } | undefined
	)?.url;
	const url = currentUrl?.trim() || (await resolveRendererUrl());

	if (!/^https?:\/\//i.test(url)) {
		Utils.showNotification({
			title: "Developer Tools Unavailable",
			body: "Native macOS Electrobun devtools are disabled, and the renderer URL is not browser-openable.",
		});
		return;
	}

	Utils.openExternal(url);
	Utils.showNotification({
		title: "Opened Renderer in Browser",
		body: "Native macOS Electrobun devtools are disabled due to a WKWebView crash/layout bug. Use browser devtools instead.",
	});
}

function sendToActiveRenderer(message: string, payload?: unknown): void {
	currentSendToWebview?.(message, payload);
	if (!currentSendToWebview) {
		const level =
			message === "desktopTrayMenuClick" ? console.warn : console.debug;
		level.call(
			console,
			"[Main] Dropped renderer message (no window):",
			message,
		);
	}
}

function sendManagedWindowsChanged(): void {
	sendToActiveRenderer("desktopManagedWindowsChanged", {
		windows: surfaceWindowManager?.listWindows() ?? [],
	});
}

function shouldRestoreWindowBeforeMenuAction(
	action: string | undefined,
): boolean {
	if (!action || action.startsWith("focus-window:")) {
		return false;
	}
	return action !== "quit";
}

/**
 * Serve the renderer dist over HTTP so WKWebView can load it without
 * file:// CORS restrictions (crossorigin ES modules break over file://).
 * Returns the base URL e.g. "http://localhost:5174".
 */
async function startRendererServer(): Promise<string> {
	const rendererDir = resolveRendererAssetDir(import.meta.dir);
	if (!fs.existsSync(rendererDir)) {
		logger.warn("[Renderer] renderer dir not found:", rendererDir);
		return "";
	}

	// Find a free port starting at 5174 (5173 reserved for Vite dev)
	const getPort = (start: number): Promise<number> =>
		new Promise((resolve) => {
			const srv = createNetServer();
			srv.listen(start, "127.0.0.1", () => {
				const { port } = srv.address() as { port: number };
				srv.close(() => resolve(port));
			});
			srv.on("error", () => resolve(getPort(start + 1)));
		});

	const port = await getPort(5174);

	const mimeTypes: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "application/javascript",
		".mjs": "application/javascript",
		".css": "text/css",
		".png": "image/png",
		".jpg": "image/jpeg",
		".svg": "image/svg+xml",
		".ico": "image/x-icon",
		".json": "application/json",
		".gz": "application/octet-stream",
		".wasm": "application/wasm",
		".glb": "model/gltf-binary",
		".gltf": "model/gltf+json",
		".vrm": "model/gltf-binary",
	};

	// Seed the api-base-owner singleton with the initial value so the
	// HTML-inject path and the RPC push path both read the same source of
	// truth. Without this seeding, the static server would inject one value
	// into HTML before the renderer mounts and the RPC bridge would push a
	// different value moments later — the renderer racing two answers is
	// what produced the port-shift disconnect documented in MASTER.md §0.
	const initialApiBase = resolveInitialApiBase(
		process.env as Record<string, string | undefined>,
	);
	const initialApiToken =
		resolveDesktopRuntimeMode(process.env as Record<string, string | undefined>)
			.mode === "local"
			? configureDesktopLocalApiAuth()
			: (resolveApiToken(process.env) ?? "");
	apiBaseOwner.setCurrent(initialApiBase, initialApiToken);

	const resolveRendererCacheControl = (
		pathname: string,
		mimeExt: string,
	): string => {
		if (pathname.startsWith("/assets/")) {
			return "public, max-age=31536000, immutable";
		}
		if (
			mimeExt === ".vrm" ||
			pathname.endsWith(".vrm.gz") ||
			pathname.startsWith("/vrms/previews/") ||
			pathname.startsWith("/vrms/backgrounds/") ||
			[
				".png",
				".jpg",
				".jpeg",
				".gif",
				".webp",
				".avif",
				".svg",
				".mp3",
				".wav",
				".ogg",
				".m4a",
				".aac",
				".flac",
				".glb",
			].includes(mimeExt)
		) {
			return "public, max-age=86400";
		}
		return "public, max-age=0, must-revalidate";
	};

	Bun.serve({
		port,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const pathname = url.pathname;

			// Proxy /api/*, /ws, /music-player to the agent port. Mirrors the Vite
			// dev-server proxy in apps/app/vite.config.ts so the renderer can rely
			// on same-origin /api fetches whether it's loaded via Vite (watch mode)
			// or this static server (non-watch dev:desktop). Without this, every
			// /api/* call returned SPA HTML and Settings sat on "Loading…" forever.
			if (
				initialApiBase &&
				(pathname.startsWith("/api/") ||
					pathname === "/ws" ||
					pathname.startsWith("/music-player"))
			) {
				const target = new URL(pathname + url.search, initialApiBase);
				const headers = new Headers(req.headers);
				headers.set("host", target.host);
				try {
					const upstream = await fetch(target, {
						method: req.method,
						headers,
						body: req.body,
						// @ts-expect-error Bun fetch supports duplex for streaming bodies
						duplex: "half",
						redirect: "manual",
					});
					return new Response(upstream.body, {
						status: upstream.status,
						statusText: upstream.statusText,
						headers: upstream.headers,
					});
				} catch (err) {
					return new Response(
						JSON.stringify({
							error: "API server unavailable",
							detail: err instanceof Error ? err.message : String(err),
						}),
						{
							status: 502,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			}

			const { filePath, isGzipped, mimeExt } = resolveRendererAsset({
				rendererDir,
				urlPath: pathname,
				existsSync: fs.existsSync,
				statSync: fs.statSync,
			});

			try {
				const content = fs.readFileSync(filePath);
				// Inject API base into HTML responses
				if (mimeExt === ".html" || filePath.endsWith("index.html")) {
					const html = apiBaseOwner.injectIntoHtml(content.toString("utf8"));
					return new Response(html, {
						headers: {
							"Content-Type": "text/html; charset=utf-8",
							"Access-Control-Allow-Origin": "*",
							"Cache-Control": "public, max-age=0, must-revalidate",
						},
					});
				}

				const headers: Record<string, string> = {
					"Content-Type": mimeTypes[mimeExt] ?? "application/octet-stream",
					"Access-Control-Allow-Origin": "*",
					"Cache-Control": resolveRendererCacheControl(pathname, mimeExt),
				};

				if (isGzipped) {
					headers["Content-Encoding"] = "gzip";
				}

				return new Response(content, { headers });
			} catch {
				return new Response("Not found", { status: 404 });
			}
		},
	});

	console.log(`[Renderer] Static server on http://127.0.0.1:${port}`);
	return `http://127.0.0.1:${port}`;
}

async function resolveRendererUrl(): Promise<string> {
	// Prefer ELIZA_RENDERER_URL / VITE_DEV_SERVER_URL when set (e.g. dev-platform.mjs watch mode).
	// Why: Vite HMR only works against the dev server; serving pre-built dist from this static
	// server would force a full rebuild for every UI change.
	let rendererUrl =
		process.env.ELIZA_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL ?? "";

	if (!rendererUrl) {
		rendererUrlPromise ??= startRendererServer();
		rendererUrl = await rendererUrlPromise;
	}

	if (!rendererUrl) {
		// Last resort: file:// (may have CORS issues with crossorigin module scripts)
		rendererUrl = `file://${path.join(resolveRendererAssetDir(import.meta.dir), "index.html")}`;
		logger.warn(
			"[Main] Falling back to file:// renderer URL — CORS issues possible",
		);
	}

	return rendererUrl;
}

async function createMainWindow(rpc: ElizaDesktopRpc): Promise<BrowserWindow> {
	const rendererUrl = await resolveRendererUrl();
	const mainWindowPartition = resolveMainWindowPartition(process.env);
	if (mainWindowPartition) {
		logger.info(
			`[Main] Using isolated main window partition ${mainWindowPartition}`,
		);
	}

	const statePath = path.join(Utils.paths.userData, "window-state.json");
	const state = loadWindowState(statePath);

	let preload: string;
	try {
		preload = readResolvedPreloadScript(import.meta.dir);
	} catch (err) {
		logger.error(
			`[Main] Failed to read preload script: ${err instanceof Error ? err.message : String(err)}`,
		);
		preload = "// preload unavailable";
	}

	const windowFrame = {
		width: state.width,
		height: state.height,
		x: state.x,
		y: state.y,
	};
	const titleBarStyle =
		process.platform === "darwin" ? "hiddenInset" : "default";
	const transparent = process.platform === "darwin";
	const buildInfo = await BuildConfig.get();
	const forceMainWindowCef = shouldForceMainWindowCef(process.env);
	const canUseCefView = buildInfo.availableRenderers.includes("cef");
	const useIsolatedMainView =
		(process.platform === "win32" && mainWindowPartition) ||
		(forceMainWindowCef && canUseCefView && !!mainWindowPartition);

	if (forceMainWindowCef && !canUseCefView) {
		logger.warn(
			"[Main] ELIZA_DESKTOP_FORCE_CEF=1 requested, but this Electrobun build does not bundle the CEF renderer. Falling back to the native renderer.",
		);
	}

	let win: BrowserWindow;
	if (useIsolatedMainView) {
		// Shell window with the empty default webview. The actual content
		// (and therefore the RPC channel) is hosted on the separate mainView
		// BrowserView constructed below — that's what we attach `rpc` to.
		win = new BrowserWindow({
			title: BRAND.appName,
			// @ts-expect-error: Electrobun doesn't expose icon in JS typings yet
			icon: resolveDesktopAppIconPath(),
			url: null,
			preload: null,
			frame: windowFrame,
			renderer: resolveBootstrapShellRenderer(buildInfo),
			titleBarStyle,
			transparent,
		});
		win.webview.remove();
		const mainView = new BrowserView({
			url: rendererUrl,
			preload,
			renderer: forceMainWindowCef
				? "cef"
				: resolveBootstrapViewRenderer(buildInfo),
			partition: mainWindowPartition,
			frame: {
				x: 0,
				y: 0,
				width: state.width,
				height: state.height,
			},
			windowId: win.id,
			rpc,
		});
		win.webviewId = mainView.id;
		if (forceMainWindowCef) {
			logger.info(
				`[Main] Using CEF main-window workaround with persistent partition ${mainWindowPartition}`,
			);
		}
	} else {
		win = new BrowserWindow({
			title: BRAND.appName,
			// @ts-expect-error: Electrobun doesn't expose icon in JS typings yet
			icon: resolveDesktopAppIconPath(),
			url: rendererUrl,
			preload,
			frame: windowFrame,
			titleBarStyle,
			transparent,
			rpc,
		});
	}

	applyMacOSWindowEffects(win);
	win.on("resize", () => scheduleStateSave(statePath, win));
	win.on("move", () => scheduleStateSave(statePath, win));

	// First-launch ergonomics: when there's no saved state (or the
	// saved state was garbage and we're falling back to defaults), open
	// the window maximized so the user gets a full workspace instead of
	// a 1440x900 rectangle in the corner they have to resize by hand.
	// Subsequent launches skip this because loadWindowState returns the
	// real persisted dimensions without the shouldMaximize sentinel.
	if (state.shouldMaximize === MAXIMIZE_ON_LAUNCH_SENTINEL) {
		try {
			(win as typeof win & { maximize?: () => void }).maximize?.();
		} catch (err) {
			// Non-fatal — if maximize() isn't available on this electrobun
			// build, the window still opens at the default dimensions.
			logger.warn(
				`[main-window] maximize() failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return win;
}

function attachMainWindow(
	win: BrowserWindow,
	rpc: ElizaDesktopRpc,
	sendToWebview: SendToWebview,
): BrowserWindow {
	wireMainWindowAfterCreate(win, rpc, sendToWebview);
	currentWindow = win;
	currentSendToWebview = sendToWebview;
	setCurrentMainWindow(win, {
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
		transparent: process.platform === "darwin",
	});
	trackFocusedWindow(win);

	win.webview.on("dom-ready", () => {
		injectApiBase(win);
	});

	// Prevent the main webview from navigating to external URLs.
	// The renderer is always served from localhost — any other navigation
	// (e.g. from a compromised plugin) should open in the default browser.
	win.webview.on("will-navigate", (event: unknown) => {
		const e = event as {
			url?: string;
			data?: { detail?: string };
			preventDefault?: () => void;
		};
		const url = readNavigationEventUrl(e);
		try {
			const parsed = new URL(url);
			const isAllowed =
				parsed.protocol === "file:" ||
				parsed.hostname === "localhost" ||
				parsed.hostname === "127.0.0.1" ||
				parsed.protocol === "views:";
			if (!isAllowed) {
				e.preventDefault?.();
				void import("electrobun/bun")
					.then(({ Utils }) => {
						try {
							Utils.openExternal(url);
						} catch {
							// Ignore external open failures during navigation blocking.
						}
					})
					.catch(() => {});
			}
		} catch {
			// Unparseable URL — block it.
			e.preventDefault?.();
		}
	});

	win.on("close", () => {
		if (currentWindow?.id === win.id) {
			currentWindow = null;
			currentSendToWebview = null;
		}
		clearCurrentMainWindow(win);
		getDesktopManager().clearMainWindow(win);

		if (!isQuitting) {
			void ensureBackgroundWindow();
		}
	});

	return win;
}

async function ensureBackgroundWindow(): Promise<void> {
	if (isQuitting || currentWindow) {
		return;
	}

	// Don't recreate the window — just keep the process alive in the
	// background (exitOnLastWindowClosed is false in electrobun.config.ts).
	// The dock icon click fires the "reopen" event which restores the window.
	logger.info("[Main] Window closed — agent continues in background");
	showBackgroundRunNoticeOnce();
}

/** Restore or recreate the main window (called on dock icon click). */
async function restoreWindow(): Promise<void> {
	if (currentWindow) {
		try {
			currentWindow.unminimize();
			currentWindow.focus();
		} catch {
			// unminimize/focus may not be available
		}
		return;
	}
	if (backgroundWindowPromise) {
		await backgroundWindowPromise;
		return;
	}
	backgroundWindowPromise = (async () => {
		const { rpc, sendToWebview } = createDesktopRpc("main");
		const win = attachMainWindow(
			await createMainWindow(rpc),
			rpc,
			sendToWebview,
		);
		injectApiBase(win);
		logger.info("[Main] Restored window from dock click");
	})().finally(() => {
		backgroundWindowPromise = null;
	});
	await backgroundWindowPromise;
}

function showBackgroundRunNoticeOnce(): void {
	try {
		showBackgroundNoticeOnce({
			fileSystem: fs,
			userDataDir: Utils.paths.userData,
			showNotification: (options) => {
				Utils.showNotification(options);
			},
		});
	} catch (error) {
		logger.warn(
			`[Main] Failed to persist background notice marker: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function createSettingsWindow(tabHint?: string): Promise<void> {
	if (!surfaceWindowManager) return;
	await surfaceWindowManager.openSettingsWindow(tabHint);
}

async function showMainSurface(surface: string): Promise<void> {
	if (!currentWindow) {
		await restoreWindow();
	}
	void getDesktopManager().showWindow();
	sendToActiveRenderer("desktopTrayMenuClick", {
		itemId: `show-main:${surface}`,
	});
}

function resolveDefaultDialogPath(): string {
	const downloadsPath = path.join(os.homedir(), "Downloads");
	return fs.existsSync(downloadsPath) ? downloadsPath : os.homedir();
}

async function exportConfigFromMenu(): Promise<void> {
	const apiBase = resolveLoopbackApiBase();
	if (!apiBase) {
		Utils.showNotification({
			title: "Config Export Failed",
			body: "Agent unavailable",
		});
		return;
	}

	try {
		const response = await fetch(`${apiBase}/api/config`, {
			headers: buildApiRequestHeaders(),
		});
		if (!response.ok) {
			throw new Error(`Config fetch failed (${response.status})`);
		}

		const config = await response.json();
		const dialog = await getDesktopManager().showSaveDialog({
			defaultPath: resolveDefaultDialogPath(),
			allowedFileTypes: "json",
		});
		if (dialog.canceled || dialog.filePaths.length === 0) {
			return;
		}

		const outputPath = path.join(dialog.filePaths[0], CONFIG_EXPORT_FILE_NAME);
		fs.writeFileSync(
			outputPath,
			`${JSON.stringify(config, null, 2)}\n`,
			"utf8",
		);

		Utils.showNotification({
			title: "Config Exported",
			body: `Saved to ${outputPath}`,
		});
	} catch (error) {
		Utils.showNotification({
			title: "Config Export Failed",
			body: summarizeDesktopActionError(error, "Config export failed"),
		});
	}
}

async function importConfigFromMenu(): Promise<void> {
	const apiBase = resolveLoopbackApiBase();
	if (!apiBase) {
		Utils.showNotification({
			title: "Config Import Failed",
			body: "Agent unavailable",
		});
		return;
	}

	try {
		const dialog = await getDesktopManager().showOpenDialog({
			defaultPath: resolveDefaultDialogPath(),
			allowedFileTypes: "json",
			canChooseFiles: true,
			canChooseDirectory: false,
			allowsMultipleSelection: false,
		});
		if (dialog.canceled || dialog.filePaths.length === 0) {
			return;
		}

		const inputPath = dialog.filePaths[0];
		const rawConfig = fs.readFileSync(inputPath, "utf8");
		const parsedConfig = JSON.parse(rawConfig) as unknown;
		if (
			typeof parsedConfig !== "object" ||
			parsedConfig === null ||
			Array.isArray(parsedConfig)
		) {
			throw new Error("Config file must contain a JSON object");
		}

		const response = await fetch(`${apiBase}/api/config`, {
			method: "PUT",
			headers: buildApiRequestHeaders("application/json"),
			body: JSON.stringify(parsedConfig),
		});
		if (!response.ok) {
			throw new Error(`Config import failed (${response.status})`);
		}

		Utils.showNotification({
			title: "Config Imported",
			body: `Loaded ${path.basename(inputPath)}`,
		});
	} catch (error) {
		Utils.showNotification({
			title: "Config Import Failed",
			body: summarizeDesktopActionError(error, "Config import failed"),
		});
	}
}

function trackFocusedWindow(window: ManagedWindowLike): void {
	lastFocusedWindow = window;
	window.on("focus", () => {
		lastFocusedWindow = window;
		const windowId = (window as { id?: number }).id;
		if (
			process.platform === "darwin" &&
			typeof windowId === "number" &&
			macOpenedDevtoolsWindowIds.has(windowId)
		) {
			scheduleDevtoolsLayoutRefresh(
				window as Parameters<typeof scheduleDevtoolsLayoutRefresh>[0],
			);
		}
	});
	window.on("close", () => {
		const windowId = (window as { id?: number }).id;
		if (typeof windowId === "number") {
			macOpenedDevtoolsWindowIds.delete(windowId);
		}
	});
}

function toggleFocusedWindowDevTools(): void {
	const targetWindow = lastFocusedWindow ?? currentWindow;
	const webview = targetWindow?.webview as
		| {
				toggleDevTools?: () => void;
				openDevTools?: () => void;
		  }
		| undefined;

	if (shouldUseBrowserDevtoolsFallback()) {
		void openBrowserDevtoolsFallback(targetWindow);
		return;
	}

	if (typeof webview?.toggleDevTools === "function") {
		webview.toggleDevTools();
		scheduleDevtoolsLayoutRefresh(
			targetWindow as Parameters<typeof scheduleDevtoolsLayoutRefresh>[0],
		);
		return;
	}

	if (typeof webview?.openDevTools === "function") {
		webview.openDevTools();
		scheduleDevtoolsLayoutRefresh(
			targetWindow as Parameters<typeof scheduleDevtoolsLayoutRefresh>[0],
		);
		return;
	}

	Utils.showNotification({
		title: "Developer Tools Unavailable",
		body: "The focused window does not expose Electrobun devtools controls.",
	});
}

/**
 * The exact rpc object that BrowserView.defineRPC<ElizaDesktopRPCSchema>
 * returns. Carries the schema generic so call sites get typed `request`
 * and `send` proxies.
 */
type ElizaDesktopRpc = ReturnType<
	typeof BrowserView.defineRPC<ElizaDesktopRPCSchema>
>;

/**
 * Internal: type-erased view of the rpc shape that
 * `wireBrowserWorkspaceCaller` consumes. The handler module declares its
 * own structural type with `params: any`, so we widen here at the
 * boundary instead of forcing every consumer to import that internal.
 */
// biome-ignore lint/suspicious/noExplicitAny: bridges typed rpc.request to the handler-module's any-params signature
type RpcRequestProxy = Record<string, (params: any) => Promise<any>>;

const MAX_RPC_REQUEST_TIME_MS = 600_000;

/**
 * Build a typed RPC instance plus its `sendToWebview` companion, ready to
 * be passed to a `BrowserWindow` / `BrowserView` constructor via the `rpc`
 * option.
 *
 * This is the constructor-time injection pattern required by the
 * Electrobun rules: handlers are declared up front and bound when the
 * webview is created, not patched in post-hoc via `setRequestHandler`.
 *
 * `sendToWebview` closes over the RPC by reference so it can be passed
 * into `buildBunRpcHandlers` before `defineRPC` returns — we only need
 * the actual `send` proxy at call time, after the webview is alive.
 *
 * @param label  Diagnostic tag included in the "no RPC method" warning so
 *               main / settings / surface windows are distinguishable.
 */
function createDesktopRpc(label: string): {
	rpc: ElizaDesktopRpc;
	sendToWebview: SendToWebview;
} {
	let rpc: ElizaDesktopRpc | undefined;

	const sendToWebview: SendToWebview = (message, payload) => {
		if (!rpc) {
			logger.warn(
				`[sendToWebview:${label}] RPC not yet initialised; dropping message: ${message}`,
			);
			return;
		}
		try {
			// `rpc.send` is a Proxy<sendFn> from defineElectrobunRPC: both
			// `rpc.send(message, payload)` and `rpc.send.<message>(payload)`
			// dispatch through the same underlying sendFn. Cast to a plain
			// function signature to call it dynamically by name without the
			// schema-typed overloads narrowing the message string.
			(rpc.send as unknown as (m: string, p?: unknown) => void)(
				message,
				payload ?? null,
			);
		} catch (err) {
			logger.warn(
				`[sendToWebview:${label}] send(${message}) failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	rpc = BrowserView.defineRPC<ElizaDesktopRPCSchema>({
		maxRequestTime: MAX_RPC_REQUEST_TIME_MS,
		handlers: {
			requests: buildBunRpcHandlers({ sendToWebview }),
		},
	});

	return { rpc, sendToWebview };
}

/**
 * Wire main-window-only side effects after the BrowserWindow has been
 * constructed with its pre-built RPC.
 *
 * Does NOT register request handlers — those are baked into the rpc by
 * `createDesktopRpc` at construction time. This function only wires
 * post-hoc concerns that need a live `win` and `rpc.request` proxy:
 *
 *   - native module singletons (DesktopManager, AgentManager, …) get
 *     bound to the main window + sendToWebview
 *   - browser workspace's renderer-side caller is set so bun-side tab
 *     code can `rpc.request.browserWorkspaceRendererEvaluate(...)`
 *   - steward sidecar's send-to-webview is wired
 */
function wireMainWindowAfterCreate(
	win: BrowserWindow,
	rpc: ElizaDesktopRpc,
	sendToWebview: SendToWebview,
): void {
	initializeNativeModules(win, sendToWebview);
	setStewardSendToWebview(sendToWebview);
	wireBrowserWorkspaceCaller({
		request: rpc.request as unknown as RpcRequestProxy,
	});
}

/**
 * Wire RPC for a secondary window (e.g. settings) after constructor-time
 * injection. Does NOT call `initializeNativeModules` — that would
 * overwrite the main window reference on DesktopManager and other
 * singletons.
 *
 * This keeps the call site symmetric with the main window even though
 * settings windows don't need most of the wiring.
 */
function wireSettingsRpcAfterCreate(rpc: ElizaDesktopRpc): void {
	wireBrowserWorkspaceCaller({
		request: rpc.request as unknown as RpcRequestProxy,
	});
}

function injectApiBase(win: BrowserWindow): void {
	const runtimeResolution = resolveDesktopRuntimeMode(
		process.env as Record<string, string | undefined>,
	);

	if (runtimeResolution.externalApi.invalidSources.length > 0) {
		logger.warn(
			`[Main] Invalid API base env vars: ${runtimeResolution.externalApi.invalidSources.join(", ")}`,
		);
	}

	if (
		runtimeResolution.mode === "external" &&
		runtimeResolution.externalApi.base
	) {
		apiBaseOwner.notifyChange(
			win,
			runtimeResolution.externalApi.base,
			resolveApiToken(process.env) ?? "",
		);
		setAgentReady(true);
		return;
	}

	const agent = getAgentManager();
	const port = agent.getPort() ?? resolveDesktopApiPort(process.env);
	const apiToken = configureDesktopLocalApiAuth();
	apiBaseOwner.notifyChange(
		win,
		resolveRendererFacingApiBase(
			process.env as Record<string, string | undefined>,
			port,
		),
		apiToken,
	);
	setAgentReady(true);
}

/**
 * Push real OS permission states into the agent REST API so the renderer's
 * PermissionsSection shows correct statuses and capability toggles unlock.
 */
async function syncPermissionsToRestApi(
	port: number,
	startup = false,
): Promise<void> {
	try {
		const permissions = await mergeRuntimePermissionStates(
			port,
			await getPermissionManager().checkAllPermissions(),
		);
		await fetch(`http://127.0.0.1:${port}/api/permissions/state`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ permissions, startup }),
		});
	} catch (err) {
		logger.warn(
			`[Main] Permission sync failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function _startAgent(win: BrowserWindow): Promise<void> {
	const runtimeResolution = resolveDesktopRuntimeMode(
		process.env as Record<string, string | undefined>,
	);

	if (runtimeResolution.mode !== "local") {
		logger.info(
			`[Main] Skipping embedded agent startup (${runtimeResolution.mode} mode)`,
		);
		injectApiBase(win);
		return;
	}

	const agent = getAgentManager();
	recordStartupPhase("autostart_requested", {
		pid: process.pid,
		exec_path: process.execPath,
		bundle_path: resolveStartupBundlePath(process.execPath),
	});

	try {
		const status = await agent.start();

		if (status.state === "running" && status.port) {
			const apiBase = `http://127.0.0.1:${status.port}`;
			const rendererBase = resolveRendererFacingApiBase(
				process.env as Record<string, string | undefined>,
				status.port,
			);
			// Mint or reload the loopback desktop session and install the
			// session+csrf cookies on the webview's cookie jar BEFORE we tell the
			// renderer to start hitting /api. This is the desktop trust path: if
			// the bridge succeeds, the renderer skips the login UI; if it fails,
			// the renderer behaves like a remote browser (password-required).
			await primeDesktopSessionAuth(apiBase, rendererBase);
			const apiToken = resolveApiToken(process.env) ?? "";
			apiBaseOwner.notifyChange(win, rendererBase, apiToken);
			setAgentReady(true);
			// Sync real OS permission states to the REST API so the renderer
			// can display them and capability toggles can unlock.
			// Pass startup=true so the backend skips scheduling a restart for
			// capabilities that are being auto-enabled for the first time.
			syncPermissionsToRestApi(status.port, true);
		}
	} catch (err) {
		logger.error(
			`[Main] Agent start failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function setupUpdater(): Promise<void> {
	const runUpdateCheck = async (notifyOnNoUpdate = false): Promise<void> => {
		try {
			const updaterState = await getDesktopManager().getUpdaterState();
			if (!updaterState.canAutoUpdate) {
				if (updaterState.autoUpdateDisabledReason) {
					logger.info(
						`[Updater] Skipping auto-update check: ${updaterState.autoUpdateDisabledReason}`,
					);
					if (notifyOnNoUpdate) {
						Utils.showNotification({
							title: "Updates Unavailable",
							body: updaterState.autoUpdateDisabledReason,
						});
					}
				}
				return;
			}

			const updateResult = await Updater.checkForUpdate();
			if (updateResult?.updateAvailable) {
				Updater.downloadUpdate().catch((err: unknown) => {
					logger.warn(
						`[Updater] Download failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
				return;
			}

			if (notifyOnNoUpdate) {
				Utils.showNotification({
					title: `${BRAND.appName} Up To Date`,
					body: "You already have the latest release installed.",
				});
			}
		} catch (err) {
			logger.warn(
				`[Updater] Update check failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			if (notifyOnNoUpdate) {
				Utils.showNotification({
					title: "Update Check Failed",
					body: `${BRAND.appName} could not reach the update server.`,
				});
			}
		}
	};

	try {
		// Subscribe to update status changes so we can notify the renderer
		// at the right lifecycle points.
		Updater.onStatusChange((entry: { status: string; message?: string }) => {
			if (entry.status === "update-available") {
				// checkForUpdate found a new version — notify renderer
				const info = Updater.updateInfo();
				sendToActiveRenderer("desktopUpdateAvailable", {
					version: info.version,
				});
			} else if (entry.status === "download-complete") {
				// downloadUpdate finished — update is ready to apply
				const info = Updater.updateInfo();
				sendToActiveRenderer("desktopUpdateReady", { version: info.version });
				Utils.showNotification({
					title: `${BRAND.appName} Update Ready`,
					body: `Version ${info.version} is ready. Restart to apply.`,
				});
			}
		});

		const triggerManualUpdateCheck = () => {
			Utils.showNotification({
				title: "Checking for Updates",
				body: `${BRAND.appName} is checking for a newer release.`,
			});
			void runUpdateCheck(true);
		};

		const handleApplicationMenuAction = async (
			action: string | undefined,
		): Promise<void> => {
			if (!currentWindow && shouldRestoreWindowBeforeMenuAction(action)) {
				await restoreWindow();
			}
			if (action === "check-for-updates") {
				triggerManualUpdateCheck();
			} else if (action === "open-about") {
				const updaterState = await getDesktopManager().getUpdaterState();
				const version = updaterState.currentVersion || "unknown";
				Utils.showNotification({
					title: `About ${BRAND.appName}`,
					body: `Version ${version} (${process.platform}/${process.arch})`,
				});
				void createSettingsWindow("updates");
			} else if (action === "export-config") {
				void exportConfigFromMenu();
			} else if (action === "import-config") {
				void importConfigFromMenu();
			} else if (action === "toggle-devtools") {
				toggleFocusedWindowDevTools();
			} else if (action === "relaunch") {
				void getDesktopManager().relaunch();
			} else if (action === "reset-app") {
				void resetTheAppFromApplicationMenu();
			} else if (action === "open-secrets-manager") {
				// The Secrets Storage modal lives in the renderer. Make sure
				// the main window is visible, then notify the renderer to
				// show the modal. The keyboard accelerator
				// (⌘⌥⌃V on Mac / Ctrl+Alt+Shift+V on Win/Linux) flows
				// through this same path; the renderer's `keydown` listener
				// also dispatches the same toggle directly when a Eliza
				// window is already focused.
				void restoreWindow();
				sendToActiveRenderer("openSecretsManager", {});
			} else if (
				action === "open-settings" ||
				action?.startsWith("open-settings-")
			) {
				void createSettingsWindow(parseSettingsWindowAction(action));
			} else if (action?.startsWith("new-window:")) {
				const surface = action.slice("new-window:".length);
				if (surfaceWindowManager && isDetachedSurface(surface)) {
					void surfaceWindowManager.openSurfaceWindow(surface);
				}
			} else if (action?.startsWith("focus-window:")) {
				const windowId = action.slice("focus-window:".length);
				surfaceWindowManager?.focusWindow(windowId);
			} else if (action?.startsWith("show-main:")) {
				const surface = action.slice("show-main:".length);
				showMainSurface(surface);
			} else if (action === "focus-main-window") {
				void getDesktopManager().focusWindow();
			} else if (action === "hide-main-window") {
				void getDesktopManager().hideWindow();
			} else if (action === "maximize-main-window") {
				void getDesktopManager().maximizeWindow();
			} else if (action === "restore-main-window") {
				void getDesktopManager().unmaximizeWindow();
			} else if (action === "desktop-notify") {
				void getDesktopManager().showNotification({
					title: `${BRAND.appName} Desktop`,
					body: `${BRAND.appName} native application menu actions are wired and responding.`,
					urgency: "normal",
				});
			} else if (action === "restart-steward") {
				if (isStewardLocalEnabled()) {
					restartSteward().catch((err: unknown) => {
						logger.error(
							`[Main] Steward restart failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						Utils.showNotification({
							title: "Steward Restart Failed",
							body: err instanceof Error ? err.message : "Unknown error",
						});
					});
				}
			} else if (action === "reset-steward") {
				if (isStewardLocalEnabled()) {
					resetSteward().catch((err: unknown) => {
						logger.error(
							`[Main] Steward reset failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						Utils.showNotification({
							title: "Steward Reset Failed",
							body: err instanceof Error ? err.message : "Unknown error",
						});
					});
				}
			} else if (
				action?.startsWith("apps:") ||
				action?.startsWith("tray-app-")
			) {
				// Both shapes resolve to the same flow:
				//   1. Look up the app entry by slug.
				//   2. If the app declares hasDetailsPage, focus the main window
				//      and tell the renderer to navigate to /apps/<slug>/details
				//      (where the user can review config + click Launch).
				//   3. Otherwise, open or focus its dedicated native window
				//      directly (zero-config viewers / overlays).
				// WHY two prefixes: `apps:<slug>` is what `buildAppsMenu` emits
				// for the OS menu bar; `tray-app-<slug>` is what the tray icons
				// emit. Both arrive here.
				const slug = action.startsWith("apps:")
					? action.slice("apps:".length)
					: action.slice("tray-app-".length);
				const entry = findAppMenuEntryBySlug(slug);
				if (entry) {
					if (entry.hasDetailsPage) {
						// Restore main window first so the renderer route is visible.
						void restoreWindow();
						sendToActiveRenderer("desktopAppDetailsRequested", {
							slug: entry.slug,
						});
					} else {
						void getDesktopManager().openAppWindow({
							slug: entry.slug,
							title: entry.displayName,
							path: entry.windowPath,
							alwaysOnTop: false,
						});
					}
				}
			} else if (action === "restart-agent") {
				getAgentManager()
					.restart()
					.catch((err: unknown) => {
						logger.error(
							`[Main] Agent restart failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
			} else if (action === "quit") {
				void getDesktopManager().quit();
			} else if (action === "show") {
				void getDesktopManager().showWindow();
			} else if (action?.startsWith("navigate-")) {
				void getDesktopManager().showWindow();
				sendToActiveRenderer("desktopTrayMenuClick", { itemId: action });
			}
		};

		setApplicationMenuActionHandler(handleApplicationMenuAction);

		Electrobun.events.on(
			"application-menu-clicked",
			(e: { data?: { action?: string } }) => {
				void handleApplicationMenuAction(e?.data?.action);
			},
		);

		// Route tray app entries (`tray-app-<slug>`) into the same handler as the
		// OS menu bar. WHY: the desktop manager forwards every tray click to the
		// renderer, but spawning native windows must happen on the bun side.
		Electrobun.events.on(
			"tray-clicked",
			(e: { data?: { action?: string } }) => {
				const action = e?.data?.action;
				if (typeof action === "string" && action.startsWith("tray-app-")) {
					void handleApplicationMenuAction(action);
				}
			},
		);

		Electrobun.events.on("context-menu-clicked", (action: string) => {
			if (action === "check-for-updates") {
				triggerManualUpdateCheck();
			} else if (action === "relaunch") {
				void getDesktopManager().relaunch();
			}
		});

		await runUpdateCheck(false);
	} catch (err) {
		logger.warn(
			`[Updater] Update check failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Handle a `<scheme>://...` deep link. Recognized routes:
 *   - `<scheme>://apps/<slug>` → open or focus the matching app window
 *   - anything else → forward to renderer as a generic share target so
 *     in-app handlers (share-into-chat, etc.) can react.
 *
 * The URL scheme itself is configured at build time (electrobun.config.ts:
 * `urlSchemes`, sourced from `ELIZA_URL_SCHEME`) — this handler does not
 * care which scheme is used; it only routes by host + pathname.
 */
function handleDeepLink(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		sendToActiveRenderer("shareTargetReceived", { url });
		return;
	}

	// `<scheme>://apps/<slug>` → URL parses host="apps", pathname="/<slug>"
	if (parsed.host === "apps") {
		const slug = parsed.pathname
			.replace(/^\/+/, "")
			.replace(/[?#].*$/, "")
			.split("/")[0];
		if (slug) {
			const entry = findAppMenuEntryBySlug(slug);
			if (entry) {
				// Mirror the menu/tray handler: apps with a details page get a config
				// review screen instead of a direct window so deep links and clicks
				// produce identical UX.
				if (entry.hasDetailsPage) {
					void restoreWindow();
					sendToActiveRenderer("desktopAppDetailsRequested", {
						slug: entry.slug,
					});
				} else {
					void getDesktopManager().openAppWindow({
						slug: entry.slug,
						title: entry.displayName,
						path: entry.windowPath,
						alwaysOnTop: false,
					});
				}
				return;
			}
		}
	}

	sendToActiveRenderer("shareTargetReceived", { url });
}

function setupDeepLinks(): void {
	Electrobun.events.on("open-url", (url: string) => {
		handleDeepLink(url);
	});
}

function setupDockReopen(): void {
	Electrobun.events.on("reopen", () => {
		void restoreWindow();
	});
}

async function runShutdownCleanup(reason: string): Promise<void> {
	logger.info(`[Main] App quitting (${reason}), disposing native modules...`);
	isQuitting = true;
	sendToActiveRenderer("desktopShutdownStarted", { reason });
	for (const cleanupFn of cleanupFns) {
		await Promise.resolve(cleanupFn());
	}
	await disposeNativeModules();
}

function setupShutdown(): void {
	Electrobun.events.on("before-quit", () => {
		void runShutdownCleanup("before-quit");
	});
}

/**
 * Load repo-root and ~/.eliza/.env into `process.env` (non-destructive) so the
 * main process can send the same `ELIZA_API_TOKEN` as `dev-server.ts` when
 * calling loopback APIs (app menu reset, export, etc.). The dev API child
 * already loads dotenv; Electrobun did not until this ran.
 *
 * Packaged desktop builds must not load these files. On machines that also
 * have a the app/Eliza dev checkout, ~/.eliza/.env can contain
 * ELIZA_DESKTOP_API_BASE and related overrides that switch the packaged app
 * into external mode and make launcher startup appear dead.
 */
async function loadTheAppEnvFilesForMain(): Promise<void> {
	const normalizedModuleDir = import.meta.dir.replaceAll("\\", "/");
	const isPackagedBuild = !normalizedModuleDir.includes("/src/");
	if (isPackagedBuild) {
		return;
	}

	try {
		const { config } = await import("dotenv");
		const repoRootGuess = path.resolve(
			normalizedModuleDir,
			"..",
			"..",
			"..",
			"..",
		);
		for (const envPath of [
			path.join(repoRootGuess, ".env"),
			path.join(os.homedir(), ".eliza", ".env"),
		]) {
			if (fs.existsSync(envPath)) {
				config({ path: envPath, override: false });
			}
		}
	} catch {
		/* dotenv may be unavailable in minimal installs */
	}
}

function initializeBundledWebGPU(): void {
	if (!WGPU.native.available) {
		logger.info(
			"[WebGPU] Native Dawn runtime not bundled for this run; renderer-side WebGPU remains available through the webview/browser path.",
		);
		return;
	}

	webgpu.install();
	logger.info(`[WebGPU] Native Dawn runtime ready at ${WGPU.native.path}`);
}

/**
 * Check WebGPU availability in the webview browser and push status to renderer.
 *
 * **WHY not inline `os.release() - 9`:** that was wrong on macOS 26 (Darwin 25);
 * see `checkWebGpuSupport` / `getMacOSMajorVersion` in `webgpu-browser-support.ts`
 * and `docs/apps/electrobun-darwin-macos-webgpu-version.md`.
 *
 * On macOS 26+ with native renderer, WebGPU is expected via WKWebView.
 * On Linux/Windows with CEF, upstream Electrobun flag support is still needed.
 */
function checkWebGpuBrowserSupport(): void {
	const status = checkWebGpuSupport();
	if (status.available) {
		logger.info(`[WebGPU Browser] ${status.reason}`);
	} else {
		logger.warn(`[WebGPU Browser] ${status.reason}`);
		if (status.chromeBetaPath) {
			logger.info(
				`[WebGPU Browser] Chrome Beta found at: ${status.chromeBetaPath}`,
			);
		} else if (status.downloadUrl) {
			logger.info(
				`[WebGPU Browser] Download Chrome Beta: ${status.downloadUrl}`,
			);
		}
	}

	// Push status to renderer after a short delay to allow window creation.
	setTimeout(() => {
		sendToActiveRenderer("webgpu:browserStatus", status);
	}, 2000);
}

async function main(): Promise<void> {
	recordStartupPhase("main_start", {
		pid: process.pid,
		exec_path: process.execPath,
		bundle_path: resolveStartupBundlePath(process.execPath),
	});
	await loadTheAppEnvFilesForMain();
	recordStartupPhase("env_loaded", {
		pid: process.pid,
	});
	console.log(`[Main] Starting ${BRAND.appName} (Electrobun)`);
	const normalizedModuleDir = import.meta.dir.replaceAll("\\", "/");
	const runtimeResolution = resolveDesktopRuntimeMode(
		process.env as Record<string, string | undefined>,
	);
	// Structured startup environment block — visible in CI logs and eliza-startup.log
	console.log(
		`[Env] platform=${process.platform} arch=${process.arch} bun=${Bun.version} ` +
			`execPath=${process.execPath} cwd=${process.cwd()} moduleDir=${import.meta.dir} ` +
			`packaged=${!normalizedModuleDir.includes("/src/")} argv=${process.argv.slice(1).join(" ")}`,
	);
	console.log(
		`[Env] desktopRuntimeMode=${runtimeResolution.mode} externalApi=${runtimeResolution.externalApi.base ?? "none"}`,
	);

	printElectrobunDevSettingsBanner(
		process.env as Record<string, string | undefined>,
	);

	await maybePromptStartupCrashReport();
	recordStartupPhase("crash_prompt_checked", {
		pid: process.pid,
	});
	// On Windows (CEF renderer), clear stale CEF profile data when the app
	// version changes.  A leftover Partitions/default profile from a previous
	// install causes "Cannot create profile at path" errors that cascade into
	// GPU process crashes, rendering the UI unusable.  Clearing the CEF cache
	// is safe — it only contains browser session state (cookies, caches,
	// LevelDB stores) that CEF recreates on next launch.
	if (process.platform === "win32") {
		try {
			const cefDir = path.join(Utils.paths.userData, "CEF");
			const cefVersionMarker = path.join(
				cefDir,
				BRAND.cefVersionMarkerFileName,
			);
			const currentVersion =
				resolveDesktopBundleVersion(import.meta.dir) ?? "unknown";
			let previousVersion: string | null = null;
			try {
				previousVersion = fs.readFileSync(cefVersionMarker, "utf-8").trim();
			} catch {
				// No marker — first run or pre-fix install.
			}
			if (
				shouldResetWindowsCefProfile({
					currentVersion,
					previousVersion,
					cefDirExists: fs.existsSync(cefDir),
				})
			) {
				logger.info(
					`[Main] CEF version mismatch (${previousVersion ?? "none"} → ${currentVersion}), clearing stale CEF profile`,
				);
				// Remove everything except the version marker we're about to write.
				for (const entry of fs.readdirSync(cefDir)) {
					if (entry === BRAND.cefVersionMarkerFileName) continue;
					const entryPath = path.join(cefDir, entry);
					try {
						fs.rmSync(entryPath, { recursive: true, force: true });
					} catch (err) {
						logger.warn(
							`[Main] Could not remove ${entryPath}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
			// Write/update version marker so we don't clear again on next launch.
			if (shouldWriteWindowsCefProfileMarker(currentVersion)) {
				fs.mkdirSync(cefDir, { recursive: true });
				fs.writeFileSync(cefVersionMarker, currentVersion);
			}
		} catch (err) {
			logger.warn(
				`[Main] CEF profile cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	initializeBundledWebGPU();
	recordStartupPhase("webgpu_initialized", {
		pid: process.pid,
	});
	checkWebGpuBrowserSupport();
	cleanupFns.length = 0;
	cleanupFns.push(await startBrowserWorkspaceBridgeServer());
	recordStartupPhase("browser_workspace_bridge_ready", {
		pid: process.pid,
	});
	const stopDesktopTestBridgeServer = await startDesktopTestBridgeServer();
	recordStartupPhase("desktop_test_bridge_ready", {
		pid: process.pid,
	});
	if (stopDesktopTestBridgeServer) {
		cleanupFns.push(stopDesktopTestBridgeServer);
	}

	// WHY push API base on every status tick with a port: embedded startup can
	// settle on a different loopback port than env/static HTML (allocation + stdout).
	// Detached surfaces must not keep a stale __ELIZA_API_BASE__ while the main
	// window was already updated—menu reset, chat, and settings each own a webview.
	cleanupFns.push(
		getAgentManager().onStatusChange((status) => {
			if (status.port) {
				// The agent rebound to a different loopback port (or recovered from a
				// crash) — the cookies we installed during _startAgent were scoped to
				// the old origin. Re-prime so the renderer's next /api request stays
				// authenticated.
				markDesktopSessionStale();
				const apiBase = `http://127.0.0.1:${status.port}`;
				const rendererBase = resolveRendererFacingApiBase(
					process.env as Record<string, string | undefined>,
					status.port,
				);
				void primeDesktopSessionAuth(apiBase, rendererBase);
				if (currentWindow) {
					injectApiBase(currentWindow);
				}
				surfaceWindowManager?.forEachWindow((w) => {
					injectApiBase(w as BrowserWindow);
				});
			}
		}),
	);

	// Create window first — on Windows (CEF) the UI message loop must be
	// running before any synchronous FFI calls like setApplicationMenu().
	// Calling setupApplicationMenu() before createMainWindow() deadlocks.
	recordStartupPhase("creating_window", {
		pid: process.pid,
	});
	const { rpc: mainRpc, sendToWebview: mainSendToWebview } =
		createDesktopRpc("main");
	const mainWin = attachMainWindow(
		await createMainWindow(mainRpc),
		mainRpc,
		mainSendToWebview,
	);
	recordStartupPhase("window_ready", {
		pid: process.pid,
	});

	// Configure the floating chat manager now that the renderer URL is resolved.
	// This must run after createMainWindow() so rendererUrlPromise is already set.
	void resolveRendererUrl().then((url) => {
		let preload = "";
		try {
			preload = readResolvedPreloadScript(import.meta.dir);
		} catch {
			/* non-fatal */
		}
		getFloatingChatManager().configure(url, preload);
	});

	// Per-window RPC tracking: surface windows each get their own typed
	// RPC built up front via createDesktopRpc, baked into the BrowserWindow
	// constructor, then "wired" post-hoc by wireSettingsRpcAfterCreate.
	const surfaceRpcs = new WeakMap<ManagedWindowLike, ElizaDesktopRpc>();

	surfaceWindowManager = new SurfaceWindowManager({
		createWindow: (options) => {
			const { rpc } = createDesktopRpc("surface");
			const window = new BrowserWindow({
				...options,
				rpc,
			}) as BrowserWindow & ManagedWindowLike;
			surfaceRpcs.set(window, rpc);
			return window;
		},
		resolveRendererUrl,
		readPreload: () => readResolvedPreloadScript(import.meta.dir),
		wireRpc: (window) => {
			const rpc = surfaceRpcs.get(window);
			if (!rpc) {
				logger.warn(
					"[surface-windows] wireRpc called for window with no tracked rpc; skipping browser-workspace caller setup",
				);
				return;
			}
			wireSettingsRpcAfterCreate(rpc);
		},
		injectApiBase: (window) =>
			injectApiBase(window as BrowserWindow & ManagedWindowLike),
		onWindowFocused: (window) => {
			lastFocusedWindow = window;
		},
		onRegistryChanged: () => {
			sendManagedWindowsChanged();
			setupApplicationMenu();
		},
		boundsStore: createAppWindowBoundsStore(),
	});
	// Set up app menu after the window (and its message loop) exists.
	setupApplicationMenu();
	const stopScreenshotDevServer = startScreenshotDevServer();
	if (stopScreenshotDevServer) {
		cleanupFns.push(stopScreenshotDevServer);
	}

	// Wire detached window callbacks so menus and RPC can open them.
	getDesktopManager().setOpenSettingsCallback((tabHint) => {
		void createSettingsWindow(tabHint);
	});
	getDesktopManager().setRestoreMainWindowCallback(() => restoreWindow());
	getDesktopManager().setRequestQuitCallback(() => {
		requestAppQuit();
	});
	getDesktopManager().setOpenSurfaceWindowCallback(
		(surface, browse, alwaysOnTop) => {
			if (!surfaceWindowManager) {
				throw new Error("Surface window manager is not ready.");
			}
			return surfaceWindowManager.openSurfaceWindow(
				surface,
				browse,
				alwaysOnTop === true,
			);
		},
	);
	getDesktopManager().setOpenAppWindowCallback((options) => {
		if (!surfaceWindowManager) {
			throw new Error("Surface window manager is not ready.");
		}
		return surfaceWindowManager.openAppWindow(options);
	});
	getDesktopManager().setManagedWindowAlwaysOnTopCallback((id, flag) => {
		return surfaceWindowManager?.setWindowAlwaysOnTop(id, flag) ?? false;
	});

	// If launched with --hidden (e.g. auto-launch with openAsHidden), minimize immediately.
	if (process.argv.includes("--hidden")) {
		try {
			mainWin.minimize();
		} catch (err) {
			logger.warn(
				`[Main] Failed to minimize window on --hidden startup: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	setupDeepLinks();
	setupDockReopen();

	const desktop = getDesktopManager();
	try {
		await desktop.createTray({
			icon: resolveDesktopAppIconPath(),
			tooltip: BRAND.appName,
			title: BRAND.appName,
			menu: [
				{ id: "tray-show-window", label: "Show Window", type: "normal" },
				{ id: "sep-apps", type: "separator" },
				// One entry per known app — clicks dispatch to handleApplicationMenuAction
				// via the bun-side `tray-clicked` listener below, which then opens (or
				// focuses) the dedicated native window for that app.
				...getAppMenuEntries().map((entry) => ({
					id: `tray-app-${entry.slug}`,
					label: entry.displayName,
					type: "normal" as const,
				})),
				{ id: "sep-lifecycle", type: "separator" },
				{
					id: "tray-toggle-lifecycle",
					label: "Start/Stop Agent",
					type: "normal",
				},
				{
					id: "tray-restart",
					label: "Restart Agent",
					type: "normal",
				},
				{ id: "sep-quit", type: "separator" },
				{ id: "quit", label: "Quit", type: "normal" },
			],
		});
	} catch (err) {
		logger.warn(
			`[Main] Tray creation failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// ── Steward sidecar startup (must happen BEFORE agent) ────────────
	// When STEWARD_LOCAL=true, start the steward sidecar first so it can
	// set STEWARD_API_URL / STEWARD_AGENT_TOKEN env vars. The the app agent's
	// steward-bridge.ts reads these on boot to discover local steward.
	if (isStewardLocalEnabled()) {
		logger.info("[Main] STEWARD_LOCAL=true — starting steward sidecar...");
		cleanupFns.push(() => stopSteward());

		// Listen for steward status changes and push to renderer
		cleanupFns.push(
			onStewardStatusChange((status) => {
				sendToActiveRenderer("stewardStatusUpdate", status);
			}),
		);

		try {
			const stewardResult = await startSteward();
			if (stewardResult.state === "running") {
				logger.info(
					`[Main] Steward sidecar ready on port ${stewardResult.port}, wallet: ${stewardResult.walletAddress ?? "pending"}`,
				);
			} else {
				logger.warn(
					`[Main] Steward sidecar in state "${stewardResult.state}": ${stewardResult.error ?? "unknown"}`,
				);
				sendToActiveRenderer("stewardStartupFailed", {
					error: stewardResult.error ?? "Steward failed to start",
					canRetry: true,
				});
			}
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			logger.error(`[Main] Steward sidecar startup failed: ${error}`);
			sendToActiveRenderer("stewardStartupFailed", {
				error,
				canRetry: true,
			});
			// Don't block agent startup — steward is optional
		}
	}

	// Agent startup: in external mode, push the API base via the
	// api-base-owner (the agent is already running externally). In local
	// mode, start the embedded agent first — apiBaseOwner.injectIntoHtml()
	// already set the initial window.__ELIZA_API_BASE__ from the seed value
	// in main(), but _startAgent will push the actual port once the agent
	// reports it.
	if (currentWindow) {
		const rt = resolveDesktopRuntimeMode(
			process.env as Record<string, string | undefined>,
		);
		if (rt.mode === "external") {
			injectApiBase(currentWindow);
		} else if (rt.mode === "local") {
			logger.info("[Main] Starting embedded agent (local mode).");
			_startAgent(currentWindow).catch((err) => {
				logger.error(
					`[Main] Agent auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				const error = err instanceof Error ? err.message : String(err);
				sendToActiveRenderer("agentStartupFailed", { error });
				console.error(`title: "${BRAND.appName} startup failed"`);
			});
		}
	}

	void setupUpdater();
	cleanupFns.push(() => getAgentManager().stop());
	setupShutdown();
}

function resolveStartupCrashReportPath(): string {
	return path.join(
		path.dirname(getDiagnosticLogPath()),
		STARTUP_CRASH_REPORT_FILE,
	);
}

function resolveStartupCrashPromptMarkerPath(): string {
	return path.join(
		path.dirname(getDiagnosticLogPath()),
		STARTUP_CRASH_PROMPT_MARKER_FILE,
	);
}

function buildStartupCrashDiscordReport(options: {
	source: "startup-recovery" | "fatal-startup";
	error: string | null;
}): string {
	const diagnostics = getStartupDiagnosticsSnapshot();
	const startupLogTail = getStartupDiagnosticLogTail(8_000).trim();
	const appVersion = process.env.npm_package_version?.trim() || "unknown";
	const appRuntime = `electrobun/${Bun.version}`;
	const reportLines = [
		`${BRAND.appName} startup crash report`,
		"",
		"Share this report in Discord and ping @iono.",
		"",
		`Source: ${options.source}`,
		`Timestamp: ${new Date().toISOString()}`,
		`App Version: ${appVersion}`,
		`Runtime: ${appRuntime}`,
		`Platform: ${process.platform} ${process.arch}`,
		`State: ${diagnostics.state}`,
		`Phase: ${diagnostics.phase}`,
		`Last Error: ${options.error ?? diagnostics.lastError ?? "unknown"}`,
		`Updated At: ${diagnostics.updatedAt}`,
		`Log Path: ${diagnostics.logPath}`,
		`Status Path: ${diagnostics.statusPath}`,
		"",
		startupLogTail ? "Startup Log Tail:" : "Startup Log Tail: unavailable",
	];

	if (startupLogTail) {
		reportLines.push("```");
		reportLines.push(startupLogTail);
		reportLines.push("```");
	}
	return `${reportLines.join("\n")}\n`;
}

function persistStartupCrashReport(options: {
	source: "startup-recovery" | "fatal-startup";
	error: string | null;
}): { report: string; reportPath: string } {
	const report = buildStartupCrashDiscordReport(options);
	const primaryReportPath = resolveStartupCrashReportPath();
	const fallbackReportPath = path.join(os.tmpdir(), STARTUP_CRASH_REPORT_FILE);
	let reportPath = primaryReportPath;
	try {
		fs.mkdirSync(path.dirname(primaryReportPath), { recursive: true });
		fs.writeFileSync(primaryReportPath, report, "utf8");
	} catch (err) {
		logger.warn(
			`[Main] Failed to write startup crash report: ${err instanceof Error ? err.message : String(err)}`,
		);
		try {
			fs.mkdirSync(path.dirname(fallbackReportPath), { recursive: true });
			fs.writeFileSync(fallbackReportPath, report, "utf8");
			reportPath = fallbackReportPath;
		} catch (fallbackErr) {
			logger.warn(
				`[Main] Failed to write fallback startup crash report: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
			);
		}
	}
	return { report, reportPath };
}

function wasStartupCrashAlreadyPrompted(updatedAt: string): boolean {
	try {
		const markerPath = resolveStartupCrashPromptMarkerPath();
		return fs.readFileSync(markerPath, "utf8").trim() === updatedAt;
	} catch {
		return false;
	}
}

function markStartupCrashPrompted(updatedAt: string): void {
	try {
		fs.writeFileSync(resolveStartupCrashPromptMarkerPath(), updatedAt, "utf8");
	} catch {}
}

async function maybePromptStartupCrashReport(): Promise<void> {
	if (
		process.env.ELIZA_DESKTOP_SKIP_STARTUP_CRASH_PROMPT === "1" ||
		process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS === "1"
	) {
		return;
	}

	const diagnostics = getStartupDiagnosticsSnapshot();
	const looksLikeStartupFailure =
		diagnostics.state === "error" &&
		diagnostics.phase !== "ready" &&
		diagnostics.phase !== "stopped";
	if (!looksLikeStartupFailure) {
		return;
	}
	if (wasStartupCrashAlreadyPrompted(diagnostics.updatedAt)) {
		return;
	}

	const { report, reportPath } = persistStartupCrashReport({
		source: "startup-recovery",
		error: diagnostics.lastError,
	});
	markStartupCrashPrompted(diagnostics.updatedAt);

	const dialog = await Utils.showMessageBox({
		type: "warning",
		title: `${BRAND.appName} recovered after a startup failure`,
		message:
			"The previous launch failed. A crash report is ready to share with support.",
		detail:
			"Choose Copy Report, paste into Discord, and ping @iono. You can also open logs.",
		buttons: ["Copy Report", "Open Logs Folder", "Continue"],
		defaultId: 0,
		cancelId: 2,
	});
	const response =
		dialog && typeof dialog === "object" && "response" in dialog
			? (dialog as { response: number }).response
			: typeof dialog === "number"
				? dialog
				: 2;

	if (response === 0) {
		try {
			Utils.clipboardWriteText(report);
			Utils.showNotification({
				title: "Crash report copied",
				body: "Paste in Discord and ping @iono.",
			});
		} catch (err) {
			logger.warn(
				`[Main] Failed to copy startup crash report: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (response === 1) {
		try {
			Utils.openPath(path.dirname(reportPath));
		} catch (err) {
			logger.warn(
				`[Main] Failed to open startup logs folder: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

main().catch((err) => {
	const msg = `[Main] Fatal error during startup: ${err?.stack ?? err}`;
	console.error(msg);
	recordStartupPhase("fatal", {
		pid: process.pid,
		exec_path: process.execPath,
		bundle_path: resolveStartupBundlePath(process.execPath),
		error: err instanceof Error ? err.stack || err.message : String(err),
	});
	persistStartupCrashReport({
		source: "fatal-startup",
		error: msg,
	});
	recordStartupPhase("fatal", {
		pid: process.pid,
		exec_path: process.execPath,
		bundle_path: resolveStartupBundlePath(process.execPath),
		error: err instanceof Error ? err.stack || err.message : String(err),
	});
	// Write to startup log so it's visible even without a console
	try {
		const logPath = getDiagnosticLogPath();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
		fs.writeFileSync(
			getStartupStatusPath(),
			`${JSON.stringify(
				{
					state: "error",
					phase: "fatal_startup",
					updatedAt: new Date().toISOString(),
					lastError: msg,
					platform: process.platform,
					arch: process.arch,
					logPath,
					statusPath: getStartupStatusPath(),
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
	} catch {}
	void runShutdownCleanup("fatal-startup").finally(shutdownAfterFatalError);
});

import { shutdownAfterFatalError } from "./fatal-shutdown";

export { shutdownAfterFatalError };
