/**
 * Phase 2.3 fixture plugin. Exports a tiny Plugin shape with two
 * actions:
 *
 * - `ECHO`: returns `{ echoed: content }`. Proves the host can pass
 *   params into the worker's action handler and read the result back.
 * - `RUNTIME_PROBE`: tries to call `runtime.getMemories(...)`. With
 *   the Phase 2.3 stub this MUST throw; the test asserts the
 *   structured failure surfaces back across the bridge with the
 *   stub's diagnostic message.
 *
 * Intentionally not a full @elizaos/core Plugin — the worker entry
 * is duck-typed against `{ actions: [{ name, handler }, ...] }` so
 * fixtures can stay minimal.
 */

interface FixtureAction {
	name: string;
	// biome-ignore lint/suspicious/noExplicitAny: handler args are runtime/message/state/options; fixture only uses content + options
	handler: (...args: any[]) => unknown | Promise<unknown>;
}

interface FixturePlugin {
	name: string;
	actions: FixtureAction[];
}

const sandboxPlugin: FixturePlugin = {
	name: "sandbox-fixture",
	actions: [
		{
			name: "ECHO",
			handler: async (
				_runtime: unknown,
				message: { content: unknown },
				_state: unknown,
				_options: unknown,
			) => {
				return { echoed: message.content };
			},
		},
		{
			name: "RUNTIME_PROBE",
			handler: async (runtime: { getMemories: (...args: unknown[]) => unknown }) => {
				// Phase 2.3 stub throws on every property access. This
				// proves the worker correctly forwards the failure as a
				// structured RPC error rather than crashing the worker.
				return await runtime.getMemories({});
			},
		},
	],
};

export default sandboxPlugin;
export { sandboxPlugin };
