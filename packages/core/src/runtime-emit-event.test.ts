/**
 * emitEvent must invoke every registered handler for an event even when an
 * earlier handler throws synchronously (#31949). Deterministic: a real
 * AgentRuntime with no database adapter and no model calls.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime";
import type { EventPayload } from "./types";

function createRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: { name: "EmitEvent", bio: ["test"], settings: {} },
	});
}

describe("AgentRuntime.emitEvent", () => {
	it("still invokes later handlers when an earlier one throws synchronously", async () => {
		const runtime = createRuntime();
		const seen: string[] = [];
		runtime.registerEvent("hunt.sync-throw", (() => {
			seen.push("first");
			throw new Error("first handler failed synchronously");
		}) as unknown as (params: EventPayload) => Promise<void>);
		runtime.registerEvent("hunt.sync-throw", async () => {
			seen.push("second");
		});

		await expect(
			runtime.emitEvent("hunt.sync-throw", { source: "test" }),
		).rejects.toThrow("first handler failed synchronously");
		expect(seen).toEqual(["first", "second"]);
	});

	it("invokes every handler in registration order when none throw", async () => {
		const runtime = createRuntime();
		const seen: string[] = [];
		runtime.registerEvent("hunt.ok", async () => {
			seen.push("a");
		});
		runtime.registerEvent("hunt.ok", async () => {
			seen.push("b");
		});
		await runtime.emitEvent("hunt.ok", { source: "test" });
		expect(seen).toEqual(["a", "b"]);
	});
});
