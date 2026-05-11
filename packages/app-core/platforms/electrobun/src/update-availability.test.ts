import { describe, expect, it } from "vitest";
import { resolveDesktopUpdateAvailability } from "./update-availability";

describe("resolveDesktopUpdateAvailability", () => {
	it("disables external updates for store builds on every desktop platform", () => {
		for (const platform of ["darwin", "win32", "linux"] as const) {
			const result = resolveDesktopUpdateAvailability({
				platform,
				execPath:
					platform === "darwin"
						? "/Applications/Eliza.app/Contents/MacOS/Eliza"
						: "/opt/Eliza/eliza",
				homeDir: "/Users/alice",
				appName: "Eliza",
				buildVariant: "store",
			});

			expect(result.canAutoUpdate).toBe(false);
			expect(result.autoUpdateDisabledReason).toContain(
				"managed by the app store",
			);
		}
	});

	it("allows direct non-macOS desktop builds to use the bundled updater", () => {
		const result = resolveDesktopUpdateAvailability({
			platform: "linux",
			execPath: "/opt/Eliza/eliza",
			homeDir: "/home/alice",
			appName: "Eliza",
			buildVariant: "direct",
		});

		expect(result).toEqual({
			appBundlePath: null,
			canAutoUpdate: true,
			autoUpdateDisabledReason: null,
		});
	});

	it("requires direct macOS builds to run from an installed Applications bundle", () => {
		expect(
			resolveDesktopUpdateAvailability({
				platform: "darwin",
				execPath: "/Applications/Eliza.app/Contents/MacOS/Eliza",
				homeDir: "/Users/alice",
				appName: "Eliza",
				buildVariant: "direct",
			}).canAutoUpdate,
		).toBe(true);

		const downloads = resolveDesktopUpdateAvailability({
			platform: "darwin",
			execPath: "/Users/alice/Downloads/Eliza.app/Contents/MacOS/Eliza",
			homeDir: "/Users/alice",
			appName: "Eliza",
			buildVariant: "direct",
		});
		expect(downloads.canAutoUpdate).toBe(false);
		expect(downloads.autoUpdateDisabledReason).toContain("/Applications");

		const dev = resolveDesktopUpdateAvailability({
			platform: "darwin",
			execPath: "/Users/alice/eliza/packages/app-core/platforms/electrobun",
			homeDir: "/Users/alice",
			appName: "Eliza",
			buildVariant: "direct",
		});
		expect(dev.canAutoUpdate).toBe(false);
		expect(dev.autoUpdateDisabledReason).toContain("installed .app bundle");
	});
});
