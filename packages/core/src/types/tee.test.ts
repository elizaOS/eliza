/**
 * Unit tests for legacy TEE contracts: validates TEEMode and TeeType enum objects.
 */
import { describe, expect, it } from "vitest";
import { TEEMode, TeeType } from "./tee.ts";

describe("tee constants", () => {
	it("exports expected TEEMode values", () => {
		expect(TEEMode.UNSPECIFIED).toBe("UNSPECIFIED");
		expect(TEEMode.OFF).toBe("OFF");
		expect(TEEMode.LOCAL).toBe("LOCAL");
		expect(TEEMode.DOCKER).toBe("DOCKER");
		expect(TEEMode.PRODUCTION).toBe("PRODUCTION");
	});

	it("exports expected TeeType values", () => {
		expect(TeeType.UNSPECIFIED).toBe("UNSPECIFIED");
		expect(TeeType.TDX_DSTACK).toBe("TDX_DSTACK");
	});
});
