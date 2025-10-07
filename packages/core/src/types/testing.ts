import type { IAgentRuntime } from './runtime';

/**
 * Represents a test case for evaluating agent or plugin functionality.
 * Each test case has a name and a function that contains the test logic.
 * The test function receives the `IAgentRuntime` instance, allowing it to interact with the agent's capabilities.
 * Test cases are typically grouped into `TestSuite`s.
 */
export interface TestCase {
  /** A descriptive name for the test case, e.g., "should respond to greetings". */
  name: string;
  /**
   * The function that executes the test logic. It can be synchronous or asynchronous.
   * It receives the `IAgentRuntime` to interact with the agent and its services.
   * The function should typically contain assertions to verify expected outcomes.
   */
  fn: (runtime: IAgentRuntime) => Promise<void> | void;
}

/**
 * Represents a suite of related test cases for an agent or plugin.
 * This helps in organizing tests and running them collectively.
 * A `ProjectAgent` can define one or more `TestSuite`s.
 */
export interface TestSuite {
  /** A descriptive name for the test suite, e.g., "Core Functionality Tests". */
  name: string;
  /** An array of `TestCase` objects that belong to this suite. */
  tests: TestCase[];
}
