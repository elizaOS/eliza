import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resolveDesktopRuntimeMode,
	resolveDesktopRuntimeModeSignal,
	resolveLocalAgentIpcMode,
} from "./api-base";
import { getBrandConfig, resetBrandConfigForTests } from "./brand-config";
import { shouldStartBottomBar } from "./desktop-bottom-bar-config";
import { parseDesktopEnvFlag, readDesktopEnvFlag } from "./desktop-env-flags";
import {
	shouldAttachTrayMenu,
	shouldCreateDesktopTray,
	shouldEnableTrayPopover,
	shouldStartTrayFirst,
} from "./desktop-tray-config";
import { logger } from "./logger";

const TRUTHY = ["1", "true", "yes", "on", " ON ", "True"];
const FALSY = ["0", "false", "no", "off", " OFF ", "No"];
const noArgs: readonly string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetBrandConfigForTests();
});

describe("desktop env flag vocabulary", () => {
	it.each(TRUTHY)("parses %j as enabled", (value) => {
		expect(parseDesktopEnvFlag("X", value)).toBe(true);
	});
	it.each(FALSY)("parses %j as disabled", (value) => {
		expect(parseDesktopEnvFlag("X", value)).toBe(false);
	});

	it("keeps the default for unset or empty values without warning", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(readDesktopEnvFlag({}, "X", true)).toBe(true);
		expect(readDesktopEnvFlag({ X: "  " }, "X", false)).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});

	it("keeps the default for unrecognized values and warns", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(readDesktopEnvFlag({ FLAG_A: "maybe" }, "FLAG_A", true)).toBe(true);
		expect(readDesktopEnvFlag({ FLAG_B: "maybe" }, "FLAG_B", false)).toBe(
			false,
		);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(String(warn.mock.calls[0]?.[0])).toContain("FLAG_A");
	});
});

describe("desktop kill switches share one vocabulary", () => {
	it.each(FALSY)("ELIZA_DESKTOP_TRAY=%j disables the tray", (value) => {
		expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_TRAY: value })).toBe(false);
	});

	it.each(TRUTHY)(
		"ELIZA_DESKTOP_DISABLE_TRAY=%j disables the tray",
		(value) => {
			expect(
				shouldCreateDesktopTray({ ELIZA_DESKTOP_DISABLE_TRAY: value }),
			).toBe(false);
		},
	);

	it.each(FALSY)("ELIZA_DESKTOP_TRAY_FIRST=%j disables tray-first", (value) => {
		expect(
			shouldStartTrayFirst(
				{ ELIZA_DESKTOP_TRAY_FIRST: value },
				"darwin",
				noArgs,
			),
		).toBe(false);
	});

	it.each(FALSY)(
		"ELIZA_DESKTOP_TRAY_MENU=%j disables the tray menu",
		(value) => {
			expect(shouldAttachTrayMenu({ ELIZA_DESKTOP_TRAY_MENU: value })).toBe(
				false,
			);
		},
	);

	it.each(TRUTHY)(
		"ELIZA_DESKTOP_TRAY_POPOVER=%j enables the popover",
		(value) => {
			expect(
				shouldEnableTrayPopover(
					{ ELIZA_DESKTOP_TRAY_POPOVER: value },
					"darwin",
					noArgs,
				),
			).toBe(true);
		},
	);

	it.each(FALSY)(
		"ELIZA_DESKTOP_BOTTOM_BAR=%j disables the bottom bar",
		(value) => {
			expect(
				shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: value }, noArgs),
			).toBe(false);
		},
	);

	it("keeps tray and bottom-bar defaults on for unset/unrecognized values", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(shouldCreateDesktopTray({})).toBe(true);
		expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_TRAY: "bogus" })).toBe(true);
		expect(shouldStartTrayFirst({}, "darwin", noArgs)).toBe(true);
		expect(shouldAttachTrayMenu({ ELIZA_DESKTOP_TRAY_MENU: "bogus" })).toBe(
			true,
		);
		expect(shouldEnableTrayPopover({}, "darwin", noArgs)).toBe(false);
		expect(
			shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: "bogus" }, noArgs),
		).toBe(true);
	});

	it.each(TRUTHY)("api-base opt-in flags accept %j", (value) => {
		expect(
			resolveDesktopRuntimeMode({ ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: value })
				.mode,
		).toBe("disabled");
		expect(
			resolveDesktopRuntimeModeSignal({ ELIZA_DESKTOP_CLOUD_ONLY: value }),
		).toBe("cloud");
		expect(
			resolveLocalAgentIpcMode({ ELIZA_DESKTOP_LOCAL_AGENT_IPC: value }),
		).toBe(true);
	});

	it.each(FALSY)("api-base opt-in flags stay off for %j", (value) => {
		expect(
			resolveDesktopRuntimeMode({ ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: value })
				.mode,
		).toBe("local");
		expect(
			resolveLocalAgentIpcMode({ ELIZA_DESKTOP_LOCAL_AGENT_IPC: value }),
		).toBe(false);
	});

	it("brand config ELIZA_DESKTOP_CLOUD_ONLY accepts on and rejects off", () => {
		vi.stubEnv("ELIZA_DESKTOP_CLOUD_ONLY", " On ");
		resetBrandConfigForTests();
		expect(getBrandConfig().cloudOnly).toBe(true);
		vi.stubEnv("ELIZA_DESKTOP_CLOUD_ONLY", "off");
		resetBrandConfigForTests();
		expect(getBrandConfig().cloudOnly).toBe(false);
	});
});
