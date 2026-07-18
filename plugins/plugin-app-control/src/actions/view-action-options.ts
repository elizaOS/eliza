/**
 * Normalizes the structured operation and target fields accepted by VIEWS.
 * Action parameters form the semantic boundary; natural-language matchers may
 * infer missing fields but must not reinterpret fields the planner supplied.
 */

import { readStringOption } from "../params.js";

const VIEW_NAVIGATION_OPERATIONS = new Set([
	"open",
	"show",
	"view",
	"open_view",
	"show_view",
	"navigate",
	"navigate_to_view",
	"go_to_view",
	"switch",
	"switch_view",
]);

export function readViewOperationOption(
	options?: Record<string, unknown>,
): string | null {
	const operation =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	return operation?.trim().toLowerCase().replace(/-/g, "_") ?? null;
}

export function readViewTargetOption(
	options?: Record<string, unknown>,
): string | null {
	return (
		readStringOption(options, "view") ??
		readStringOption(options, "viewId") ??
		readStringOption(options, "id") ??
		readStringOption(options, "name") ??
		readStringOption(options, "target")
	);
}

export function isViewNavigationOperation(operation: string | null): boolean {
	return operation !== null && VIEW_NAVIGATION_OPERATIONS.has(operation);
}
