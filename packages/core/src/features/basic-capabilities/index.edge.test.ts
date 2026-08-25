/**
 * Unit tests for basic-capabilities edge entrypoint: validates Workerd plugin
 * assembly and unsupported capability error rejection.
 */
import { describe, expect, it } from "vitest";
import { createBasicCapabilitiesPlugin } from "./index.edge.ts";

describe("basic-capabilities edge", () => {
	it("throws error when unsupported capability flags are enabled in Workerd", () => {
		expect(() =>
			createBasicCapabilitiesPlugin({ enableAutonomy: true }),
		).toThrow("Workerd runtime does not support core capability flags");
	});
});
