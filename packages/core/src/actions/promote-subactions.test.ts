/**
 * Unit tests for umbrella action subaction promotion and discriminator pinning.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	Action,
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "../types/index.js";
import {
	isPromotedSubactionVirtual,
	listSubactionsFromParameters,
	promotedParentRoutingHint,
	promoteSubactionsToActions,
} from "./promote-subactions.js";

function makeAction(overrides: Partial<Action> = {}): Action {
	return {
		name: "TASKS",
		description: "Manage system tasks.",
		parameters: [
			{
				name: "action",
				description: "Subaction to execute",
				required: true,
				schema: {
					type: "string",
					enum: ["create", "list", "delete"],
				},
			},
			{
				name: "title",
				description: "Task title",
				required: false,
				schema: { type: "string" },
				subactions: ["create"],
			},
		],
		handler: vi.fn(async () => ({ success: true, text: "ok" })),
		validate: vi.fn(async () => true),
		examples: [],
		...overrides,
	};
}

describe("promote-subactions", () => {
	it("extracts subactions list from discriminator parameter enum", () => {
		const action = makeAction();
		const subactions = listSubactionsFromParameters(action.parameters);
		expect(subactions).toEqual(["create", "list", "delete"]);

		expect(listSubactionsFromParameters(undefined)).toEqual([]);
		expect(listSubactionsFromParameters([])).toEqual([]);
	});

	it("promotes umbrella subactions into virtual top-level actions", () => {
		const parent = makeAction({ routingHint: "Use for background jobs." });
		const promoted = promoteSubactionsToActions(parent);

		// Returns [parent, ...virtuals]
		expect(promoted).toHaveLength(4);
		expect(promoted[0].name).toBe("TASKS");
		expect(promoted[1].name).toBe("TASKS_CREATE");
		expect(promoted[2].name).toBe("TASKS_LIST");
		expect(promoted[3].name).toBe("TASKS_DELETE");

		// Parent records subActions
		expect(parent.subActions).toEqual([
			"TASKS_CREATE",
			"TASKS_LIST",
			"TASKS_DELETE",
		]);

		// isPromotedSubactionVirtual predicate
		expect(isPromotedSubactionVirtual(promoted[0])).toBe(false);
		expect(isPromotedSubactionVirtual(promoted[1])).toBe(true);

		// promotedParentRoutingHint accessor
		const hint = promotedParentRoutingHint(promoted[1]);
		expect(hint).toEqual({ parent: "TASKS", hint: "Use for background jobs." });
	});

	it("pins discriminator and filters inapplicable parameters on virtual actions", () => {
		const parent = makeAction();
		const promoted = promoteSubactionsToActions(parent);
		const createVirtual = promoted[1];
		const listVirtual = promoted[2];

		// TASKS_CREATE keeps 'title' because subactions: ["create"]
		expect(createVirtual.parameters?.some((p) => p.name === "title")).toBe(
			true,
		);

		// TASKS_LIST drops 'title' because it only applies to create
		expect(listVirtual.parameters?.some((p) => p.name === "title")).toBe(false);

		// Discriminator is pinned to single enum value
		const discriminator = createVirtual.parameters?.find(
			(p) => p.name === "action",
		);
		expect(discriminator?.schema).toMatchObject({
			enum: ["create"],
			default: "create",
		});
	});

	it("delegates virtual execution to parent handler with merged discriminator", async () => {
		const parentHandler = vi.fn(async () => ({ success: true, text: "done" }));
		const parent = makeAction({ handler: parentHandler });
		const promoted = promoteSubactionsToActions(parent);
		const createVirtual = promoted[1];

		const mockRuntime = {} as IAgentRuntime;
		const mockMessage = {} as Memory;
		const options: HandlerOptions = {
			parameters: { title: "Buy milk" },
		};

		await createVirtual.handler(mockRuntime, mockMessage, undefined, options);

		expect(parentHandler).toHaveBeenCalledTimes(1);
		const callArgs = parentHandler.mock.calls[0];
		expect(callArgs[3]?.parameters).toEqual({
			title: "Buy milk",
			action: "create",
			subaction: "create",
		});
	});

	it("rejects conflicting explicit discriminator values on virtual actions", async () => {
		const parent = makeAction();
		const promoted = promoteSubactionsToActions(parent);
		const createVirtual = promoted[1];

		const mockRuntime = {} as IAgentRuntime;
		const mockMessage = {} as Memory;
		const options: HandlerOptions = {
			parameters: { action: "delete" }, // Conflicting with pinned 'create'
		};

		const result = await createVirtual.handler(
			mockRuntime,
			mockMessage,
			undefined,
			options,
		);

		expect(result).toMatchObject({
			success: false,
		});
		expect((result as { text: string }).text).toContain(
			"This tool is pinned to create; 'action: delete' contradicts it.",
		);
	});
});
