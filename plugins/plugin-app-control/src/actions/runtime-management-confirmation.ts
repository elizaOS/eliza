/** Builds and validates complete, operation-bound runtime confirmations. */

import type { RuntimeManagementRequest } from "@elizaos/shared";

function normalize(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/^yes,\s+/, "yes ")
		.replace(/\s+/g, " ");
}

function display(value: string | number | boolean | undefined): string {
	return value === undefined ? "<none>" : String(value);
}

function operationFields(
	request: RuntimeManagementRequest,
): Array<[string, string]> {
	const fields: Array<[string, string]> = [];
	const add = (name: string, field: string | number | boolean | undefined) =>
		fields.push([name, display(field)]);
	if (request.op === "create_pairing") return fields;
	if (
		[
			"claim_pairing",
			"confirm_pairing",
			"deny_pairing",
			"approve_pairing",
		].includes(request.op)
	) {
		add("session", request.sessionId);
		if (request.op === "claim_pairing") add("code", request.code);
		return fields;
	}
	if (
		["enroll_host", "start_host", "stop_host", "revoke_host"].includes(
			request.op,
		)
	) {
		add("host", request.targetId ?? request.runtimeId ?? request.platform);
		if (request.op === "enroll_host") {
			add("platform", request.platform);
			add("managedNetwork", request.managedNetwork);
		}
		return fields;
	}
	if (request.op === "connect_ssh") {
		add("runtime", request.runtimeId);
		add("target", request.target);
		add("sshPort", request.sshPort);
		add("remoteApiPort", request.remoteApiPort);
		add("fingerprint", request.expectedFingerprint);
		add("identityFile", request.identityFile ?? "<ssh-agent>");
		return fields;
	}
	if (request.op === "add_direct") {
		add("runtime", request.runtimeId);
		add("apiBase", request.apiBase);
		return fields;
	}
	add(
		request.op === "pair" ? "target" : "runtime",
		request.targetId ??
			request.runtimeId ??
			request.target ??
			request.apiBase ??
			request.label,
	);
	return fields;
}

/** Returns false when a mutation cannot be described unambiguously to a human. */
export function hasCompleteRuntimeManagementConfirmation(
	request: RuntimeManagementRequest,
): boolean {
	const present = (field: unknown): boolean =>
		typeof field === "string" ? field.trim().length > 0 : field !== undefined;
	if (
		[
			"claim_pairing",
			"confirm_pairing",
			"deny_pairing",
			"approve_pairing",
		].includes(request.op)
	) {
		return (
			present(request.sessionId) &&
			(request.op !== "claim_pairing" || present(request.code))
		);
	}
	if (["revoke", "remove", "retry", "pair"].includes(request.op)) {
		return present(
			request.targetId ??
				request.runtimeId ??
				request.target ??
				request.apiBase ??
				request.label,
		);
	}
	if (request.op === "connect_ssh") {
		return (
			present(request.runtimeId) &&
			present(request.target) &&
			present(request.sshPort) &&
			present(request.remoteApiPort) &&
			present(request.expectedFingerprint)
		);
	}
	if (request.op === "add_direct") {
		return present(request.runtimeId) && present(request.apiBase);
	}
	if (request.op === "enroll_host") {
		return (
			present(request.platform) && typeof request.managedNetwork === "boolean"
		);
	}
	if (["start_host", "stop_host", "revoke_host"].includes(request.op)) {
		return present(request.targetId ?? request.runtimeId ?? request.platform);
	}
	return true;
}

export function runtimeManagementConfirmationText(
	request: RuntimeManagementRequest,
): string {
	const operation =
		request.op === "confirm_pairing"
			? "pairing"
			: request.op.replaceAll("_", " ");
	const fields = operationFields(request)
		.map(([name, field]) => `${name}=${field}`)
		.join(" ");
	return `confirm ${operation}${fields ? ` ${fields}` : ""}`;
}

export function isBoundRuntimeManagementConfirmation(
	text: string,
	request: RuntimeManagementRequest,
): boolean {
	if (!hasCompleteRuntimeManagementConfirmation(request)) return false;
	const normalized = normalize(text);
	const expected = normalize(runtimeManagementConfirmationText(request));
	return normalized === expected || normalized === `yes ${expected}`;
}
