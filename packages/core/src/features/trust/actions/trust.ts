/**
 * @module features/trust/actions/trust
 *
 * Unified TRUST umbrella action. The discriminator parameter `action` selects
 * one of:
 *   - `evaluate` — read a trust profile for an entity
 *   - `record_interaction` — log a trust-affecting interaction
 *   - `request_elevation` — request temporary permission elevation
 *   - `update_role` — change an entity's role in the world (admin/owner/none)
 *
 * Legacy discriminator aliases (`subaction`, `op`, `operation`) are also
 * accepted as input. Each subaction's behavior lives in a sibling handler
 * file as a plain function; this file is pure dispatch.
 *
 * The umbrella is registered alongside its virtual top-level subactions via
 * `promoteSubactionsToActions(trustAction)`.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
} from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import { evaluateTrustHandler } from "./evaluateTrust.ts";
import { hasTrustEngine } from "./hasTrustEngine.ts";
import { recordTrustInteractionHandler } from "./recordTrustInteraction.ts";
import { requestElevationHandler } from "./requestElevation.ts";
import { updateRoleHandler } from "./roles.ts";

export type TrustSubaction =
	| "evaluate"
	| "record_interaction"
	| "request_elevation"
	| "update_role";

const SUBACTIONS: readonly TrustSubaction[] = [
	"evaluate",
	"record_interaction",
	"request_elevation",
	"update_role",
] as const;

type ActionOptions = Record<string, unknown>;

function readNestedParameters(
	options: ActionOptions | undefined,
): ActionOptions | undefined {
	const parameters = options?.parameters;
	if (
		typeof parameters !== "object" ||
		parameters === null ||
		Array.isArray(parameters)
	) {
		return undefined;
	}
	return parameters as ActionOptions;
}

function readStringOption(
	options: ActionOptions | undefined,
	key: string,
): string | undefined {
	const nested = readNestedParameters(options);
	const value = nested?.[key] ?? options?.[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSubaction(value: string): TrustSubaction | null {
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	switch (normalized) {
		case "evaluate":
		case "check":
		case "lookup":
			return "evaluate";
		case "record_interaction":
		case "record":
		case "log_interaction":
		case "track":
			return "record_interaction";
		case "request_elevation":
		case "elevate":
		case "elevation":
			return "request_elevation";
		case "update_role":
		case "assign_role":
		case "set_role":
		case "change_role":
		case "make_admin":
			return "update_role";
		default:
			return (SUBACTIONS as readonly string[]).includes(normalized)
				? (normalized as TrustSubaction)
				: null;
	}
}

function inferSubaction(
	options: ActionOptions | undefined,
): TrustSubaction | null {
	const explicit =
		readStringOption(options, "action") ??
		readStringOption(options, "subaction") ??
		readStringOption(options, "op") ??
		readStringOption(options, "operation");
	if (explicit) return normalizeSubaction(explicit);
	return null;
}

export const trustAction: Action = {
	name: "TRUST",
	contexts: ["admin", "settings", "agent_internal"],
	roleGate: { minRole: "USER" },
	suppressPostActionContinuation: true,
	similes: [
		"TRUST_MANAGEMENT",
		"TRUST_OPERATION",
		"TRUST_PROFILE",
		"TRUST_INTERACTION",
		"ELEVATE_PERMISSIONS",
		"ASSIGN_ROLE",
		"CHANGE_ROLE",
		"MAKE_ADMIN",
		"SET_PERMISSIONS",
	],
	description:
		"Unified trust system control. action=evaluate reads a trust profile for an entity; record_interaction logs a trust-affecting event; request_elevation requests temporary permissions; update_role assigns OWNER / ADMIN / NONE roles within a world.",

	parameters: [
		{
			name: "action",
			description:
				"Action: evaluate | record_interaction | request_elevation | update_role.",
			required: true,
			schema: { type: "string" as const, enum: [...SUBACTIONS] },
		},

		// evaluate
		{
			name: "entityId",
			description:
				"Target entity ID. evaluate: defaults to sender. record_interaction: target of the interaction (defaults to agent).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "entityName",
			description:
				"Optional target entity name (evaluate). Name-only lookups return a bounded failure; provide entityId where possible.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "detailed",
			description:
				"Whether evaluate should return detailed dimensions (default false).",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},

		// record_interaction
		{
			name: "type",
			description: "Trust evidence type (record_interaction).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "targetEntityId",
			description:
				"Legacy alias for entityId in record_interaction. Defaults to the agent ID.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "impact",
			description: "Numerical trust impact (record_interaction). Default 10.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "description",
			description: "Optional interaction description (record_interaction).",
			required: false,
			schema: { type: "string" as const },
		},

		// request_elevation
		{
			name: "permissionAction",
			description: "Permission action being requested (request_elevation).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "resource",
			description: "Resource scope for elevation (request_elevation).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "justification",
			description: "Reason elevation is needed (request_elevation).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "duration",
			description:
				"Requested duration in hours (request_elevation). Defaults to 60.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 168 },
		},

		// update_role
		{
			name: "roleAssignments",
			description: "Role assignments (update_role).",
			required: false,
			schema: {
				type: "array" as const,
				items: {
					type: "object" as const,
					properties: {
						entityId: { type: "string" as const },
							newRole: {
								type: "string" as const,
								enum: ["OWNER", "ADMIN", "NONE"],
							},
					},
					required: ["entityId", "newRole"],
				},
			},
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: ActionOptions,
	): Promise<boolean> => {
		const hasStructuredAction = Boolean(inferSubaction(options));
		if (hasStructuredAction) {
			// Structured callers may target a subaction that doesn't need the
			// trust engine (update_role only needs the world). Accept and let
			// the dispatcher route + return a friendly failure if required.
			return true;
		}

		// Free-form trigger: require the trust engine to be available so we
		// don't match conversations in agents without the trust feature on.
		if (!hasTrustEngine(runtime)) return false;
		return hasActionContext(message, state, {
			contexts: ["admin", "settings", "agent_internal"],
			keywords: [
				"trust score",
				"trust profile",
				"trust level",
				"trust rating",
				"record trust",
				"trust interaction",
				"trust evidence",
				"request elevation",
				"elevate permissions",
				"temporary access",
				"grant me access",
				"update role",
				"change role",
				"assign role",
				"make admin",
				"set permissions",
			],
		});
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: ActionOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const subaction = inferSubaction(options);
		if (!subaction) {
			return {
				success: false,
				text: "Specify a trust action: evaluate, record_interaction, request_elevation, or update_role.",
				error: "Missing trust subaction",
				data: { actionName: "TRUST" },
			};
		}

		switch (subaction) {
			case "evaluate":
				return evaluateTrustHandler(runtime, message, state, options);
			case "record_interaction":
				return recordTrustInteractionHandler(runtime, message, state, options);
			case "request_elevation":
				return requestElevationHandler(runtime, message, state, options);
			case "update_role":
				return updateRoleHandler(runtime, message, state, options, callback);
		}
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: { text: "What is my trust score?" },
			},
			{
				name: "{{name2}}",
				content: {
					text: "Trust Level: Good (65/100) based on 42 interactions",
					action: "TRUST",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Record that Alice kept their promise to help with the project",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Trust interaction recorded: PROMISE_KEPT with impact +15",
					action: "TRUST",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "I need permission to manage roles to help moderate spam",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Elevation approved! You have been granted temporary manage_roles permissions.",
					action: "TRUST",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "Make {{name2}} an ADMIN", source: "discord" },
			},
			{
				name: "{{name3}}",
				content: {
					text: "Updated {{name2}}'s role to ADMIN.",
					action: "TRUST",
				},
			},
		],
	],
};
