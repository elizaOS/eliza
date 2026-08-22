/**
 * Implements the PERSONALITY action, the single dispatcher for structured
 * personality-preference operations: setting or clearing the verbosity, tone,
 * and formality traits, arming or lifting the reply gate, adding or clearing
 * free-text directives, loading/saving named profiles, and showing current
 * state. Each mutation runs through the PersonalityStore service and records an
 * audit memory in the personality_audit_log table.
 *
 * Every trait/gate/directive op requires an explicit scope — "user" (the
 * requesting entity's slot) or "global" (the agent-wide slot) — with no
 * auto-inference: an ambiguous request returns a clarification rather than
 * guessing. Authorization is derived from the operation's actual reach and
 * effect: requester-only operations require USER, agent-wide inspection
 * requires ADMIN, and agent-wide reconfiguration requires OWNER. The slots
 * written here are injected back into prompts by the user-personality provider
 * and enforced by the reply-gate and verbosity helpers of the same capability.
 */
import { logger } from "../../../../logger.ts";
import { hasRoleAccess, type RoleName } from "../../../../roles.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { MemoryType } from "../../../../types/memory.ts";
import type { UUID } from "../../../../types/primitives.ts";
import { hasActionContext } from "../../../../utils/action-validation.ts";
import {
	describeUserReference,
	userReferenceLogView,
} from "../../../../utils/reference-echo.ts";
import {
	getPersonalityStore,
	type PersonalityStore,
} from "../services/personality-store.ts";
import {
	FORMALITY_VALUES,
	GLOBAL_PERSONALITY_SCOPE,
	PERSONALITY_AUDIT_TABLE,
	type PersonalityScope,
	type PersonalitySlot,
	REPLY_GATE_VALUES,
	SCOPE_VALUES,
	TONE_VALUES,
	TRAIT_VALUES,
	VERBOSITY_VALUES,
} from "../types.ts";

const PERSONALITY_OPS = [
	"set_trait",
	"clear_trait",
	"set_reply_gate",
	"lift_reply_gate",
	"add_directive",
	"clear_directives",
	"load_profile",
	"save_profile",
	"list_profiles",
	"show_state",
] as const;
type PersonalityOp = (typeof PERSONALITY_OPS)[number];

type PersonalityReach = "requester" | "agent_wide";
type PersonalityEffect = "inspect" | "reconfigure";

const PERSONALITY_OP_SHAPE: Record<
	PersonalityOp,
	{ effect: PersonalityEffect; reach: PersonalityReach | "scoped" }
> = {
	set_trait: { effect: "reconfigure", reach: "scoped" },
	clear_trait: { effect: "reconfigure", reach: "scoped" },
	set_reply_gate: { effect: "reconfigure", reach: "scoped" },
	lift_reply_gate: { effect: "reconfigure", reach: "scoped" },
	add_directive: { effect: "reconfigure", reach: "scoped" },
	clear_directives: { effect: "reconfigure", reach: "scoped" },
	show_state: { effect: "inspect", reach: "scoped" },
	load_profile: { effect: "reconfigure", reach: "agent_wide" },
	// Saving can replace shared executable personality configuration; listing
	// exposes the process-wide registry and its directive contents.
	save_profile: { effect: "reconfigure", reach: "agent_wide" },
	list_profiles: { effect: "inspect", reach: "agent_wide" },
};

const PERSONALITY_ACCESS_FLOOR: Record<
	PersonalityEffect,
	Record<PersonalityReach, RoleName>
> = {
	inspect: { requester: "USER", agent_wide: "ADMIN" },
	reconfigure: { requester: "USER", agent_wide: "OWNER" },
};

const PERSONALITY_DENY_MESSAGE: Record<PersonalityEffect, string> = {
	inspect:
		"The personality settings that apply to everyone are admin-only — ask an admin or the owner.",
	reconfigure:
		"Changing shared personality configuration is owner-only. I can change your personal settings instead.",
};

interface PersonalityParameters {
	op?: string;
	action?: string;
	subaction?: string;
	scope?: string;
	trait?: string;
	value?: string;
	mode?: string;
	directive?: string;
	name?: string;
	description?: string;
}

interface PersonalityHandlerOptions {
	parameters?: PersonalityParameters;
}

function isPersonalityOp(value: unknown): value is PersonalityOp {
	return (
		typeof value === "string" &&
		(PERSONALITY_OPS as readonly string[]).includes(value)
	);
}

function isPersonalityScope(value: unknown): value is PersonalityScope {
	return value === "user" || value === "global";
}

function resolveReach(
	op: PersonalityOp,
	scope: PersonalityScope | null,
): PersonalityReach {
	const reach = PERSONALITY_OP_SHAPE[op].reach;
	if (reach !== "scoped") return reach;
	return scope === "global" ? "agent_wide" : "requester";
}

function getStoreOrError(
	runtime: IAgentRuntime,
): PersonalityStore | { error: string } {
	const store = getPersonalityStore(runtime);
	if (!store) {
		return { error: "personality store service not available" };
	}
	return store;
}

async function recordAuditMemory(
	runtime: IAgentRuntime,
	message: Memory,
	op: PersonalityOp,
	scope: PersonalityScope,
	before: PersonalitySlot | null,
	after: PersonalitySlot | null,
): Promise<void> {
	try {
		// Serialize slot shapes through JSON so they fit MetadataValue.
		const beforeJson = before ? JSON.parse(JSON.stringify(before)) : null;
		const afterJson = after ? JSON.parse(JSON.stringify(after)) : null;
		await runtime.createMemory(
			{
				entityId: runtime.agentId,
				roomId: message.roomId,
				content: {
					text: `personality_change ${op} scope=${scope}`,
					source: "personality_change",
				},
				metadata: {
					type: MemoryType.CUSTOM,
					timestamp: Date.now(),
					actorId: message.entityId,
					targetId: after?.userId ?? before?.userId ?? GLOBAL_PERSONALITY_SCOPE,
					personalityScope: scope,
					action: op,
					before: beforeJson,
					after: afterJson,
				},
			},
			PERSONALITY_AUDIT_TABLE,
		);
	} catch (error) {
		// error-policy:J7 Audit persistence must not reverse an already-applied
		// personality mutation, but the missing audit record remains observable.
		runtime.reportError("PersonalityAction.auditMemory", error, {
			op,
			roomId: message.roomId,
		});
		logger.warn(
			{
				error: error instanceof Error ? error.message : String(error),
				op,
			},
			"Failed to write personality audit memory",
		);
	}
}

function denyResult(
	op: PersonalityOp,
	message: string,
	requirement: { reach: PersonalityReach; requiredRole: RoleName },
): ActionResult {
	return {
		text: message,
		success: false,
		values: { error: "PERMISSION_DENIED" },
		data: { action: "PERSONALITY", op, ...requirement },
	};
}

function paramError(op: PersonalityOp, message: string): ActionResult {
	return {
		text: message,
		success: false,
		values: { error: "INVALID_PARAMETERS" },
		data: { action: "PERSONALITY", op },
	};
}

function clarifyScopeResult(op: PersonalityOp): ActionResult {
	const text =
		'Did you mean this for you specifically, or globally? Please clarify the scope ("for me" / "globally").';
	return {
		text,
		success: false,
		values: {
			needsClarification: true,
			clarification: "scope",
		},
		data: { action: "PERSONALITY", op, clarification: "scope" },
	};
}

/** Render a slot as a human sentence fragment (#17923: user-facing text stays
 * human; the raw slot rides in `data.slot` for planner/log consumers). */
function summarizeSlot(slot: PersonalitySlot): string {
	const traits = [
		slot.verbosity ? `verbosity ${slot.verbosity}` : null,
		slot.tone ? `tone ${slot.tone}` : null,
		slot.formality ? `formality ${slot.formality}` : null,
	].filter((part): part is string => part !== null);
	const traitPart = traits.length > 0 ? traits.join(", ") : "no traits pinned";
	const gate =
		slot.reply_gate === "never_until_lift"
			? "staying silent until told otherwise"
			: slot.reply_gate === "on_mention"
				? "replying only when mentioned"
				: slot.reply_gate === "addressed_or_ambient"
					? "replying when addressed or to undirected chat"
					: "replying normally";
	const count = slot.custom_directives.length;
	const directives =
		count === 0
			? "no custom directives"
			: count === 1
				? "one custom directive"
				: `${count} custom directives`;
	return `${traitPart}; ${gate}; ${directives}`;
}

export const personalityAction: Action = {
	name: "PERSONALITY",
	contexts: ["settings", "agent_internal", "media", "admin", "general"],
	roleGate: { minRole: "USER" },
	similes: [
		"SET_PERSONALITY",
		"CHANGE_TONE",
		"BE_NICER",
		"BE_TERSE",
		"BE_QUIET",
		"BE_LESS_RESPONSIVE",
		"BE_MORE_AGREEABLE",
		"SHUT_UP",
		"BE_VERBOSE",
		"BE_WARMER",
		"BE_COLDER",
	],
	description:
		"Manage personality preferences. Subactions: set_trait | clear_trait | set_reply_gate | lift_reply_gate | add_directive | clear_directives | load_profile | save_profile | list_profiles | show_state. Scope is REQUIRED for trait/gate/directive changes — 'user' affects only the requester; 'global' is agent-wide. Listing shared profiles or inspecting global state requires an admin; global changes and saving or loading profiles require the owner.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "action",
			description: `Canonical discriminator: which personality operation to run: ${PERSONALITY_OPS.join(", ")}.`,
			required: true,
			schema: { type: "string", enum: [...PERSONALITY_OPS] },
		},
		{
			name: "op",
			description: "Legacy alias for `action`.",
			required: false,
			schema: { type: "string", enum: [...PERSONALITY_OPS] },
		},
		{
			name: "scope",
			description:
				"Required for set_trait/clear_trait/set_reply_gate/lift_reply_gate/add_directive/clear_directives/show_state. Use 'user' for the requester's slot. Use 'global' only when explicitly requested; agent-wide inspection requires ADMIN and reconfiguration requires OWNER.",
			required: false,
			schema: { type: "string", enum: [...SCOPE_VALUES] },
		},
		{
			name: "trait",
			description:
				"set_trait / clear_trait: which trait to modify. One of verbosity, tone, formality.",
			required: false,
			schema: { type: "string", enum: [...TRAIT_VALUES] },
		},
		{
			name: "value",
			description:
				"set_trait: the new trait value. verbosity ∈ {terse,normal,verbose}; tone ∈ {warm,neutral,direct,cold}; formality ∈ {casual,professional,formal}.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "mode",
			description: `set_reply_gate: gate mode. One of ${REPLY_GATE_VALUES.join(", ")}. 'never_until_lift' is the canonical "shut up" mode.`,
			required: false,
			schema: { type: "string", enum: [...REPLY_GATE_VALUES] },
		},
		{
			name: "directive",
			description:
				"add_directive: a free-text directive to attach to the user's slot.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "name",
			description: "load_profile / save_profile: name of the named profile.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "description",
			description: "save_profile: human-readable description of the profile.",
			required: false,
			schema: { type: "string" },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => {
		const store = getPersonalityStore(runtime);
		if (!store) return false;
		return hasActionContext(message, state, {
			contexts: ["settings", "agent_internal", "media", "admin", "general"],
		});
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const handlerOptions = options as PersonalityHandlerOptions | undefined;
		const params = handlerOptions?.parameters ?? {};
		const rawOp = params.op ?? params.action ?? params.subaction;
		const op = isPersonalityOp(rawOp) ? rawOp : null;
		if (!op) {
			const text =
				"Tell me what to change — a trait (verbosity, tone, formality), the reply gate, a directive, or a saved profile.";
			await callback?.({ text, thought: "Missing or invalid op" });
			return {
				text,
				success: false,
				values: { error: "INVALID_OP" },
				// Machine detail (the op vocabulary) stays out of the user-facing
				// text (#17923) and rides here for the planner instead.
				data: { action: "PERSONALITY", ops: [...PERSONALITY_OPS] },
			};
		}

		const storeOrError = getStoreOrError(runtime);
		if ("error" in storeOrError) {
			const text = "Personality service is not available.";
			await callback?.({ text, thought: storeOrError.error });
			return {
				text,
				success: false,
				values: { error: "SERVICE_UNAVAILABLE" },
				data: { action: "PERSONALITY", op },
			};
		}
		const store = storeOrError;

		const scope: PersonalityScope | null = isPersonalityScope(params.scope)
			? params.scope
			: null;

		// Clarify before authorization so a missing scope cannot be silently
		// upgraded or downgraded to a different blast radius.
		if (PERSONALITY_OP_SHAPE[op].reach === "scoped" && !scope) {
			const result = clarifyScopeResult(op);
			await callback?.({ text: result.text, thought: "Ambiguous scope" });
			return result;
		}

		const effect = PERSONALITY_OP_SHAPE[op].effect;
		const reach = resolveReach(op, scope);
		const requiredRole = PERSONALITY_ACCESS_FLOOR[effect][reach];
		if (!(await hasRoleAccess(runtime, message, requiredRole))) {
			return denyResult(op, PERSONALITY_DENY_MESSAGE[effect], {
				reach,
				requiredRole,
			});
		}

		const userId = message.entityId as UUID;
		const agentId = runtime.agentId;
		const actorId = message.entityId as UUID;

		switch (op) {
			case "set_trait":
				return runSetTrait({
					runtime,
					message,
					store,
					scope: scope as PersonalityScope,
					params,
					callback,
					userId,
					agentId,
					actorId,
				});
			case "clear_trait":
				return runClearTrait({
					runtime,
					message,
					store,
					scope: scope as PersonalityScope,
					params,
					callback,
					userId,
					agentId,
					actorId,
				});
			case "set_reply_gate":
				return runSetReplyGate({
					runtime,
					message,
					store,
					scope: scope as PersonalityScope,
					params,
					callback,
					userId,
					agentId,
					actorId,
				});
			case "lift_reply_gate":
				return runLiftReplyGate({
					runtime,
					message,
					store,
					scope: scope as PersonalityScope,
					callback,
					userId,
					agentId,
					actorId,
				});
			case "add_directive":
				return runAddDirective({
					runtime,
					message,
					store,
					params,
					callback,
					userId,
					agentId,
					actorId,
					scope: scope as PersonalityScope,
				});
			case "clear_directives":
				return runClearDirectives({
					runtime,
					message,
					store,
					scope: scope as PersonalityScope,
					callback,
					userId,
					agentId,
					actorId,
				});
			case "load_profile":
				return runLoadProfile({
					runtime,
					message,
					store,
					params,
					callback,
					agentId,
					actorId,
				});
			case "save_profile":
				return runSaveProfile({ store, params, callback });
			case "list_profiles":
				return runListProfiles({ store, callback });
			case "show_state":
				return runShowState({
					store,
					scope: scope as PersonalityScope,
					callback,
					userId,
					agentId,
				});
		}
	},

	examples: [
		[
			{ name: "{{user}}", content: { text: "shut up" } },
			{
				name: "{{agent}}",
				content: {
					text: "Okay — I'll stay silent until you tell me to talk again.",
					actions: ["PERSONALITY"],
				},
			},
		],
		[
			{ name: "{{user}}", content: { text: "be terse with me" } },
			{
				name: "{{agent}}",
				content: {
					text: "Got it. I'll keep replies short for you.",
					actions: ["PERSONALITY"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: { text: "load the focused profile globally" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Loaded 'focused' as the global personality.",
					actions: ["PERSONALITY"],
				},
			},
		],
		[
			{ name: "{{user}}", content: { text: "be nicer" } },
			{
				name: "{{agent}}",
				content: {
					text: "Did you mean this for you specifically, or globally?",
					actions: ["PERSONALITY"],
				},
			},
		],
	] as ActionExample[][],
};

interface OpArgs {
	runtime: IAgentRuntime;
	message: Memory;
	store: PersonalityStore;
	callback?: HandlerCallback;
	userId: UUID;
	agentId: UUID;
	actorId: UUID;
}

function isValidTraitValue(
	trait: "verbosity" | "tone" | "formality",
	value: string,
): boolean {
	if (trait === "verbosity")
		return (VERBOSITY_VALUES as readonly string[]).includes(value);
	if (trait === "tone")
		return (TONE_VALUES as readonly string[]).includes(value);
	return (FORMALITY_VALUES as readonly string[]).includes(value);
}

async function runSetTrait(
	args: OpArgs & {
		scope: PersonalityScope;
		params: PersonalityParameters;
	},
): Promise<ActionResult> {
	const trait = args.params.trait;
	const value = args.params.value;
	if (!trait || !(TRAIT_VALUES as readonly string[]).includes(trait)) {
		const text = "Which trait should I change — verbosity, tone, or formality?";
		await args.callback?.({ text, thought: "Missing trait" });
		return paramError("set_trait", text);
	}
	if (typeof value !== "string" || value.length === 0) {
		const text = "What should I set it to? (e.g. terse, warm, casual.)";
		await args.callback?.({ text, thought: "Missing value" });
		return paramError("set_trait", text);
	}
	if (!isValidTraitValue(trait as "verbosity" | "tone" | "formality", value)) {
		// Blob-safe rendering rationale lives in utils/reference-echo.ts.
		const text = `I can't set ${trait} to ${describeUserReference(value, "that value")} — that's not one of the options.`;
		await args.callback?.({ text, thought: "Invalid value" });
		return paramError("set_trait", text);
	}

	const { before, after } = await args.store.applyTrait({
		scope: args.scope,
		userId: args.userId,
		agentId: args.agentId,
		actorId: args.actorId,
		trait: trait as "verbosity" | "tone" | "formality",
		value,
	});

	await recordAuditMemory(
		args.runtime,
		args.message,
		"set_trait",
		args.scope,
		before,
		after,
	);

	// Human ack (#17923): the trait/value pair is machine detail and already
	// rides in `values` + `data.after`; the spoken/rendered line stays plain.
	const text =
		args.scope === "user"
			? `Okay — I'll be ${value} with you from here on.`
			: `Okay — I'll be ${value} with everyone from now on.`;
	await args.callback?.({
		text,
		thought: `Personality trait updated: ${trait}=${value} (${args.scope})`,
		actions: ["PERSONALITY"],
	});
	// Every personality confirmation below is the complete answer to its turn:
	// verified + turnComplete make the action's own callback the sole delivery
	// instead of double-messaging with a second planner/evaluator reply
	// (observed live on set_reply_gate: the user got the confirmation twice).
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { scope: args.scope, trait, value },
		data: { action: "PERSONALITY", op: "set_trait", after },
	};
}

async function runClearTrait(
	args: OpArgs & {
		scope: PersonalityScope;
		params: PersonalityParameters;
	},
): Promise<ActionResult> {
	const trait = args.params.trait;
	if (!trait || !(TRAIT_VALUES as readonly string[]).includes(trait)) {
		const text = "Which trait should I clear — verbosity, tone, or formality?";
		await args.callback?.({ text, thought: "Missing trait" });
		return paramError("clear_trait", text);
	}
	const { before, after } = await args.store.applyTrait({
		scope: args.scope,
		userId: args.userId,
		agentId: args.agentId,
		actorId: args.actorId,
		trait: trait as "verbosity" | "tone" | "formality",
		value: null,
	});
	await recordAuditMemory(
		args.runtime,
		args.message,
		"clear_trait",
		args.scope,
		before,
		after,
	);
	const text =
		args.scope === "user"
			? `Cleared ${trait} for you.`
			: `Cleared ${trait} globally.`;
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { scope: args.scope, trait },
		data: { action: "PERSONALITY", op: "clear_trait", after },
	};
}

async function runSetReplyGate(
	args: OpArgs & {
		scope: PersonalityScope;
		params: PersonalityParameters;
	},
): Promise<ActionResult> {
	const mode = args.params.mode;
	if (!mode || !(REPLY_GATE_VALUES as readonly string[]).includes(mode)) {
		const text =
			"Should I always reply, reply only when mentioned, or stay silent until told otherwise?";
		await args.callback?.({ text, thought: "Missing mode" });
		return paramError("set_reply_gate", text);
	}
	const { before, after } = await args.store.applyReplyGate({
		scope: args.scope,
		userId: args.userId,
		agentId: args.agentId,
		actorId: args.actorId,
		mode: mode as PersonalitySlot["reply_gate"],
	});
	await recordAuditMemory(
		args.runtime,
		args.message,
		"set_reply_gate",
		args.scope,
		before,
		after,
	);
	let text: string;
	if (mode === "never_until_lift") {
		text =
			args.scope === "user"
				? "Okay — I'll stay silent until you tell me to talk again."
				: "Okay — I'll stay silent everywhere until an admin lifts it.";
	} else if (mode === "on_mention") {
		text =
			args.scope === "user"
				? "Got it — I'll only reply when you @-mention me."
				: "Got it — I'll only reply when @-mentioned (global).";
	} else if (mode === "addressed_or_ambient") {
		text =
			args.scope === "user"
				? "Got it — I'll join in when you address me or when chat is undirected, and stay out of turns aimed at someone else."
				: "Got it — I'll engage when addressed or when chat is undirected, never in turns aimed at someone else (global).";
	} else {
		text =
			args.scope === "user"
				? "Reply gate cleared — I'll respond normally to you."
				: "Reply gate cleared globally.";
	}
	await args.callback?.({
		text,
		thought: `Reply gate set: ${mode} (${args.scope})`,
		actions: ["PERSONALITY"],
	});
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { scope: args.scope, mode },
		data: { action: "PERSONALITY", op: "set_reply_gate", after },
	};
}

async function runLiftReplyGate(
	args: OpArgs & { scope: PersonalityScope },
): Promise<ActionResult> {
	const { before, after } = await args.store.applyReplyGate({
		scope: args.scope,
		userId: args.userId,
		agentId: args.agentId,
		actorId: args.actorId,
		mode: "always",
	});
	await recordAuditMemory(
		args.runtime,
		args.message,
		"lift_reply_gate",
		args.scope,
		before,
		after,
	);
	const text =
		args.scope === "user"
			? "Reply gate lifted — back to normal."
			: "Global reply gate lifted.";
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { scope: args.scope, mode: "always" },
		data: { action: "PERSONALITY", op: "lift_reply_gate", after },
	};
}

async function runAddDirective(
	args: OpArgs & {
		scope: PersonalityScope;
		params: PersonalityParameters;
	},
): Promise<ActionResult> {
	if (args.scope !== "user") {
		const text =
			"Custom directives are per-person right now — I can only add that for you specifically.";
		await args.callback?.({ text, thought: "Unsupported scope" });
		return paramError("add_directive", text);
	}
	const directive = args.params.directive?.trim();
	if (!directive) {
		const text = "What should I keep in mind? Give me the directive text.";
		await args.callback?.({ text, thought: "Missing directive" });
		return paramError("add_directive", text);
	}
	const { before, after } = await args.store.addDirective({
		userId: args.userId,
		agentId: args.agentId,
		actorId: args.actorId,
		directive,
	});
	await recordAuditMemory(
		args.runtime,
		args.message,
		"add_directive",
		"user",
		before,
		after,
	);
	const text = "Got it — I'll keep that in mind for our chats.";
	await args.callback?.({
		text,
		thought: `Added directive: ${directive}`,
		actions: ["PERSONALITY"],
	});
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			scope: "user",
			directiveCount: after.custom_directives.length,
		},
		data: { action: "PERSONALITY", op: "add_directive", after },
	};
}

async function runClearDirectives(
	args: OpArgs & { scope: PersonalityScope },
): Promise<ActionResult> {
	const { before, after } = await args.store.clearDirectives({
		scope: args.scope,
		userId: args.userId,
		agentId: args.agentId,
		actorId: args.actorId,
	});
	await recordAuditMemory(
		args.runtime,
		args.message,
		"clear_directives",
		args.scope,
		before,
		after,
	);
	const text =
		args.scope === "user"
			? "Cleared your personal directives."
			: "Cleared the global directives.";
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { scope: args.scope },
		data: { action: "PERSONALITY", op: "clear_directives", after },
	};
}

async function runLoadProfile(args: {
	runtime: IAgentRuntime;
	message: Memory;
	store: PersonalityStore;
	params: PersonalityParameters;
	callback?: HandlerCallback;
	agentId: UUID;
	actorId: UUID;
}): Promise<ActionResult> {
	const name = args.params.name?.trim();
	if (!name) {
		const text = "Which profile should I load?";
		await args.callback?.({ text, thought: "Missing name" });
		return paramError("load_profile", text);
	}
	const profile = args.store.getProfile(name);
	if (!profile) {
		// Blob-safe rendering rationale lives in utils/reference-echo.ts.
		const text = `I don't have a profile named ${describeUserReference(name, "that profile")} saved — ask me to list the profiles.`;
		await args.callback?.({ text, thought: "Unknown profile" });
		return paramError("load_profile", text);
	}
	const { before, after } = await args.store.loadProfileIntoGlobal(
		profile,
		args.agentId,
		args.actorId,
	);
	await recordAuditMemory(
		args.runtime,
		args.message,
		"load_profile",
		"global",
		before,
		after,
	);
	const text = `Loaded '${profile.name}' as the global personality. ${profile.description}`;
	await args.callback?.({
		text,
		thought: `Loaded profile: ${profile.name}`,
		actions: ["PERSONALITY"],
	});
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { profile: profile.name },
		data: { action: "PERSONALITY", op: "load_profile", profile },
	};
}

async function runSaveProfile(args: {
	store: PersonalityStore;
	params: PersonalityParameters;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	// Clamped at save time: a blob-shaped planner name stored raw would
	// re-broadcast wholesale on every later list_profiles render.
	const name = userReferenceLogView(args.params.name?.trim() ?? "");
	if (!name) {
		const text = "What should I call this profile?";
		await args.callback?.({ text, thought: "Missing name" });
		return paramError("save_profile", text);
	}
	const description =
		args.params.description?.trim() || "User-saved personality profile";
	const current = args.store.getSlot(GLOBAL_PERSONALITY_SCOPE);
	const profile = args.store.snapshotSlotAsProfile(current, name, description);
	// Blob-safe rendering rationale lives in utils/reference-echo.ts.
	const text = `Saved current global personality as ${describeUserReference(name, "that profile")}.`;
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { profile: profile.name },
		data: { action: "PERSONALITY", op: "save_profile", profile },
	};
}

async function runListProfiles(args: {
	store: PersonalityStore;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const profiles = args.store.listProfiles();
	const text =
		profiles.length === 0
			? "No saved profiles yet."
			: profiles
					.map((profile) => `• ${profile.name}: ${profile.description}`)
					.join("\n");
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { profileCount: profiles.length },
		data: { action: "PERSONALITY", op: "list_profiles", profiles },
	};
}

async function runShowState(args: {
	store: PersonalityStore;
	scope: PersonalityScope;
	callback?: HandlerCallback;
	userId: UUID;
	agentId: UUID;
}): Promise<ActionResult> {
	const target =
		args.scope === "global" ? GLOBAL_PERSONALITY_SCOPE : args.userId;
	const slot = args.store.getSlot(target, args.agentId);
	const recent = args.store.getRecentAudit(10);
	const text =
		args.scope === "user"
			? `Here's how I'm tuned for you: ${summarizeSlot(slot)}.`
			: `Here's how I'm tuned for everyone: ${summarizeSlot(slot)}.`;
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: { scope: args.scope },
		data: {
			action: "PERSONALITY",
			op: "show_state",
			slot,
			recentAudit: recent,
		},
	};
}
