/**
 * Main exports TypeScript implementation
 */

// Core types
export * from './types';
export * from './exceptions';

// Agent module - selective exports to avoid conflicts
export {
  AbstractAgent,
  DefaultAgent,
  RetryAgent,
  AgentConfig,
  DefaultAgentConfig,
  RetryAgentConfig,
  ShellAgentConfig,
  TemplateConfig,
  getAgentFromConfig,
} from './agent/agents';

export {
  AbstractModel,
  HumanModel,
  LiteLLMModel,
  ReplayModel,
  InstantEmptySubmitModel,
  HumanThoughtModel,
  ModelConfig,
  GenericAPIModelConfig,
  HumanModelConfig,
  ReplayModelConfig,
  GlobalStats,
  InstanceStats,
  getModel,
} from './agent/models';

export {
  ProblemStatement,
  ProblemStatementConfig,
  EmptyProblemStatement,
  TextProblemStatement,
  FileProblemStatement,
  GithubIssue,
  SWEBenchMultimodalProblemStatement,
  problemStatementFromSimplifiedInput,
} from './agent/problem-statement';

export {
  AbstractReviewer,
  AbstractRetryLoop,
  ReviewSubmission,
  ReviewerResult,
  PreselectorOutput,
  ChooserOutput,
  Reviewer,
  Chooser,
  ChooserRetryLoop,
  ScoreRetryLoop,
  ReviewerConfig,
  ChooserConfig,
  PreselectorConfig,
  ChooserRetryLoopConfig,
  ScoreRetryLoopConfig,
  RetryLoopConfig,
  getRetryLoopFromConfig,
} from './agent/reviewer';

export {
  AbstractActionSampler,
  ActionSamplerOutput,
  AskColleagues,
  AskColleaguesConfig,
  BinaryTrajectoryComparison,
  BinaryTrajectoryComparisonConfig,
  ActionSamplerConfig,
  createActionSampler,
} from './agent/action-sampler';

export {
  AbstractHistoryProcessor,
  DefaultHistoryProcessor,
  LastNObservations,
  TagToolCallObservations,
  ClosedWindowHistoryProcessor,
  CacheControlHistoryProcessor,
  RemoveRegex,
  ImageParsingHistoryProcessor,
  createHistoryProcessor,
} from './agent/history-processors';

// Environment module
export { SWEEnv, EnvironmentConfig } from './environment/swe-env';

export {
  Repo,
  PreExistingRepo,
  LocalRepo,
  GithubRepo,
  PreExistingRepoConfig,
  LocalRepoConfig,
  GithubRepoConfig,
  RepoConfig,
  repoFromSimplifiedInput,
} from './environment/repo';

export {
  AbstractDeployment,
  DockerDeployment,
  DockerDeploymentConfig,
  DeploymentConfig,
  getDeployment,
} from './environment/deployment';

export {
  AbstractRuntime,
  BashAction,
  BashActionResult,
  BashInterruptAction,
  CreateBashSessionRequest,
  Command,
  CommandResult,
  ReadFileRequest,
  ReadFileResponse,
  WriteFileRequest,
  UploadRequest,
} from './environment/runtime';

// Utils module - selective exports
export { getLogger, AgentLogger, setThreadName, getThreadName, setLogLevel, log } from './utils/log';

export {
  convertPathRelativeToRepoRoot,
  convertPathToAbspath,
  convertPathsToAbspath,
  loadEnvironmentVariables,
  stripAbspathFromDict,
  couldBeAPath,
} from './utils/config';

export { loadFile } from './utils/files';

export {
  isGithubRepoUrl,
  isGithubIssueUrl,
  parseGhIssueUrl,
  parseGhRepoUrl,
  getGhIssueData,
  getProblemStatementFromGithubIssue,
  getAssociatedCommitUrls,
  InvalidGithubURL,
} from './utils/github';

export { warnProbablyWrongJinjaSyntax } from './utils/jinja-warnings';

export { PatchFormatter } from './utils/patch-formatter';

export { convertToYamlLiteralString, yamlSerializationWithLinebreaks, mergeNestedDicts } from './utils/serialization';

// Tools module - selective exports
export { Bundle, BundleConfig } from './tools/bundle';

export { Command as ToolCommand, Argument } from './tools/commands';

export {
  AbstractParseFunction,
  ActionParser,
  ActionOnlyParser,
  ThoughtActionParser,
  XMLThoughtActionParser,
  FunctionCallingParser,
  JsonParser,
  IdentityParser,
  ParseFunction,
  createParser,
} from './tools/parsing';

export { ToolHandler, ToolConfig, ToolFilterConfig, defaultToolConfig, defaultToolFilterConfig } from './tools/tools';

export { guardMultilineInput, shouldQuote, getSignature, generateCommandDocs } from './tools/utils';

// Run module - selective exports
export {
  RunSingle,
  RunSingleConfig,
  RunSingleActionConfig,
  runFromConfig as runSingleFromConfig,
} from './run/run-single';

export { RunBatch, RunBatchConfig, runBatchFromConfig } from './run/run-batch';

export { RunReplay, RunReplayConfig, runReplayFromConfig } from './run/run-replay';

export { RunShell } from './run/run-shell';

export {
  BatchInstance,
  SimpleBatchInstance,
  AbstractInstanceSource,
  InstancesFromFile,
  SWEBenchInstances,
  BatchInstanceSourceConfig,
  createInstanceSource,
  filterBatchItems,
} from './run/batch-instances';

export { RunHook, AbstractRunHook, CombinedRunHooks } from './run/hooks/types';
export { SaveApplyPatchHook } from './run/hooks/apply-patch';
export { OpenPRHook } from './run/hooks/open-pr';
export { SweBenchEvaluate } from './run/hooks/swe-bench-evaluate';

export {
  shortenString,
  shortenStrings,
  savePredictions,
  isPromisingPatch,
  createNestedDict,
  parseArgsToNestedDict,
} from './run/common';

export { run } from './run/run';

// Version info
export const VERSION = '1.1.0';

/**
 * Get agent commit hash
 */
export function getAgentCommitHash(): string {
  // In a real implementation, this would get the actual git commit hash
  return process.env.SWE_AGENT_COMMIT_HASH || 'unknown';
}

/**
 * Get REX commit hash
 */
export function getRexCommitHash(): string {
  return process.env.SWE_REX_COMMIT_HASH || 'unknown';
}

/**
 * Get REX version
 */
export function getRexVersion(): string {
  return process.env.SWE_REX_VERSION || '0.0.0';
}

/**
 * Get agent version info
 */
export function getAgentVersionInfo(): string {
  return `SWE-agent ${VERSION}`;
}
