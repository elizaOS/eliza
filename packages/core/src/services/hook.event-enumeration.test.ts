import { describe, expect, it } from "vitest";
import { EventType } from "../types/events";
import type { IAgentRuntime } from "../types/runtime";
import { HookService } from "./hook";

/**
 * Item #36 (Refs #12091): HookService enumerates HOOK_* event types via a
 * static `import { EventType }` instead of an inline `require("../types/events")`.
 * This proves the statically-imported enum is the source the interceptor setup
 * registers, and that every HOOK_* member (and only those) gets wired.
 */

function makeRuntime(registered: string[]): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa",
		registerEvent: (eventType: string) => {
			registered.push(eventType);
		},
	} as unknown as IAgentRuntime;
}

describe("HookService static HOOK_ event enumeration", () => {
	it("registers exactly the statically-imported HOOK_* event types", async () => {
		const registered: string[] = [];
		await HookService.start(makeRuntime(registered));

		const expected = Object.values(EventType).filter(
			(e) => typeof e === "string" && e.startsWith("HOOK_"),
		);

		// Non-empty: the enum actually carries HOOK_ members.
		expect(expected.length).toBeGreaterThan(0);
		expect(new Set(registered)).toEqual(new Set(expected));
		// Only HOOK_* events are intercepted.
		expect(registered.every((e) => e.startsWith("HOOK_"))).toBe(true);
	});
});
