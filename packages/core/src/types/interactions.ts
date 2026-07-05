/**
 * Interactive message blocks — the canonical, connector-agnostic vocabulary for
 * structured controls an agent can embed in a reply: forms, option pickers,
 * suggestion chips, live task cards, and sensitive (secret / OAuth) requests.
 *
 * These types are the single source of truth shared by every surface:
 *   - the runtime normalizes a reply's `Content.text` into `Content.interactions`
 *     (see `messaging/interactions`),
 *   - the dashboard renders them as inline widgets,
 *   - connectors (Telegram, Discord, …) render them as native components
 *     (inline keyboards, action rows, select menus) and route the user's answer
 *     back as an ordinary inbound message.
 *
 * The wire format is the bracket-marker text the dashboard already emits
 * (`[FORM]`, `[CHOICE:…]`, `[FOLLOWUPS]`, `[TASK:…]`) so existing agent output
 * keeps working unchanged; `messaging/interactions/parse` is a faithful superset
 * of the dashboard's per-feature parsers. Secret requests travel out-of-band via
 * the sensitive-request dispatch registry rather than as plaintext in the text,
 * but share this vocabulary so a connector has one place to render every control.
 */

/** A selectable option in a choice picker or select field. */
export interface InteractionOption {
	/** Stable token sent back when chosen (short — also used as connector callback data). */
	value: string;
	/** Human-facing label. */
	label: string;
	/** Optional longer description (rendered by surfaces that support it). */
	description?: string;
}

export type InteractionFieldType =
	| "text"
	| "number"
	| "select"
	| "checkbox"
	| "secret"
	| "image"
	| "file"
	// Native temporal pickers. Submitted values are the HTML input's own string
	// value — `date` → `YYYY-MM-DD`, `time` → `HH:mm`, `datetime` →
	// `YYYY-MM-DDTHH:mm` (local, no timezone). Consuming actions parse these
	// deterministically; there is no custom picker or extra dependency.
	| "date"
	| "time"
	| "datetime";

/** A single field in a form or secret request. */
export interface InteractionField {
	/** Result key. */
	name: string;
	type: InteractionFieldType;
	label?: string;
	placeholder?: string;
	required?: boolean;
	/** For `type: "select"` only. */
	options?: InteractionOption[];
	/**
	 * For `type: "image" | "file"` only — accepted MIME types (maps to the file
	 * input's `accept`). Defaults to `image/*` for image fields when omitted.
	 */
	mimeTypes?: string[];
	/** For `type: "image" | "file"` only — max upload size in bytes. */
	maxBytes?: number;
}

/** `[FORM]` — a structured multi-field input rendered as an inline form. */
export interface FormInteraction {
	kind: "form";
	id: string;
	title?: string;
	description?: string;
	submitLabel?: string;
	fields: InteractionField[];
}

/**
 * `[CHOICE:<scope> id=<id>]` — pick exactly one option. `scope` carries the
 * routing semantics the consuming action keys off. `allowCustom` lets the user
 * supply their own free-text answer instead of a listed option.
 */
export interface ChoiceInteraction {
	kind: "choice";
	id: string;
	scope: string;
	prompt?: string;
	options: InteractionOption[];
	allowCustom?: boolean;
}

export type FollowupKind = "reply" | "navigate" | "prompt";

/** A single suggestion chip. */
export interface FollowupOption {
	kind: FollowupKind;
	/** reply/prompt: the message text; navigate: a viewId or `/`-prefixed path. */
	payload: string;
	label: string;
}

/** `[FOLLOWUPS]` — passive, dismissible suggestion chips under a reply. */
export interface FollowupsInteraction {
	kind: "followups";
	id: string;
	options: FollowupOption[];
}

/** `[TASK:<threadId>]` — a live orchestrator task card linking to the task view. */
export interface TaskInteraction {
	kind: "task";
	threadId: string;
	title: string;
}

/**
 * A sensitive-information request: a secret/credential form or an OAuth connect.
 * Rendered inline (per-field password inputs / a Connect button) in the
 * dashboard; on connectors it becomes a single button linking out to a secure
 * entry page so secrets never transit the chat transport. Built from a
 * sensitive-request dispatch envelope rather than parsed from message text.
 */
export interface SecretInteraction {
	kind: "secret";
	id: string;
	secretKind: "secret" | "oauth";
	reason?: string;
	/** Secret mode: the fields to collect (each typically `type: "secret"`). */
	fields?: InteractionField[];
	/** OAuth mode: human-readable provider label (e.g. "GitHub"). */
	provider?: string;
	/** OAuth mode: scopes the consent screen requests. */
	scopes?: string[];
	/** Secure entry / consent URL the connector links to (absent for app-inline). */
	url?: string;
	submitLabel?: string;
}

/** The discriminated union of every interactive control a reply can carry. */
export type InteractionBlock =
	| FormInteraction
	| ChoiceInteraction
	| FollowupsInteraction
	| TaskInteraction
	| SecretInteraction;

export type InteractionKind = InteractionBlock["kind"];
