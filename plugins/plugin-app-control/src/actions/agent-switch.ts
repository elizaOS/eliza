/**
 * AGENT_SWITCH action — repoints the app shell to a saved runtime profile
 * (a local / cloud-dedicated / remote agent) from chat (#12178 WI-6).
 *
 * Runtime profiles are client-persisted (localStorage registry,
 * packages/ui/src/state/agent-profiles.ts), so the server owns no profile
 * list. The handler POSTs the shared loopback route
 * `POST /api/runtime/agent-switch`, which broadcasts `shell:switch-agent`; the
 * connected shell resolves the requested profile (by id or fuzzy label) and
 * applies it via the canonical `switchRuntimeNonDestructive`, inheriting its
 * remote-trust gate (an untrusted public URL is refused). The shell reports
 * the outcome back and this handler narrates it — including the refusal reason
 * for unknown/untrusted profiles.
 *
 * OWNER-gated: this repoints the backend the app talks to (and the bearer token
 * it sends), so it is not a member-level capability.
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
import { readStringOption } from "../params.js";

/** Parsed wire response of POST /api/runtime/agent-switch. */
export interface AgentSwitchOutcome {
	ok: boolean;
	profileId?: string;
	profileLabel?: string;
	reason?: string;
}

export type AgentSwitchFn = (profile: string) => Promise<AgentSwitchOutcome>;

export interface AgentSwitchActionDeps {
	switchAgent?: AgentSwitchFn;
}

const REQUEST_TIMEOUT_MS = 15_000;

async function defaultSwitchAgent(
	profile: string,
): Promise<AgentSwitchOutcome> {
	const port = resolveServerOnlyPort(process.env);
	const response = await fetch(
		`http://127.0.0.1:${port}/api/runtime/agent-switch`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ profile }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!response.ok) {
		return {
			ok: false,
			reason:
				typeof body?.error === "string"
					? body.error
					: `agent switch returned ${response.status}`,
		};
	}
	return {
		ok: body?.ok === true,
		profileId: typeof body?.profileId === "string" ? body.profileId : undefined,
		profileLabel:
			typeof body?.profileLabel === "string" ? body.profileLabel : undefined,
		reason: typeof body?.reason === "string" ? body.reason : undefined,
	};
}

const SWITCH_VERB_RE = /\b(switch|use|change|connect|move|go|activate)\b/i;
const AGENT_NOUN_RE =
	/\b(agent|runtime|backend|profile|instance|server|node)\b/i;

/**
 * Extract the target profile from an explicit option or the message. Returns
 * null when no profile is named — AGENT_SWITCH never picks a profile blindly.
 */
export function inferAgentSwitchProfile(
	text: string,
	options?: Record<string, unknown>,
): string | null {
	const explicit =
		readStringOption(options, "profile") ??
		readStringOption(options, "agent") ??
		readStringOption(options, "target");
	if (explicit) return explicit;

	const trimmed = text.trim();
	if (!trimmed) return null;
	if (!SWITCH_VERB_RE.test(trimmed) || !AGENT_NOUN_RE.test(trimmed))
		return null;

	// Pull the phrase after the agent/runtime noun: "switch to my cloud agent"
	// → "cloud"; "use the laptop runtime" → "laptop". The shell resolves this
	// fuzzy label against the profile registry (id or label).
	const match =
		/\b(?:switch|use|change|connect|move|go|activate)\b\s+(?:to\s+|over\s+to\s+)?(?:the\s+|my\s+)?(.+?)\s+(?:agent|runtime|backend|profile|instance|server|node)\b/i.exec(
			trimmed,
		);
	const label = match?.[1]?.trim();
	if (label && label.length > 0 && label.toLowerCase() !== "another") {
		return label;
	}
	// "switch agent to X" / "switch to the X runtime" fallback: the phrase after
	// "to".
	const toMatch = /\bto\s+(?:the\s+|my\s+)?(.+?)\s*$/i.exec(trimmed);
	const toLabel = toMatch?.[1]
		?.replace(/\b(agent|runtime|backend|profile|instance|server|node)\b/gi, "")
		.trim();
	return toLabel && toLabel.length > 0 ? toLabel : null;
}

function narrateRefusal(reason: string | undefined, profile: string): string {
	switch (reason) {
		case "not-found":
			return `I couldn't find a saved runtime called "${profile}". Add it in Settings → Runtimes first, or tell me one of your existing agents.`;
		case "untrusted-remote":
			return `I won't connect to "${profile}" — its address isn't a trusted local/VPN host, so switching to it could leak your session. Use a loopback, private-network, or tailscale runtime.`;
		case "no-shell":
			return "No app window is connected right now, so I can't switch the active agent from here.";
		default:
			return `I couldn't switch to "${profile}"${reason ? `: ${reason}` : ""}.`;
	}
}

export function createAgentSwitchAction(
	deps: AgentSwitchActionDeps = {},
): Action {
	const switchAgent = deps.switchAgent ?? defaultSwitchAgent;

	return {
		name: "AGENT_SWITCH",
		contexts: ["general", "settings", "admin"],
		contextGate: { anyOf: ["general", "settings", "admin"] },
		roleGate: { minRole: "OWNER" },
		similes: [
			"SWITCH_AGENT",
			"SWITCH_RUNTIME",
			"CHANGE_AGENT",
			"USE_AGENT",
			"CONNECT_AGENT",
			"SWITCH_TO_AGENT",
			"SWITCH_BACKEND",
			"USE_RUNTIME",
		],
		description:
			"Switch the app to a different saved runtime/agent profile — a local agent, a dedicated Eliza Cloud agent, or a trusted remote (VPS/tailscale) backend. Repoints the live app to that profile without a page reload where allowed. Refuses unknown profiles and untrusted remote addresses.",
		descriptionCompressed:
			"agent switch <profile> — repoint the app to a saved runtime profile (local/cloud/remote) by id or label; refuses unknown or untrusted-remote profiles",
		routingHint:
			"Requests to change WHICH agent/backend the app talks to -> AGENT_SWITCH: 'switch to my cloud agent', 'use the laptop runtime', 'connect to my VPS agent', 'switch back to local'. This repoints the backend (owner-only); it is NOT model routing (that's MODEL_SWITCH) and NOT view navigation (VIEWS).",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "profile",
				description:
					"The saved runtime profile to switch to — its id or a fuzzy label (e.g. 'cloud', 'laptop', 'my VPS agent'). Resolved against the app's runtime-profile registry.",
				required: true,
				schema: { type: "string" },
			},
		],

		validate: async (
			_runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			return (
				inferAgentSwitchProfile(message.content.text ?? "", undefined) !== null
			);
		},

		handler: async (
			_runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const profile = inferAgentSwitchProfile(
				message.content.text ?? "",
				options,
			);
			if (!profile) {
				const reply =
					'Tell me which agent to switch to — e.g. "switch to my cloud agent" or "use the laptop runtime".';
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			logger.info(`[plugin-app-control] AGENT_SWITCH profile="${profile}"`);

			try {
				const outcome = await switchAgent(profile);
				if (!outcome.ok) {
					const reply = narrateRefusal(outcome.reason, profile);
					await callback?.({ text: reply });
					return {
						success: false,
						text: reply,
						values: { profile, reason: outcome.reason },
					};
				}
				const label = outcome.profileLabel ?? outcome.profileId ?? profile;
				const reply = `Switched the app to "${label}".`;
				await callback?.({ text: reply });
				return {
					success: true,
					text: reply,
					values: {
						profile,
						profileId: outcome.profileId,
						profileLabel: outcome.profileLabel,
					},
					data: {
						profileId: outcome.profileId,
						profileLabel: outcome.profileLabel,
					},
				};
			} catch (err) {
				const messageText = err instanceof Error ? err.message : String(err);
				logger.error(
					`[plugin-app-control] AGENT_SWITCH failed: ${messageText}`,
				);
				const reply = `I couldn't switch to "${profile}": ${messageText}.`;
				await callback?.({ text: reply });
				return {
					success: false,
					text: reply,
					values: { profile },
				};
			}
		},
	};
}

export const agentSwitchAction: Action = createAgentSwitchAction();
