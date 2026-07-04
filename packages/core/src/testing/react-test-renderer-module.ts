/**
 * Ambient declaration supplying the `act` signature for `react-test-renderer`,
 * which ships no bundled types.
 */
declare module "react-test-renderer" {
	export function act<T>(callback: () => T | Promise<T>): Promise<Awaited<T>>;
}
