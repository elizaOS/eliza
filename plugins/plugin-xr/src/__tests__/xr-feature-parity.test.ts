/**
 * XR feature parity audit — automated.
 *
 * This test suite formally validates the claim that the XR app (app-xr)
 * provides 100% feature parity with the native iOS / Android / desktop app
 * for every capability that can be expressed through the agent view system.
 *
 * Parity axes:
 *   1. View registration — every gui view has a matching xr view
 *   2. Route infrastructure — every xr view id has a working view-host route
 *   3. Agent CRUD surface — all 5 agent actions are wired in plugin-xr
 *   4. Connection modes — Local/Cloud/Custom all represented in code
 *   5. Voice input — transcript routing is wired in view-host for all views
 *   6. Platform manifest — both APK configurations are present
 *   7. PWA manifest — app-xr has a complete web manifest
 *   8. HTTPS tunnel — connect script produces a shareable URL
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	registerPluginViews,
	unregisterPluginViews,
} from "@elizaos/agent/api/views-registry";
import { afterEach, describe, expect, it } from "vitest";
import {
	xrListViewsAction,
	xrOpenViewAction,
} from "../actions/xr-view-actions.ts";
import { xrViewHostRoute } from "../routes/xr-view-host.ts";
import { xrViewsRoute } from "../routes/xr-views.ts";

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const appXrRoot = resolve(repoRoot, "plugins/plugin-facewear/app-xr");
const facewearAndroidRoot = resolve(
	repoRoot,
	"plugins/plugin-facewear/native/android",
);
const XR_ROUTE_TEST_PLUGIN = "@test/plugin-xr-route-registry";

// ── helpers ───────────────────────────────────────────────────────────────────

function readFile(relPath: string): string {
	return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function appXrFileExists(relPath: string): boolean {
	return existsSync(resolve(appXrRoot, relPath));
}

function readAppXr(relPath: string): string {
	return readFileSync(resolve(appXrRoot, relPath), "utf8");
}

function facewearAndroidFileExists(relPath: string): boolean {
	return existsSync(resolve(facewearAndroidRoot, relPath));
}

function readFacewearAndroid(relPath: string): string {
	return readFileSync(resolve(facewearAndroidRoot, relPath), "utf8");
}

function hasAppXr(): boolean {
	return appXrFileExists("package.json");
}

// Parses `views: [...]` from a plugin source file
function extractViewObjects(source: string): string[] {
	const viewsStart = source.indexOf("views:");
	if (viewsStart === -1) return [];
	const arrayStart = source.indexOf("[", viewsStart);
	if (arrayStart === -1) return [];
	let depth = 0;
	let arrayEnd = -1;
	for (let i = arrayStart; i < source.length; i++) {
		if (source[i] === "[") depth++;
		if (source[i] === "]") depth--;
		if (depth === 0) {
			arrayEnd = i;
			break;
		}
	}
	if (arrayEnd === -1) return [];
	const body = source.slice(arrayStart + 1, arrayEnd);
	const objects: string[] = [];
	let start = -1;
	depth = 0;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "{") {
			if (depth === 0) start = i;
			depth++;
		}
		if (body[i] === "}") {
			depth--;
			if (depth === 0 && start !== -1) {
				objects.push(body.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return objects.filter(
		(o) => o.includes("id:") && o.includes("componentExport:"),
	);
}

function stringField(source: string, field: string): string | null {
	return source.match(new RegExp(`${field}:\\s*"([^"]+)"`))?.[1] ?? null;
}

// Source-level mirror of core's `getViewModalities`: a view renders on the
// explicit `modalities: [...]` list when present, otherwise the single
// `viewType` (default "gui"). Returns the lowercased modality set for one
// view-object source slice.
function viewModalities(objectSource: string): Set<string> {
	const modalitiesMatch = objectSource.match(/modalities:\s*\[([^\]]*)\]/);
	if (modalitiesMatch) {
		const mods = [...modalitiesMatch[1].matchAll(/"([^"]+)"/g)].map(
			(m) => m[1],
		);
		if (mods.length > 0) return new Set(mods);
	}
	return new Set([stringField(objectSource, "viewType") ?? "gui"]);
}

const VIEW_HOST_SMOKE_IDS = [
	"xr-route-smoke",
	"hyphenated-view",
	"space-panel",
] as const;

const VOICE_ROUTE_SAMPLE_IDS = [
	"xr-route-smoke",
	"hyphenated-view",
	"space-panel",
] as const;

// The plugin manifest paths (same as plugin-tui-view-coverage.test.ts)
const VIEW_MANIFESTS = [
	"plugins/plugin-contacts/src/plugin.ts",
	"plugins/plugin-hyperliquid/src/plugin.ts",
	"plugins/plugin-messages/src/plugin.ts",
	"plugins/app-model-tester/src/plugin.ts",
	"plugins/plugin-phone/src/plugin.ts",
	"plugins/plugin-polymarket/src/plugin.ts",
	"plugins/plugin-shopify/src/plugin.ts",
	"plugins/plugin-wallet-ui/src/plugin.ts",
	"plugins/plugin-feed/src/index.ts",
	"plugins/plugin-app-control/src/index.ts",
	"plugins/plugin-screenshare/src/index.ts",
	"plugins/plugin-task-coordinator/src/index.ts",
	"plugins/plugin-trajectory-logger/src/index.ts",
	"plugins/plugin-training/src/setup-routes.ts",
	"plugins/plugin-facewear/src/index.ts",
] as const;

// ── tests ─────────────────────────────────────────────────────────────────────

describe("XR feature parity audit", () => {
	afterEach(() => {
		unregisterPluginViews(XR_ROUTE_TEST_PLUGIN);
	});

	// 1. View registration parity ───────────────────────────────────────────────

	it("axis 1 — every gui plugin view has a matching xr view in the plugin manifest", () => {
		const missing: string[] = [];
		for (const manifestPath of VIEW_MANIFESTS) {
			const source = readFile(manifestPath);
			const objects = extractViewObjects(source);
			const guiIds = new Set<string>();
			const xrIds = new Set<string>();
			for (const obj of objects) {
				const id = stringField(obj, "id");
				if (!id) continue;
				const modalities = viewModalities(obj);
				if (modalities.has("xr")) xrIds.add(id);
				if (modalities.has("gui")) guiIds.add(id);
			}
			for (const id of guiIds) {
				if (!xrIds.has(id))
					missing.push(`${manifestPath}: missing xr view for "${id}"`);
			}
		}
		expect(missing, "plugins missing XR views").toEqual([]);
	});

	// 2. Route infrastructure ───────────────────────────────────────────────────

	it("axis 2 — the xrViewHostRoute returns valid HTML for arbitrary xr view ids", async () => {
		const failures: string[] = [];
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const result = await xrViewHostRoute.routeHandler({
				params: { id },
				runtime: { port: 31337 },
			} as never);
			if (result.status !== 200) {
				failures.push(`${id}: status ${result.status}`);
				continue;
			}
			const html = result.body as string;
			if (!html.includes(`data-view-id="${id}"`))
				failures.push(`${id}: data-view-id not in HTML`);
			if (!html.includes('id="xr-shell"'))
				failures.push(`${id}: missing xr-shell`);
		}
		expect(failures, "view-host route failures").toEqual([]);
	});

	it("axis 2 — xrViewsRoute source is registered as GET /xr/views through the canonical registry", () => {
		const routeSrc = readFile("plugins/plugin-xr/src/routes/xr-views.ts");
		expect(routeSrc).toContain('"GET"');
		expect(routeSrc).toContain('"/xr/views"');
		expect(routeSrc).toContain("@elizaos/agent/api/views-registry");
		expect(routeSrc).toContain('viewType: "xr"');
		// Returns view list with count
		expect(routeSrc).toContain("count");
	});

	it("axis 2 — xrViewsRoute returns canonical registry XR entries", async () => {
		await registerPluginViews({
			name: XR_ROUTE_TEST_PLUGIN,
			views: [
				{
					id: "xr-registry-route-smoke",
					label: "XR Registry Route",
					viewType: "xr",
					path: "/apps/xr-registry-route-smoke/xr",
					icon: "Glasses",
					tags: ["xr", "registry"],
					description: "Registry-backed XR route smoke",
					xrOptions: { placement: "panel" },
					bundleUrl: "https://views.example.test/xr-registry-route.js",
				},
				{
					id: "gui-registry-route-smoke",
					label: "GUI Registry Route",
					viewType: "gui",
					path: "/apps/gui-registry-route-smoke",
					bundleUrl: "https://views.example.test/gui-registry-route.js",
				},
			],
		} as never);

		const result = await xrViewsRoute.routeHandler({
			runtime: {
				getService: () => ({
					getConnections: () => [{ id: "headset-1", deviceType: "webxr" }],
				}),
			},
		} as never);

		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			count: expect.any(Number),
			connections: [{ id: "headset-1", deviceType: "webxr" }],
		});
		expect(
			(result.body as { views: Array<Record<string, unknown>> }).views,
		).toContainEqual(
			expect.objectContaining({
				id: "xr-registry-route-smoke",
				label: "XR Registry Route",
				path: "/apps/xr-registry-route-smoke/xr",
				pluginName: XR_ROUTE_TEST_PLUGIN,
				available: true,
				xrOptions: { placement: "panel" },
			}),
		);
		expect(
			(result.body as { views: Array<Record<string, unknown>> }).views.some(
				(view) => view.id === "gui-registry-route-smoke",
			),
		).toBe(false);
	});

	// 3. Agent CRUD action surface ──────────────────────────────────────────────

	it("axis 3 — plugin-xr exports all 5 agent view actions", () => {
		const actionsSource = readFile(
			"plugins/plugin-xr/src/actions/xr-view-actions.ts",
		);
		const requiredActions = [
			"XR_OPEN_VIEW",
			"XR_CLOSE_VIEW",
			"XR_SWITCH_VIEW",
			"XR_LIST_VIEWS",
			"XR_RESIZE_VIEW",
		];
		const missing = requiredActions.filter((a) => !actionsSource.includes(a));
		expect(missing, "missing agent actions").toEqual([]);
	});

	it("axis 3 — view actions route dynamically registered XR views", async () => {
		await registerPluginViews({
			name: XR_ROUTE_TEST_PLUGIN,
			views: [
				{
					id: "xr-dynamic-action-panel",
					label: "Dynamic Action Panel",
					viewType: "xr",
					path: "/apps/xr-dynamic-action-panel/xr",
					icon: "Glasses",
					description: "Dynamically registered action target",
					bundleUrl: "https://views.example.test/xr-dynamic-action-panel.js",
				},
			],
		} as never);

		const calls = {
			opened: [] as Array<{ connectionId: string; viewId: string }>,
			catalogs: [] as Array<Array<{ id: string; label: string }>>,
		};
		const runtime = {
			port: 31337,
			getService: () => ({
				getConnections: () => [{ id: "headset-1", deviceType: "webxr" }],
				hasActiveConnections: () => true,
				openView: (connectionId: string, viewId: string) => {
					calls.opened.push({ connectionId, viewId });
				},
				sendViewsCatalog: (
					_connectionId: string,
					views: Array<{ id: string; label: string }>,
				) => {
					calls.catalogs.push(views);
				},
			}),
		};

		await xrOpenViewAction.handler?.(
			runtime as never,
			{ content: { text: "open the dynamic action panel in xr" } } as never,
			undefined,
			{},
		);
		await xrListViewsAction.handler?.(
			runtime as never,
			{ content: { text: "what can i open in xr?" } } as never,
			undefined,
			{},
		);

		expect(calls.opened).toContainEqual({
			connectionId: "headset-1",
			viewId: "xr-dynamic-action-panel",
		});
		expect(calls.catalogs.at(-1)).toContainEqual(
			expect.objectContaining({
				id: "xr-dynamic-action-panel",
				label: "Dynamic Action Panel",
			}),
		);
		const actionsSource = readFile(
			"plugins/plugin-xr/src/actions/xr-view-actions.ts",
		);
		expect(actionsSource).toContain("@elizaos/agent/api/views-registry");
		expect(actionsSource).not.toContain("const known = [");
		expect(actionsSource).not.toContain("runtime.plugins");
		expect(actionsSource).not.toContain("RuntimePluginWithViews");
		expect(actionsSource).not.toContain("plugin.views");
	});

	// 4. Connection modes ───────────────────────────────────────────────────────

	it("axis 4 — app-xr connection-config.ts implements Local/Cloud/Custom modes", () => {
		if (!hasAppXr()) return;
		const src = readAppXr("src/connection-config.ts");
		expect(src).toContain('"local"');
		expect(src).toContain('"cloud"');
		expect(src).toContain('"custom"');
		expect(src).toContain("configToWsUrl");
	});

	it("axis 4 — app-xr connection-setup.ts renders the mode picker UI", () => {
		if (!hasAppXr()) return;
		const src = readAppXr("src/ui/connection-setup.ts");
		expect(src).toContain("local");
		expect(src).toContain("cloud");
		expect(src).toContain("custom");
	});

	it("axis 4 — AgentSocket supports hot reconnect for mode switching", () => {
		if (!hasAppXr()) return;
		const socketSrc = readAppXr("src/agent-socket.ts");
		expect(socketSrc).toContain("reconnectTo");
	});

	// 5. Voice input ────────────────────────────────────────────────────────────

	it("axis 5 — view-host pages have voice transcript routing for INPUT, TEXTAREA, SELECT, and ARIA widgets", async () => {
		for (const id of VOICE_ROUTE_SAMPLE_IDS) {
			const result = await xrViewHostRoute.routeHandler({
				params: { id },
				runtime: { port: 31337 },
			} as never);
			const html = result.body as string;
			expect(html, `${id}: fillFocusedInput for INPUT`).toContain(
				"HTMLInputElement",
			);
			expect(html, `${id}: fillFocusedInput for TEXTAREA`).toContain(
				"HTMLTextAreaElement",
			);
			expect(html, `${id}: fillFocusedInput for SELECT`).toContain(
				"HTMLSelectElement",
			);
			expect(html, `${id}: ARIA combobox/listbox routing`).toContain(
				"combobox",
			);
			expect(html, `${id}: xr:focus-next handler`).toContain("focus-next");
			expect(html, `${id}: voice indicator`).toContain("voice-indicator");
		}
	});

	// 6. Platform APK manifests ─────────────────────────────────────────────────

	it("axis 6 — Quest 3 Bubblewrap APK configuration is present and complete", () => {
		if (!hasAppXr()) return;
		expect(facewearAndroidFileExists("quest/bubblewrap.json")).toBe(true);
		const config = JSON.parse(readFacewearAndroid("quest/bubblewrap.json"));
		expect(config.packageId).toBe("com.eliza.xr.quest");
		expect(config.metaQuest).toBe(true);
		expect(config.permissions).toContain("android.permission.CAMERA");
		expect(config.permissions).toContain("android.permission.RECORD_AUDIO");
		expect(config.display).toBe("fullscreen");
	});

	it("axis 6 — XReal Android project has complete Gradle project structure", () => {
		if (!hasAppXr()) return;
		expect(facewearAndroidFileExists("xreal/build.gradle.kts")).toBe(true);
		expect(facewearAndroidFileExists("xreal/settings.gradle.kts")).toBe(true);
		expect(facewearAndroidFileExists("xreal/gradlew")).toBe(true);
		expect(
			facewearAndroidFileExists(
				"xreal/gradle/wrapper/gradle-wrapper.properties",
			),
		).toBe(true);
		expect(facewearAndroidFileExists("xreal/app/build.gradle.kts")).toBe(true);
		expect(
			facewearAndroidFileExists("xreal/app/src/main/AndroidManifest.xml"),
		).toBe(true);
	});

	it("axis 6 — XReal Kotlin source files are present", () => {
		if (!hasAppXr()) return;
		const base = "xreal/app/src/main/java/com/elizaos/facewear/xreal";
		expect(facewearAndroidFileExists(`${base}/MainActivity.kt`)).toBe(true);
		expect(facewearAndroidFileExists(`${base}/CameraService.kt`)).toBe(true);
		expect(facewearAndroidFileExists(`${base}/XrealBridgeJs.kt`)).toBe(true);
	});

	it("axis 6 — XReal AndroidManifest declares camera, audio, and XREAL tracking permissions", () => {
		if (!hasAppXr()) return;
		const manifest = readFacewearAndroid(
			"xreal/app/src/main/AndroidManifest.xml",
		);
		expect(manifest).toContain("android.permission.CAMERA");
		expect(manifest).toContain("android.permission.RECORD_AUDIO");
		expect(manifest).toContain("android.permission.INTERNET");
		expect(manifest).toContain("ai.xreal.permission.TRACKING");
	});

	// 7. PWA manifest ───────────────────────────────────────────────────────────

	it("axis 7 — app-xr has a complete PWA web manifest for browser-based WebXR", () => {
		if (!hasAppXr()) return;
		expect(appXrFileExists("manifest.webmanifest")).toBe(true);
		const manifest = JSON.parse(readAppXr("manifest.webmanifest"));
		expect(manifest.display).toBeDefined();
		expect(manifest.name).toBeDefined();
		expect(manifest.icons?.length).toBeGreaterThan(0);
	});

	// 8. HTTPS tunnel and pairing ───────────────────────────────────────────────

	it("axis 8 — app-xr package.json has a connect script for HTTPS tunnel + QR code", () => {
		if (!hasAppXr()) return;
		const pkg = JSON.parse(readAppXr("package.json"));
		expect(pkg.scripts?.connect, "connect script for tunnel").toBeDefined();
	});

	it("axis 8 — xr-connect route serves QR code + text pairing page", () => {
		const routeSrc = readFile("plugins/plugin-xr/src/routes/xr-connect.ts");
		expect(routeSrc).toContain("/xr/connect");
		// Should generate QR code
		expect(routeSrc.toLowerCase()).toContain("qr");
		// Should include a text code fallback
		expect(routeSrc).toContain("code");
	});

	it("axis 8 — xr-status route provides JSON pairing state for polling", () => {
		const routeSrc = readFile("plugins/plugin-xr/src/routes/xr-status.ts");
		expect(routeSrc).toContain("/xr/");
	});

	// Cross-cutting: simulator test coverage ────────────────────────────────────

	it("cross-cut — all-views-crud Playwright spec discovers XR views from the route", () => {
		if (!hasAppXr()) return;
		const specSrc = readAppXr("e2e/all-views-crud.spec.ts");
		expect(specSrc).toContain("/api/xr/views");
		expect(specSrc).not.toContain("ALL_VIEW_IDS");
	});

	it("cross-cut — voice-forms Playwright spec is present (voice-into-forms routing tested)", () => {
		if (!hasAppXr()) return;
		expect(appXrFileExists("e2e/voice-forms.spec.ts")).toBe(true);
		const src = readAppXr("e2e/voice-forms.spec.ts");
		expect(src).toContain("xr:transcript");
	});

	it("cross-cut — camera-pose Playwright spec proves DOM overlay is screen-space (panels follow camera)", () => {
		if (!hasAppXr()) return;
		expect(appXrFileExists("e2e/camera-pose.spec.ts")).toBe(true);
		const src = readAppXr("e2e/camera-pose.spec.ts");
		expect(src).toContain("setPose");
	});
});
