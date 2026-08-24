/**
 * Coverage for trigger.
 */
import { describe, expect, it } from "vitest";
import { TRIGGER_SCHEMA_VERSION } from "./trigger.js";

describe("trigger", () => {
	it("exposes version", () => {
		expect(TRIGGER_SCHEMA_VERSION).toBe(1);
	});
});
