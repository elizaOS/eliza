/**
 * Routing regression for the SETTINGS action (#14364): a semantic settings
 * write with no dedicated action of its own ("turn off shell access") must
 * surface SETTINGS on the planner tool surface, so the model selects a
 * registered action instead of falling back to the generic `agent-fill`
 * synthetic-DOM bridge on a builtin field.
 *
 * Drives the REAL retrieval → tiering pipeline (the same `retrieveActions` →
 * `tierActionResults` calls `message.ts` makes) over the plugin's REAL action
 * metadata, so it fails whenever SETTINGS metadata regresses below the score
 * that keeps it exposed under a settings-flavored Stage-1 narrow.
 */

import { buildActionCatalog } from "@elizaos/core/runtime/action-catalog.js";
import { retrieveActions } from "@elizaos/core/runtime/action-retrieval.js";
import { tierActionResults } from "@elizaos/core/runtime/action-tiering.js";
import { satisfiesContextGate } from "@elizaos/core/runtime/context-gates.js";
import { describe, expect, it } from "vitest";
import { modelSwitchAction } from "./model-switch.ts";
import { settingsAction } from "./settings.ts";
import { viewsAction } from "./views.ts";

/**
 * Realistic sibling catalog so bm25 document-frequency + score normalization
 * matches production rather than a two-action toy corpus.
 */
const FILLER_ACTIONS = [
	{
		name: "CHARACTER",
		description:
			"Modify the agent character: name, persona, style, identity, memory flush.",
		contexts: ["settings", "character"],
	},
	{
		name: "PLUGIN",
		description:
			"Enable, disable, or configure connector plugins and integrations in settings.",
		contexts: ["settings", "connectors"],
	},
	{
		name: "SECRETS",
		description:
			"Look up or update saved credentials, passwords, and API keys in settings.",
		contexts: ["settings", "secrets"],
	},
	{
		name: "ROOM",
		description: "Manage rooms: mute, unmute, follow, unfollow.",
		contexts: ["messaging"],
	},
	{
		name: "SKILL",
		description: "Run a skill from the knowledge base.",
		contexts: ["general"],
	},
];

const CATALOG_ACTIONS = [
	settingsAction,
	modelSwitchAction,
	viewsAction,
	...FILLER_ACTIONS,
];

function routeTurn(params: {
	messageText: string;
	candidateActions: string[];
	selectedContexts: string[];
}) {
	const catalog = buildActionCatalog(CATALOG_ACTIONS);
	const retrieval = retrieveActions({
		catalog,
		messageText: params.messageText,
		candidateActions: params.candidateActions,
		selectedContexts: params.selectedContexts,
	});
	const tiered = tierActionResults({
		catalog,
		results: retrieval.results,
		narrowToCandidateActions: params.candidateActions,
	});
	return { retrieval, tiered };
}

function exposedParents(tiered: {
	tierAParents: Array<{ name: string }>;
	tierBParents: Array<{ name: string }>;
}): string[] {
	return [
		...tiered.tierAParents.map((p) => p.name),
		...tiered.tierBParents.map((p) => p.name),
	];
}

describe("SETTINGS is discoverable for un-actioned settings writes (#14364)", () => {
	it.each([
		["turn off shell access", ["UPDATE_SETTINGS", "TOGGLE_SETTING"]],
		["disable shell", ["UPDATE_SETTINGS"]],
		["what settings can you change", ["LIST_SETTINGS"]],
		["change the permissions setting", ["UPDATE_SETTINGS"]],
	])("surfaces SETTINGS for %j", (messageText, candidateActions) => {
		const { tiered } = routeTurn({
			messageText,
			candidateActions,
			selectedContexts: ["settings"],
		});
		expect(exposedParents(tiered)).toContain("SETTINGS");
	});

	it("admits SETTINGS under the settings and general context gates", () => {
		// A gated-out action can never be recovered by ranking, so the gate must
		// admit the Stage-1 contexts a settings turn actually classifies to.
		for (const context of ["settings", "general"]) {
			expect(
				satisfiesContextGate(settingsAction.contextGate, [context]),
				`SETTINGS must admit the ${context} context`,
			).toBe(true);
		}
	});

	it("is exposable: validate() returns true at exposure (no options yet)", async () => {
		// The planner-surface chokepoint calls validate(runtime, message, state)
		// with NO options — params only exist once the planner invokes the action.
		// A validate that required parsed options made SETTINGS fail its own
		// exposure gate, so it never reached the planner and shell/permission
		// writes routed to VIEWS (verified live on gpt-oss-120b). Availability must
		// not depend on params; the handler validates the actual request.
		const validate = settingsAction.validate;
		expect(validate).toBeTypeOf("function");
		const runtime = {} as never;
		const message = {
			content: { text: "turn off shell permissions" },
		} as never;
		expect(await validate?.(runtime, message)).toBe(true);
		expect(await validate?.(runtime, message, undefined, {})).toBe(true);
	});

	it("admits the admin/system contexts a permission ask can classify to", () => {
		// permissions/runtime/security sections live under SETTINGS, so a Stage-1
		// admin/system classification of a permission toggle must not gate it out.
		for (const context of ["general", "settings", "admin", "system"]) {
			expect(
				satisfiesContextGate(settingsAction.contextGate, [context], ["USER"]),
				`SETTINGS must admit the ${context} context`,
			).toBe(true);
		}
	});

	it("keeps MODEL_SWITCH ahead for model requests so SETTINGS does not shadow it", () => {
		// The registry delegates ai-model to MODEL_SWITCH; a model request must
		// still rank MODEL_SWITCH on the surface (routingHint steers there).
		const { tiered } = routeTurn({
			messageText: "switch to eliza cloud inference",
			candidateActions: ["SWITCH_MODEL"],
			selectedContexts: ["settings"],
		});
		expect(exposedParents(tiered)).toContain("MODEL_SWITCH");
	});
});
