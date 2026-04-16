/**
 * Shared PGLite runtime helper for live scripts under `test/live/`.
 *
 * Duplicated from app-core test helpers so `@elizaos/core` live scenarios
 * stay colocated with the orchestrator implementation.
 */
import type { Plugin } from "@elizaos/core";
import { AgentRuntime } from "@elizaos/core";
export interface TestRuntimeOptions {
	characterName?: string;
	plugins?: Plugin[];
	pgliteDir?: string;
	removePgliteDirOnCleanup?: boolean;
}
export interface TestRuntimeResult {
	runtime: AgentRuntime;
	pgliteDir: string;
	cleanup: () => Promise<void>;
}
export declare function createTestRuntime(
	options?: TestRuntimeOptions,
): Promise<TestRuntimeResult>;
//# sourceMappingURL=pglite-runtime.d.ts.map
