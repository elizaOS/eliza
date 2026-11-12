/** iPhone and iPad user agents contain "like Mac OS X", so they must not be
 * detected as macOS: iOS has no `x-apple.systempreferences` settings panes,
 * and opening one there does nothing. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPermissionSettings } from "../src/utils/permission-deep-links";

const IPHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
	"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
// iPadOS 13+ Safari requests desktop sites by default, so it sends a Mac
// user agent with no iPad token; only maxTouchPoints tells it apart.
const IPAD_DESKTOP_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAC_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WINDOWS_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

describe("openPermissionSettings user-agent platform detection", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	const originalNavigator = Object.getOwnPropertyDescriptor(
		globalThis,
		"navigator",
	);
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Hide the real platform so the navigator branch is reached.
		Object.defineProperty(process, "platform", {
			value: "freebsd",
			configurable: true,
		});
	});

	afterEach(() => {
		warn.mockRestore();
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
		if (originalNavigator) {
			Object.defineProperty(globalThis, "navigator", originalNavigator);
		} else {
			delete (globalThis as { navigator?: unknown }).navigator;
		}
	});

	function withNavigator(userAgent: string, maxTouchPoints?: number): void {
		Object.defineProperty(globalThis, "navigator", {
			value:
				maxTouchPoints === undefined
					? { userAgent }
					: { userAgent, maxTouchPoints },
			configurable: true,
		});
	}

	it("does not open a macOS settings link for an iPhone user agent", async () => {
		withNavigator(IPHONE_UA);
		const open = vi.fn();
		await openPermissionSettings("camera", { open });
		expect(open).not.toHaveBeenCalled();
	});

	it("does not open a macOS settings link for an iPad user agent", async () => {
		withNavigator(IPAD_UA);
		const open = vi.fn();
		await openPermissionSettings("camera", { open });
		expect(open).not.toHaveBeenCalled();
	});

	it("does not open a macOS settings link for an iPadOS 13+ desktop user agent", async () => {
		withNavigator(IPAD_DESKTOP_UA, 5);
		const open = vi.fn();
		await openPermissionSettings("camera", { open });
		expect(open).not.toHaveBeenCalled();
	});

	it("opens the macOS camera pane for a Mac user agent", async () => {
		withNavigator(MAC_UA);
		const open = vi.fn();
		await openPermissionSettings("camera", { open });
		expect(open).toHaveBeenCalledWith(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
		);
	});

	it("opens the macOS camera pane for a real Mac with no touch points", async () => {
		withNavigator(MAC_UA, 0);
		const open = vi.fn();
		await openPermissionSettings("camera", { open });
		expect(open).toHaveBeenCalledWith(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
		);
	});

	it("does not open a macOS settings link for a Windows user agent", async () => {
		withNavigator(WINDOWS_UA);
		const open = vi.fn();
		await openPermissionSettings("camera", { open });
		expect(open).not.toHaveBeenCalled();
	});
});
