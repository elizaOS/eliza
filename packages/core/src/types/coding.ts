/** Defines trusted per-turn coding action profiles without changing runtime plugin composition. */

/**
 * Restricts a coding turn to the native action families exposed by Pi.
 * WORKTREE is opt-in because Pi's default tool surface has no worktree tool.
 */
export interface PiCodingActionProfile {
	readonly kind: "pi";
	readonly includeWorktree?: boolean;
}

/** Model-facing action policy selected by a trusted coding host for one turn. */
export type CodingActionProfile = PiCodingActionProfile;

/** Pi 0.84.2 default active tools mapped to Eliza: READ, SHELL, EDIT, and WRITE. */
export const PI_CODING_ACTION_PROFILE: PiCodingActionProfile = Object.freeze({
	kind: "pi",
});
