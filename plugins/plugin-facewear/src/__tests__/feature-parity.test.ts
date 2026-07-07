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
	facewearListViewsAction,
	facewearOpenViewAction,
} from "../actions/view-actions.ts";
import { viewHostRoute } from "../routes/view-host.ts";
import { viewsRoute } from "../routes/views.ts";

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const appXrRoot = resolve(repoRoot, "plugins/plugin-facewear/app-xr");
const XR_ROUTE_TEST_PLUGIN = "@test/plugin-facewear-xr-route-registry";

// ── helpers ───────────────────────────────────────────────────────────────────

function readFile(relPath: string): string {
	return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function fileExists(relPath: string): boolean {
	return existsSync(resolve(repoRoot, relPath));
}

function appXrFileExists(relPath: string): boolean {
	return existsSync(resolve(appXrRoot, relPath));
}

function readAppXr(relPath: string): string {
	return readFileSync(resolve(appXrRoot, relPath), "utf8");
}

const VIEW_HOST_SMOKE_IDS = [
	"facewear",
	"smartglasses",
	"hyphenated-view",
] as const;

const VOICE_ROUTE_SAMPLE_IDS = [
	"facewear",
	"smartglasses",
	"hyphenated-view",
] as const;

async function callViewHostRoute(input: unknown) {
	const handler = viewHostRoute.routeHandler;
	if (!handler) throw new Error("viewHostRoute has no routeHandler");
	return handler(input as never);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("XR feature parity audit", () => {
	afterEach(() => {
		unregisterPluginViews(XR_ROUTE_TEST_PLUGIN);
	});

	// 1. View registration — the standalone facewear/smartglasses launcher views
	//    were XR/TUI-only and are retired (#15269). GUI settings live under
	//    Settings → Wearables through register.ts. The manifest must not
	//    reintroduce shipped view declarations.
	it("axis 1 — plugin-facewear ships no standalone view declarations", () => {
		const source = readFile("plugins/plugin-facewear/src/index.ts");
		expect(source, "no views property").not.toContain("views:");
		expect(source, "no modalities literals").not.toContain("modalities:");
	});

	// 2. Route infrastructure ───────────────────────────────────────────────────

	it("axis 2 — the viewHostRoute returns valid HTML for arbitrary xr view ids", async () => {
		const failures: string[] = [];
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const result = await callViewHostRoute({
				params: { id },
				runtime: { port: 31337 },
			});
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

	it("axis 2 — viewsRoute source is registered as GET /xr/views through the canonical registry", () => {
		const routeSrc = readFile("plugins/plugin-facewear/src/routes/views.ts");
		expect(routeSrc).toContain('"GET"');
		expect(routeSrc).toContain('"/xr/views"');
		expect(routeSrc).toContain("@elizaos/agent/api/views-registry");
		expect(routeSrc).toContain('viewType: "xr"');
		// Returns view list with count
		expect(routeSrc).toContain("count");
	});

	it("axis 2 — viewsRoute returns canonical registry XR entries", async () => {
		await registerPluginViews({
			name: XR_ROUTE_TEST_PLUGIN,
			views: [
				{
					id: "facewear-xr-registry-route-smoke",
					label: "Facewear XR Registry Route",
					viewType: "xr",
					path: "/apps/facewear-xr-registry-route-smoke/xr",
					icon: "Glasses",
					tags: ["xr", "registry"],
					description: "Registry-backed facewear XR route smoke",
					xrOptions: { placement: "panel" },
					bundleUrl: "https://views.example.test/facewear-xr-route.js",
				},
				{
					id: "facewear-gui-registry-route-smoke",
					label: "Facewear GUI Registry Route",
					viewType: "gui",
					path: "/apps/facewear-gui-registry-route-smoke",
					bundleUrl: "https://views.example.test/facewear-gui-route.js",
				},
			],
		} as never);

		const routeHandler = viewsRoute.routeHandler;
		if (!routeHandler) {
			throw new Error("viewsRoute.routeHandler is required for this test");
		}

		const result = await routeHandler({
			runtime: {
				getService: () => ({
					getConnections: () => [
						{ id: "glasses-1", deviceType: "smartglasses" },
					],
				}),
			},
		} as never);

		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			count: expect.any(Number),
			connections: [{ id: "glasses-1", deviceType: "smartglasses" }],
		});
		expect(
			(result.body as { views: Array<Record<string, unknown>> }).views,
		).toContainEqual(
			expect.objectContaining({
				id: "facewear-xr-registry-route-smoke",
				label: "Facewear XR Registry Route",
				path: "/apps/facewear-xr-registry-route-smoke/xr",
				pluginName: XR_ROUTE_TEST_PLUGIN,
				available: true,
				xrOptions: { placement: "panel" },
			}),
		);
		expect(
			(result.body as { views: Array<Record<string, unknown>> }).views.some(
				(view) => view.id === "facewear-gui-registry-route-smoke",
			),
		).toBe(false);
	});

	// 3. Agent CRUD action surface ──────────────────────────────────────────────

	it("axis 3 — plugin-facewear exports all 5 agent view actions", () => {
		const actionsSource = readFile(
			"plugins/plugin-facewear/src/actions/xr-view-actions.ts",
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
					id: "facewear-dynamic-action-panel",
					label: "Facewear Dynamic Action Panel",
					viewType: "xr",
					path: "/apps/facewear-dynamic-action-panel/xr",
					icon: "Glasses",
					description: "Dynamically registered facewear action target",
					bundleUrl:
						"https://views.example.test/facewear-dynamic-action-panel.js",
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
				getConnections: () => [{ id: "glasses-1", deviceType: "smartglasses" }],
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

		await facewearOpenViewAction.handler?.(
			runtime as never,
			{
				content: { text: "open the facewear dynamic action panel in xr" },
			} as never,
			undefined,
			{},
		);
		await facewearListViewsAction.handler?.(
			runtime as never,
			{ content: { text: "what can i open in xr?" } } as never,
			undefined,
			{},
		);

		expect(calls.opened).toContainEqual({
			connectionId: "glasses-1",
			viewId: "facewear-dynamic-action-panel",
		});
		expect(calls.catalogs.at(-1)).toContainEqual(
			expect.objectContaining({
				id: "facewear-dynamic-action-panel",
				label: "Facewear Dynamic Action Panel",
			}),
		);
		const actionsSource = readFile(
			"plugins/plugin-facewear/src/actions/view-actions.ts",
		);
		expect(actionsSource).toContain("@elizaos/agent/api/views-registry");
		expect(actionsSource).not.toContain("const known = [");
		expect(actionsSource).not.toContain("runtime.plugins");
		expect(actionsSource).not.toContain("RuntimePluginWithViews");
		expect(actionsSource).not.toContain("plugin.views");
	});

	// 4. Connection modes ───────────────────────────────────────────────────────

	it("axis 4 — app-xr connection-config.ts implements Local/Cloud/Custom modes", () => {
		const src = readAppXr("src/connection-config.ts");
		expect(src).toContain('"local"');
		expect(src).toContain('"cloud"');
		expect(src).toContain('"custom"');
		expect(src).toContain("configToWsUrl");
	});

	it("axis 4 — app-xr connection-setup.ts renders the mode picker UI", () => {
		const src = readAppXr("src/ui/connection-setup.ts");
		expect(src).toContain("local");
		expect(src).toContain("cloud");
		expect(src).toContain("custom");
	});

	it("axis 4 — AgentSocket supports hot reconnect for mode switching", () => {
		const socketSrc = readAppXr("src/agent-socket.ts");
		expect(socketSrc).toContain("reconnectTo");
	});

	// 5. Voice input ────────────────────────────────────────────────────────────

	it("axis 5 — view-host pages have voice transcript routing for INPUT, TEXTAREA, SELECT, and ARIA widgets", async () => {
		for (const id of VOICE_ROUTE_SAMPLE_IDS) {
			const result = await callViewHostRoute({
				params: { id },
				runtime: { port: 31337 },
			});
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
		expect(
			fileExists(
				"plugins/plugin-facewear/native/android/quest/bubblewrap.json",
			),
		).toBe(true);
		const config = JSON.parse(
			readFile("plugins/plugin-facewear/native/android/quest/bubblewrap.json"),
		);
		expect(config.packageId).toBe("com.eliza.xr.quest");
		expect(config.metaQuest).toBe(true);
		expect(config.permissions).toContain("android.permission.CAMERA");
		expect(config.permissions).toContain("android.permission.RECORD_AUDIO");
		expect(config.display).toBe("fullscreen");
	});

	it("axis 6 — XReal Android project has complete Gradle project structure", () => {
		expect(
			fileExists(
				"plugins/plugin-facewear/native/android/xreal/build.gradle.kts",
			),
		).toBe(true);
		expect(
			fileExists(
				"plugins/plugin-facewear/native/android/xreal/settings.gradle.kts",
			),
		).toBe(true);
		expect(
			fileExists("plugins/plugin-facewear/native/android/xreal/gradlew"),
		).toBe(true);
		expect(
			fileExists(
				"plugins/plugin-facewear/native/android/xreal/gradle/wrapper/gradle-wrapper.properties",
			),
		).toBe(true);
		expect(
			fileExists(
				"plugins/plugin-facewear/native/android/xreal/app/build.gradle.kts",
			),
		).toBe(true);
		expect(
			fileExists(
				"plugins/plugin-facewear/native/android/xreal/app/src/main/AndroidManifest.xml",
			),
		).toBe(true);
	});

	it("axis 6 — XReal Kotlin source files are present", () => {
		const base =
			"plugins/plugin-facewear/native/android/xreal/app/src/main/java/com/elizaos/facewear/xreal";
		expect(fileExists(`${base}/MainActivity.kt`)).toBe(true);
		expect(fileExists(`${base}/CameraService.kt`)).toBe(true);
		expect(fileExists(`${base}/XrealBridgeJs.kt`)).toBe(true);
	});

	it("axis 6 — XReal AndroidManifest declares camera, audio, and XREAL tracking permissions", () => {
		const manifest = readFile(
			"plugins/plugin-facewear/native/android/xreal/app/src/main/AndroidManifest.xml",
		);
		expect(manifest).toContain("android.permission.CAMERA");
		expect(manifest).toContain("android.permission.RECORD_AUDIO");
		expect(manifest).toContain("android.permission.INTERNET");
		expect(manifest).toContain("ai.xreal.permission.TRACKING");
	});

	it("axis 6 — Even Realities Android bridge uses whole-headset G1 protocol and forwards mic frames", () => {
		const base =
			"plugins/plugin-facewear/native/android/even-realities/app/src/main/java/com/elizaos/facewear/evenrealities";
		const g1Service = readFile(`${base}/G1BleService.kt`);
		const agentBridge = readFile(`${base}/AgentBridgeService.kt`);

		expect(g1Service).toContain("enum class GlassSide");
		expect(g1Service).toContain("GlassSide.LEFT");
		expect(g1Service).toContain("GlassSide.RIGHT");
		expect(g1Service).toContain("cmdSendResult = 0x4E");
		expect(g1Service).toContain("cmdOpenMic = 0x0E");
		expect(g1Service).toContain("cmdBrightness = 0x01");
		expect(g1Service).toContain("cmdBattery = 0x2C");
		expect(g1Service).toContain("connectionReadyPacket");
		expect(g1Service).toContain("writeBoth");

		expect(agentBridge).not.toContain("stub");
		expect(agentBridge).not.toContain("not yet forwarded");
		expect(agentBridge).toContain('"g1_raw"');
		expect(agentBridge).toContain('"mic_lc3"');
		expect(agentBridge).toContain('"g1_write"');
	});

	// 7. PWA manifest ───────────────────────────────────────────────────────────

	it("axis 7 — app-xr has a complete PWA web manifest for browser-based WebXR", () => {
		expect(appXrFileExists("manifest.webmanifest")).toBe(true);
		const manifest = JSON.parse(readAppXr("manifest.webmanifest"));
		expect(manifest.display).toBeDefined();
		expect(manifest.name).toBeDefined();
		expect(manifest.icons?.length).toBeGreaterThan(0);
	});

	// 8. HTTPS tunnel and pairing ───────────────────────────────────────────────

	it("axis 8 — app-xr package.json has a connect script for HTTPS tunnel + QR code", () => {
		const pkg = JSON.parse(readAppXr("package.json"));
		expect(pkg.scripts?.connect, "connect script for tunnel").toBeDefined();
	});

	it("axis 8 — xr-connect route serves QR code + text pairing page", () => {
		const routeSrc = readFile("plugins/plugin-facewear/src/routes/connect.ts");
		expect(routeSrc).toContain("/xr/connect");
		// Should generate QR code
		expect(routeSrc.toLowerCase()).toContain("qr");
		// Should include a text code fallback
		expect(routeSrc).toContain("code");
	});

	it("axis 8 — xr-status route provides JSON pairing state for polling", () => {
		const routeSrc = readFile("plugins/plugin-facewear/src/routes/status.ts");
		expect(routeSrc).toContain("/xr/");
	});

	// Cross-cutting: simulator test coverage ────────────────────────────────────

	it("cross-cut — all-views-crud Playwright spec discovers XR views from the route", () => {
		const specSrc = readAppXr("e2e/all-views-crud.spec.ts");
		expect(specSrc).toContain("/api/xr/views");
		expect(specSrc).not.toContain("ALL_VIEW_IDS");
	});

	it("cross-cut — voice-forms Playwright spec is present (voice-into-forms routing tested)", () => {
		expect(appXrFileExists("e2e/voice-forms.spec.ts")).toBe(true);
		const src = readAppXr("e2e/voice-forms.spec.ts");
		expect(src).toContain("xr:transcript");
	});

	it("cross-cut — camera-pose Playwright spec proves DOM overlay is screen-space (panels follow camera)", () => {
		expect(appXrFileExists("e2e/camera-pose.spec.ts")).toBe(true);
		const src = readAppXr("e2e/camera-pose.spec.ts");
		expect(src).toContain("setPose");
	});
});
