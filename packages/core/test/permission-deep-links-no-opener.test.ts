/** On macOS with no opener and no `window.open`, `openPermissionSettings`
 * used to resolve successfully while opening nothing: the caller believed
 * the settings pane was shown. It must fail loudly instead. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPermissionSettings } from "../src/utils/permission-deep-links";

describe("openPermissionSettings without an opener on darwin", () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
		if (originalWindow) {
			Object.defineProperty(globalThis, "window", originalWindow);
		} else {
			delete (globalThis as { window?: unknown }).window;
		}
	});

	it("rejects when no opener is available", async () => {
		await expect(
			openPermissionSettings("camera", { platform: "darwin" }),
		).rejects.toThrow(/no opener/i);
	});

	it("still opens through an injected opener", async () => {
		const open = vi.fn();
		await openPermissionSettings("camera", { platform: "darwin", open });
		expect(open).toHaveBeenCalledWith(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
		);
	});

	it("still opens through window.open when one exists", async () => {
		const windowOpen = vi.fn();
		Object.defineProperty(globalThis, "window", {
			value: { open: windowOpen },
			configurable: true,
		});
		await openPermissionSettings("camera", { platform: "darwin" });
		expect(windowOpen).toHaveBeenCalledWith(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
			"_self",
		);
	});

	it("still warns and resolves on a platform without deep links", async () => {
		const open = vi.fn();
		await openPermissionSettings("camera", { platform: "win32", open });
		expect(open).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});
});
