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

interface SandboxRuntime {
	slug: string;
	statePath: string | null;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	fs: {
		readFile: (path: string) => Promise<string>;
		writeFile: (path: string, content: string) => Promise<void>;
	};
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
			handler: async (runtime: {
				getMemories: (...args: unknown[]) => unknown;
			}) => {
				// Stub throws on every un-gated property access. Proves
				// the worker forwards the failure as a structured RPC
				// error rather than crashing the worker.
				return await runtime.getMemories({});
			},
		},
		{
			name: "NET_FETCH",
			handler: async (
				runtime: SandboxRuntime,
				message: { content: { url: string } },
			) => {
				const response = await runtime.fetch(message.content.url);
				return { status: response.status };
			},
		},
		{
			name: "FS_WRITE_THEN_READ",
			handler: async (
				runtime: SandboxRuntime,
				message: { content: { relPath: string; payload: string } },
			) => {
				if (!runtime.statePath) {
					throw new Error("statePath not assigned");
				}
				const target = `${runtime.statePath}/${message.content.relPath}`;
				await runtime.fs.writeFile(target, message.content.payload);
				return { read: await runtime.fs.readFile(target) };
			},
		},
		{
			name: "FS_ESCAPE_ATTEMPT",
			handler: async (
				runtime: SandboxRuntime,
				message: { content: { absolutePath: string } },
			) => {
				return {
					read: await runtime.fs.readFile(message.content.absolutePath),
				};
			},
		},
	],
};

export default sandboxPlugin;
export { sandboxPlugin };
