/**
 * @module plugin-app-control/resolve
 * @description Helpers for resolving a user-supplied "app name" to either a
 * registered app (for launch) or an active run (for close).
 *
 * Match rules:
 * - Exact case-insensitive match on `name`, `displayName`, or `pluginName`
 *   wins unambiguously.
 * - Otherwise, substring match across the same fields. Multiple matches
 *   are returned as candidates for disambiguation at the caller.
 */
function norm(value) {
	return value.trim().toLowerCase();
}
function appKeys(app) {
	return [app.name, app.displayName, app.pluginName].map(norm);
}
function runKeys(run) {
	return [run.appName, run.displayName, run.pluginName, run.runId].map(norm);
}
function matches(needle, items, keyer) {
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
export function resolveInstalledApp(name, apps) {
	return matches(name, apps, appKeys);
}
export function resolveRunByName(name, runs) {
	return matches(name, runs, runKeys);
}
export function formatAppCandidates(apps) {
	return apps.map((app) => `- ${app.displayName} (${app.name})`).join("\n");
}
export function formatRunCandidates(runs) {
	return runs
		.map(
			(run) =>
				`- ${run.displayName} [runId: ${run.runId}, status: ${run.status}]`,
		)
		.join("\n");
}
//# sourceMappingURL=resolve.js.map
