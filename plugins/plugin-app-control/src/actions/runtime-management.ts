/** Owner-gated semantic action for Devices & Runtimes mutations. */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
	isRuntimeManagementOperation,
	RUNTIME_MANAGEMENT_OPERATIONS,
	type RuntimeManagementRequest,
	type RuntimeManagementResult,
} from "@elizaos/shared";
import { getAppControlApiBase } from "../loopback-api.js";
import {
	normalizeActionOptions,
	readStringOption,
	userRequestMessageText,
} from "../params.js";
import {
	type ConfirmedRuntimeOperation,
	isUnambiguousRuntimeConfirmation,
} from "./runtime-management-confirmation.js";
import { readViewInteractionClientId } from "./view-delivery.js";
import { createViewsRequestHeaders } from "./views-request-auth.js";

export type RuntimeManagementFn = (
	request: RuntimeManagementRequest,
) => Promise<RuntimeManagementResult>;

export interface RuntimeManagementActionDeps {
	manageRuntime?: RuntimeManagementFn;
}

const REQUEST_TIMEOUT_MS = 50_000;
const CONFIRMATION_REQUIRED: ReadonlySet<RuntimeManagementRequest["op"]> =
	new Set(
		RUNTIME_MANAGEMENT_OPERATIONS.filter(
			(op) => op !== "list" && op !== "inspect_ssh",
		),
	);

function requiresConfirmation(
	op: RuntimeManagementRequest["op"],
): op is ConfirmedRuntimeOperation {
	return CONFIRMATION_REQUIRED.has(op);
}

const SECRET_OPTION_NAMES = new Set([
	"accesstoken",
	"apikey",
	"bearertoken",
	"credential",
	"password",
	"privatekey",
	"secret",
	"token",
]);

function isSecretOptionName(key: string): boolean {
	return SECRET_OPTION_NAMES.has(key.replace(/[-_]/g, "").toLowerCase());
}

function readNumberOption(
	options: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = options[key];
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value !== "string" || !/^\d+$/.test(value.trim()))
		return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isConfirmed(options: Record<string, unknown>): boolean {
	const value = options.confirm;
	return (
		value === true ||
		(typeof value === "string" &&
			/^(true|yes|confirm|confirmed)$/i.test(value.trim()))
	);
}

export function parseRuntimeManagementRequest(
	optionsValue?: Record<string, unknown>,
): RuntimeManagementRequest | null {
	const options = normalizeActionOptions(optionsValue) ?? {};
	if (Object.keys(options).some(isSecretOptionName)) {
		return null;
	}
	const opValue =
		readStringOption(options, "op") ?? readStringOption(options, "action");
	if (!isRuntimeManagementOperation(opValue)) return null;
	return {
		op: opValue,
		targetId: readStringOption(options, "targetId") ?? undefined,
		runtimeId: readStringOption(options, "runtimeId") ?? undefined,
		label: readStringOption(options, "label") ?? undefined,
		target: readStringOption(options, "target") ?? undefined,
		sshPort: readNumberOption(options, "sshPort"),
		remoteApiPort: readNumberOption(options, "remoteApiPort"),
		expectedFingerprint:
			readStringOption(options, "expectedFingerprint") ?? undefined,
		identityFile: readStringOption(options, "identityFile") ?? undefined,
		apiBase: readStringOption(options, "apiBase") ?? undefined,
		sessionId: readStringOption(options, "sessionId") ?? undefined,
		code: readStringOption(options, "code") ?? undefined,
	};
}

async function defaultManageRuntime(
	request: RuntimeManagementRequest,
	message: Memory,
): Promise<RuntimeManagementResult> {
	const clientId = readViewInteractionClientId(message);
	if (!clientId) {
		return {
			ok: false,
			op: request.op,
			error:
				"open the Eliza app and send this request from its chat so the operation is bound to that device",
		};
	}
	const response = await fetch(`${getAppControlApiBase()}/api/runtime/manage`, {
		method: "POST",
		headers: createViewsRequestHeaders(),
		body: JSON.stringify({ ...request, clientId }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const body = (await response
		.json()
		.catch(() => null)) as RuntimeManagementResult | null;
	if (!response.ok || !body) {
		return {
			ok: false,
			op: request.op,
			error: body?.error ?? `runtime management returned ${response.status}`,
		};
	}
	return body;
}

function successText(result: RuntimeManagementResult): string {
	if (result.op === "list") {
		const runtimes = Array.isArray(result.data?.runtimes)
			? result.data.runtimes
			: [];
		if (runtimes.length === 0) return "No saved runtimes were found.";
		const rows = runtimes.map((runtime) => {
			if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
				return `- ${JSON.stringify(runtime)}`;
			}
			const item = runtime as Record<string, unknown>;
			const label = String(item.label ?? "Unnamed runtime");
			const id = String(item.id ?? "unknown-id");
			const kind = String(item.connectionMode ?? item.kind ?? "unknown");
			return `- ${label} (${id}) — ${kind}${item.active === true ? ", active" : ""}`;
		});
		return `Saved runtimes (${runtimes.length}):\n${rows.join("\n")}`;
	}
	if (result.op === "pair") {
		const receipt =
			result.data?.receipt && typeof result.data.receipt === "object"
				? (result.data.receipt as Record<string, unknown>)
				: {};
		return `Pairing is ready. Session ${String(receipt.sessionId ?? "unknown")}, one-use code ${String(receipt.code ?? "unknown")}, expires ${String(receipt.expiresAt ?? "soon")}.`;
	}
	if (result.op === "inspect_ssh") {
		const inspection =
			result.data?.inspection &&
			typeof result.data.inspection === "object" &&
			!Array.isArray(result.data.inspection)
				? (result.data.inspection as Record<string, unknown>)
				: {};
		const fingerprints = Array.isArray(inspection.fingerprints)
			? inspection.fingerprints
			: [];
		const rows = fingerprints.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				return `- ${JSON.stringify(entry)}`;
			}
			const key = entry as Record<string, unknown>;
			return `- ${String(key.algorithm ?? "unknown")}: ${String(key.fingerprint ?? "unknown")}`;
		});
		const preferred = String(inspection.preferredFingerprint ?? "unavailable");
		return `SSH host keys read without trusting or connecting:\n${rows.join("\n")}\nPreferred fingerprint: ${preferred}\nVerify it out of band before connecting.`;
	}
	const labels: Record<string, string> = {
		revoke: "Revoked the selected controller session.",
		remove: "Removed the selected runtime and completed its local cleanup.",
		retry: "Retried the runtime lifecycle operation.",
		connect_ssh: "Connected the fingerprint-pinned SSH runtime.",
		add_direct: "Added the trusted private runtime.",
		enroll_host: "Enrolled this computer as a remote target.",
		approve_pairing: "Approved the one-use pairing and started the relay.",
		start_host: "Started this computer's remote relay.",
		stop_host: "Stopped this computer's remote relay.",
		revoke_host:
			"Revoked this computer and completed local credential cleanup.",
	};
	return labels[result.op] ?? "Updated Devices & Runtimes.";
}

export function createRuntimeManagementAction(
	deps: RuntimeManagementActionDeps = {},
): Action {
	const manageRuntime = deps.manageRuntime;
	return {
		name: "RUNTIMES",
		contexts: ["general", "settings", "admin", "system"],
		contextGate: { anyOf: ["general", "settings", "admin", "system"] },
		roleGate: { minRole: "OWNER" },
		similes: [
			"MANAGE_RUNTIMES",
			"PAIR_DEVICE",
			"LINK_DEVICE",
			"REVOKE_DEVICE",
			"REMOVE_RUNTIME",
			"ENROLL_REMOTE_HOST",
			"START_REMOTE_RELAY",
			"STOP_REMOTE_RELAY",
			"INSPECT_SSH_HOST",
			"CONNECT_SSH_RUNTIME",
			"ADD_PRIVATE_RUNTIME",
		],
		description:
			"Manage Devices & Runtimes from chat: list runtimes; create or approve one-use device pairing; revoke/remove/retry runtimes; enroll/start/stop/revoke this desktop host; inspect an SSH host without trusting it; connect only after an out-of-band verified SHA256 fingerprint; or add a trusted private/Tailscale runtime. Every mutation requires confirm=true. Never provide passwords, private keys, bearer/access tokens, or other secrets to this action; enter secrets locally in Settings > Devices & Runtimes. Switching an already-saved runtime is AGENT_SWITCH.",
		descriptionCompressed:
			"runtimes list|pair|revoke|remove|retry|inspect_ssh|connect_ssh|add_direct|enroll_host|approve_pairing|start_host|stop_host|revoke_host; owner-only, confirmed, no secrets",
		routingHint:
			"Device/runtime lifecycle, pairing, revoke, SSH fingerprint inspection/connection, and host relay management -> RUNTIMES. Switching to an already-saved runtime -> AGENT_SWITCH. Never send credentials or private keys; secret entry stays in the local Devices & Runtimes UI.",
		suppressPostActionContinuation: true,
		parameters: [
			{
				name: "op",
				description: "Runtime operation.",
				required: true,
				schema: { type: "string", enum: [...RUNTIME_MANAGEMENT_OPERATIONS] },
			},
			{
				name: "targetId",
				description: "Remote host or pairing target id.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "runtimeId",
				description: "Saved runtime id or new SSH runtime id.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "label",
				description: "Human-readable runtime label.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "target",
				description: "SSH user@host target. Never include a password.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "sshPort",
				description: "SSH port.",
				required: false,
				schema: { type: "number" },
			},
			{
				name: "remoteApiPort",
				description: "Remote loopback Eliza API port.",
				required: false,
				schema: { type: "number" },
			},
			{
				name: "expectedFingerprint",
				description: "Out-of-band verified SHA256 SSH host fingerprint.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "identityFile",
				description:
					"Local SSH identity-file path; the key contents never leave this computer.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "apiBase",
				description:
					"Trusted private/local/Tailscale runtime URL. Public HTTP is rejected.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "sessionId",
				description: "One-use pairing session id.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "code",
				description: "One-use six-digit pairing code.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "confirm",
				description:
					"Explicit true/yes confirmation required for every mutation.",
				required: false,
				schema: { type: "string" },
			},
		],
		validate: async (): Promise<boolean> => true,
		handler: async (
			_runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const request = parseRuntimeManagementRequest(options);
			if (!request) {
				const reply =
					"Tell me which Devices & Runtimes operation to perform, without including passwords, private keys, tokens, API keys, or credentials.";
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}
			const normalized = normalizeActionOptions(options) ?? {};
			if (
				requiresConfirmation(request.op) &&
				(!isConfirmed(normalized) ||
					!isUnambiguousRuntimeConfirmation(
						userRequestMessageText(message),
						request.op,
					))
			) {
				const reply = `Please confirm before I run the ${request.op} Devices & Runtimes operation.`;
				await callback?.({ text: reply });
				return {
					success: false,
					text: reply,
					userFacingText: reply,
					verifiedUserFacing: true,
					values: { awaitingConfirmation: true, op: request.op },
				};
			}

			logger.info(`[plugin-app-control] RUNTIMES op=${request.op}`);
			const result = manageRuntime
				? await manageRuntime(request)
				: await defaultManageRuntime(request, message);
			if (!result.ok) {
				const reply = `I couldn't complete ${request.op}: ${result.error ?? "the connected app refused the operation"}.`;
				await callback?.({ text: reply });
				return { success: false, text: reply, values: { op: request.op } };
			}
			const reply = successText(result);
			await callback?.({ text: reply });
			return {
				success: true,
				text: reply,
				userFacingText: reply,
				verifiedUserFacing: true,
				turnComplete: true,
				values: {
					op: request.op,
					...(result.data ? { resultJson: JSON.stringify(result.data) } : {}),
				},
			};
		},
	};
}

export const runtimeManagementAction: Action = createRuntimeManagementAction();
