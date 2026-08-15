/**
 * Exercises the typed per-turn alias boundary with the real planned-tool
 * executor. The deterministic harness proves authorization precedes resolution,
 * guessed names cannot read settings, and nested argument copies stay immutable.
 */
import { describe, expect, it, vi } from "vitest";
import { buildOwnerEntityToolArgAliases } from "../../services/message";
import type { Action, IAgentRuntime, Memory, State } from "../../types";
import {
	executePlannedToolCall,
	resolveToolArgAliases,
	type ToolArgAliasCapability,
} from "../execute-planned-tool-call";

const OWNER_ID = "b961de75-2cf0-46bc-9d61-82f32e752c63";
const ADMIN_ALIAS = "[REDACTED:ELIZA_ADMIN_ENTITY_ID]";
const GUESSED_ALIAS = "[REDACTED:OTHER_TENANT_ENTITY_ID]";
const UUID_PATTERN =
	"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

function makeMessage(entityId = OWNER_ID): Memory {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		agentId: "22222222-2222-4222-8222-222222222222",
		roomId: "33333333-3333-4333-8333-333333333333",
		entityId,
		content: { text: "search my history" },
	} as Memory;
}

function makeRuntime(action: Action, getSetting = vi.fn()): IAgentRuntime {
	return {
		actions: [action],
		getSetting,
		getRoom: vi.fn(async () => null),
		getService: vi.fn(() => undefined),
		reportError: vi.fn(),
		logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

function makeAction(handler = vi.fn(async () => ({ success: true }))): Action {
	return {
		name: "OWNER_HISTORY_SEARCH",
		description: "Search the owner's history",
		roleGate: { minRole: "OWNER" },
		parameters: [
			{
				name: "entityId",
				description: "Authorized owner entity",
				required: true,
				schema: { type: "string", pattern: UUID_PATTERN },
			},
		],
		validate: async () => true,
		handler,
	};
}

const capability: ToolArgAliasCapability = {
	token: ADMIN_ALIAS,
	value: OWNER_ID,
	kind: "entity_id",
};

describe("typed tool argument aliases", () => {
	it("resolves an emitted owner alias at the real executor boundary", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction(handler);
		const result = await executePlannedToolCall(
			makeRuntime(action),
			{ message: makeMessage(), userRoles: ["OWNER"] },
			{ name: action.name, params: { entityId: ADMIN_ALIAS } },
			{ toolArgAliases: [capability] },
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
		expect(handler.mock.calls[0]?.[3]).toMatchObject({
			parameters: { entityId: OWNER_ID },
		});
	});

	it("refuses a guessed alias without consulting an ambient setting", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const getSetting = vi.fn(() => OWNER_ID);
		const action = makeAction(handler);
		const result = await executePlannedToolCall(
			makeRuntime(action, getSetting),
			{ message: makeMessage(), userRoles: ["OWNER"] },
			{ name: action.name, params: { entityId: GUESSED_ALIAS } },
			{ toolArgAliases: [capability] },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("does not match pattern");
		expect(getSetting).not.toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();
	});

	it("denies the action before an unauthorized caller can use a capability", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction(handler);
		const result = await executePlannedToolCall(
			makeRuntime(action),
			{ message: makeMessage(), userRoles: ["USER"] },
			{ name: action.name, params: { entityId: ADMIN_ALIAS } },
			{ toolArgAliases: [capability] },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("not allowed");
		expect(handler).not.toHaveBeenCalled();
	});

	it("resolves nested objects and arrays without mutating planner arguments", () => {
		const args = {
			filter: {
				owners: [ADMIN_ALIAS, { backup: ADMIN_ALIAS }],
				embedded: `prefix ${ADMIN_ALIAS}`,
			},
		};
		const resolved = resolveToolArgAliases(args, [capability]);

		expect(resolved).toEqual({
			filter: {
				owners: [OWNER_ID, { backup: OWNER_ID }],
				embedded: `prefix ${ADMIN_ALIAS}`,
			},
		});
		expect(args.filter.owners).toEqual([
			ADMIN_ALIAS,
			{ backup: ADMIN_ALIAS },
		]);
	});

	it("ignores malformed capability values", () => {
		const args = { entityId: ADMIN_ALIAS };
		expect(
			resolveToolArgAliases(args, [
				{ ...capability, value: "not-a-uuid" },
			]),
		).toBe(args);
	});

	it("creates the canonical alias only for an owner turn that emitted it", async () => {
		const action = makeAction();
		const getSetting = vi.fn((key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
		);
		const runtime = makeRuntime(action, getSetting);
		const state = {
			values: {},
			data: {},
			text: `owner: ${ADMIN_ALIAS}`,
		} as State;

		await expect(
			buildOwnerEntityToolArgAliases({
				runtime,
				message: makeMessage(),
				state,
				senderRole: "OWNER",
			}),
		).resolves.toEqual([capability]);
		await expect(
			buildOwnerEntityToolArgAliases({
				runtime,
				message: makeMessage(),
				state,
				senderRole: "USER",
			}),
		).resolves.toEqual([]);
		await expect(
			buildOwnerEntityToolArgAliases({
				runtime,
				message: makeMessage(),
				state: { ...state, text: "no alias this turn" },
				senderRole: "OWNER",
			}),
		).resolves.toEqual([]);
		expect(getSetting).toHaveBeenCalledTimes(1);
		expect(getSetting).toHaveBeenCalledWith("ELIZA_ADMIN_ENTITY_ID");
	});
});
