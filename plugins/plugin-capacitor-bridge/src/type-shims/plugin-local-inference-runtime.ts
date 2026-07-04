/**
 * Type-only shim for optional plugin-local-inference runtime wiring.
 *
 * Mobile bridge code imports the real router handler dynamically when present;
 * this file keeps the bridge package typecheck from requiring that plugin's
 * built runtime output.
 */

export function installRouterHandler(
	_runtime: unknown,
	_options: unknown,
): void {
	throw new Error("Type shim only");
}
