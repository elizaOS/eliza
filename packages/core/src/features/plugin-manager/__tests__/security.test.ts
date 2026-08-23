import { describe, expect, it } from "vitest";
import { hasAdminAccess, hasOwnerAccess } from "./security.ts";

describe("hasOwnerAccess", () => {
	it("grants OWNER role access", async () => {
		expect(await hasOwnerAccess({} as never, {} as never)).toBe(true);
	});
});

describe("hasAdminAccess", () => {
	it("grants ADMIN role access", async () => {
		expect(await hasAdminAccess({} as never, {} as never)).toBe(true);
	});
});
