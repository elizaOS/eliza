/**
 * Unit tests for basic-capabilities edge entrypoint: validates Workerd plugin
 * assembly and unsupported capability error rejection.
 */
import { describe, expect, it } from "vitest";
import {
	basicActions,
	basicCapabilities,
	basicProviders,
	createBasicCapabilitiesPlugin,
} from "./index.edge.ts";

describe("basic-capabilities edge", () => {
	it("exports default basic capabilities structure", () => {
		expect(basicCapabilities.providers.length).toBeGreaterThan(0);
		expect(basicCapabilities.actions.length).toBe(3);
		expect(basicCapabilities.services.length).toBe(1);
	});

	it("creates basic capabilities plugin with default config", () => {
		const plugin = createBasicCapabilitiesPlugin();
		expect(plugin.name).toBe("basic-capabilities");
		expect(plugin.actions.length).toBe(basicActions.length);
		expect(plugin.providers.length).toBe(basicProviders.length);
	});

	it("throws error when unsupported capability flags are enabled in Workerd", () => {
		expect(() =>
			createBasicCapabilitiesPlugin({ enableAutonomy: true }),
		).toThrow("Workerd runtime does not support core capability flags");
	});
});
