import { describe, expect, it, vi } from "vitest";
import { ignoreAction } from "./ignore";

describe("ignoreAction", () => {
	it("stays silent while preserving the ignored action metadata", async () => {
		const callback = vi.fn();

		const result = await ignoreAction.handler(
			{} as never,
			{} as never,
			undefined,
			undefined,
			callback,
			[],
		);

		expect(callback).not.toHaveBeenCalled();
		expect(result?.text).toBe("");
		expect(result?.values?.ignored).toBe(true);
		expect(result?.data?.actionName).toBe("IGNORE");
	});
});
