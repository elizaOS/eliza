/**
 * Live-model SETTINGS voice scenario (MVP workstream 6 acceptance bar, #16942):
 * natural "turn on voice" phrasing must make a REAL model select the semantic
 * SETTINGS action and drive the voice section's own write path — never a raw
 * selector (`agent-fill`/`agent-click`) on the Settings surface. The loopback
 * captures the exact `PUT /api/config` persisted voice prefs and the
 * `voice-settings:apply` broadcast the running shell consumes, so every check
 * is on behavior, not on the model's phrasing. The persisted payload is pinned
 * to the #14910 twin defaults (silenceMs 650, speechRmsThreshold 0.003) so a
 * chat-issued voice write can never diverge from what the Voice settings UI
 * seeds. deterministic-settings-voice-actions pins the same payload contract
 * keyless on the PR lane.
 */

import { VOICE_SETTINGS_APPLY_EVENT } from "@elizaos/shared";
import type {
	CapturedAction,
	ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
	jsonResponse,
	readAppControlHttpRequests,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

// The stateful stand-in for the real config route: GET serves it, PUT replaces
// `messages`, so the second turn's write proves cumulative state (the silence
// change must preserve the continuous mode the first turn persisted).
let configState: { messages: JsonRecord } = { messages: {} };

function voiceConfigWrites(): unknown[] {
	return readAppControlHttpRequests(
		(request) =>
			request.method === "PUT" && request.pathname === "/api/config",
	).map((request) => request.body ?? null);
}

function voiceApplyBroadcasts(): unknown[] {
	return readAppControlHttpRequests(
		(request) =>
			request.method === "POST" &&
			request.pathname === "/api/views/events/broadcast" &&
			toRecord(request.body).type === VOICE_SETTINGS_APPLY_EVENT,
	).map((request) => toRecord(request.body).payload ?? null);
}

function actionParams(action: CapturedAction): JsonRecord {
	const envelope = toRecord(action.parameters);
	return toRecord(envelope.parameters ?? envelope);
}

// The raw-selector negative the acceptance bar names: the builtin Settings
// surface must be driven semantically, never through the generic synthetic-DOM
// bridge.
function noSyntheticDomFallback(ctx: ScenarioContext): string | undefined {
	for (const call of ctx.actionsCalled) {
		if (call.actionName === "VIEWS") {
			return `expected no VIEWS synthetic-DOM fallback, saw VIEWS with ${JSON.stringify(actionParams(call))}`;
		}
		const capability = actionParams(call).capability;
		if (capability === "agent-fill" || capability === "agent-click") {
			return `expected no agent-fill/agent-click, saw capability=${String(capability)}`;
		}
	}
	return undefined;
}

// #14910 twin invariant: a chat-write that seeds an empty voice config must
// persist exactly the defaults the Voice settings UI applies.
const TWIN_DEFAULT_RMS = 0.003;
const TWIN_DEFAULT_SILENCE_MS = 650;

const EXPECTED_PREFS_LEDGER = [
	{
		continuous: "always-on",
		vadAutoStop: {
			silenceMs: TWIN_DEFAULT_SILENCE_MS,
			speechRmsThreshold: TWIN_DEFAULT_RMS,
		},
	},
	{
		continuous: "always-on",
		vadAutoStop: { silenceMs: 1200, speechRmsThreshold: TWIN_DEFAULT_RMS },
	},
];

function expectSettingsSuccess(execution: {
	actionsCalled: CapturedAction[];
}): string | undefined {
	const action = execution.actionsCalled.find(
		(candidate) => candidate.actionName === "SETTINGS",
	);
	if (!action) {
		return `expected the model to route to SETTINGS, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
	}
	if (action.result?.success !== true) {
		return `expected SETTINGS result.success=true, saw ${JSON.stringify(action.result)}`;
	}
	return undefined;
}

export default scenario({
	lane: "live-only",
	id: "settings-voice-toggle",
	title: "SETTINGS action turns on continuous voice via the config route",
	domain: "app-control",
	tags: ["app-control", "settings", "set", "voice", "mvp"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	seed: [
		{
			type: "custom",
			name: "register config + broadcast loopback API",
			apply: () => {
				resetAppControlHttpLoopback();
				configState = { messages: {} };
				registerAppControlHttpHandler((request) => {
					if (
						request.method === "GET" &&
						request.pathname === "/api/config"
					) {
						return jsonResponse(configState);
					}
					if (
						request.method === "PUT" &&
						request.pathname === "/api/config"
					) {
						configState = {
							messages: toRecord(toRecord(request.body).messages),
						};
						return jsonResponse({ ok: true });
					}
					if (
						request.method === "POST" &&
						request.pathname === "/api/views/events/broadcast"
					) {
						return jsonResponse({ ok: true, delivered: 1 });
					}
					return undefined;
				});
				return undefined;
			},
		},
	],
	rooms: [
		{
			id: "main",
			source: "client_chat",
			title: "Settings Voice Toggle",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-turns-on-continuous-voice",
			text: "Turn on continuous voice chat so it's always on.",
			expectedActions: ["SETTINGS"],
			assertTurn: expectSettingsSuccess,
		},
		{
			kind: "message",
			name: "user-sets-voice-silence-window",
			// "window" is deliberately avoided: it is a strong VIEWS retrieval
			// keyword (detached windows), and the acceptance bar's canonical
			// phrasing for this write is "set voice silence to 1200ms".
			text: "Update my voice settings: set the end-of-turn silence to 1200 ms.",
			expectedActions: ["SETTINGS"],
			assertTurn: expectSettingsSuccess,
		},
	],
	finalChecks: [
		{
			type: "selectedAction",
			actionName: "SETTINGS",
		},
		{
			type: "actionCalled",
			actionName: "SETTINGS",
			status: "success",
			minCount: 2,
		},
		{
			type: "custom",
			name: "SETTINGS persisted the exact voice prefs through PUT /api/config",
			predicate: () => {
				const expected = EXPECTED_PREFS_LEDGER.map((prefs) => ({
					messages: { voice: prefs },
				}));
				const actual = voiceConfigWrites();
				return JSON.stringify(actual) === JSON.stringify(expected)
					? undefined
					: `expected voice config write ledger ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
			},
		},
		{
			type: "custom",
			name: "voice-settings:apply broadcasts mirror the persisted prefs in order",
			predicate: () => {
				const actual = voiceApplyBroadcasts();
				return JSON.stringify(actual) ===
					JSON.stringify(EXPECTED_PREFS_LEDGER)
					? undefined
					: `expected voice-settings:apply ledger ${JSON.stringify(EXPECTED_PREFS_LEDGER)}, saw ${JSON.stringify(actual)}`;
			},
		},
		{
			type: "custom",
			name: "no synthetic-DOM (VIEWS/agent-fill/agent-click) fallback was used",
			predicate: noSyntheticDomFallback,
		},
		{
			type: "custom",
			name: "cleanup config loopback",
			predicate: () => {
				resetAppControlHttpLoopback();
				return undefined;
			},
		},
	],
});
