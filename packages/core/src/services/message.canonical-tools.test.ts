/**
 * Exercises lossless promoted-family tool rendering and dispatch against real
 * action handlers. No model or connector is called; provider wire and live
 * planner behavior are verified separately by the integration workflow.
 */
import { describe, expect, it } from "vitest";
import { actionToJsonSchema, type JsonSchema } from "../actions/action-schema";
import { promoteSubactionsToActions } from "../actions/promote-subactions";
import { validateSchema } from "../actions/validate-tool-args";
import { AgentRuntime } from "../runtime";
import { createContextObject } from "../runtime/context-object";
import type { Action, ActionParameter } from "../types/components";
import {
	collectActionsFromContext,
	collectCanonicalPlannerActions,
	collectPlannerTools,
} from "./message/planned-tool";

function fixture() {
	const stored = new Map<string, string>();
	const parent: Action = {
		name: "RECORDS",
		description: "Create and update complete records.",
		parameters: [
			{
				name: "action",
				description: "Operation",
				required: true,
				schema: { type: "string", enum: ["create", "update"] },
			},
			{
				name: "id",
				description: "Record identity",
				required: true,
				schema: { type: "string" },
			},
			{
				name: "text",
				description: "Complete record text",
				required: true,
				schema: { type: "string" },
			},
		],
		handler: async (_runtime, _message, _state, options) => {
			const params = options?.parameters;
			if (typeof params?.id !== "string" || typeof params.text !== "string")
				throw new Error("Missing record input");
			if (params.action === "update" && !stored.has(params.id))
				return { success: false, error: "Record absent" };
			stored.set(params.id, params.text);
			return { success: true, data: { savedText: stored.get(params.id) } };
		},
	};
	// Mirrors owner/context admission wrappers that spread registered Actions.
	const actions = promoteSubactionsToActions(parent, {
		overrides: {
			create: {
				description: "Creation must preserve the supplied record boundary.",
			},
		},
	}).map((action) => ({
		...action,
	}));
	const context = createContextObject({
		id: "canonical-tools",
		events: actions.map((action) => ({
			id: `tool:${action.name}`,
			type: "tool",
			tool: { name: action.name, action },
		})),
	});
	return { actions, context, stored };
}

describe("canonical promoted-family planner surface", () => {
	it("retains complete arguments and dispatches successive operations through the umbrella", async () => {
		const { actions, context, stored } = fixture();
		const tools = collectPlannerTools(context, undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"RECORDS",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		const wire = JSON.parse(JSON.stringify(tools));
		const text = `${"complete payload ".repeat(12000)}last record boundary`;
		const runtime = new AgentRuntime({
			character: { name: "Canonical dispatch" },
			disableBasicCapabilities: true,
		});
		for (const action of actions) runtime.registerAction(action);
		expect(collectCanonicalPlannerActions(actions, [])).toEqual([actions[0]]);
		for (const action of ["create", "update"]) {
			const params = { action, id: "record", text: `${action}: ${text}` };
			const errors: string[] = [];
			validateSchema(wire[0].parameters as JsonSchema, params, "", errors);
			expect(errors).toEqual([]);
			const result = await actions[0].handler?.(
				runtime,
				{
					agentId: runtime.agentId,
					entityId: runtime.agentId,
					roomId: runtime.agentId,
					content: { text: "Save the complete record" },
				},
				undefined,
				{ parameters: params },
			);
			expect(result).toMatchObject({
				success: true,
				data: { savedText: params.text },
			});
			expect(stored.get("record")).toBe(params.text);
		}
		expect(collectActionsFromContext(context)).toEqual(actions);
	});

	it("keeps an explicitly selected generated alias callable with its implicit operation", async () => {
		const { actions, context, stored } = fixture();
		const tools = collectPlannerTools(context, undefined, {
			canonicalFamilies: true,
			candidateActions: ["RECORDS_CREATE"],
		});
		expect(tools.some((tool) => tool.name === "RECORDS_CREATE")).toBe(true);
		const selected = collectCanonicalPlannerActions(actions, [
			"RECORDS_CREATE",
		]);
		const alias = selected.find((action) => action.name === "RECORDS_CREATE");
		const runtime = new AgentRuntime({
			character: { name: "Alias dispatch" },
			disableBasicCapabilities: true,
		});
		const result = await alias?.handler?.(
			runtime,
			{
				agentId: runtime.agentId,
				entityId: runtime.agentId,
				roomId: runtime.agentId,
				content: { text: "Create" },
			},
			undefined,
			{ parameters: { id: "alias", text: "complete alias receipt" } },
		);
		expect(result).toMatchObject({ success: true });
		expect(stored.get("alias")).toBe("complete alias receipt");
	});

	it("does not hide an authorized alias when its umbrella is denied", () => {
		const { actions } = fixture();
		const authorized = actions.filter((action) => action.name !== "RECORDS");
		expect(collectCanonicalPlannerActions(authorized, [])).toEqual(authorized);
	});

	it("keeps independently implemented children even when named like generated aliases", () => {
		const child: Action = {
			name: "RECORDS_EXPORT",
			description: "Independent export",
			handler: async () => ({ success: true, data: { exported: true } }),
		};
		const { actions } = fixture();
		actions[0].subActions?.push(child);
		const retained = collectCanonicalPlannerActions([...actions, child], []);
		expect(retained).toEqual([actions[0], child]);
	});

	it("retains an alias if the admitted parent no longer declares its dispatch relation", () => {
		const { actions } = fixture();
		actions[0].subActions = [];
		expect(collectCanonicalPlannerActions(actions, [])).toEqual(actions);
	});
	it("does not consolidate a family with an unauthorized sibling", () => {
		const { actions } = fixture();
		const authorized = actions.filter(
			(action) => action.name !== "RECORDS_UPDATE",
		);
		expect(collectCanonicalPlannerActions(authorized, [])).toEqual(authorized);
	});
	it("reconstructs each alias parameter contract from complete parent schemas and retained guidance", () => {
		const { actions, context } = fixture();
		const tool = collectPlannerTools(context, undefined, {
			canonicalFamilies: true,
		})[0];
		const contracts: Array<{
			name: string;
			description: string;
			parameters: Array<
				ActionParameter & { schemaFromParentParameter?: string }
			>;
		}> = JSON.parse(tool.description.split("\n").at(-1) ?? "invalid");
		for (const contract of contracts) {
			const original = actions.find((action) => action.name === contract.name);
			if (!original)
				throw new Error("Alias action missing from dispatch context");
			expect(contract.description).toBe(original.description);
			const parameters = contract.parameters.map(
				({ schemaFromParentParameter, ...parameter }) => ({
					...parameter,
					schema: schemaFromParentParameter
						? actions[0].parameters?.find(
								(entry) => entry.name === schemaFromParentParameter,
							)?.schema
						: parameter.schema,
				}),
			);
			// Reassembled schemas retain pinned discriminator rejection and every
			// shared field, rather than accepting another operation under an alias.
			const schema = actionToJsonSchema({ ...original, parameters });
			const validErrors: string[] = [];
			const operation = original.parameters?.find(
				(parameter) => parameter.name === "action",
			)?.schema?.enum?.[0];
			validateSchema(
				schema,
				{ action: operation, id: "record", text: "complete boundary" },
				"",
				validErrors,
			);
			expect(validErrors).toEqual([]);
			const invalidErrors: string[] = [];
			validateSchema(
				schema,
				{
					action: "unrelated-operation",
					id: "record",
					text: "complete boundary",
				},
				"",
				invalidErrors,
			);
			expect(invalidErrors.length).toBeGreaterThan(0);
		}
	});
	it("keeps an alias direct if its umbrella requires a parameter excluded from that operation", () => {
		const parent: Action = {
			name: "FILES",
			description: "File operations",
			parameters: [
				{
					name: "action",
					description: "Operation",
					required: true,
					schema: { type: "string", enum: ["create", "list"] },
				},
				{
					name: "body",
					description: "New file body",
					required: true,
					subactions: ["create"],
					schema: { type: "string" },
				},
			],
		};
		const actions = [...promoteSubactionsToActions(parent)];
		expect(
			collectCanonicalPlannerActions(actions, []).map((action) => action.name),
		).toContain("FILES_LIST");
	});
});
