import { beforeAll, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	type Action,
	ActionMode,
	type Character,
	HOOK_MODES,
	type Memory,
} from "../../types";

function makeProbe(
	name: string,
	mode: ActionMode,
	ledger: string[],
	options: {
		modePriority?: number;
		contexts?: string[];
		validate?: () => boolean;
		throwInHandler?: boolean;
		delayMs?: number;
	} = {},
): Action {
	return {
		name,
		description: `probe:${mode}`,
		mode,
		modePriority: options.modePriority,
		contexts: options.contexts,
		examples: [],
		validate: async () => options.validate?.() ?? true,
		handler: async () => {
			if (options.delayMs) {
				await new Promise((r) => setTimeout(r, options.delayMs));
			}
			ledger.push(name);
			if (options.throwInHandler) {
				throw new Error(`probe ${name} threw`);
			}
			return { success: true };
		},
	};
}

function makeCharacter(): Character {
	return {
		name: "TestAgent",
		bio: "test",
		settings: {},
	} as Character;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-00000000000a" as Memory["id"],
		entityId: "00000000-0000-0000-0000-00000000000b" as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-00000000000c" as Memory["roomId"],
		content: { text: "hello", source: "test" },
	} as Memory;
}

describe("runActionsByMode", () => {
	let runtime: AgentRuntime;

	beforeAll(async () => {
		runtime = new AgentRuntime({
			character: makeCharacter(),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		// Register the runtime with a no-op composeState so we don't need a
		// model provider.
		runtime.composeState = async () => ({ values: {}, data: {}, text: "" });
	});

	it("filters actions by mode and ignores PLANNER actions", async () => {
		const ledger: string[] = [];
		const before = makeProbe("p-before", "ALWAYS_BEFORE", ledger);
		const after = makeProbe("p-after", "ALWAYS_AFTER", ledger);
		const planner = makeProbe("p-planner", "PLANNER", ledger);
		runtime.actions.length = 0;
		runtime.actions.push(before, after, planner);

		await runtime.runActionsByMode("ALWAYS_BEFORE", makeMessage());
		expect(ledger).toEqual(["p-before"]);
	});

	it("honors validate() — actions returning false are skipped", async () => {
		const ledger: string[] = [];
		const ok = makeProbe("ok", "ALWAYS_AFTER", ledger);
		const skip = makeProbe("skip", "ALWAYS_AFTER", ledger, {
			validate: () => false,
		});
		runtime.actions.length = 0;
		runtime.actions.push(ok, skip);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());
		expect(ledger).toEqual(["ok"]);
	});

	it("runs sequential modes in modePriority ascending, alphabetical tiebreak", async () => {
		const ledger: string[] = [];
		runtime.actions.length = 0;
		runtime.actions.push(
			makeProbe("late", "ALWAYS_AFTER", ledger, { modePriority: 200 }),
			makeProbe("first", "ALWAYS_AFTER", ledger, { modePriority: 50 }),
			makeProbe("second-b", "ALWAYS_AFTER", ledger, { modePriority: 100 }),
			makeProbe("second-a", "ALWAYS_AFTER", ledger, { modePriority: 100 }),
		);
		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());
		expect(ledger).toEqual(["first", "second-a", "second-b", "late"]);
	});

	it("DURING modes run handlers in parallel (overlap detected)", async () => {
		const events: string[] = [];
		const make = (name: string) =>
			({
				name,
				description: `probe:DURING:${name}`,
				mode: ActionMode.ALWAYS_DURING,
				examples: [],
				validate: async () => true,
				handler: async () => {
					events.push(`${name}:start`);
					await new Promise((r) => setTimeout(r, 30));
					events.push(`${name}:end`);
					return { success: true };
				},
			}) as Action;
		runtime.actions.length = 0;
		runtime.actions.push(make("a"), make("b"));
		await runtime.runActionsByMode("ALWAYS_DURING", makeMessage());
		// Both should have started before either ended (true parallelism).
		const aStart = events.indexOf("a:start");
		const bStart = events.indexOf("b:start");
		const aEnd = events.indexOf("a:end");
		const bEnd = events.indexOf("b:end");
		expect(aStart).toBeLessThan(bEnd);
		expect(bStart).toBeLessThan(aEnd);
	});

	it("CONTEXT_* gates by intersection of action.contexts and selectedContexts", async () => {
		const ledger: string[] = [];
		const knowledge = makeProbe("k", "CONTEXT_BEFORE", ledger, {
			contexts: ["documents"],
		});
		const wallet = makeProbe("w", "CONTEXT_BEFORE", ledger, {
			contexts: ["wallet"],
		});
		const both = makeProbe("kw", "CONTEXT_BEFORE", ledger, {
			contexts: ["documents", "wallet"],
		});
		const none = makeProbe("n", "CONTEXT_BEFORE", ledger, { contexts: [] });
		runtime.actions.length = 0;
		runtime.actions.push(knowledge, wallet, both, none);

		await runtime.runActionsByMode("CONTEXT_BEFORE", makeMessage(), undefined, {
			selectedContexts: ["documents"],
		});
		expect(ledger.sort()).toEqual(["k", "kw"]);
	});

	it("handler errors don't stop the run; subsequent actions still execute", async () => {
		const ledger: string[] = [];
		runtime.actions.length = 0;
		runtime.actions.push(
			makeProbe("first", "ALWAYS_AFTER", ledger, {
				modePriority: 10,
				throwInHandler: true,
			}),
			makeProbe("second", "ALWAYS_AFTER", ledger, { modePriority: 20 }),
		);
		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());
		expect(ledger).toEqual(["first", "second"]);
	});

	it("HOOK_MODES export covers all 9 hook positions", () => {
		expect(HOOK_MODES.length).toBe(9);
		expect(HOOK_MODES).toContain("ALWAYS_BEFORE");
		expect(HOOK_MODES).toContain("RESPONSE_HANDLER_BEFORE");
		expect(HOOK_MODES).toContain("RESPONSE_HANDLER_DURING");
		expect(HOOK_MODES).toContain("RESPONSE_HANDLER_AFTER");
		expect(HOOK_MODES).toContain("CONTEXT_BEFORE");
		expect(HOOK_MODES).toContain("CONTEXT_DURING");
		expect(HOOK_MODES).toContain("CONTEXT_AFTER");
		expect(HOOK_MODES).toContain("ALWAYS_DURING");
		expect(HOOK_MODES).toContain("ALWAYS_AFTER");
		expect(HOOK_MODES).not.toContain("PLANNER");
	});
});
