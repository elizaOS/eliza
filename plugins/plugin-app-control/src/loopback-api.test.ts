/**
 * Verifies app-control loopback requests target the bound API listener in
 * split desktop development and retain the single-process CLI contract.
 */

import { describe, expect, it } from "vitest";
import {
	getAppControlApiBase,
	resolveAppControlLoopbackPort,
} from "./loopback-api";

describe("app-control loopback API port", () => {
	it("prefers the desktop API listener over the public Vite port", () => {
		const env = {
			ELIZA_API_PORT: "31337",
			ELIZA_PORT: "2138",
			ELIZA_UI_PORT: "2138",
		};

		expect(resolveAppControlLoopbackPort(env)).toBe(31337);
		expect(getAppControlApiBase(env)).toBe("http://127.0.0.1:31337");
	});

	it("retains the server-only listener when no desktop API port exists", () => {
		expect(
			resolveAppControlLoopbackPort({
				ELIZA_PORT: "2144",
				ELIZA_UI_PORT: "2144",
			}),
		).toBe(2144);
	});

	it("uses the canonical server-only default for an empty environment", () => {
		expect(resolveAppControlLoopbackPort({})).toBe(2138);
	});
});
