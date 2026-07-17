/**
 * @module plugin-app-control/resolve
 * @description Helpers for resolving a user-supplied "app name" to a
 * registered app (for launch).
 *
 * Match rules:
 * - Exact case-insensitive match on `name`, `displayName`, or `pluginName`
 *   wins unambiguously.
 * - Otherwise, substring match across the same fields. Multiple matches
 *   are returned as candidates for disambiguation at the caller.
 */

import type { InstalledAppInfo } from "./types.js";

export interface ResolveResult<T> {
	kind: "match" | "ambiguous" | "none";
	match?: T;
	candidates?: T[];
}

function norm(value: string): string {
	return value.trim().toLowerCase();
}

function appKeys(app: InstalledAppInfo): string[] {
	return [app.name, app.displayName, app.pluginName].map(norm);
}

function matches<T>(
	needle: string,
	items: readonly T[],
	keyer: (item: T) => string[],
): ResolveResult<T> {
	const target = norm(needle);
	if (!target) {
		return { kind: "none" };
	}

	const exact = items.filter((item) => keyer(item).includes(target));
	if (exact.length === 1) {
		return { kind: "match", match: exact[0] };
	}
	if (exact.length > 1) {
		return { kind: "ambiguous", candidates: exact };
	}

	const substr = items.filter((item) =>
		keyer(item).some((key) => key.includes(target)),
	);
	if (substr.length === 1) {
		return { kind: "match", match: substr[0] };
	}
	if (substr.length > 1) {
		return { kind: "ambiguous", candidates: substr };
	}

	return { kind: "none" };
}

export function resolveInstalledApp(
	name: string,
	apps: readonly InstalledAppInfo[],
): ResolveResult<InstalledAppInfo> {
	return matches(name, apps, appKeys);
}

export function formatAppCandidates(apps: readonly InstalledAppInfo[]): string {
	return apps.map((app) => `- ${app.displayName} (${app.name})`).join("\n");
}
