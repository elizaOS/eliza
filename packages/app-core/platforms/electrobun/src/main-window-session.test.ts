import { describe, expect, it } from "vitest";
import {
	MAC_DESKTOP_CEF_PARTITION,
	PACKAGED_WINDOWS_BOOTSTRAP_PARTITION,
	resolveMainWindowPartition,
	shouldForceMainWindowCef,
	shouldUseIsolatedMainView,
} from "./main-window-session";

const linuxCefBuild = {
	defaultRenderer: "cef" as const,
	availableRenderers: ["native" as const, "cef" as const],
};

const linuxNativeBuild = {
	defaultRenderer: "native" as const,
	availableRenderers: ["native" as const],
};

describe("main window session", () => {
	it("forces CEF only on macOS when explicitly requested", () => {
		expect(
			shouldForceMainWindowCef({ ELIZA_DESKTOP_FORCE_CEF: "1" }, "darwin"),
		).toBe(true);
		expect(
			shouldForceMainWindowCef({ ELIZA_DESKTOP_FORCE_CEF: "1" }, "linux"),
		).toBe(false);
	});

	it("honors an explicit test partition on every platform", () => {
		expect(
			resolveMainWindowPartition(
				{ ELIZA_DESKTOP_TEST_PARTITION: "desktop-test" },
				{ platform: "linux", buildInfo: linuxCefBuild },
			),
		).toBe("persist:desktop-test");
	});

	it("uses the packaged bootstrap partition for desktop API-base smoke tests", () => {
		expect(
			resolveMainWindowPartition(
				{ ELIZA_DESKTOP_TEST_API_BASE: "http://127.0.0.1:31337" },
				{ platform: "win32" },
			),
		).toBe(PACKAGED_WINDOWS_BOOTSTRAP_PARTITION);
	});

	it("uses the branded persistent partition for Linux CEF main windows", () => {
		expect(
			resolveMainWindowPartition(
				{},
				{ platform: "linux", buildInfo: linuxCefBuild },
			),
		).toBe(MAC_DESKTOP_CEF_PARTITION);
	});

	it("does not assign a partition to Linux native-only builds", () => {
		expect(
			resolveMainWindowPartition(
				{},
				{ platform: "linux", buildInfo: linuxNativeBuild },
			),
		).toBeNull();
	});

	it("keeps Linux CEF in the primary BrowserWindow with its partition", () => {
		expect(
			shouldUseIsolatedMainView({
				platform: "linux",
				mainWindowPartition: MAC_DESKTOP_CEF_PARTITION,
				forceMainWindowCef: false,
				buildInfo: linuxCefBuild,
			}),
		).toBe(false);
	});

	it("uses an isolated shell plus partitioned BrowserView for Windows", () => {
		expect(
			shouldUseIsolatedMainView({
				platform: "win32",
				mainWindowPartition: PACKAGED_WINDOWS_BOOTSTRAP_PARTITION,
				forceMainWindowCef: false,
				buildInfo: linuxCefBuild,
			}),
		).toBe(true);
	});

	it("uses an isolated shell plus partitioned BrowserView for forced macOS CEF", () => {
		expect(
			shouldUseIsolatedMainView({
				platform: "darwin",
				mainWindowPartition: MAC_DESKTOP_CEF_PARTITION,
				forceMainWindowCef: true,
				buildInfo: linuxCefBuild,
			}),
		).toBe(true);
	});

	it("does not use an isolated main view without a partition", () => {
		expect(
			shouldUseIsolatedMainView({
				platform: "linux",
				mainWindowPartition: null,
				forceMainWindowCef: false,
				buildInfo: linuxCefBuild,
			}),
		).toBe(false);
	});
});
