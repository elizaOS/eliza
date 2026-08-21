/**
 * Per-turn entity-alias capabilities at the executor boundary (#20091):
 * `buildTurnEntityAliases` mints grants only from composed-state evidence,
 * OWNER-resolved roles, and canonical owner resolution; `resolveEntityAliasRefs`
 * substitutes only granted full-string placeholders; `executePlannedToolCall`
 * never performs an ambient setting lookup keyed by model-authored text.
 * Deterministic — stub runtime with vi.fn handlers, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	Action,
	ActionParameters,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../types";
import type { State } from "../../types/state";
import { executePlannedToolCall } from "../execute-planned-tool-call";
import {
	buildTurnEntityAliases,
	CANONICAL_OWNER_ENTITY_ALIAS,
	resolveEntityAliasRefs,
	statePresentsEntityAlias,
} from "../tool-arg-aliases";

const OWNER_ID = "b961de75-2cf0-06bc-9d61-82f32e752c63";
const ADMIN_PLACEHOLDER = "[REDACTED:ELIZA_ADMIN_ENTITY_ID]";
const OWNER_ALIASES = Object.freeze({
	[CANONICAL_OWNER_ENTITY_ALIAS]: OWNER_ID,
});

function makeState(text: string, values: State["values"] = {}): State {
	return { text, values, data: {} };
}

function makeMessage(entityId = "entity-id"): Memory {
	return {
		id: "message-id",
		entityId,
		roomId: "room-id",
		content: { text: "hello" },
	} as Memory;
}

function makeRuntime(
	actions: Action[],
	settings: Record<string, string> = {},
): IAgentRuntime {
	return {
		actions,
		agentId: "agent-id" as UUID,
		getRoom: vi.fn(async () => null),
		getService: vi.fn(() => undefined),
		getSetting: (key: string) => settings[key],
		reportError: vi.fn(),
		logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

describe("resolveEntityAliasRefs", () => {
	it("resolves only granted full-string placeholders, recursively", () => {
		const args = {
			entityId: ADMIN_PLACEHOLDER,
			nested: { deep: { ref: ADMIN_PLACEHOLDER } },
			list: [ADMIN_PLACEHOLDER, "plain", { ref: ADMIN_PLACEHOLDER }],
			query: "favorite color",
		};
		const resolved = resolveEntityAliasRefs(OWNER_ALIASES, args);
		expect(resolved.entityId).toBe(OWNER_ID);
		expect((resolved.nested as { deep: { ref: string } }).deep.ref).toBe(
			OWNER_ID,
		);
		expect(resolved.list).toEqual([OWNER_ID, "plain", { ref: OWNER_ID }]);
		expect(resolved.query).toBe("favorite color");
	});

	it("never mutates the input structure", () => {
		const args = {
			entityId: ADMIN_PLACEHOLDER,
			nested: { ref: ADMIN_PLACEHOLDER },
			list: [ADMIN_PLACEHOLDER],
		};
		const snapshot = structuredClone(args);
		resolveEntityAliasRefs(OWNER_ALIASES, args);
		expect(args).toEqual(snapshot);
	});

	it("returns the same reference when nothing resolves", () => {
		const args = { a: "plain", nested: { b: 1 } };
		expect(resolveEntityAliasRefs(OWNER_ALIASES, args)).toBe(args);
		expect(resolveEntityAliasRefs({}, { a: ADMIN_PLACEHOLDER })).toEqual({
			a: ADMIN_PLACEHOLDER,
		});
	});

	it("refuses guessed/ungranted aliases and embedded placeholders", () => {
		const args = {
			guessed: "[REDACTED:OTHER_TENANT_ENTITY_ID]",
			credential: "[REDACTED:OPENAI_API_KEY]",
			embedded: `prefix ${ADMIN_PLACEHOLDER} suffix`,
		};
		const resolved = resolveEntityAliasRefs(OWNER_ALIASES, args);
		expect(resolved).toBe(args);
	});

	it("refuses malformed granted values", () => {
		const args = { entityId: ADMIN_PLACEHOLDER };
		const resolved = resolveEntityAliasRefs(
			{ [CANONICAL_OWNER_ENTITY_ALIAS]: "not-a-uuid" },
			args,
		);
		expect(resolved.entityId).toBe(ADMIN_PLACEHOLDER);
	});

	it("copies a JSON-parsed own __proto__ key without swapping the prototype", () => {
		const args = JSON.parse(
			`{"entityId":"${ADMIN_PLACEHOLDER}","__proto__":{"polluted":"yes","ref":"${ADMIN_PLACEHOLDER}"}}`,
		) as Record<string, unknown>;
		const resolved = resolveEntityAliasRefs(OWNER_ALIASES, args);
		expect(resolved.entityId).toBe(OWNER_ID);
		expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
		expect(Object.hasOwn(resolved, "__proto__")).toBe(true);
		const protoEntry = Object.getOwnPropertyDescriptor(resolved, "__proto__")
			?.value as Record<string, unknown>;
		expect(protoEntry.polluted).toBe("yes");
		expect(protoEntry.ref).toBe(OWNER_ID);
		expect(
			(resolved as Record<string, unknown> & { polluted?: unknown }).polluted,
		).toBeUndefined();
	});
});

describe("buildTurnEntityAliases", () => {
	const settings = { ELIZA_ADMIN_ENTITY_ID: OWNER_ID };

	it("grants the owner alias when state carries the placeholder and roles include OWNER", async () => {
		const aliases = await buildTurnEntityAliases(
			makeRuntime([], settings),
			makeMessage(),
			makeState(`context: ${ADMIN_PLACEHOLDER}`),
			["OWNER"],
		);
		expect(aliases).toEqual({ [CANONICAL_OWNER_ENTITY_ALIAS]: OWNER_ID });
	});

	it("detects the placeholder in nested state values", async () => {
		const aliases = await buildTurnEntityAliases(
			makeRuntime([], settings),
			makeMessage(),
			makeState("", { block: { line: ADMIN_PLACEHOLDER } } as never),
			["OWNER"],
		);
		expect(aliases).toEqual({ [CANONICAL_OWNER_ENTITY_ALIAS]: OWNER_ID });
	});

	it("returns no grants when the placeholder was not emitted this turn", async () => {
		const aliases = await buildTurnEntityAliases(
			makeRuntime([], settings),
			makeMessage(),
			makeState("no placeholder here"),
			["OWNER"],
		);
		expect(aliases).toEqual({});
	});

	it("returns no grants without an OWNER role", async () => {
		const aliases = await buildTurnEntityAliases(
			makeRuntime([], settings),
			makeMessage(),
			makeState(ADMIN_PLACEHOLDER),
			["USER"],
		);
		expect(aliases).toEqual({});
	});

	it("returns no grants when canonical owner resolution is not UUID-shaped", async () => {
		const aliases = await buildTurnEntityAliases(
			makeRuntime([], { ELIZA_ADMIN_ENTITY_ID: "12345" }),
			makeMessage(),
			makeState(ADMIN_PLACEHOLDER),
			["OWNER"],
		);
		expect(aliases).toEqual({});
	});
});

describe("statePresentsEntityAlias", () => {
	it("requires the exact placeholder token", () => {
		expect(
			statePresentsEntityAlias(
				makeState("[REDACTED:SOMETHING_ELSE]"),
				CANONICAL_OWNER_ENTITY_ALIAS,
			),
		).toBe(false);
		expect(
			statePresentsEntityAlias(undefined, CANONICAL_OWNER_ENTITY_ALIAS),
		).toBe(false);
	});
});

describe("executePlannedToolCall alias boundary", () => {
	const UUID_PATTERN =
		"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

	function entityAction(
		onParameters: (parameters: ActionParameters | undefined) => void,
	): Action {
		return {
			name: "SEARCH_MEMORIES",
			description: "Search memories for an entity",
			parameters: [
				{
					name: "entityId",
					description: "Entity to search",
					required: true,
					schema: { type: "string", pattern: UUID_PATTERN },
				},
			],
			validate: async () => true,
			handler: async (_runtime, _message, _state, options) => {
				onParameters(options?.parameters);
				return { success: true };
			},
		};
	}

	it("resolves an emitted alias on an owner-authorized turn without consulting settings by model text", async () => {
		let seen: ActionParameters | undefined;
		const getSetting = vi.fn((key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
		);
		const runtime = makeRuntime([
			entityAction((parameters) => {
				seen = parameters;
			}),
		]);
		(runtime as { getSetting: typeof getSetting }).getSetting = getSetting;

		const toolArgs = { entityId: ADMIN_PLACEHOLDER };
		const result = await executePlannedToolCall(
			runtime,
			{
				message: makeMessage(),
				state: makeState(`owner: ${ADMIN_PLACEHOLDER}`),
				userRoles: ["OWNER"],
			},
			{ name: "SEARCH_MEMORIES", params: toolArgs },
		);

		expect(result.success).toBe(true);
		expect(seen?.entityId).toBe(OWNER_ID);
		// The planner-visible args copy keeps the placeholder.
		expect(toolArgs.entityId).toBe(ADMIN_PLACEHOLDER);
		// Only the canonical owner alias key is ever consulted — the arbitrary
		// name embedded in model output cannot drive a settings read.
		for (const [key] of getSetting.mock.calls) {
			expect(key).not.toBe("SOME_OTHER_SETTING");
		}
	});

	it("refuses a guessed alias the composed state never emitted", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const runtime = makeRuntime(
			[
				{
					...entityAction(() => {}),
					handler,
				},
			],
			{ ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
		);

		const result = await executePlannedToolCall(
			runtime,
			{
				message: makeMessage(),
				state: makeState("no placeholder in the composed state"),
				userRoles: ["OWNER"],
			},
			{ name: "SEARCH_MEMORIES", params: { entityId: ADMIN_PLACEHOLDER } },
		);

		expect(result.success).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it("refuses the alias on a non-owner turn even when state emitted it", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const runtime = makeRuntime([{ ...entityAction(() => {}), handler }], {
			ELIZA_ADMIN_ENTITY_ID: OWNER_ID,
		});

		const result = await executePlannedToolCall(
			runtime,
			{
				message: makeMessage(),
				state: makeState(ADMIN_PLACEHOLDER),
				userRoles: ["USER"],
			},
			{ name: "SEARCH_MEMORIES", params: { entityId: ADMIN_PLACEHOLDER } },
		);

		expect(result.success).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it("honors an explicitly supplied capability map over derivation", async () => {
		let seen: ActionParameters | undefined;
		const runtime = makeRuntime([
			entityAction((parameters) => {
				seen = parameters;
			}),
		]);

		const result = await executePlannedToolCall(
			runtime,
			{
				message: makeMessage(),
				userRoles: ["OWNER"],
				entityAliases: OWNER_ALIASES,
			},
			{ name: "SEARCH_MEMORIES", params: { entityId: ADMIN_PLACEHOLDER } },
		);

		expect(result.success).toBe(true);
		expect(seen?.entityId).toBe(OWNER_ID);
	});

	it("keeps an empty explicit capability map authoritative", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const runtime = makeRuntime([{ ...entityAction(() => {}), handler }], {
			ELIZA_ADMIN_ENTITY_ID: OWNER_ID,
		});

		const result = await executePlannedToolCall(
			runtime,
			{
				message: makeMessage(),
				state: makeState(ADMIN_PLACEHOLDER),
				userRoles: ["OWNER"],
				entityAliases: {},
			},
			{ name: "SEARCH_MEMORIES", params: { entityId: ADMIN_PLACEHOLDER } },
		);

		expect(result.success).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});
});
