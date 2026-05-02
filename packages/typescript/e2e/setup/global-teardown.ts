/**
 * Playwright global teardown: stops the test HTTP server and the AgentRuntime.
 */
import type http from "node:http";
import type { IAgentRuntime } from "../../src/types";

export default async function globalTeardown(): Promise<void> {
	const server = (globalThis as Record<string, unknown>).__e2eServer as
		| http.Server
		| undefined;
	const runtime = (globalThis as Record<string, unknown>).__e2eRuntime as
		| IAgentRuntime
		| undefined;

	if (server) {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		console.log("[e2e] Test server stopped");
	}

	if (runtime) {
		await runtime.stop();
		console.log("[e2e] Runtime stopped");
	}
}
