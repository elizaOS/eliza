import { logger } from "../../../../logger.ts";
import { hasRoleAccess } from "../../../../roles.ts";
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
	getPersonalityStore,
	type PersonalityStore,
} from "../services/personality-store.ts";
import {
	FORMALITY_VALUES,
	GLOBAL_PERSONALITY_SCOPE,
	MAX_CUSTOM_DIRECTIVES,
	MAX_DIRECTIVE_CHARS,
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

const ADMIN_REQUIRED_GLOBAL_OPS = new Set<PersonalityOp>([
	"set_trait",
	"clear_trait",
	"set_reply_gate",
	"lift_reply_gate",
	"clear_directives",
]);

const ADMIN_ONLY_OPS = new Set<PersonalityOp>(["load_profile", "save_profile"]);

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
		logger.warn(
			{
				error: error instanceof Error ? error.message : String(error),
				op,
			},
			"Failed to write personality audit memory",
		);
	}
}

function denyResult(op: PersonalityOp, message: string): ActionResult {
	return {
		text: message,
		success: false,
		values: { error: "PERMISSION_DENIED" },
		data: { action: "PERSONALITY", op },
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

function summarizeSlot(slot: PersonalitySlot): string {
	const parts = [
		`verbosity=${slot.verbosity ?? "—"}`,
		`tone=${slot.tone ?? "—"}`,
		`formality=${slot.formality ?? "—"}`,
		`reply_gate=${slot.reply_gate ?? "—"}`,
		`directives=${slot.custom_directives.length}`,
	];
	return parts.join(" ");
}

export const personalityAction: Action = {
	name: "PERSONALITY",
	contexts: ["settings", "agent_internal", "media", "admin", "general"],
	similes: [
		"SET_PERSONALITY",
		"CHANGE_TONE",
		"BE_NICER",
		"BE_TERSE",
		"BE_QUIET",
		"BE_LESS_RESPONSIVE",
		"BE_MORE_AGREEABLE",
		"SHUT_UP",
		"STOP_TALKING",
		"BE_VERBOSE",
		"BE_WARMER",
		"BE_COLDER",
	],
	description:
		"Manage personality preferences. Subactions: set_trait | clear_trait | set_reply_gate | lift_reply_gate | add_directive | clear_directives | load_profile | save_profile | list_profiles | show_state. Scope is REQUIRED for trait/gate/directive changes — 'user' affects only the requesting user, 'global' affects all users (admin only).",
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
				"Required for set_trait/clear_trait/set_reply_gate/lift_reply_gate/add_directive/clear_directives/show_state. Use 'user' for the requesting user's slot, or 'global' for the agent-wide slot (admin only).",
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
				"add_directive: a free-text directive to attach to the user's slot (≤200 chars, ≤5 active directives, FIFO eviction).",
			required: false,
			schema: { type: "string", maxLength: MAX_DIRECTIVE_CHARS },
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
			keywords: [
				"personality",
				"shut up",
				"be quiet",
				"stop talking",
				"be nicer",
				"be terse",
				"be verbose",
				"less responsive",
				"more agreeable",
				"only respond when",
				"only when mentioned",
				"stop responding",
				"tone",
				"verbosity",
				"formality",
				"reply gate",
				"profile",
			],
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
			const text = `PERSONALITY requires an op: ${PERSONALITY_OPS.join(", ")}.`;
			await callback?.({ text, thought: "Missing or invalid op" });
			return {
				text,
				success: false,
				values: { error: "INVALID_OP" },
				data: { action: "PERSONALITY" },
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

		const isAdmin = await hasRoleAccess(runtime, message, "ADMIN");

		// Admin-only ops gate first
		if (ADMIN_ONLY_OPS.has(op) && !isAdmin) {
			return denyResult(
				op,
				`Permission denied: only admins or the owner may run ${op}.`,
			);
		}

		const scope: PersonalityScope | null = isPersonalityScope(params.scope)
			? params.scope
			: null;

		// Ops that need scope: enforce explicit scope (NO auto-inference). This
		// is the "non-ambiguity" the user explicitly asked for.
		const needsScope: ReadonlySet<PersonalityOp> = new Set<PersonalityOp>([
			"set_trait",
			"clear_trait",
			"set_reply_gate",
			"lift_reply_gate",
			"add_directive",
			"clear_directives",
			"show_state",
		]);
		if (needsScope.has(op) && !scope) {
			const result = clarifyScopeResult(op);
			await callback?.({ text: result.text, thought: "Ambiguous scope" });
			return result;
		}

		if (scope === "global" && ADMIN_REQUIRED_GLOBAL_OPS.has(op) && !isAdmin) {
			return denyResult(
				op,
				`Permission denied: only admins or the owner may change the global personality.`,
			);
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
		const text = `set_trait requires a trait: ${TRAIT_VALUES.join(", ")}.`;
		await args.callback?.({ text, thought: "Missing trait" });
		return paramError("set_trait", text);
	}
	if (typeof value !== "string" || value.length === 0) {
		const text = "set_trait requires a value.";
		await args.callback?.({ text, thought: "Missing value" });
		return paramError("set_trait", text);
	}
	if (!isValidTraitValue(trait as "verbosity" | "tone" | "formality", value)) {
		const text = `Invalid value '${value}' for trait '${trait}'.`;
		await args.callback?.({ text, thought: "Invalid value" });
		return paramError("set_trait", text);
	}

	const { before, after } = args.store.applyTrait({
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

	const text =
		args.scope === "user"
			? `Set ${trait}=${value} for you.`
			: `Set ${trait}=${value} globally.`;
	await args.callback?.({
		text,
		thought: `Personality trait updated: ${trait}=${value} (${args.scope})`,
		actions: ["PERSONALITY"],
	});
	return {
		text,
		success: true,
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
		const text = `clear_trait requires a trait: ${TRAIT_VALUES.join(", ")}.`;
		await args.callback?.({ text, thought: "Missing trait" });
		return paramError("clear_trait", text);
	}
	const { before, after } = args.store.applyTrait({
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
		const text = `set_reply_gate requires mode: ${REPLY_GATE_VALUES.join(", ")}.`;
		await args.callback?.({ text, thought: "Missing mode" });
		return paramError("set_reply_gate", text);
	}
	const { before, after } = args.store.applyReplyGate({
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
		values: { scope: args.scope, mode },
		data: { action: "PERSONALITY", op: "set_reply_gate", after },
	};
}

async function runLiftReplyGate(
	args: OpArgs & { scope: PersonalityScope },
): Promise<ActionResult> {
	const { before, after } = args.store.applyReplyGate({
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
		const text = "add_directive only supports scope='user' in this release.";
		await args.callback?.({ text, thought: "Unsupported scope" });
		return paramError("add_directive", text);
	}
	const directive = args.params.directive?.trim();
	if (!directive) {
		const text = "add_directive requires a directive string.";
		await args.callback?.({ text, thought: "Missing directive" });
		return paramError("add_directive", text);
	}
	if (directive.length > MAX_DIRECTIVE_CHARS) {
		const text = `Directive too long (max ${MAX_DIRECTIVE_CHARS} chars).`;
		await args.callback?.({ text, thought: "Directive too long" });
		return paramError("add_directive", text);
	}
	const { before, after } = args.store.addDirective({
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
	const text =
		after.custom_directives.length === MAX_CUSTOM_DIRECTIVES
			? `Got it. (You're at the ${MAX_CUSTOM_DIRECTIVES}-directive limit; oldest entries get evicted as you add more.)`
			: "Got it — I'll keep that in mind for our chats.";
	await args.callback?.({
		text,
		thought: `Added directive: ${directive}`,
		actions: ["PERSONALITY"],
	});
	return {
		text,
		success: true,
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
	const { before, after } = args.store.clearDirectives({
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
		const text = "load_profile requires `name`.";
		await args.callback?.({ text, thought: "Missing name" });
		return paramError("load_profile", text);
	}
	const profile = args.store.getProfile(name);
	if (!profile) {
		const text = `No profile named '${name}'. Try list_profiles.`;
		await args.callback?.({ text, thought: "Unknown profile" });
		return paramError("load_profile", text);
	}
	const { before, after } = args.store.loadProfileIntoGlobal(
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
		values: { profile: profile.name },
		data: { action: "PERSONALITY", op: "load_profile", profile },
	};
}

async function runSaveProfile(args: {
	store: PersonalityStore;
	params: PersonalityParameters;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const name = args.params.name?.trim();
	if (!name) {
		const text = "save_profile requires `name`.";
		await args.callback?.({ text, thought: "Missing name" });
		return paramError("save_profile", text);
	}
	const description =
		args.params.description?.trim() || "User-saved personality profile";
	const current = args.store.getSlot(GLOBAL_PERSONALITY_SCOPE);
	const profile = args.store.snapshotSlotAsProfile(current, name, description);
	const text = `Saved current global personality as '${name}'.`;
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
		values: { profile: profile.name },
		data: { action: "PERSONALITY", op: "save_profile", profile },
	};
}

async function runListProfiles(args: {
	store: PersonalityStore;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const profiles = args.store.listProfiles();
	const text = profiles
		.map((profile) => `• ${profile.name}: ${profile.description}`)
		.join("\n");
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
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
	const text = `Current ${args.scope} personality — ${summarizeSlot(slot)}`;
	await args.callback?.({ text, actions: ["PERSONALITY"] });
	return {
		text,
		success: true,
		values: { scope: args.scope },
		data: {
			action: "PERSONALITY",
			op: "show_state",
			slot,
			recentAudit: recent,
		},
	};
}
