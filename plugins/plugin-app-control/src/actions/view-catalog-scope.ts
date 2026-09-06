/**
 * Defines the visibility boundary of view catalogs returned to callers and models.
 * Omission does not disclose whether a view exists outside the caller's authority.
 */
export const CALLER_VIEW_CATALOG_SCOPE = Object.freeze({
	visibility: "caller-authorized",
	missingView: "unavailable-to-caller",
	missingViewCause: "unknown",
} as const);

export const VIEW_CATALOG_SCOPE_CONTEXT =
	`View catalog scope: ${JSON.stringify(CALLER_VIEW_CATALOG_SCOPE)}. ` +
	"An absent destination is unavailable to this caller. This catalog cannot establish global nonexistence or rule out a role restriction; do not infer either cause from omission.";
