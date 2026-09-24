/** Types the agent test runner's discovery, process invocation, and evidence helpers. */
export const agentTestInclude: string[];
export const agentTestExclude: string[];
export function isDefaultAgentTest(relativePath: string): boolean;
export function positiveInteger(
  value: string | undefined,
  label: string,
  fallback: number,
): number;
export function createBatches<T>(files: readonly T[], batchSize: number): T[][];
export function resolveBunExecutable(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): string | null;
export function parseAgentTestArgs(argv: readonly string[]): {
  reporterOutfile: string | undefined;
  selectors: string[];
};
export function mergeAgentJunit(
  fragments: readonly string[],
  destination: string,
): void;
export function createVitestInvocation(
  bunExecutable: string,
  batch: readonly string[],
  fragmentPath?: string,
): {
  command: string;
  args: string[];
};
