/**
 * Type-only shim for the agent root bootstrap imported by Android bridge code.
 *
 * Runtime code loads the real package dynamically; this stand-in exists only so
 * the bridge package can typecheck without a built agent distribution.
 */

export function startEliza(_options: { serverOnly: true }): Promise<unknown> {
	throw new Error("Type shim only");
}
