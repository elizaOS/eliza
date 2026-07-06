/**
 * SETTINGS action — the single discoverable, semantic entry point for reading
 * and changing built-in settings sections from chat (#14364).
 *
 * Before this, chat could NAVIGATE to any settings section (VIEWS) and WRITE a
 * few of them through dedicated actions (MODEL_SWITCH, BACKGROUND, CHARACTER,
 * PLUGIN, SECRETS), but the remaining sections were reachable only via the
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
 * id has a registry entry, and every non-catalog settings section has an
 * explicit audit disposition — completeness invariants the unit tests pin so
 * the catalog and chat-write audit can never silently drift.
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
import {
	APPEARANCE_APPLY_EVENT,
	type AppearanceApplyPayload,
	AppPermissionsViewSchema,
	buildWalletRpcUpdateRequest,
	isPermissionId,
	normalizeWalletRpcProviderId,
	type PermissionId,
	resolveInitialWalletRpcSelections,
	type WalletConfigStatus,
	type WalletRpcChain,
	type WalletRpcSelections,
} from "@elizaos/shared";
import {
	type SETTINGS_NON_CATALOG_SECTION_META,
	SETTINGS_SECTION_META,
} from "@elizaos/ui/components/settings/settings-section-meta";
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
			/** Open issue that owns the missing action/view twin. */
			trackingIssue?: number;
			/** Durable reason this section is intentionally not chat-writable. */
			exemptionReason?: string;
	  };

export interface SettingsNonCatalogAuditEntry {
	reason: string;
	coveredBy?: string;
	trackingIssue?: number;
}

export const SETTINGS_NON_CATALOG_SECTION_AUDIT = {
	"cloud-overview": {
		reason:
			"Cloud upsell/account overview is a late-registered non-catalog page, not a local setting value.",
		coveredBy: "VIEWS navigation and cloud onboarding surfaces",
	},
	"cloud-agents": {
		reason:
			"Cloud agent create/switch/delete is a cloud agent-management workflow, not part of the local SETTINGS value registry.",
		coveredBy:
			"AGENT_SWITCH for switching; cloud agent management needs its own product action if chat-write is required.",
	},
	"my-runtimes": {
		reason:
			"Runtime registry management spans local/cloud/VPS runtimes and is outside the pinned settings catalog.",
		coveredBy:
			"MODEL_SWITCH for inference target changes; runtime CRUD needs a separate runtime-management action if chat-write is required.",
	},
} satisfies Readonly<
	Record<
		(typeof SETTINGS_NON_CATALOG_SECTION_META)[number]["id"],
		SettingsNonCatalogAuditEntry
	>
>;

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

const SYSTEM_PERMISSION_ALIASES: ReadonlyMap<string, PermissionId> = new Map([
	["accessibility", "accessibility"],
	["app-blocking", "app-blocking"],
	["automation", "automation"],
	["battery", "battery-optimization"],
	["battery-optimization", "battery-optimization"],
	["bluetooth", "bluetooth"],
	["calendar", "calendar"],
	["camera", "camera"],
	["contacts", "contacts"],
	["disk", "full-disk"],
	["full-disk", "full-disk"],
	["health", "health"],
	["local-network", "local-network"],
	["location", "location"],
	["messages", "messages"],
	["mic", "microphone"],
	["microphone", "microphone"],
	["network", "local-network"],
	["notes", "notes"],
	["notification", "notifications"],
	["notifications", "notifications"],
	["overlay", "overlay"],
	["phone", "phone"],
	["photos", "photos"],
	["reminders", "reminders"],
	["screen", "screen-recording"],
	["screen-recording", "screen-recording"],
	["screentime", "screentime"],
	["speech", "speech-recognition"],
	["speech-recognition", "speech-recognition"],
	["usage-access", "usage-access"],
	["website-blocking", "website-blocking"],
	["wifi", "wifi"],
	["write-settings", "write-settings"],
]);

function normalizePermissionToken(token: string): string {
	return token.trim().toLowerCase().replaceAll("_", "-").replace(/\s+/g, "-");
}

function resolveSystemPermissionId(token: string | null): PermissionId | null {
	if (!token) return null;
	const normalized = normalizePermissionToken(token);
	const aliased = SYSTEM_PERMISSION_ALIASES.get(normalized);
	if (aliased) return aliased;
	return isPermissionId(normalized) ? normalized : null;
}

function isPermissionStateNeedingHandoff(data: unknown): boolean {
	if (!data || typeof data !== "object") return true;
	const status = (data as { status?: unknown }).status;
	return status !== "granted";
}

function readPermissionFromOutcome(data: unknown): PermissionId | null {
	if (!data || typeof data !== "object") return null;
	const permission = (data as { permission?: unknown }).permission;
	return typeof permission === "string" && isPermissionId(permission)
		? permission
		: null;
}

function readPermissionRequestState(data: unknown): unknown {
	if (!data || typeof data !== "object") return data;
	return (data as { request?: unknown }).request ?? data;
}

function readPermissionHandoff(data: unknown): boolean {
	if (!data || typeof data !== "object") return false;
	return (data as { handoff?: unknown }).handoff === true;
}

const PERMISSIONS_REQUEST_KEY: SettingsWritableKey = {
	description:
		"Request an OS/system permission by id or alias. Use key=request permission=<id>, or key=mic|camera|location|notifications|screen-recording.",
	valueType: "command",
	apply: async ({ keyName, request, routeFetch }) => {
		const permission = resolveSystemPermissionId(
			keyName === "request"
				? (request.permission ?? request.value)
				: (request.permission ?? keyName),
		);
		if (!permission) {
			return {
				ok: false,
				detail:
					"provide permission=<id> such as microphone, camera, location, notifications, or screen-recording",
			};
		}
		if (permission === "shell") {
			return {
				ok: false,
				detail:
					"use key=shell value=on|off for shell access; OS permission request is for device permissions",
			};
		}

		const requestOutcome = await routeFetch({
			method: "POST",
			path: `/api/permissions/${encodePathSegment(permission)}/request`,
		});
		if (!requestOutcome.ok) return requestOutcome;

		let handoff = false;
		if (isPermissionStateNeedingHandoff(requestOutcome.data)) {
			const handoffOutcome = await routeFetch({
				method: "POST",
				path: "/api/views/settings/navigate",
				body: {
					path: "/settings",
					subview: "permissions",
					source: "settings-action",
					payload: { permissionRequest: { permission } },
				},
			});
			handoff = handoffOutcome.ok;
		}

		return {
			ok: true,
			data: { permission, request: requestOutcome.data, handoff },
		};
	},
	successText: (_value, request, outcome, keyName) => {
		const permission =
			readPermissionFromOutcome(outcome.data) ??
			resolveSystemPermissionId(
				keyName === "request"
					? (request.permission ?? request.value)
					: (request.permission ?? keyName),
			);
		const label = permission ?? "permission";
		if (
			!isPermissionStateNeedingHandoff(readPermissionRequestState(outcome.data))
		) {
			return `Requested ${label} permission.`;
		}
		return readPermissionHandoff(outcome.data)
			? `Requested ${label} permission. I opened Settings > Permissions so you can complete the OS prompt if it needs device-side confirmation.`
			: `Requested ${label} permission. Open Settings > Permissions to complete the OS prompt if it needs device-side confirmation.`;
	},
};

const PERMISSIONS_REQUEST_KEYS: Readonly<Record<string, SettingsWritableKey>> =
	{
		request: PERMISSIONS_REQUEST_KEY,
		mic: PERMISSIONS_REQUEST_KEY,
		microphone: PERMISSIONS_REQUEST_KEY,
		camera: PERMISSIONS_REQUEST_KEY,
		location: PERMISSIONS_REQUEST_KEY,
		notification: PERMISSIONS_REQUEST_KEY,
		notifications: PERMISSIONS_REQUEST_KEY,
		screen: PERMISSIONS_REQUEST_KEY,
		"screen-recording": PERMISSIONS_REQUEST_KEY,
		accessibility: PERMISSIONS_REQUEST_KEY,
		photos: PERMISSIONS_REQUEST_KEY,
		contacts: PERMISSIONS_REQUEST_KEY,
		calendar: PERMISSIONS_REQUEST_KEY,
		reminders: PERMISSIONS_REQUEST_KEY,
		"speech-recognition": PERMISSIONS_REQUEST_KEY,
	};

type UpdateChannel = "stable" | "beta" | "nightly";

interface UpdateStatusPayload {
	currentVersion?: string;
	channel?: string;
	installMethod?: string;
	updateAvailable?: boolean;
	latestVersion?: string | null;
	lastCheckAt?: string | null;
	error?: string | null;
	updateCommand?: string | null;
	updateInstructions?: string | null;
	canExecuteUpdate?: boolean;
}

const UPDATE_CHANNELS = new Set<UpdateChannel>(["stable", "beta", "nightly"]);

function isUpdateChannel(value: string | null): value is UpdateChannel {
	return value !== null && UPDATE_CHANNELS.has(value as UpdateChannel);
}

function readUpdateStatusPayload(data: unknown): UpdateStatusPayload {
	if (!data || typeof data !== "object") return {};
	return data as UpdateStatusPayload;
}

function describeUpdateStatus(data: unknown): string {
	const status = readUpdateStatusPayload(data);
	if (status.error) {
		return `Update check failed: ${status.error}`;
	}
	const current = status.currentVersion ?? "unknown";
	const channel = status.channel ?? "unknown";
	if (status.updateAvailable) {
		const latest = status.latestVersion ?? "the latest release";
		return `Update available: ${current} → ${latest} on ${channel}.`;
	}
	return `Current: ${current} on ${channel}.`;
}

function fetchUpdateStatus(
	routeFetch: SettingsRouteFetch,
	force: boolean,
): Promise<SettingsRouteOutcome> {
	return routeFetch({
		method: "GET",
		path: `/api/update/status${force ? "?force=true" : ""}`,
	});
}

const UPDATES_STATUS_KEY: SettingsWritableKey = {
	description:
		"Read the connected agent update status from the same backend route the Release Center uses.",
	valueType: "command",
	apply: async ({ routeFetch }) => fetchUpdateStatus(routeFetch, false),
	successText: (_value, _request, outcome) =>
		`Release status: ${describeUpdateStatus(outcome.data)}`,
};

const UPDATES_CHECK_KEY: SettingsWritableKey = {
	description:
		"Force an update check through the connected agent update-status route.",
	valueType: "command",
	apply: async ({ routeFetch }) => fetchUpdateStatus(routeFetch, true),
	successText: (_value, _request, outcome) =>
		`Update check complete. ${describeUpdateStatus(outcome.data)}`,
};

const UPDATES_CHANNEL_KEY: SettingsWritableKey = {
	description:
		"Switch the connected agent update channel to stable, beta, or nightly.",
	valueType: "command",
	apply: async ({ request, routeFetch }) => {
		if (!isUpdateChannel(request.value)) {
			return {
				ok: false,
				detail: "choose stable, beta, or nightly",
			};
		}
		const channelResult = await routeFetch({
			method: "PUT",
			path: "/api/update/channel",
			body: { channel: request.value },
		});
		if (!channelResult.ok) return channelResult;
		const status = await fetchUpdateStatus(routeFetch, true);
		return status.ok ? status : channelResult;
	},
	successText: (_value, request, outcome) =>
		`Update channel is ${request.value}. ${describeUpdateStatus(outcome.data)}`,
};

const UPDATES_APPLY_KEY: SettingsWritableKey = {
	description:
		"Report the real apply plan for an available connected-agent update. Chat does not invent a remote installer.",
	valueType: "command",
	apply: async ({ routeFetch }) => fetchUpdateStatus(routeFetch, true),
	successText: (_value, _request, outcome) => {
		const status = readUpdateStatusPayload(outcome.data);
		if (status.error) {
			return `I checked the update plan, but the update check failed: ${status.error}`;
		}
		if (!status.updateAvailable) {
			return `No update to apply. ${describeUpdateStatus(outcome.data)}`;
		}
		const instruction =
			status.updateCommand ??
			status.updateInstructions ??
			"review the host update plan";
		return status.canExecuteUpdate
			? `An update is available. Use the host updater to run: ${instruction}`
			: `An update is available, but chat cannot apply it directly. ${
					status.updateInstructions ?? `Run ${instruction} on the host.`
				}`;
	},
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

/**
 * Wallet / browser / computer-use toggles persist as `ui.capabilities.<name>`
 * in the agent config store — the same field the on-screen Capabilities
 * switches sync (`client.updateConfig`) and the legacy TOGGLE_CAPABILITY op
 * writes. Routed through the deep-merging `PUT /api/config` loopback route so
 * the chat action and the view control are twins on one write path.
 */
function makeCapabilityConfigKey(
	name: "wallet" | "browser" | "computerUse",
	label: string,
): SettingsWritableKey {
	return {
		description: `Whether the agent's ${label} capability is enabled.`,
		valueType: "boolean",
		buildRequest: (enabled) => ({
			method: "PUT",
			path: "/api/config",
			body: { ui: { capabilities: { [name]: enabled } } },
		}),
		successText: (enabled) =>
			enabled
				? `The ${label} capability is on.`
				: `The ${label} capability is off.`,
	};
}

const WALLET_CAPABILITY_KEY = makeCapabilityConfigKey("wallet", "wallet");
const BROWSER_CAPABILITY_KEY = makeCapabilityConfigKey("browser", "browser");
const COMPUTER_USE_CAPABILITY_KEY = makeCapabilityConfigKey(
	"computerUse",
	"computer-use",
);

const APPEARANCE_THEME_ALIASES: ReadonlyMap<
	string,
	AppearanceApplyPayload["themeMode"]
> = new Map([
	["light", "light"],
	["day", "light"],
	["dark", "dark"],
	["night", "dark"],
	["system", "system"],
	["auto", "system"],
	["automatic", "system"],
]);

const APPEARANCE_ACCENT_ALIASES: ReadonlyMap<string, string> = new Map([
	["default", "default"],
	["orange", "default"],
	["eliza", "default"],
	["amber", "amber"],
	["yellow", "amber"],
	["rose", "rose"],
	["pink", "rose"],
	["red", "red"],
	["green", "green"],
	["olive", "olive"],
]);

const APPEARANCE_LANGUAGE_ALIASES: ReadonlyMap<
	string,
	AppearanceApplyPayload["language"]
> = new Map([
	["en", "en"],
	["english", "en"],
	["zh-cn", "zh-CN"],
	["zh", "zh-CN"],
	["chinese", "zh-CN"],
	["mandarin", "zh-CN"],
	["ko", "ko"],
	["korean", "ko"],
	["es", "es"],
	["spanish", "es"],
	["pt", "pt"],
	["portuguese", "pt"],
	["vi", "vi"],
	["vietnamese", "vi"],
	["tl", "tl"],
	["tagalog", "tl"],
	["filipino", "tl"],
	["ja", "ja"],
	["japanese", "ja"],
]);

function normalizeAppearanceToken(value: string | null): string | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

function appearanceBroadcastRequest(
	payload: AppearanceApplyPayload,
): SettingsRouteRequest {
	return {
		method: "POST",
		path: "/api/views/events/broadcast",
		body: { type: APPEARANCE_APPLY_EVENT, payload },
	};
}

function makeAppearanceCommandKey(
	field: "themeMode" | "accentId" | "language",
	description: string,
): SettingsWritableKey {
	return {
		description,
		valueType: "command",
		apply: ({ request, routeFetch }) => {
			const token = normalizeAppearanceToken(request.value);
			const value =
				field === "themeMode"
					? APPEARANCE_THEME_ALIASES.get(token ?? "")
					: field === "accentId"
						? APPEARANCE_ACCENT_ALIASES.get(token ?? "")
						: APPEARANCE_LANGUAGE_ALIASES.get(token ?? "");
			if (!value) {
				return Promise.resolve({
					ok: false,
					detail: `provide a supported appearance value for ${field}`,
				});
			}
			return routeFetch(appearanceBroadcastRequest({ [field]: value }));
		},
		successText: (_value, request) => {
			const token = normalizeAppearanceToken(request.value);
			const value =
				field === "themeMode"
					? APPEARANCE_THEME_ALIASES.get(token ?? "")
					: field === "accentId"
						? APPEARANCE_ACCENT_ALIASES.get(token ?? "")
						: APPEARANCE_LANGUAGE_ALIASES.get(token ?? "");
			if (field === "themeMode") return `Theme mode is ${value}.`;
			if (field === "accentId") return `Accent is ${value}.`;
			return `UI language is ${value}.`;
		},
	};
}

const APPEARANCE_THEME_KEY = makeAppearanceCommandKey(
	"themeMode",
	"Theme mode: light, dark, or system.",
);
const APPEARANCE_ACCENT_KEY = makeAppearanceCommandKey(
	"accentId",
	"Accent preset: default/orange, amber, rose, red, green, or olive.",
);
const APPEARANCE_LANGUAGE_KEY = makeAppearanceCommandKey(
	"language",
	"UI language: en, zh-CN, ko, es, pt, vi, tl, or ja.",
);

const APPEARANCE_HOME_TIME_WIDGET_KEY: SettingsWritableKey = {
	description: "Whether the home time/date widget is visible.",
	valueType: "boolean",
	buildRequest: (visible) =>
		appearanceBroadcastRequest({ homeTimeWidgetHidden: !visible }),
	successText: (visible) =>
		visible
			? "Home time/date widget is shown."
			: "Home time/date widget is hidden.",
};

type VoiceContinuousMode = "off" | "vad-gated" | "always-on";

interface VoiceVadAutoStopPrefs {
	silenceMs: number;
	speechRmsThreshold: number;
}

interface VoiceSettingsPrefs {
	continuous: VoiceContinuousMode;
	vadAutoStop: VoiceVadAutoStopPrefs;
}

const VOICE_CONTINUOUS_ALIASES: ReadonlyMap<string, VoiceContinuousMode> =
	new Map([
		["off", "off"],
		["push-to-talk", "off"],
		["ptt", "off"],
		["manual", "off"],
		["vad", "vad-gated"],
		["vad-gated", "vad-gated"],
		["gated", "vad-gated"],
		["hands-free", "vad-gated"],
		["handsfree", "vad-gated"],
		["always-on", "always-on"],
		["always", "always-on"],
		["continuous", "always-on"],
		["on", "always-on"],
	]);

// These defaults fill in a partial/empty `messages.voice` config before it is
// written back through /api/config, so they MUST equal the values the running
// capture path uses when it has no stored override — `DEFAULT_LOCAL_ASR_AUTO_STOP`
// in @elizaos/ui (silenceMs 900, speechRmsThreshold 0.003), which is also what
// the Voice settings UI (`DEFAULT_VAD_AUTO_STOP`/`DEFAULT_VAD_AUTO_STOP_PREFS`)
// seeds from. Any other value here would let a chat-issued voice SETTINGS write
// (e.g. "set voice silence to 1200") silently persist a *different* VAD
// sensitivity than the Voice UI applies, so the two twins diverge (#14910). The
// literals are duplicated rather than imported because this server action must
// not pull the browser capture graph into its bundle; the drift is caught
// mechanically by a test that imports the canonical constant.
export const DEFAULT_VOICE_SETTINGS_PREFS: VoiceSettingsPrefs = {
	continuous: "off",
	vadAutoStop: {
		silenceMs: 900,
		speechRmsThreshold: 0.003,
	},
};

const VOICE_VAD_SILENCE_MIN_MS = 300;
const VOICE_VAD_SILENCE_MAX_MS = 3000;
const VOICE_VAD_RMS_MIN = 0.001;
const VOICE_VAD_RMS_MAX = 0.02;

function readPlainObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readVoiceVadAutoStop(value: unknown): VoiceVadAutoStopPrefs {
	const stored = readPlainObject(value);
	const silenceMs = stored?.silenceMs;
	const speechRmsThreshold = stored?.speechRmsThreshold;
	return {
		silenceMs:
			typeof silenceMs === "number" && Number.isFinite(silenceMs)
				? silenceMs
				: DEFAULT_VOICE_SETTINGS_PREFS.vadAutoStop.silenceMs,
		speechRmsThreshold:
			typeof speechRmsThreshold === "number" &&
			Number.isFinite(speechRmsThreshold)
				? speechRmsThreshold
				: DEFAULT_VOICE_SETTINGS_PREFS.vadAutoStop.speechRmsThreshold,
	};
}

function readVoiceSettingsPrefs(config: unknown): VoiceSettingsPrefs {
	const root = readPlainObject(config) ?? {};
	const messages = readPlainObject(root.messages) ?? {};
	const voice = readPlainObject(messages.voice) ?? {};
	const continuous =
		typeof voice.continuous === "string"
			? VOICE_CONTINUOUS_ALIASES.get(voice.continuous)
			: undefined;
	return {
		continuous: continuous ?? DEFAULT_VOICE_SETTINGS_PREFS.continuous,
		vadAutoStop: readVoiceVadAutoStop(voice.vadAutoStop),
	};
}

function readConfigMessages(config: unknown): Record<string, unknown> {
	return readPlainObject(readPlainObject(config)?.messages) ?? {};
}

function normalizeVoiceContinuousMode(
	value: string | null,
): VoiceContinuousMode | null {
	if (!value) return null;
	return VOICE_CONTINUOUS_ALIASES.get(value.trim().toLowerCase()) ?? null;
}

function parseBoundedNumber(args: {
	value: string | null;
	min: number;
	max: number;
	label: string;
}): number | string {
	if (!args.value) return `provide ${args.label}=<number>`;
	const parsed = Number(args.value);
	if (!Number.isFinite(parsed)) return `${args.label} must be a number`;
	if (parsed < args.min || parsed > args.max) {
		return `${args.label} must be between ${args.min} and ${args.max}`;
	}
	return parsed;
}

function buildVoiceSettingsPrefs(
	current: VoiceSettingsPrefs,
	keyName: string,
	value: string | null,
): VoiceSettingsPrefs | string {
	const normalizedKey = keyName.trim().toLowerCase();
	if (
		normalizedKey === "continuous" ||
		normalizedKey === "continuous-chat" ||
		normalizedKey === "mode"
	) {
		const continuous = normalizeVoiceContinuousMode(value);
		if (!continuous) {
			return "provide value=off|vad-gated|always-on for voice continuous chat";
		}
		return { ...current, continuous };
	}

	if (
		normalizedKey === "silence" ||
		normalizedKey === "silence-ms" ||
		normalizedKey === "vad-silence" ||
		normalizedKey === "end-of-turn"
	) {
		const silenceMs = parseBoundedNumber({
			value,
			min: VOICE_VAD_SILENCE_MIN_MS,
			max: VOICE_VAD_SILENCE_MAX_MS,
			label: "silenceMs",
		});
		if (typeof silenceMs === "string") return silenceMs;
		return {
			...current,
			vadAutoStop: { ...current.vadAutoStop, silenceMs },
		};
	}

	if (
		normalizedKey === "rms" ||
		normalizedKey === "sensitivity" ||
		normalizedKey === "speech-threshold" ||
		normalizedKey === "vad-rms"
	) {
		const speechRmsThreshold = parseBoundedNumber({
			value,
			min: VOICE_VAD_RMS_MIN,
			max: VOICE_VAD_RMS_MAX,
			label: "speechRmsThreshold",
		});
		if (typeof speechRmsThreshold === "string") return speechRmsThreshold;
		return {
			...current,
			vadAutoStop: { ...current.vadAutoStop, speechRmsThreshold },
		};
	}

	return "provide key=continuous|silence-ms|rms";
}

const VOICE_PREFS_KEY: SettingsWritableKey = {
	description:
		"Voice continuous-chat mode and VAD end-of-turn thresholds persisted under messages.voice through /api/config.",
	valueType: "command",
	apply: async ({ keyName, request, routeFetch }) => {
		const current = await routeFetch({ method: "GET", path: "/api/config" });
		if (!current.ok) return current;
		if (!readPlainObject(current.data)) {
			return { ok: false, detail: "config route returned an invalid object" };
		}

		const previous = readVoiceSettingsPrefs(current.data);
		const next = buildVoiceSettingsPrefs(previous, keyName, request.value);
		if (typeof next === "string") return { ok: false, detail: next };

		const messages = readConfigMessages(current.data);
		const outcome = await routeFetch({
			method: "PUT",
			path: "/api/config",
			body: { messages: { ...messages, voice: next } },
		});
		return outcome.ok ? { ...outcome, data: next } : outcome;
	},
	successText: (_value, _request, outcome) => {
		const next = readVoiceSettingsPrefs({ messages: { voice: outcome.data } });
		return `Voice settings updated: continuous chat is ${next.continuous}, silence is ${next.vadAutoStop.silenceMs}ms, speech threshold is ${next.vadAutoStop.speechRmsThreshold}.`;
	},
};

const WALLET_RPC_CHAIN_ALIASES: ReadonlyMap<string, WalletRpcChain> = new Map([
	["evm", "evm"],
	["eth", "evm"],
	["ethereum", "evm"],
	["base", "evm"],
	["avalanche", "evm"],
	["bsc", "bsc"],
	["bnb", "bsc"],
	["binance", "bsc"],
	["sol", "solana"],
	["solana", "solana"],
]);

const WALLET_RPC_NETWORKS = new Set(["mainnet", "testnet"]);

function resolveWalletRpcChain(token: string | null): WalletRpcChain | null {
	if (!token) return null;
	return WALLET_RPC_CHAIN_ALIASES.get(token.trim().toLowerCase()) ?? null;
}

function isWalletConfigStatus(data: unknown): data is WalletConfigStatus {
	return Boolean(data && typeof data === "object");
}

function normalizeWalletRpcNetwork(
	value: string | null,
): "mainnet" | "testnet" | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	return WALLET_RPC_NETWORKS.has(normalized)
		? (normalized as "mainnet" | "testnet")
		: null;
}

function readWalletRpcProviderToken(
	request: SettingsRequest,
	keyName: string,
	chain: WalletRpcChain,
): string | null {
	const chainSpecific =
		chain === "evm"
			? request.evm
			: chain === "bsc"
				? request.bsc
				: request.solana;
	if (chainSpecific) return chainSpecific;
	const providerTargetChain = resolveWalletRpcChain(request.chain ?? keyName);
	if (request.provider && providerTargetChain === chain) {
		return request.provider;
	}
	return resolveWalletRpcChain(keyName) === chain ? request.value : null;
}

function applyWalletRpcProviderSelection(
	selections: WalletRpcSelections,
	chain: WalletRpcChain,
	providerToken: string,
): void {
	if (chain === "evm") {
		const provider = normalizeWalletRpcProviderId("evm", providerToken);
		if (!provider) {
			throw new Error(
				`${providerToken} is not a supported ${chain} RPC provider`,
			);
		}
		selections.evm = provider;
		return;
	}
	if (chain === "bsc") {
		const provider = normalizeWalletRpcProviderId("bsc", providerToken);
		if (!provider) {
			throw new Error(
				`${providerToken} is not a supported ${chain} RPC provider`,
			);
		}
		selections.bsc = provider;
		return;
	}
	const provider = normalizeWalletRpcProviderId("solana", providerToken);
	if (!provider) {
		throw new Error(
			`${providerToken} is not a supported ${chain} RPC provider`,
		);
	}
	selections.solana = provider;
}

function buildWalletRpcSelections(args: {
	current: WalletRpcSelections;
	keyName: string;
	request: SettingsRequest;
}): { selections: WalletRpcSelections; network: "mainnet" | "testnet" | null } {
	const { current, keyName, request } = args;
	const selections: WalletRpcSelections = { ...current };
	const normalizedKey = keyName.trim().toLowerCase();
	const explicitNetwork = normalizeWalletRpcNetwork(
		request.network ?? (normalizedKey === "network" ? request.value : null),
	);

	if (
		normalizedKey === "cloud" ||
		normalizedKey === "managed" ||
		normalizedKey === "eliza-cloud"
	) {
		return {
			selections: {
				evm: "eliza-cloud",
				bsc: "eliza-cloud",
				solana: "eliza-cloud",
			},
			network: explicitNetwork,
		};
	}

	for (const chain of ["evm", "bsc", "solana"] as const) {
		const providerToken = readWalletRpcProviderToken(request, keyName, chain);
		if (!providerToken) continue;
		applyWalletRpcProviderSelection(selections, chain, providerToken);
	}

	const chain = resolveWalletRpcChain(request.chain ?? keyName);
	if (chain) {
		const providerToken = readWalletRpcProviderToken(request, keyName, chain);
		if (!providerToken) {
			throw new Error(`provide provider=<id> or value=<id> for ${chain} RPC`);
		}
		applyWalletRpcProviderSelection(selections, chain, providerToken);
	}

	if (
		!chain &&
		!request.evm &&
		!request.bsc &&
		!request.solana &&
		!explicitNetwork
	) {
		throw new Error(
			"provide key=evm|bsc|solana value=<provider>, key=cloud, or key=network value=mainnet|testnet",
		);
	}

	return { selections, network: explicitNetwork };
}

function describeWalletRpcSelections(selections: WalletRpcSelections): string {
	return `EVM=${selections.evm}, BSC=${selections.bsc}, Solana=${selections.solana}`;
}

const WALLET_RPC_CONFIG_KEY: SettingsWritableKey = {
	description:
		"Select wallet RPC providers without exposing API keys. Use key=evm|bsc|solana value=<provider>, key=cloud, or key=network value=mainnet|testnet.",
	valueType: "command",
	apply: async ({ keyName, request, routeFetch }) => {
		const current = await routeFetch({
			method: "GET",
			path: "/api/wallet/config",
		});
		if (!current.ok) return current;
		if (!isWalletConfigStatus(current.data)) {
			return {
				ok: false,
				detail: "wallet config route returned an invalid status",
			};
		}

		let next: {
			selections: WalletRpcSelections;
			network: "mainnet" | "testnet" | null;
		};
		try {
			next = buildWalletRpcSelections({
				current: resolveInitialWalletRpcSelections(current.data),
				keyName,
				request,
			});
		} catch (error) {
			return {
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			};
		}

		const body = buildWalletRpcUpdateRequest({
			walletConfig: current.data,
			rpcFieldValues: {},
			selectedProviders: next.selections,
			...(next.network ? { selectedNetwork: next.network } : {}),
		});
		const updated = await routeFetch({
			method: "PUT",
			path: "/api/wallet/config",
			body,
		});
		return updated.ok
			? {
					...updated,
					data: {
						selections: body.selections,
						walletNetwork: body.walletNetwork,
					},
				}
			: updated;
	},
	successText: (_value, _request, outcome) => {
		const data = outcome.data as
			| { selections?: WalletRpcSelections; walletNetwork?: string }
			| undefined;
		const selections = data?.selections
			? describeWalletRpcSelections(data.selections)
			: "wallet RPC providers";
		const network = data?.walletNetwork ? ` on ${data.walletNetwork}` : "";
		return `Updated ${selections}${network}. Manage provider credentials in Secrets/Vault if a selected provider requires one.`;
	},
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
 * `delegate` targets are the canonical action names for sections with their own
 * owner. MODEL_SWITCH/BACKGROUND live in this plugin; CHARACTER and PLUGIN are
 * registered by the default agent surface; SECRETS is the encrypted-secret
 * capability and must be enabled with the vault surface. SETTINGS points at the
 * owner instead of re-implementing those writes.
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
		kind: "route",
		summary:
			"Theme mode, accent preset, UI language, and the home time/date widget.",
		keys: {
			theme: APPEARANCE_THEME_KEY,
			"theme-mode": APPEARANCE_THEME_KEY,
			mode: APPEARANCE_THEME_KEY,
			accent: APPEARANCE_ACCENT_KEY,
			"accent-color": APPEARANCE_ACCENT_KEY,
			language: APPEARANCE_LANGUAGE_KEY,
			lang: APPEARANCE_LANGUAGE_KEY,
			"ui-language": APPEARANCE_LANGUAGE_KEY,
			"home-time-widget": APPEARANCE_HOME_TIME_WIDGET_KEY,
			"time-widget": APPEARANCE_HOME_TIME_WIDGET_KEY,
			clock: APPEARANCE_HOME_TIME_WIDGET_KEY,
		},
	},
	background: {
		kind: "delegate",
		action: "BACKGROUND",
		summary: "Set, generate, undo, or reset the app background.",
	},
	connectors: {
		kind: "delegate",
		action: "PLUGIN",
		summary:
			"Enable, disable, configure, or disconnect connector plugins and integrations.",
	},
	secrets: {
		kind: "delegate",
		action: "SECRETS",
		summary:
			"Store, update, request, mirror, or delete encrypted API keys and secrets.",
	},
	permissions: {
		kind: "route",
		summary:
			"OS/runtime permission toggles and OS permission requests (e.g. shell access, microphone, camera, location, notifications).",
		keys: { shell: PERMISSIONS_SHELL_KEY, ...PERMISSIONS_REQUEST_KEYS },
	},
	runtime: {
		kind: "readonly",
		summary:
			"Diagnostic view of how the agent is running (local/remote/cloud). To change where inference runs, use MODEL_SWITCH.",
	},
	security: {
		kind: "readonly",
		summary:
			"Security posture and host password status; password changes are deliberately not chat-writable because secrets must not flow through the model.",
	},
	voice: {
		kind: "route",
		summary:
			"Voice continuous-chat mode and VAD end-of-turn thresholds. Wake word remains a device-local toggle in Settings because it is not backed by a loopback route.",
		keys: {
			continuous: VOICE_PREFS_KEY,
			"continuous-chat": VOICE_PREFS_KEY,
			mode: VOICE_PREFS_KEY,
			silence: VOICE_PREFS_KEY,
			"silence-ms": VOICE_PREFS_KEY,
			"vad-silence": VOICE_PREFS_KEY,
			"end-of-turn": VOICE_PREFS_KEY,
			rms: VOICE_PREFS_KEY,
			sensitivity: VOICE_PREFS_KEY,
			"speech-threshold": VOICE_PREFS_KEY,
			"vad-rms": VOICE_PREFS_KEY,
		},
	},
	capabilities: {
		kind: "route",
		summary:
			"Capability toggles that already have backend settings routes: wallet, browser, computer use, and automatic training.",
		keys: {
			"auto-training": AUTO_TRAINING_KEY,
			wallet: WALLET_CAPABILITY_KEY,
			browser: BROWSER_CAPABILITY_KEY,
			computerUse: COMPUTER_USE_CAPABILITY_KEY,
			"computer-use": COMPUTER_USE_CAPABILITY_KEY,
		},
	},
	apps: {
		kind: "unwired",
		reason:
			"Installed-view management is handled by the VIEWS/APP surface, not a settings value.",
		exemptionReason:
			"APP and VIEWS own app installation, launch, creation, and view management; SETTINGS must not duplicate that workflow.",
	},
	"remote-plugins": {
		kind: "unwired",
		reason:
			"Remote plugin host registration is developer-only and has no single-value chat write.",
		exemptionReason:
			"Remote plugin registration is a developer workflow without a stable single-value setting contract.",
	},
	"wallet-rpc": {
		kind: "route",
		summary:
			"Wallet RPC provider selection and mainnet/testnet mode through the wallet config route. Provider credentials stay out of chat.",
		keys: {
			cloud: WALLET_RPC_CONFIG_KEY,
			managed: WALLET_RPC_CONFIG_KEY,
			"eliza-cloud": WALLET_RPC_CONFIG_KEY,
			evm: WALLET_RPC_CONFIG_KEY,
			eth: WALLET_RPC_CONFIG_KEY,
			ethereum: WALLET_RPC_CONFIG_KEY,
			bsc: WALLET_RPC_CONFIG_KEY,
			bnb: WALLET_RPC_CONFIG_KEY,
			solana: WALLET_RPC_CONFIG_KEY,
			sol: WALLET_RPC_CONFIG_KEY,
			network: WALLET_RPC_CONFIG_KEY,
		},
	},
	updates: {
		kind: "route",
		summary:
			"Connected-agent update status, forced checks, channel selection, and apply-plan reporting through the Release Center backend route.",
		keys: {
			status: UPDATES_STATUS_KEY,
			check: UPDATES_CHECK_KEY,
			"check-updates": UPDATES_CHECK_KEY,
			channel: UPDATES_CHANNEL_KEY,
			apply: UPDATES_APPLY_KEY,
			"apply-update": UPDATES_APPLY_KEY,
		},
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
	permission: string | null;
	provider: string | null;
	chain: string | null;
	network: string | null;
	evm: string | null;
	bsc: string | null;
	solana: string | null;
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
	const permission =
		readStringOption(options, "permission") ?? readStringOption(options, "id");
	const provider = readStringOption(options, "provider");
	const chain = readStringOption(options, "chain");
	const network = readStringOption(options, "network");
	const evm = readStringOption(options, "evm");
	const bsc = readStringOption(options, "bsc");
	const solana = readStringOption(options, "solana");

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
			permission,
			provider,
			chain,
			network,
			evm,
			bsc,
			solana,
		};
	}
	return {
		verb,
		sectionId,
		key,
		value,
		fileName,
		confirm,
		app,
		namespace,
		permission,
		provider,
		chain,
		network,
		evm,
		bsc,
		solana,
	};
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
		request.namespace ??
		request.key ??
		(request.sectionId === "wallet-rpc" && request.chain
			? request.chain
			: null) ??
		(request.sectionId === "permissions" && request.permission
			? "request"
			: Object.keys(cap.keys)[0]);
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
	const requestedPermission = readPermissionFromOutcome(outcome.data);
	return {
		success: true,
		text: reply,
		values: {
			section: request.sectionId,
			key: keyName,
			...(parsedValue === null ? {} : { value: parsedValue }),
			...(request.fileName ? { fileName: request.fileName } : {}),
			...(request.app ? { app: request.app } : {}),
			...(requestedPermission ? { permission: requestedPermission } : {}),
		},
		data: {
			section: request.sectionId,
			key: keyName,
			...(parsedValue === null ? {} : { value: parsedValue }),
			...(request.fileName ? { fileName: request.fileName } : {}),
			...(request.app ? { app: request.app } : {}),
			...(requestedPermission ? { permission: requestedPermission } : {}),
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
			"REQUEST_PERMISSION",
			"REQUEST_OS_PERMISSION",
			"ASK_FOR_MICROPHONE",
			"ASK_FOR_CAMERA",
			"CHANGE_THEME_MODE",
			"SET_THEME_MODE",
			"CHANGE_ACCENT",
			"SET_ACCENT",
			"CHANGE_UI_LANGUAGE",
			"SET_UI_LANGUAGE",
			"HOME_TIME_WIDGET",
			"WALLET_RPC",
			"WALLET_RPC_PROVIDER",
			"SET_WALLET_RPC",
			"CHANGE_WALLET_RPC",
			"ELIZA_CLOUD_RPC",
			"CHECK_FOR_UPDATES",
			"UPDATE_STATUS",
			"APPLY_UPDATE",
			"CHANGE_UPDATE_CHANNEL",
			"VOICE_SETTINGS",
			"VOICE_CONTINUOUS_CHAT",
			"VOICE_END_OF_TURN",
			"VOICE_VAD_SETTINGS",
		],
		description:
			"Change a built-in settings VALUE or run a built-in settings operation from chat — most importantly turning OS/runtime permissions like shell access on/off via section=permissions key=shell, requesting OS permissions via section=permissions key=request permission=microphone|camera|location|notifications|screen-recording, changing appearance values via section=appearance key=theme|accent|language|home-time-widget, changing voice continuous-chat/end-of-turn prefs via section=voice key=continuous|silence-ms|rms, turning automatic training on/off via section=capabilities key=auto-training, toggling the wallet/browser/computer-use capabilities via section=capabilities key=wallet|browser|computer-use value=on|off, selecting wallet RPC providers via section=wallet-rpc key=evm|bsc|solana value=<provider> or key=cloud, granting/revoking an app permission namespace via section=app-permissions app=<slug> key=fs|net value=on|off, creating/restoring local agent backups via section=advanced key=create-backup|restore-backup, and checking/reporting connected-agent updates via section=updates key=status|check|channel|apply. Restore requires fileName and confirm=true. Update channel requires value=stable|beta|nightly. Also reads (`action=get`) or lists (`action=list`) which settings are changeable. `action=set` writes an owned section or points to the dedicated action that owns a delegated section (models→MODEL_SWITCH, background→BACKGROUND, identity→CHARACTER, connectors→PLUGIN, secrets→SECRETS). This CHANGES a setting's value or runs an explicit settings operation; opening a settings page without changing anything is VIEWS. Never fill a settings field with agent-fill.",
		descriptionCompressed:
			"settings get|set|list section/key/value — CHANGE a setting VALUE or run a settings operation, incl. shell access, OS permission requests, appearance, voice, auto-training, wallet RPC providers, app permissions, local backups, and updates",
		routingHint:
			"Semantic settings reads/writes that do NOT already have a dedicated action -> SETTINGS. Changing a PERMISSION or setting VALUE is SETTINGS action=set, NOT navigation: 'turn off shell permissions', 'disable shell access', 'turn off shell access', 'revoke shell access', 'stop the agent running shell commands', 'turn shell back on', 'change my permissions' -> SETTINGS section=permissions key=shell value=off|on. 'ask for microphone permission', 'request camera access', 'enable location permission', 'turn on notifications', 'request screen recording' -> SETTINGS section=permissions key=request permission=microphone|camera|location|notifications|screen-recording. 'switch to dark mode', 'use system theme', 'set the accent to green', 'change UI language to Spanish', 'hide/show the home time widget' -> SETTINGS section=appearance key=theme|accent|language|home-time-widget value=<value>. 'turn on continuous voice chat', 'switch voice to VAD', 'turn off hands-free voice' -> SETTINGS section=voice key=continuous value=always-on|vad-gated|off. 'set voice silence to 1200ms', 'make voice end-of-turn threshold 0.008' -> SETTINGS section=voice key=silence-ms|rms value=<number>. Wake word and voice profiles are device-local controls; open Settings > Voice for those. 'turn on auto-training', 'enable automatic training', 'disable auto training' -> SETTINGS section=capabilities key=auto-training value=on|off. 'turn off the wallet capability', 'enable the browser capability', 'disable computer use' -> SETTINGS section=capabilities key=wallet|browser|computer-use value=on|off. 'use Alchemy for EVM RPC', 'set BSC RPC to NodeReal', 'use Helius for Solana RPC' -> SETTINGS section=wallet-rpc key=evm|bsc|solana value=alchemy|infura|ankr|nodereal|quicknode|helius-birdeye|eliza-cloud. 'use Eliza Cloud RPC' -> SETTINGS section=wallet-rpc key=cloud. 'switch wallet network to testnet' -> SETTINGS section=wallet-rpc key=network value=testnet. Never put wallet API keys or RPC URLs in SETTINGS; use SECRETS for API keys and vault material. 'check for updates', 'refresh update status' -> SETTINGS section=updates key=check. 'what update version am I on' -> SETTINGS section=updates key=status. 'switch updates to beta/nightly/stable' -> SETTINGS section=updates key=channel value=beta|nightly|stable. 'apply the available update' -> SETTINGS section=updates key=apply. 'revoke network access for my-app', 'grant filesystem access to sample-app' -> SETTINGS section=app-permissions app=<slug> key=net|fs value=off|on. 'back up my agent', 'create a local backup' -> SETTINGS section=advanced key=create-backup. 'restore backup <file>' -> SETTINGS section=advanced key=restore-backup fileName=<file> confirm=true; if confirm is absent, ask for confirmation. Also 'what settings can you change' / 'list settings' -> SETTINGS action=list. Do NOT use SETTINGS for changes a dedicated action owns: switching the model is MODEL_SWITCH, the background/wallpaper is BACKGROUND, the agent identity is CHARACTER, connector plugin lifecycle/config is PLUGIN, secret/API keys are SECRETS. The distinction from VIEWS is value-vs-navigation: changing/toggling a permission or setting VALUE, requesting an OS permission, changing an appearance value, changing voice preferences, changing wallet RPC provider selection, checking update status, changing update channel, or running a backup operation, is SETTINGS even though it lives on a settings page; merely OPENING or navigating to a settings page with no value change is VIEWS. SETTINGS never fills a form field with agent-fill.",
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
					"Canonical settings section id or alias (e.g. appearance, permissions, capabilities, app-permissions, ai-model, background, secrets). Required for get/set.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "key",
				description:
					"The specific toggle or operation within the section (e.g. theme, accent, language, home-time-widget, shell, voice continuous/silence-ms/rms, auto-training, wallet-rpc evm/bsc/solana/cloud/network, fs/net, create-backup, restore-backup, status/check/channel/apply for updates). Optional; defaults to the section's primary key.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "provider",
				description:
					"Wallet RPC provider when section=wallet-rpc and chain/key names evm, bsc, or solana. Do not pass API keys here.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "chain",
				description:
					"Wallet RPC chain when section=wallet-rpc; accepted aliases include evm/ethereum, bsc/bnb, and solana/sol.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "network",
				description:
					"Wallet network when section=wallet-rpc; accepted values are mainnet or testnet.",
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
				name: "permission",
				description:
					"OS permission id when section=permissions key=request, for example microphone, camera, location, notifications, or screen-recording.",
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
					"The new value for a set. Boolean toggles accept on/off, enable/disable, true/false; appearance accepts theme/accent/language tokens; voice accepts off|vad-gated|always-on or numeric VAD values.",
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
