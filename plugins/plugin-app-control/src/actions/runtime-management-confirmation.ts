/** Parses the fail-closed user confirmation required by runtime mutations. */

import type { RuntimeManagementOperation } from "@elizaos/shared";

export type ConfirmedRuntimeOperation = Exclude<
	RuntimeManagementOperation,
	"list" | "inspect_ssh"
>;

const CONFIRMATION_SUBJECTS: Record<
	ConfirmedRuntimeOperation,
	readonly string[]
> = {
	pair: ["pair", "pairing"],
	revoke: ["revoke", "revocation"],
	remove: ["remove", "removal", "remove it", "removing it"],
	retry: ["retry"],
	connect_ssh: ["connect ssh", "ssh connection"],
	add_direct: ["add direct runtime", "direct runtime"],
	enroll_host: ["enroll host", "host enrollment"],
	approve_pairing: ["approve pairing", "pairing approval"],
	start_host: ["start host", "host start"],
	stop_host: ["stop host", "host stop"],
	revoke_host: ["revoke host", "host revocation"],
};

export function isUnambiguousRuntimeConfirmation(
	value: string,
	op: ConfirmedRuntimeOperation,
): boolean {
	const text = value.toLowerCase().replace(/[’']/g, "'").trim();
	if (
		/\b(?:no|not|never|cancel|wait|hold|don't|dont|cannot|can't|cant|won't|wont)\b/.test(
			text,
		) ||
		/\b(?:but|however|except|unless|after|before|later|tomorrow)\b/.test(text)
	) {
		return false;
	}
	const normalized = text
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	if (
		/^(?:yes|yes please|yep|confirm|confirmed|proceed|go ahead|do it)$/.test(
			normalized,
		)
	) {
		return true;
	}
	return CONFIRMATION_SUBJECTS[op].some(
		(subject) =>
			normalized === `confirm ${subject}` ||
			normalized === `confirm the ${subject}` ||
			normalized === `yes confirm ${subject}` ||
			normalized === `yes confirm the ${subject}`,
	);
}
