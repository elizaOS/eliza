/** Resolves explicit coding profiles against already-authorized runtime actions. */

import { ElizaError } from "../errors";
import type { CodingActionProfile } from "../types/coding";
import type { Action } from "../types/components";
import { normalizeActionName } from "./action-catalog";

const PI_ACTION_NAMES = new Set(["READ", "SHELL", "EDIT", "WRITE"]);

/**
 * Validates the runtime value before it reaches action selection or telemetry.
 * Hosts normally pass the typed value, but JavaScript and transport adapters can
 * still supply an arbitrary shape at runtime.
 */
export function parseCodingActionProfile(
	value: unknown,
): CodingActionProfile | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ElizaError("Coding action profile must be an object", {
			code: "INVALID_CODING_ACTION_PROFILE",
			context: { receivedType: value === null ? "null" : typeof value },
		});
	}

	const profile = value as Record<string, unknown>;
	const unknownKeys = Object.keys(profile).filter(
		(key) => key !== "kind" && key !== "includeWorktree",
	);
	if (
		profile.kind !== "pi" ||
		(profile.includeWorktree !== undefined &&
			typeof profile.includeWorktree !== "boolean") ||
		unknownKeys.length > 0
	) {
		throw new ElizaError("Invalid coding action profile", {
			code: "INVALID_CODING_ACTION_PROFILE",
			context: {
				kind: typeof profile.kind === "string" ? profile.kind : undefined,
				includeWorktreeType: typeof profile.includeWorktree,
				unknownKeys,
			},
		});
	}

	return profile.includeWorktree === true
		? { kind: "pi", includeWorktree: true }
		: { kind: "pi" };
}

/**
 * Applies a host-selected coding profile after ordinary action authorization.
 * The input array and runtime action registry remain untouched.
 */
export function applyCodingActionProfile(
	actions: ReadonlyArray<Action>,
	profileValue: CodingActionProfile | undefined,
): Action[] {
	const profile = parseCodingActionProfile(profileValue);
	if (!profile) return [...actions];

	switch (profile.kind) {
		case "pi": {
			const allowedNames = profile.includeWorktree
				? new Set([...PI_ACTION_NAMES, "WORKTREE"])
				: PI_ACTION_NAMES;
			return actions.filter((action) =>
				allowedNames.has(normalizeActionName(action.name)),
			);
		}
	}
}
