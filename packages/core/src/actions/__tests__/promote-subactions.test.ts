/**
 * Unit tests for `actions/promote-subactions`: per-subaction parameter slicing
 * (the `ActionParameter.subactions` applicability list), discriminator
 * pinning, and the non-inheritance of `routingHint` / `descriptionCompressed`
 * on promoted virtuals. Includes a real-surface footprint regression test
 * against the MESSAGE umbrella (58 parameters, 23 subactions) proving the
 * planner tools payload shrinks massively while every subaction stays exposed
 * with the parameters its handler actually reads. Deterministic — hand-built
 * actions plus the real MESSAGE action shape, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { messageAction } from "../../features/advanced-capabilities/actions/message.ts";
import type { Action, ActionParameter, HandlerOptions } from "../../types";
import { promoteSubactionsToActions } from "../promote-subactions.ts";
import { buildPlannerToolsFromTieredActions } from "../to-tool.ts";
import { validateToolArgs } from "../validate-tool-args.ts";

function makeUmbrella(overrides: Partial<Action> = {}): Action {
	return {
		name: "WIDGET",
		description: "Operate widgets",
		descriptionCompressed:
			"widget umbrella create read delete keyword stuffed retrieval blurb",
		routingHint: "manage widgets -> WIDGET; do NOT use for gadgets -> GADGET",
		handler: async () => undefined,
		validate: async () => true,
		parameters: [
			{
				name: "action",
				description: "Widget operation.",
				required: false,
				schema: { type: "string", enum: ["create", "read", "delete"] },
			},
			{
				name: "shared",
				description: "Applies to every subaction (no applicability list).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "title",
				description: "Only for create.",
				required: false,
				subactions: ["create"],
				schema: { type: "string" },
			},
			{
				name: "widgetId",
				description: "For read and delete.",
				required: false,
				subactions: ["READ", "Delete"],
				schema: { type: "string" },
			},
		],
		...overrides,
	};
}

function paramNames(action: Action): string[] {
	return (action.parameters ?? []).map((parameter) => parameter.name);
}

function findVirtual(virtuals: readonly Action[], name: string): Action {
	const virtual = virtuals.find((entry) => entry.name === name);
	if (!virtual) throw new Error(`virtual ${name} not promoted`);
	return virtual;
}

describe("promoteSubactionsToActions parameter slicing", () => {
	it("keeps parameters without a subactions list on every virtual", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		for (const virtual of virtuals) {
			expect(paramNames(virtual)).toContain("shared");
			expect(paramNames(virtual)).toContain("action");
		}
	});

	it("drops parameters whose subactions list excludes the pinned value", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		const create = findVirtual(virtuals, "WIDGET_CREATE");
		const read = findVirtual(virtuals, "WIDGET_READ");
		const del = findVirtual(virtuals, "WIDGET_DELETE");

		expect(paramNames(create)).toEqual(["action", "shared", "title"]);
		// `widgetId` declares ["READ", "Delete"] — matching is normalized, so
		// case / separator variants still apply to the right virtuals.
		expect(paramNames(read)).toEqual(["action", "shared", "widgetId"]);
		expect(paramNames(del)).toEqual(["action", "shared", "widgetId"]);
	});

	it("pins the discriminator enum and default on each sliced virtual", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		const read = findVirtual(virtuals, "WIDGET_READ");
		const discriminator = (read.parameters ?? []).find(
			(parameter) => parameter.name === "action",
		);
		expect(discriminator?.schema.enum).toEqual(["read"]);
		expect(discriminator?.schema.default).toBe("read");
	});

	it("treats an explicit empty subactions list as parent-only", () => {
		const umbrella = makeUmbrella({
			parameters: [
				...(makeUmbrella().parameters ?? []),
				{
					name: "op",
					description: "Planner alias for action (parent-only).",
					required: false,
					subactions: [],
					schema: { type: "string", enum: ["create", "read", "delete"] },
				},
			],
		});
		const [parent, ...virtuals] = promoteSubactionsToActions(umbrella);
		expect(paramNames(parent as Action)).toContain("op");
		for (const virtual of virtuals) {
			expect(paramNames(virtual)).not.toContain("op");
		}
	});

	it("never slices the discriminator, even with a stray applicability list", () => {
		const umbrella = makeUmbrella();
		const parameters = umbrella.parameters as ActionParameter[];
		const discriminatorIndex = parameters.findIndex((p) => p.name === "action");
		parameters[discriminatorIndex] = {
			...parameters[discriminatorIndex],
			subactions: ["create"],
		} as ActionParameter;
		const [, ...virtuals] = promoteSubactionsToActions(umbrella);
		const read = findVirtual(virtuals, "WIDGET_READ");
		expect(paramNames(read)).toContain("action");
	});

	it("leaves the parent's parameters untouched", () => {
		const umbrella = makeUmbrella();
		const [parent] = promoteSubactionsToActions(umbrella);
		expect(paramNames(parent as Action)).toEqual([
			"action",
			"shared",
			"title",
			"widgetId",
		]);
		const title = (parent as Action).parameters?.find(
			(parameter) => parameter.name === "title",
		);
		expect(title?.subactions).toEqual(["create"]);
	});

	it("validates model args against the sliced schema (exposure == validation)", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		const create = findVirtual(virtuals, "WIDGET_CREATE");

		const ok = validateToolArgs(create, { title: "hello" });
		expect(ok.valid).toBe(true);
		// The pinned discriminator default is filled in for the handler.
		expect(ok.args?.action).toBe("create");

		const bad = validateToolArgs(create, { widgetId: "w-1" });
		expect(bad.valid).toBe(false);
		expect(bad.errors.join(" ")).toContain("widgetId");
	});

	it("dispatch still injects the discriminator for sliced virtuals", async () => {
		const handler = vi.fn(async () => undefined);
		const [, ...virtuals] = promoteSubactionsToActions(
			makeUmbrella({ handler }),
		);
		const del = findVirtual(virtuals, "WIDGET_DELETE");
		await del.handler({} as never, {} as never, undefined, {
			parameters: { widgetId: "w-1" },
		});
		const options = handler.mock.calls[0]?.[3] as HandlerOptions;
		expect(options.parameters).toMatchObject({
			action: "delete",
			subaction: "delete",
			widgetId: "w-1",
		});
	});
});

describe("promoteSubactionsToActions description / hint hygiene", () => {
	it("does not copy routingHint onto virtuals; the parent keeps it", () => {
		const [parent, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		expect((parent as Action).routingHint).toContain("manage widgets");
		for (const virtual of virtuals) {
			expect(virtual.routingHint).toBeUndefined();
		}
	});

	it("does not inherit the parent's descriptionCompressed", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		for (const virtual of virtuals) {
			expect(virtual.descriptionCompressed).toBeUndefined();
			// Consumers fall back to the composed per-subaction description.
			expect(virtual.description).toContain("subaction =");
		}
	});

	it("uses the override descriptionCompressed when provided", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella(), {
			overrides: {
				create: { descriptionCompressed: "create a widget" },
			},
		});
		expect(findVirtual(virtuals, "WIDGET_CREATE").descriptionCompressed).toBe(
			"create a widget",
		);
		expect(
			findVirtual(virtuals, "WIDGET_READ").descriptionCompressed,
		).toBeUndefined();
	});
});

describe("MESSAGE umbrella planner tools footprint (real surface)", () => {
	function buildFamilyTools() {
		const [parent, ...virtuals] = promoteSubactionsToActions(messageAction);
		return {
			parent: parent as Action,
			virtuals,
			tools: buildPlannerToolsFromTieredActions([parent], {
				tierAParents: [parent.name],
				actionLookup: new Map(virtuals.map((v) => [v.name, v])),
			}),
		};
	}

	it("still exposes every subaction as a first-class tool", () => {
		const { tools } = buildFamilyTools();
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("MESSAGE");
		for (const op of [
			"send",
			"read_channel",
			"read_with_contact",
			"search",
			"list_channels",
			"list_servers",
			"list_connections",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
			"triage",
			"list_inbox",
			"search_inbox",
			"draft_reply",
			"draft_followup",
			"respond",
			"send_draft",
			"schedule_draft_send",
			"manage",
		]) {
			expect(names).toContain(`MESSAGE_${op.toUpperCase()}`);
		}
	});

	it("keeps the full parameter surface on the parent tool", () => {
		const { tools, parent } = buildFamilyTools();
		const parentTool = tools.find((tool) => tool.name === "MESSAGE");
		expect(Object.keys(parentTool?.parameters.properties ?? {})).toHaveLength(
			(parent.parameters ?? []).length,
		);
	});

	it("exposes op-specific parameters only on the relevant virtuals", () => {
		const { tools } = buildFamilyTools();
		const props = (name: string) =>
			Object.keys(
				tools.find((tool) => tool.name === name)?.parameters.properties ?? {},
			);

		const send = props("MESSAGE_SEND");
		expect(send).toEqual(
			expect.arrayContaining(["message", "attachments", "urgency", "target"]),
		);
		expect(send).not.toContain("emoji");
		expect(send).not.toContain("draftId");
		expect(send).not.toContain("worldIds");

		const readChannel = props("MESSAGE_READ_CHANNEL");
		expect(readChannel).toEqual(
			expect.arrayContaining(["from", "until", "to"]),
		);

		const react = props("MESSAGE_REACT");
		expect(react).toEqual(expect.arrayContaining(["emoji", "messageId"]));
		expect(react).not.toContain("attachments");

		const triage = props("MESSAGE_TRIAGE");
		expect(triage).toEqual(
			expect.arrayContaining(["sources", "worldIds", "sinceMs"]),
		);
		expect(triage).not.toContain("message");
		expect(triage).not.toContain("emoji");

		// list_connections takes no parameters beyond the pinned discriminator.
		expect(props("MESSAGE_LIST_CONNECTIONS")).toEqual(["action"]);
	});

	it("cuts the family tools payload to well under half of the unsliced size", () => {
		const { tools } = buildFamilyTools();
		const sliced = JSON.stringify(tools).length;

		// Counterfactual: the same umbrella with every applicability list
		// stripped — the pre-slicing behavior where each virtual duplicates
		// the parent's full schema.
		const unslicedAction: Action = {
			...messageAction,
			parameters: (messageAction.parameters ?? []).map(
				({ subactions: _subactions, ...parameter }) => parameter,
			),
		};
		const [parent, ...virtuals] = promoteSubactionsToActions(unslicedAction);
		const unsliced = JSON.stringify(
			buildPlannerToolsFromTieredActions([parent], {
				tierAParents: [parent.name],
				actionLookup: new Map(virtuals.map((v) => [v.name, v])),
			}),
		).length;

		expect(sliced).toBeLessThan(unsliced * 0.4);
		// Absolute guard so the surface cannot silently flood again: the
		// measured pre-fix payload for this family was ~163 KB.
		expect(sliced).toBeLessThan(60_000);
	});

	it("virtual tool descriptions no longer duplicate the parent's routing hint and blurb", () => {
		const { tools, parent } = buildFamilyTools();
		const hint = parent.routingHint ?? "";
		expect(hint.length).toBeGreaterThan(0);
		const parentTool = tools.find((tool) => tool.name === "MESSAGE");
		expect(parentTool?.description).toContain(hint);
		for (const tool of tools) {
			if (tool.name === "MESSAGE") continue;
			expect(tool.description).not.toContain(hint);
			expect(tool.description).not.toContain(
				parent.descriptionCompressed ?? "<none>",
			);
			expect(tool.description.length).toBeLessThan(300);
		}
	});
});
