/**
 * Exercises platform restrictions through real branded environment resolution.
 * Shared resolver suites own token, port, and generic alias behavior.
 */
import {
	buildBrandEnvAliases,
	getBootConfig,
	setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isRestrictedPlatform } from "./views-platform.js";

let savedBootConfig: ReturnType<typeof getBootConfig>;

beforeEach(() => {
	vi.stubEnv("ELIZA_BUILD_VARIANT", undefined);
	vi.stubEnv("MILADY_PLATFORM", "android");
	savedBootConfig = getBootConfig();
	setBootConfig({ branding: {}, envAliases: buildBrandEnvAliases("MILADY") });
});

afterEach(() => {
	vi.unstubAllEnvs();
	setBootConfig(savedBootConfig);
});

it.each([
	{ label: "branded platform", canonical: undefined, restricted: true },
	{ label: "canonical precedence", canonical: "linux", restricted: false },
	{ label: "blank canonical fallback", canonical: "   ", restricted: true },
])(
	"applies $label without mirroring the alias",
	({ canonical, restricted }) => {
		vi.stubEnv("ELIZA_PLATFORM", canonical);
		expect(isRestrictedPlatform()).toBe(restricted);
		expect(process.env.ELIZA_PLATFORM).toBe(canonical);
	},
);
