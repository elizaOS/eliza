import { describe, expect, it } from "vitest";
import {
	dispatchSubaction,
	readSubaction,
} from "../src/actions/subaction-dispatch";

describe("readSubaction alias fall-through", () => {
	it("finds a valid subaction in an alias key when the primary key holds an unrecognized value", () => {
		expect(
			readSubaction(
				{ action: "do-the-thing", subaction: "create" },
				{ allowed: ["create", "list"] as const },
			),
		).toBe("create"); // before: undefined
	});

	it("still prefers the primary key when it holds a recognized subaction", () => {
		expect(
			readSubaction(
				{ action: "list", subaction: "create" },
				{ allowed: ["create", "list"] as const },
			),
		).toBe("list");
	});

	it("returns undefined when no key holds a recognized value", async () => {
		const found = readSubaction(
			{ action: "nope", subaction: "nah" },
			{ allowed: ["create", "list"] as const },
		);
		expect(found).toBeUndefined();
		const result = await dispatchSubaction(
			found,
			{
				create: async () => ({ success: true }),
				list: async () => ({ success: true }),
			},
			undefined,
		);
		expect(result.error).toBe("UNKNOWN_SUBACTION");
	});

	it("dispatches the alias subaction end to end", async () => {
		const result = await dispatchSubaction(
			readSubaction(
				{ action: "do-the-thing", subaction: "create" },
				{ allowed: ["create", "list"] as const },
			),
			{
				create: async () => ({ success: true, text: "created" }),
				list: async () => ({ success: true, text: "listed" }),
			},
			undefined,
		);
		expect(result).toEqual({ success: true, text: "created" });
	});
});
