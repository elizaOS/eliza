import { describe, expect, it } from "vitest";
import { createAppAction } from "./app.js";

describe("APP action role policy", () => {
	it("advertises the same owner-only gate enforced by validate and handler", () => {
		expect(createAppAction().roleGate).toEqual({ minRole: "OWNER" });
	});
});
