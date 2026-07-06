/**
 * SETTINGS action — the single discoverable, semantic entry point for reading
 * and changing built-in settings sections from chat (#14364).
 *
 * Before this, chat could NAVIGATE to any settings section (VIEWS) and WRITE a
 * few of them through dedicated actions (MODEL_SWITCH, BACKGROUND, CHARACTER,
 * CONNECTOR/CREDENTIALS), but the remaining sections were reachable only via the
 * generic synthetic-DOM bridge (`agent-fill`/`agent-click`) — invisible to the
 * planner and broken under voice. This action closes that gap with one uniform
 * `action` (get|set|list) / `section` / `key` / `value` surface.
 *
 * The write path is a registry, not a switch ladder: {@link SETTINGS_WRITE_REGISTRY}
 * declares, per built-in section, exactly how it is written — `delegate` to the
 * dedicated action that already owns it (so we never duplicate MODEL_SWITCH et
 * al.), `route` through the section's own backend loopback endpoint (the SAME
 * endpoint the on-screen control calls, so view button and action are twins),
 * `readonly` for pure diagnostics, or `unwired` for a gap section whose semantic
 * write is deliberately deferred (with a stated reason). Every built-in section
 * id has a registry entry — a completeness invariant the unit test pins so the
 * catalog can never silently drift, and which the view-mutation ratchet (#14369)
 * consumes as the action-side mapping.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { logger, resolveServerOnlyPort } from "@elizaos/core";
import { SETTINGS_SECTION_META } from "@elizaos/ui/components/settings/settings-section-meta";
import { normalizeActionOptions, readStringOption } from "../params.js";

/** The three verbs SETTINGS understands. */
export type SettingsVerb = "get" | "set" | "list";

/** Result of dispatching one owned `set` to a section's backend route. */
export interface SettingsRouteOutcome {
	ok: boolean;
	/** Human-facing confirmation or failure detail. */
	detail?: string;
}

/**
 * Executes one HTTP call against a settings section's own backend loopback
 * route. Injectable so unit tests exercise routing/validation without a live
 * server; the default hits `127.0.0.1:<server port>`.
 */
export type SettingsRouteFetch = (request: {
	method: "PUT" | "POST";
	path: string;
	body: unknown;
}) => Promise<SettingsRouteOutcome>;

/**
 * A single writable key on an owned (`route`) section: how to parse the value,
 * how to turn it into a backend request, and how to narrate success. Kept per
 * key (not per section) because one section can expose several independent
 * toggles that map to different routes.
 */
export interface SettingsWritableKey {
	description: string;
	/** Accepted value shape. `boolean` accepts on/off/true/false/enable/disable. */
	valueType: "boolean";
	/** Build the backend request for a parsed value. */
	buildRequest: (value: boolean) => {
		method: "PUT" | "POST";
		path: string;
		body: unknown;
	};
	/** Confirmation text once the route returns ok. */
	successText: (value: boolean) => string;
}

/**
 * How a built-in settings section is written from chat. Discriminated so the
 * handler has zero polymorphic branching inside a single write path — each kind
 * is a distinct, traceable flow.
 */
export type SettingsSectionCapability =
	| {
			kind: "delegate";
			/** The dedicated action that already owns this section's writes. */
			action: string;
			/** One-line summary of what that action does, for `list`. */
			summary: string;
	  }
	| {
			kind: "route";
			summary: string;
			/** Writable keys, addressed by the action's `key` param. */
			keys: Record<string, SettingsWritableKey>;
	  }
	| {
			kind: "readonly";
			/** Why this section carries no write (pure diagnostic/status). */
			summary: string;
	  }
	| {
			kind: "unwired";
			/** Why the semantic write is deferred, not merely missing. */
			reason: string;
	  };

const PERMISSIONS_SHELL_KEY: SettingsWritableKey = {
	description:
		"Whether the agent may run shell commands. Turning it off disables the coding/computer-use capabilities that depend on shell access.",
	valueType: "boolean",
	buildRequest: (enabled) => ({
		method: "PUT",
		path: "/api/permissions/shell",
		body: { enabled },
	}),
	successText: (enabled) =>
		enabled
			? "Shell access is on. Coding and computer-use capabilities can run again."
			: "Shell access is off. The agent can no longer run shell commands.",
};

/**
 * The single source of truth mapping every built-in settings section to its
 * write capability. Adding a built-in section without a matching entry fails the
 * completeness test — the drift guard that keeps chat and view in lockstep.
 *
 * `delegate` targets are real, registered actions (MODEL_SWITCH/BACKGROUND live
 * in this plugin; CHARACTER/CONNECTOR/CREDENTIALS in their own plugins) — the
 * planner reaches them directly via routingHint, so `set` on a delegated section
 * only ever needs to point the way, never re-implement the write.
 */
export const SETTINGS_WRITE_REGISTRY: Readonly<
	Record<string, SettingsSectionCapability>
> = {
	identity: {
		kind: "delegate",
		action: "CHARACTER",
		summary: "Change the agent's name, persona, and identity.",
	},
	"ai-model": {
		kind: "delegate",
		action: "MODEL_SWITCH",
		summary: "Switch inference between the on-device model and Eliza Cloud.",
	},
	appearance: {
		kind: "delegate",
		action: "BACKGROUND",
		summary: "Change theme and appearance via the background control.",
	},
	background: {
		kind: "delegate",
		action: "BACKGROUND",
		summary: "Set, generate, undo, or reset the app background.",
	},
	connectors: {
		kind: "delegate",
		action: "CONNECTOR",
		summary: "Enable, disable, or configure connectors and integrations.",
	},
	secrets: {
		kind: "delegate",
		action: "CREDENTIALS",
		summary: "Store or update API keys and secrets in the vault.",
	},
	permissions: {
		kind: "route",
		summary: "OS/runtime permission toggles (e.g. shell access).",
		keys: { shell: PERMISSIONS_SHELL_KEY },
	},
	runtime: {
		kind: "readonly",
		summary:
			"Diagnostic view of how the agent is running (local/remote/cloud). To change where inference runs, use MODEL_SWITCH.",
	},
	security: {
		kind: "readonly",
		summary: "Security posture and status; no chat-writable value.",
	},
	voice: {
		kind: "unwired",
		reason:
			"Voice enable/config is not yet exposed as a semantic action; it currently lives behind the voice section controls.",
	},
	capabilities: {
		kind: "unwired",
		reason:
			"Per-capability toggles route through plugin config, not a single-value settings write.",
	},
	apps: {
		kind: "unwired",
		reason:
			"Installed-view management is handled by the VIEWS/APP surface, not a settings value.",
	},
	"remote-plugins": {
		kind: "unwired",
		reason:
			"Remote plugin host registration is developer-only and has no single-value chat write.",
	},
	"wallet-rpc": {
		kind: "unwired",
		reason:
			"RPC endpoint configuration is a structured object; wallet keys are read-only from chat.",
	},
	updates: {
		kind: "unwired",
		reason:
			"Update check/apply is an asynchronous job surface, not a settings value.",
	},
	advanced: {
		kind: "unwired",
		reason:
			"Backup and reset are destructive one-shot operations that require a dedicated confirmation flow.",
	},
	"app-permissions": {
		kind: "unwired",
		reason:
			"Per-app namespace grants are a multi-value structure, deferred to a dedicated flow.",
	},
};

/**
 * Token → canonical section id, derived from the pinned section metadata (id +
 * declared aliases). Built locally from `SETTINGS_SECTION_META` (pure data) so
 * the action stays server-safe and never pulls the renderer's section-component
 * graph.
 */
const SECTION_TOKENS: ReadonlyMap<string, string> = (() => {
	const map = new Map<string, string>();
	for (const meta of SETTINGS_SECTION_META) {
		map.set(meta.id, meta.id);
		for (const alias of meta.aliases ?? []) map.set(alias, meta.id);
	}
	return map;
})();

/** Resolve a user-typed token to a canonical built-in section id, or null. */
export function resolveSectionId(token: string | null): string | null {
	if (!token) return null;
	return SECTION_TOKENS.get(token.trim().toLowerCase()) ?? null;
}

const TRUE_VALUES = new Set(["on", "true", "enable", "enabled", "yes", "1"]);
const FALSE_VALUES = new Set([
	"off",
	"false",
	"disable",
	"disabled",
	"no",
	"0",
]);

/** Parse a boolean setting value; null when the token is not a boolean word. */
export function parseBooleanValue(value: string | null): boolean | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return null;
}

/** The fully-parsed intent of one SETTINGS invocation. */
export interface SettingsRequest {
	verb: SettingsVerb;
	sectionId: string | null;
	key: string | null;
	value: string | null;
}

const VERB_TOKENS: ReadonlyMap<string, SettingsVerb> = new Map([
	["get", "get"],
	["read", "get"],
	["show", "get"],
	["set", "set"],
	["change", "set"],
	["update", "set"],
	["toggle", "set"],
	["enable", "set"],
	["disable", "set"],
	["turn", "set"],
	["list", "list"],
	["sections", "list"],
]);

/**
 * Resolve the SETTINGS intent from explicit action options. The planner invokes
 * SETTINGS with structured params, so parsing is option-driven — SETTINGS never
 * scrapes free text for a section (that would contend with the dedicated
 * actions the routingHint steers to). Returns null when no usable verb is
 * present.
 */
export function parseSettingsRequest(
	options: Record<string, unknown> | undefined,
): SettingsRequest | null {
	const rawVerb = readStringOption(options, "action")?.toLowerCase();
	const verb = rawVerb ? VERB_TOKENS.get(rawVerb) : undefined;
	const sectionToken = readStringOption(options, "section");
	const sectionId = resolveSectionId(sectionToken);
	const key = readStringOption(options, "key");
	const value = readStringOption(options, "value");

	if (!verb) {
		// A bare `section` with a `value` but no verb reads as an implicit `set`;
		// a bare `section` alone reads as `get`. No section and no verb -> not a
		// SETTINGS turn.
		if (!sectionId) return null;
		return { verb: value ? "set" : "get", sectionId, key, value };
	}
	return { verb, sectionId, key, value };
}

async function defaultRouteFetch(request: {
	method: "PUT" | "POST";
	path: string;
	body: unknown;
}): Promise<SettingsRouteOutcome> {
	const port = resolveServerOnlyPort(process.env);
	const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
		method: request.method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request.body),
		signal: AbortSignal.timeout(30_000),
	});
	// error-policy:J3 an unparseable body is treated as no detail; the caller
	// keys success off response.ok, not the parsed shape.
	const parsed = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!response.ok) {
		const detail =
			parsed && typeof parsed.error === "string"
				? parsed.error
				: `route ${request.path} returned ${response.status}`;
		return { ok: false, detail };
	}
	return { ok: true };
}

export interface SettingsActionDeps {
	routeFetch?: SettingsRouteFetch;
}

/** Machine-readable capability list for `action=list`. */
export interface SettingsSectionListing {
	id: string;
	label: string;
	group: string;
	writable: boolean;
	/** How this section is written: the action name, "route", or a reason. */
	via: string;
}

function buildListing(): SettingsSectionListing[] {
	return SETTINGS_SECTION_META.map((meta) => {
		const cap = SETTINGS_WRITE_REGISTRY[meta.id];
		const writable = cap.kind === "delegate" || cap.kind === "route";
		const via =
			cap.kind === "delegate"
				? cap.action
				: cap.kind === "route"
					? "SETTINGS"
					: cap.kind === "readonly"
						? "read-only"
						: "not-yet-wired";
		return {
			id: meta.id,
			label: meta.defaultLabel,
			group: meta.group,
			writable,
			via,
		};
	});
}

function narrateList(listing: SettingsSectionListing[]): string {
	const writable = listing.filter((s) => s.writable);
	const lines = writable.map((s) => `- ${s.label} (${s.id}) → ${s.via}`);
	return `Settings I can change from chat:\n${lines.join("\n")}`;
}

async function handleSet(
	request: SettingsRequest,
	routeFetch: SettingsRouteFetch,
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	if (!request.sectionId) {
		const reply =
			"Tell me which settings section to change (e.g. permissions, model, background).";
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}
	const cap = SETTINGS_WRITE_REGISTRY[request.sectionId];

	if (cap.kind === "delegate") {
		// Point the planner at the dedicated action rather than duplicating its
		// write. routingHint already prefers that action; this is the safety net
		// for when the planner reached SETTINGS anyway.
		const reply = `Changing ${request.sectionId} runs through the ${cap.action} action — ${cap.summary}`;
		await callback?.({ text: reply });
		return {
			success: false,
			text: reply,
			data: { delegateTo: cap.action, section: request.sectionId },
		};
	}

	if (cap.kind === "readonly") {
		const reply = `${request.sectionId} is read-only: ${cap.summary}`;
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}

	if (cap.kind === "unwired") {
		const reply = `I can't change ${request.sectionId} from chat yet: ${cap.reason} Open it in Settings to change it there.`;
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}

	// cap.kind === "route"
	const keyName = request.key ?? Object.keys(cap.keys)[0];
	const writable = keyName ? cap.keys[keyName] : undefined;
	if (!writable) {
		const known = Object.keys(cap.keys).join(", ");
		const reply = `I don't know how to set "${request.key}" on ${request.sectionId}. I can change: ${known}.`;
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}

	const parsedValue = parseBooleanValue(request.value);
	if (parsedValue === null) {
		const reply = `Tell me on or off for ${request.sectionId} ${keyName}.`;
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}

	logger.info(
		`[SettingsAction] set section=${request.sectionId} key=${keyName} value=${parsedValue}`,
	);
	const req = writable.buildRequest(parsedValue);
	const outcome = await routeFetch(req);
	if (!outcome.ok) {
		const reply = `I couldn't change ${request.sectionId} ${keyName}: ${outcome.detail ?? "the settings route failed"}.`;
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}
	const reply = writable.successText(parsedValue);
	await callback?.({ text: reply });
	return {
		success: true,
		text: reply,
		values: { section: request.sectionId, key: keyName, value: parsedValue },
		data: { section: request.sectionId, key: keyName, value: parsedValue },
	};
}

function handleGet(
	request: SettingsRequest,
	callback: HandlerCallback | undefined,
): ActionResult {
	if (!request.sectionId) {
		const reply = "Which settings section do you want to read?";
		void callback?.({ text: reply });
		return { success: false, text: reply };
	}
	const cap = SETTINGS_WRITE_REGISTRY[request.sectionId];
	const meta = SETTINGS_SECTION_META.find((m) => m.id === request.sectionId);
	const label = meta?.defaultLabel ?? request.sectionId;
	const summary =
		cap.kind === "unwired"
			? cap.reason
			: cap.kind === "delegate"
				? `Written via the ${cap.action} action — ${cap.summary}`
				: cap.summary;
	const reply = `${label}: ${summary}`;
	void callback?.({ text: reply });
	return {
		success: true,
		text: reply,
		data: { section: request.sectionId, capability: cap.kind },
	};
}

export function createSettingsAction(deps: SettingsActionDeps = {}): Action {
	const routeFetch = deps.routeFetch ?? defaultRouteFetch;

	return {
		name: "SETTINGS",
		// SETTINGS is the entry point to EVERY built-in section, so its context
		// gate admits the contexts a settings/permission ask classifies to — not
		// only general/settings. Permission/runtime/security toggles are routinely
		// tagged admin/system by the Stage-1 classifier; gated to general/settings
		// only, SETTINGS would be hidden from the planner on those turns. It stops
		// at admin/system on purpose: code/terminal belong to the coding shell
		// action, and SETTINGS must not shadow a genuine shell-command turn.
		contexts: ["general", "settings", "admin", "system"],
		contextGate: { anyOf: ["general", "settings", "admin", "system"] },
		// Owner-only: changing settings/permissions is a privileged write.
		roleGate: { minRole: "OWNER" },
		similes: [
			"CHANGE_SETTING",
			"UPDATE_SETTINGS",
			"SETTINGS_WRITE",
			"TOGGLE_SETTING",
			"GET_SETTING",
			"LIST_SETTINGS",
			"PERMISSIONS",
			"CHANGE_PERMISSION",
			"CHANGE_PERMISSIONS",
			"SET_PERMISSION",
			"TOGGLE_PERMISSION",
			"REVOKE_PERMISSION",
			"GRANT_PERMISSION",
			"SHELL_ACCESS",
			"SHELL_PERMISSION",
			"SHELL_PERMISSIONS",
			"TOGGLE_SHELL_ACCESS",
			"DISABLE_SHELL_ACCESS",
			"ENABLE_SHELL_ACCESS",
			"TURN_OFF_SHELL",
			"TURN_OFF_SHELL_ACCESS",
			"DISABLE_SHELL",
			"ENABLE_SHELL",
			"REVOKE_SHELL_ACCESS",
			"GRANT_SHELL_ACCESS",
		],
		description:
			"Change a built-in settings VALUE from chat — most importantly turning OS/runtime permissions like shell access on or off (turn off / disable / revoke shell access, or turn it back on) via section=permissions key=shell. Also reads (`action=get`) or lists (`action=list`) which settings are changeable. `action=set` writes an owned section (permissions shell access) or points to the dedicated action that owns a delegated section (models→MODEL_SWITCH, background→BACKGROUND, identity→CHARACTER, connectors→CONNECTOR, secrets→CREDENTIALS). This CHANGES a setting's value; opening a settings page without changing anything is VIEWS. Never fill a settings field with agent-fill.",
		descriptionCompressed:
			"settings get|set|list section/key/value — CHANGE a setting VALUE from chat, incl. turning shell access / OS permissions on/off (section=permissions key=shell); delegates model/background/identity/connectors/secrets to their dedicated actions",
		routingHint:
			"Semantic settings reads/writes that do NOT already have a dedicated action -> SETTINGS. Changing a PERMISSION or setting VALUE is SETTINGS action=set, NOT navigation: 'turn off shell permissions', 'disable shell access', 'turn off shell access', 'revoke shell access', 'stop the agent running shell commands', 'turn shell back on', 'change my permissions' -> SETTINGS section=permissions key=shell value=off|on. Also 'what settings can you change' / 'list settings' -> SETTINGS action=list. Do NOT use SETTINGS for changes a dedicated action owns: switching the model is MODEL_SWITCH, the background/theme is BACKGROUND, the agent identity is CHARACTER, connectors are CONNECTOR, secret/API keys are CREDENTIALS. The distinction from VIEWS is value-vs-navigation: changing/toggling a permission or setting VALUE is SETTINGS even though that permission lives on a settings page; merely OPENING or navigating to a settings page with no value change is VIEWS. SETTINGS never fills a form field with agent-fill.",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "action",
				description: "What to do: get (read), set (change), or list.",
				required: true,
				schema: { type: "string", enum: ["get", "set", "list"] },
			},
			{
				name: "section",
				description:
					"Canonical settings section id or alias (e.g. permissions, ai-model, background, secrets). Required for get/set.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "key",
				description:
					"The specific toggle within the section (e.g. shell for permissions). Optional; defaults to the section's primary key.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "value",
				description:
					"The new value for a set. Boolean toggles accept on/off, enable/disable, true/false.",
				required: false,
				schema: { type: "string" },
			},
		],

		// `validate` is the availability gate the planner surface calls at EXPOSURE
		// time — with no `options` yet (params only exist once the planner invokes
		// the action). Gating on parsed options here made SETTINGS fail its own
		// exposure check (`parseSettingsRequest(undefined) === null`), so it never
		// reached the planner and settings/permission writes routed to VIEWS. The
		// action is always available; retrieval/tiering decides per-turn relevance,
		// and the handler validates the actual request (replying for a bad one).
		validate: async (): Promise<boolean> => true,

		handler: async (
			_runtime: IAgentRuntime,
			_message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const request = parseSettingsRequest(normalizeActionOptions(options));
			if (!request) {
				const reply =
					"Tell me what to do with settings: list them, read one, or change one (e.g. 'turn off shell access').";
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			if (request.verb === "list") {
				const listing = buildListing();
				const reply = narrateList(listing);
				await callback?.({ text: reply });
				return {
					success: true,
					text: reply,
					data: { sections: listing },
				};
			}

			if (request.verb === "get") {
				return handleGet(request, callback);
			}

			return handleSet(request, routeFetch, callback);
		},
	};
}

export const settingsAction: Action = createSettingsAction();
