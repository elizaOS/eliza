/**
 * CURRENT_TIME timezone precedence tests. A deterministic runtime stub and the
 * provider's emitted ISO instant prove device-local formatting without a live
 * model or wall-clock assumptions.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory } from "../../../types/index.ts";
import { currentTimeProvider } from "./currentTime.ts";

function runtime(timeZone: string): IAgentRuntime {
	return {
		getSetting: (key: string) => (key === "TIMEZONE" ? timeZone : null),
	} as IAgentRuntime;
}

function message(uiTimeZone?: string): Memory {
	return {
		content: {
			text: "schedule lunch tomorrow",
			...(uiTimeZone ? { metadata: { uiTimeZone } } : {}),
		},
	} as Memory;
}

function expectedDate(iso: unknown, timeZone: string): string {
	expect(typeof iso).toBe("string");
	return new Date(iso as string).toLocaleDateString("en-CA", { timeZone });
}

describe("currentTimeProvider", () => {
	it("formats relative-date context in the sending device timezone", async () => {
		const result = await currentTimeProvider.get(
			runtime("UTC"),
			message("America/Los_Angeles"),
			{} as never,
		);

		expect(result.data?.timeZone).toBe("America/Los_Angeles");
		expect(result.data?.date).toBe(
			expectedDate(result.data?.iso, "America/Los_Angeles"),
		);
		expect(result.text).toContain("America/Los_Angeles");
	});

	it("rejects an invalid client timezone and uses the configured timezone", async () => {
		const result = await currentTimeProvider.get(
			runtime("Europe/Paris"),
			message("Mars/Olympus_Mons"),
			{} as never,
		);

		expect(result.data?.timeZone).toBe("Europe/Paris");
		expect(result.data?.date).toBe(
			expectedDate(result.data?.iso, "Europe/Paris"),
		);
		expect(result.text).not.toContain("Mars/Olympus_Mons");
	});
});
