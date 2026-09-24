/** Real initialized kernel fixture. In-memory persistence supplies the authority
 * reads needed by provider composition; every fixture drains and closes. */

import { createSQLiteTestRuntime } from "@elizaos/testing";
import { afterEach } from "vitest";
import type { AgentRuntime } from "../runtime";

const runtimes = new Set<AgentRuntime>();
export async function createInitializedRuntime(
	options: ConstructorParameters<typeof AgentRuntime>[0],
): Promise<AgentRuntime> {
	const runtime = createSQLiteTestRuntime({
		...options,
		adapter: options?.adapter,
	});
	await runtime.initialize({ skipMigrations: true });
	runtimes.add(runtime);
	return runtime;
}
afterEach(async () => {
	const current = [...runtimes];
	runtimes.clear();
	await Promise.all(
		current.map(async (runtime) => {
			await runtime.stop();
			await runtime.close();
		}),
	);
});
