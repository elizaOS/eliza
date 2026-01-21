import type {
  TestCase as ProtoTestCase,
  TestSuite as ProtoTestSuite,
} from "./proto.js";
import type { IAgentRuntime } from "./runtime";

/**
 * Represents a test case for evaluating agent or plugin functionality.
 */
export interface TestCase
  extends Omit<ProtoTestCase, "$typeName" | "$unknown" | "handlerId"> {
  fn: (runtime: IAgentRuntime) => Promise<void> | void;
}

/**
 * Represents a suite of related test cases for an agent or plugin.
 */
export interface TestSuite
  extends Omit<ProtoTestSuite, "$typeName" | "$unknown" | "tests"> {
  tests: TestCase[];
}
