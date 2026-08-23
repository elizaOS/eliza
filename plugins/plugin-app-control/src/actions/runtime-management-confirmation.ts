/** Builds and validates operation-and-target-bound runtime confirmations. */

import type { RuntimeManagementRequest } from "@elizaos/shared";

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function confirmationTarget(request: RuntimeManagementRequest): string {
	if (request.op === "approve_pairing") {
		return request.sessionId ?? "this pairing";
	}
	if (
		request.op === "enroll_host" ||
		request.op === "start_host" ||
		request.op === "stop_host" ||
		request.op === "revoke_host"
	) {
		return "this host";
	}
	return (
		request.targetId ??
		request.runtimeId ??
		request.target ??
		request.apiBase ??
		request.label ??
		"this runtime"
	);
}

export function runtimeManagementConfirmationText(
	request: RuntimeManagementRequest,
): string {
	return `confirm ${request.op.replaceAll("_", " ")} ${confirmationTarget(request)}`;
}

export function isBoundRuntimeManagementConfirmation(
	text: string,
	request: RuntimeManagementRequest,
): boolean {
	const normalized = normalize(text);
	const expected = normalize(runtimeManagementConfirmationText(request));
	return normalized === expected || normalized === `yes ${expected}`;
}
