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
import { AppPermissionsViewSchema } from "@elizaos/shared";
import { SETTINGS_SECTION_META } from "@elizaos/ui/components/settings/settings-section-meta";
import { normalizeActionOptions, readStringOption } from "../params.js";

/** The three verbs SETTINGS understands. */
export type SettingsVerb = "get" | "set" | "list";

/** Result of dispatching one owned `set` to a section's backend route. */
export interface SettingsRouteOutcome {
	ok: boolean;
	/** Human-facing confirmation or failure detail. */
	detail?: string;
	/** Parsed JSON body for command/read-modify-write settings routes. */
	data?: unknown;
}

export interface SettingsRouteRequest {
	method: "GET" | "PUT" | "POST";
	path: string;
	body?: unknown;
}

/**
 * Executes one HTTP call against a settings section's own backend loopback
 * route. Injectable so unit tests exercise routing/validation without a live
 * server; the default hits `127.0.0.1:<server port>`.
 */
export type SettingsRouteFetch = (
	request: SettingsRouteRequest,
) => Promise<SettingsRouteOutcome>;

/**
 * A single writable key on an owned (`route`) section: how to parse the value,
 * how to turn it into a backend request, and how to narrate success. Kept per
 * key (not per section) because one section can expose several independent
 * toggles that map to different routes.
 */
export interface SettingsWritableKey {
	description: string;
	/**
	 * Accepted value shape. `boolean` accepts on/off/true/false/enable/disable;
	 * `command` executes an operation whose parameters are carried separately.
	 */
	valueType: "boolean" | "command";
	/** Build the backend request for a parsed value. */
	buildRequest?: (value: boolean) => SettingsRouteRequest;
	/** Execute command or multi-step route-backed writes. */
	apply?: (args: {
		keyName: string;
		request: SettingsRequest;
		routeFetch: SettingsRouteFetch;
		value: boolean | null;
	}) => Promise<SettingsRouteOutcome>;
	/** Confirmation text once the route returns ok. */
	successText: (
		value: boolean | null,
		request: SettingsRequest,
		outcome: SettingsRouteOutcome,
		keyName: string,
	) => string;
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

const AUTO_TRAINING_KEY: SettingsWritableKey = {
	description:
		"Whether trajectory thresholds may automatically start the training pipeline.",
	valueType: "boolean",
	buildRequest: (enabled) => ({
		method: "POST",
		path: "/api/training/auto/config",
		body: { autoTrain: enabled },
	}),
	successText: (enabled) =>
		enabled
			? "Auto-training is on. The training pipeline can start from trajectory thresholds."
			: "Auto-training is off. Trajectory counters can still collect data, but automatic training will not start.",
};

function readBackupFileName(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const backup = (data as { backup?: unknown }).backup;
	if (!backup || typeof backup !== "object") return null;
	const fileName = (backup as { fileName?: unknown }).fileName;
	return typeof fileName === "string" ? fileName : null;
}

const CREATE_BACKUP_KEY: SettingsWritableKey = {
	description:
		"Create an encrypted local backup of the current agent state through the same route as the Back Up Agent button.",
	valueType: "command",
	apply: ({ routeFetch }) =>
		routeFetch({ method: "POST", path: "/api/backups", body: {} }),
	successText: (_value, _request, outcome) => {
		const fileName = readBackupFileName(outcome.data);
		return fileName
			? `Created local agent backup ${fileName}.`
			: "Created a local agent backup.";
	},
};

const RESTORE_BACKUP_KEY: SettingsWritableKey = {
	description:
		"Restore a named local agent backup. Requires fileName=<backup> and confirm=true because restore overwrites local state and requires restart.",
	valueType: "command",
	apply: ({ request, routeFetch }) => {
		if (!request.fileName) {
			return Promise.resolve({
				ok: false,
				detail: "provide fileName=<backup file name> to restore",
			});
		}
		if (parseBooleanValue(request.confirm) !== true) {
			return Promise.resolve({
				ok: false,
				detail:
					"confirm=true is required before restoring a backup because it overwrites local state",
			});
		}
		return routeFetch({
			method: "POST",
			path: "/api/backups/restore",
			body: { fileName: request.fileName },
		});
	},
	successText: (_value, request) =>
		`Restored local agent backup ${request.fileName}. Restart the agent to activate it.`,
};

function encodePathSegment(value: string): string {
	return encodeURIComponent(value);
}

const PERMISSION_NAMESPACE_ALIASES: ReadonlyMap<string, string> = new Map([
	["fs", "fs"],
	["file", "fs"],
	["files", "fs"],
	["filesystem", "fs"],
	["storage", "fs"],
	["net", "net"],
	["network", "net"],
	["internet", "net"],
	["web", "net"],
]);

function resolvePermissionNamespace(token: string | null): string | null {
	if (!token) return null;
	return PERMISSION_NAMESPACE_ALIASES.get(token.trim().toLowerCase()) ?? null;
}

const APP_PERMISSION_NAMESPACE_KEY: SettingsWritableKey = {
	description:
		"Grant or revoke one recognised permission namespace for a registered app. Requires app=<slug>; key/namespace is fs or net.",
	valueType: "boolean",
	apply: async ({ request, routeFetch, value }) => {
		const appSlug = request.app;
		if (!appSlug) {
			return {
				ok: false,
				detail:
					"provide the app slug with app=<slug> (for example, app=my-app)",
			};
		}
		const namespace = resolvePermissionNamespace(
			request.namespace ?? request.key,
		);
		if (!namespace) {
			return {
				ok: false,
				detail: "provide namespace/key as fs or net",
			};
		}
		if (value === null) {
			return {
				ok: false,
				detail: "provide value=on or value=off for the app permission",
			};
		}

		const path = `/api/apps/permissions/${encodePathSegment(appSlug)}`;
		const current = await routeFetch({ method: "GET", path });
		if (!current.ok) return current;

		const parsed = AppPermissionsViewSchema.safeParse(current.data);
		if (!parsed.success) {
			return {
				ok: false,
				detail: "app permissions route returned an invalid permission view",
			};
		}
		const view = parsed.data;
		if (!view.recognisedNamespaces.includes(namespace as "fs" | "net")) {
			return {
				ok: false,
				detail: `${appSlug} does not declare the ${namespace} permission namespace`,
			};
		}

		const next = new Set(view.grantedNamespaces);
		if (value) next.add(namespace as "fs" | "net");
		else next.delete(namespace as "fs" | "net");
		return routeFetch({
			method: "PUT",
			path,
			body: { namespaces: [...next] },
		});
	},
	successText: (enabled, request, _outcome, keyName) => {
		const appSlug = request.app ?? "the app";
		return enabled
			? `${appSlug} ${keyName} permission is granted.`
			: `${appSlug} ${keyName} permission is revoked.`;
	},
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
		kind: "route",
		summary:
			"Capability toggles that already have backend settings routes, including automatic training.",
		keys: { "auto-training": AUTO_TRAINING_KEY },
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
		kind: "route",
		summary:
			"Local agent backup create/restore operations. Restore requires explicit confirmation.",
		keys: {
			"create-backup": CREATE_BACKUP_KEY,
			backup: CREATE_BACKUP_KEY,
			"restore-backup": RESTORE_BACKUP_KEY,
			restore: RESTORE_BACKUP_KEY,
		},
	},
	"app-permissions": {
		kind: "route",
		summary: "Grant or revoke app permission namespaces for a registered app.",
		keys: {
			fs: APP_PERMISSION_NAMESPACE_KEY,
			net: APP_PERMISSION_NAMESPACE_KEY,
		},
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
	fileName: string | null;
	confirm: string | null;
	app: string | null;
	namespace: string | null;
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
	const fileName = readStringOption(options, "fileName");
	const confirm = readStringOption(options, "confirm");
	const app =
		readStringOption(options, "app") ?? readStringOption(options, "slug");
	const namespace = readStringOption(options, "namespace");

	if (!verb) {
		// A bare `section` with a `value` but no verb reads as an implicit `set`;
		// a bare `section` alone reads as `get`. No section and no verb -> not a
		// SETTINGS turn.
		if (!sectionId) return null;
		return {
			verb: value || key ? "set" : "get",
			sectionId,
			key,
			value,
			fileName,
			confirm,
			app,
			namespace,
		};
	}
	return { verb, sectionId, key, value, fileName, confirm, app, namespace };
}

async function defaultRouteFetch(
	request: SettingsRouteRequest,
): Promise<SettingsRouteOutcome> {
	const port = resolveServerOnlyPort(process.env);
	const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
		method: request.method,
		headers: { "Content-Type": "application/json" },
		body: request.body === undefined ? undefined : JSON.stringify(request.body),
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
	return { ok: true, data: parsed };
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
	const requestedKeyName =
		request.namespace ?? request.key ?? Object.keys(cap.keys)[0];
	const keyName =
		request.sectionId === "app-permissions"
			? (resolvePermissionNamespace(requestedKeyName) ?? requestedKeyName)
			: requestedKeyName;
	const writable = keyName ? cap.keys[keyName] : undefined;
	if (!writable) {
		const known = Object.keys(cap.keys).join(", ");
		const reply = `I don't know how to set "${request.key}" on ${request.sectionId}. I can change: ${known}.`;
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}

	const parsedValue =
		writable.valueType === "boolean" ? parseBooleanValue(request.value) : null;
	if (writable.valueType === "boolean" && parsedValue === null) {
		const reply = `Tell me on or off for ${request.sectionId} ${keyName}.`;
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}

	logger.info(
		`[SettingsAction] set section=${request.sectionId} key=${keyName} value=${parsedValue}`,
	);
	const outcome = writable.apply
		? await writable.apply({
				keyName,
				request,
				routeFetch,
				value: parsedValue,
			})
		: writable.buildRequest && parsedValue !== null
			? await routeFetch(writable.buildRequest(parsedValue))
			: {
					ok: false,
					detail: `no route handler is registered for ${request.sectionId} ${keyName}`,
				};
	if (!outcome.ok) {
		const reply = `I couldn't change ${request.sectionId} ${keyName}: ${outcome.detail ?? "the settings route failed"}.`;
		await callback?.({ text: reply });
		return { success: false, text: reply };
	}
	const reply = writable.successText(parsedValue, request, outcome, keyName);
	await callback?.({ text: reply });
	return {
		success: true,
		text: reply,
		values: {
			section: request.sectionId,
			key: keyName,
			...(parsedValue === null ? {} : { value: parsedValue }),
			...(request.fileName ? { fileName: request.fileName } : {}),
			...(request.app ? { app: request.app } : {}),
		},
		data: {
			section: request.sectionId,
			key: keyName,
			...(parsedValue === null ? {} : { value: parsedValue }),
			...(request.fileName ? { fileName: request.fileName } : {}),
			...(request.app ? { app: request.app } : {}),
		},
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
			"AUTO_TRAINING",
			"AUTOMATIC_TRAINING",
			"TOGGLE_AUTO_TRAINING",
			"ENABLE_AUTO_TRAINING",
			"DISABLE_AUTO_TRAINING",
			"BACKUP_AGENT",
			"CREATE_AGENT_BACKUP",
			"RESTORE_AGENT_BACKUP",
			"APP_PERMISSIONS",
			"APP_PERMISSION",
			"GRANT_APP_PERMISSION",
			"REVOKE_APP_PERMISSION",
		],
		description:
			"Change a built-in settings VALUE or run a built-in settings operation from chat — most importantly turning OS/runtime permissions like shell access on/off via section=permissions key=shell, turning automatic training on/off via section=capabilities key=auto-training, granting/revoking an app permission namespace via section=app-permissions app=<slug> key=fs|net value=on|off, and creating/restoring local agent backups via section=advanced key=create-backup|restore-backup. Restore requires fileName and confirm=true. Also reads (`action=get`) or lists (`action=list`) which settings are changeable. `action=set` writes an owned section or points to the dedicated action that owns a delegated section (models→MODEL_SWITCH, background→BACKGROUND, identity→CHARACTER, connectors→CONNECTOR, secrets→CREDENTIALS). This CHANGES a setting's value or runs an explicit settings operation; opening a settings page without changing anything is VIEWS. Never fill a settings field with agent-fill.",
		descriptionCompressed:
			"settings get|set|list section/key/value — CHANGE a setting VALUE or run a settings operation, incl. shell access, auto-training, app permissions, and local backups",
		routingHint:
			"Semantic settings reads/writes that do NOT already have a dedicated action -> SETTINGS. Changing a PERMISSION or setting VALUE is SETTINGS action=set, NOT navigation: 'turn off shell permissions', 'disable shell access', 'turn off shell access', 'revoke shell access', 'stop the agent running shell commands', 'turn shell back on', 'change my permissions' -> SETTINGS section=permissions key=shell value=off|on. 'turn on auto-training', 'enable automatic training', 'disable auto training' -> SETTINGS section=capabilities key=auto-training value=on|off. 'revoke network access for my-app', 'grant filesystem access to sample-app' -> SETTINGS section=app-permissions app=<slug> key=net|fs value=off|on. 'back up my agent', 'create a local backup' -> SETTINGS section=advanced key=create-backup. 'restore backup <file>' -> SETTINGS section=advanced key=restore-backup fileName=<file> confirm=true; if confirm is absent, ask for confirmation. Also 'what settings can you change' / 'list settings' -> SETTINGS action=list. Do NOT use SETTINGS for changes a dedicated action owns: switching the model is MODEL_SWITCH, the background/theme is BACKGROUND, the agent identity is CHARACTER, connectors are CONNECTOR, secret/API keys are CREDENTIALS. The distinction from VIEWS is value-vs-navigation: changing/toggling a permission or setting VALUE, or running a backup operation, is SETTINGS even though it lives on a settings page; merely OPENING or navigating to a settings page with no value change is VIEWS. SETTINGS never fills a form field with agent-fill.",
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
					"Canonical settings section id or alias (e.g. permissions, capabilities, app-permissions, ai-model, background, secrets). Required for get/set.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "key",
				description:
					"The specific toggle or operation within the section (e.g. shell, auto-training, fs/net, create-backup, restore-backup). Optional; defaults to the section's primary key.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "app",
				description:
					"Registered app slug when section=app-permissions (for example my-app).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "namespace",
				description:
					"Permission namespace when section=app-permissions; accepted values are fs/filesystem or net/network.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "fileName",
				description:
					"Backup file name when section=advanced key=restore-backup.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "confirm",
				description:
					"Explicit confirmation for destructive operations. Restore requires true.",
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
