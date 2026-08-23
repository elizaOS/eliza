/**
 * Coverage for environment.
 */
import { describe, expect, it } from "vitest";
import { Role } from "./environment.js";

describe("environment", () => {
	it("exposes roles", () => {
		expect(Role.OWNER).toBe("OWNER");
		expect(Role.ADMIN).toBe("ADMIN");
		expect(Role.MEMBER).toBe("MEMBER");
		expect(Role.GUEST).toBe("GUEST");
		expect(Role.NONE).toBe("NONE");
	});
});
