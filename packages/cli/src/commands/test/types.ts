/**
 * Test command options and interfaces
 */

/**
 * Options for component test execution
 */
export interface ComponentTestOptions {
  name?: string;
  skipBuild?: boolean;
  skipTypeCheck?: boolean;
}

/**
 * Options for e2e test execution
 */
export interface E2ETestOptions {
  port?: number;
  name?: string;
  skipBuild?: boolean;
}

/**
 * Combined test command options
 */
export interface TestCommandOptions extends ComponentTestOptions, E2ETestOptions {
  type?: 'component' | 'e2e' | 'all';
  port?: number;
  name?: string;
  skipBuild?: boolean;
}

/**
 * Test execution result
 */
export interface TestResult {
  failed: boolean;
}

/**
 * Test context configuration
 */
export interface TestContext {
  projectInfo: import('@/src/utils/directory-detection').DirectoryInfo;
  testPath?: string;
  options: TestCommandOptions;
}

/**
 * Server configuration for e2e tests
 */
export interface ServerConfig {
  port: number;
  runtime?: import('@elizaos/core').IAgentRuntime;
}

/**
 * Plugin dependency information
 */
export interface PluginDependency {
  name: string;
  path: string;
  module?: import('@elizaos/core').Plugin;
}
