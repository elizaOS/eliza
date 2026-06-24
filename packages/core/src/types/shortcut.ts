/**
 * Pre-LLM action shortcuts (#8791).
 *
 * A shortcut maps a deterministic intent — an explicit slash/`!` command or a
 * natural-language phrase — onto a concrete target (an action to fire, or a
 * client navigation) *before* the first model call, so the most common turns
 * resolve without inference. The matcher is source-agnostic: a typed message
 * and an ASR transcript are both just `Memory.content.text`.
 *
 * Explicit shortcuts (slash/`!`) are unambiguous and always eligible. Natural
 * shortcuts are caller-enabled, confidence-floored, and defer to the LLM on
 * ambiguity — they never guess.
 */

/** Where a matched shortcut resolves to. */
export type ShortcutTarget =
	| { kind: "action"; name: string; parameters?: Record<string, unknown> }
	| {
			kind: "navigate";
			path: string;
			tab?: string;
			viewId?: string;
			section?: string;
	  }
	| { kind: "client"; clientAction: string };

/**
 * `explicit` = a slash/`!` prefix command (an unambiguous invocation, always
 * eligible). `natural` = a natural-language phrase (caller-enabled,
 * confidence-floored).
 */
export type ShortcutKind = "explicit" | "natural";

/** A single match pattern for a natural-language shortcut. */
export interface ShortcutPattern {
	/**
	 * A slot template compiled to an anchored regex, e.g. `"open {section}"`
	 * matches "open settings" and captures `section: "settings"`.
	 */
	template?: string;
	/** An anchored regex with named capture groups for slots (alternative to template). */
	regex?: RegExp;
	/** Match confidence in [0,1]; defaults to the definition's `confidence`. */
	confidence?: number;
}

export interface ShortcutDefinition {
	/** Stable id, unique per registry. */
	id: string;
	kind: ShortcutKind;
	/** Explicit prefix aliases (`"/settings"`, `"!stop"`). Used for `explicit` kind. */
	aliases?: string[];
	/** Natural-language patterns. Used for `natural` kind. */
	patterns?: ShortcutPattern[];
	/** Where a match resolves. */
	target: ShortcutTarget;
	/** Only eligible while one of these view ids is the foreground surface. */
	requiresContext?: string[];
	/**
	 * Base match confidence in [0,1]. Defaults to 1 for `explicit`, 0.9 for
	 * `natural`. Per-pattern `confidence` overrides this.
	 */
	confidence?: number;
	/** Tiebreak priority among equally-confident matches (higher wins). */
	priority?: number;
	requiresAuth?: boolean;
	requiresElevated?: boolean;
	/**
	 * An action name that must be registered for this shortcut to be eligible —
	 * a shortcut that fires a missing action is skipped rather than misfiring.
	 * Defaults to `target.name` when the target is an action.
	 */
	requiresAction?: string;
}

/** A successful shortcut match. */
export interface ShortcutMatch {
	shortcut: ShortcutDefinition;
	/** Slots extracted from natural-language patterns (empty for explicit). */
	parameters: Record<string, string>;
	confidence: number;
}

/** Context the matcher gates on. */
export interface ShortcutMatchContext {
	/** Registered action names available this turn (for action-existence gating). */
	actions?: readonly string[];
	/** Active view id (for `requiresContext` gating). */
	view?: string | null;
	/**
	 * Whether natural-language shortcuts are eligible this turn. Explicit
	 * (slash/`!`) shortcuts are always eligible regardless of this setting.
	 */
	allowNatural?: boolean;
	/** Sender trust — gates `requiresAuth`/`requiresElevated` shortcuts. */
	isAuthorized?: boolean;
	isElevated?: boolean;
}
