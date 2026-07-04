/**
 * Exercises the `refreshProviders` argument to `AgentRuntime.composeState`:
 * cached providers are reused while only the named ones re-run, an omitted set
 * re-runs everything, and an uncached provider runs even when unnamed. Uses a
 * real in-memory AgentRuntime with call-counting providers; no database or
 * model.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, Provider, UUID } from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

/** Provider whose text changes on every run, so reuse vs re-run is observable. */
function countingProvider(name: string): {
	provider: Provider;
	calls: () => number;
} {
	let n = 0;
	return {
		provider: {
			name,
			get: async () => {
				n += 1;
				return { text: `${name}#${n}`, values: {}, data: {} };
			},
		},
		calls: () => n,
	};
}

function makeMessage(id: string): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "gm" },
	};
}

describe("composeState refreshProviders", () => {
	it("reuses cached providers and re-runs only the named one", async () => {
		const runtime = new AgentRuntime({
			character: { name: "refresh-test" } as Character,
		});
		const a = countingProvider("AAA");
		const b = countingProvider("BBB");
		const c = countingProvider("CCC");
		runtime.registerProvider(a.provider);
		runtime.registerProvider(b.provider);
		runtime.registerProvider(c.provider);

		const message = makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
		const include = ["AAA", "BBB", "CCC"];

		// First compose runs all three and caches them.
		const first = await runtime.composeState(message, include, true, false);
		expect(first.text).toContain("AAA#1");
		expect(first.text).toContain("BBB#1");
		expect(first.text).toContain("CCC#1");

		// Second compose refreshes ONLY BBB; AAA/CCC are reused from cache.
		const second = await runtime.composeState(message, include, true, false, [
			"BBB",
		]);

		// Only BBB re-ran.
		expect(a.calls()).toBe(1);
		expect(b.calls()).toBe(2);
		expect(c.calls()).toBe(1);

		// The full set still drives order + text, with BBB refreshed.
		expect(second.data.providerOrder).toEqual(["AAA", "BBB", "CCC"]);
		expect(second.text).toContain("AAA#1"); // reused
		expect(second.text).toContain("BBB#2"); // refreshed
		expect(second.text).toContain("CCC#1"); // reused
		expect(second.text).not.toContain("BBB#1");
	});

	it("without refreshProviders re-runs every requested provider (default unchanged)", async () => {
		const runtime = new AgentRuntime({
			character: { name: "refresh-default" } as Character,
		});
		const a = countingProvider("AAA");
		const b = countingProvider("BBB");
		runtime.registerProvider(a.provider);
		runtime.registerProvider(b.provider);

		const message = makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
		const include = ["AAA", "BBB"];

		await runtime.composeState(message, include, true, false);
		const second = await runtime.composeState(message, include, true, false);

		// No refresh set ⇒ both re-run (pre-existing behavior preserved).
		expect(a.calls()).toBe(2);
		expect(b.calls()).toBe(2);
		expect(second.text).toContain("AAA#2");
		expect(second.text).toContain("BBB#2");
	});

	it("runs an uncached provider even when not named in refreshProviders", async () => {
		const runtime = new AgentRuntime({
			character: { name: "refresh-uncached" } as Character,
		});
		const a = countingProvider("AAA");
		const b = countingProvider("BBB");
		runtime.registerProvider(a.provider);
		runtime.registerProvider(b.provider);

		const message = makeMessage("cccccccc-cccc-cccc-cccc-cccccccccccc");

		// First compose only caches AAA.
		await runtime.composeState(message, ["AAA"], true, false);
		// Now request AAA+BBB, refreshing only AAA — BBB is uncached so it must run.
		const second = await runtime.composeState(
			message,
			["AAA", "BBB"],
			true,
			false,
			["AAA"],
		);

		expect(a.calls()).toBe(2); // refreshed
		expect(b.calls()).toBe(1); // uncached ⇒ ran once
		expect(second.text).toContain("AAA#2");
		expect(second.text).toContain("BBB#1");
	});
});
