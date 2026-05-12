import type { IAgentRuntime } from "./runtime";

/**
 * Represents a test case for evaluating agent or plugin functionality.
 */
export interface TestCase {
	name: string;
	fn: (runtime: IAgentRuntime) => Promise<void> | void;
}

/**
 * Represents a suite of related test cases for an agent or plugin.
 */
export interface TestSuite {
	name: string;
	tests: TestCase[];
}
