/**
 * Main agent classes
 * Converted from sweagent/agent/agents.py
 */

import * as fs from 'fs';
import * as path from 'path';
import { AbstractModel, InstanceStats, getModel, HumanModel, HumanThoughtModel, ModelConfig } from './models';
import { AbstractAgentHook, CombinedAgentHook } from './hooks';
import { AbstractHistoryProcessor } from './history-processors';
import { ProblemStatement, ProblemStatementConfig } from './problem-statement';
import { getLogger } from '../utils/log';
import {
  AgentInfo,
  AgentRunResult,
  History,
  HistoryItem,
  StepOutput,
  StepOutputImpl,
  Trajectory,
  TrajectoryStep,
} from '../types';
import { renderTemplate, renderAdvancedTemplate } from './utils/template';
import { parseYAML } from './utils/yaml';
import { AbstractParseFunction, ThoughtActionParser, getParser } from './tools/parsing';
import { AbstractActionSampler } from './action-sampler';
import { ModelOutput } from './types';

const logger = getLogger('agent');

// Import error classes
import {
  BlockedActionError,
  RetryWithOutputError,
  RetryWithoutOutputError,
  ExitForfeitError,
  TotalExecutionTimeExceededError,
} from '../exceptions';
// Dynamic import for ShellAgent to avoid circular dependency

// Special tokens
const RETRY_WITH_OUTPUT_TOKEN = '###SWE-AGENT-RETRY-WITH-OUTPUT###';
const RETRY_WITHOUT_OUTPUT_TOKEN = '###SWE-AGENT-RETRY-WITHOUT-OUTPUT###';
const EXIT_FORFEIT_TOKEN = '###SWE-AGENT-EXIT-FORFEIT###';

/**
 * Template configuration for agent messages
 */
export interface TemplateConfig {
  systemTemplate: string;
  instanceTemplate: string;
  nextStepTemplate: string;
  nextStepTruncatedObservationTemplate: string;
  maxObservationLength: number;
  nextStepNoOutputTemplate?: string;
  strategyTemplate?: string;
  demonstrationTemplate?: string;
  demonstrations: string[];
  putDemosInHistory: boolean;
  disableImageProcessing: boolean;
  shellCheckErrorTemplate: string;
  commandCancelledTimeoutTemplate: string;
}

/**
 * Default template values matching Python implementation
 */
export const DEFAULT_TEMPLATE_CONFIG: Partial<TemplateConfig> = {
  systemTemplate: '',
  instanceTemplate: '',
  nextStepTemplate: 'Observation: {{observation}}',
  nextStepTruncatedObservationTemplate:
    'Observation: {{observation[:max_observation_length]}}<response clipped>' +
    '<NOTE>Observations should not exceeded {{max_observation_length}} characters. ' +
    '{{elided_chars}} characters were elided. Please try a different command that produces less output ' +
    'or use head/tail/grep/redirect the output to a file. Do not use interactive pagers.</NOTE>',
  maxObservationLength: 100000,
  demonstrations: [],
  putDemosInHistory: false,
  disableImageProcessing: false,
  shellCheckErrorTemplate:
    'Your command contains syntax errors. Please fix them and try again.\n' +
    'Error: {{error_message}}\n' +
    'Hint: {{hint}}',
  commandCancelledTimeoutTemplate: 'Command cancelled after {{timeout}} seconds. The command was: {{command}}',
};

/**
 * Command bundle configuration
 */
export interface CommandBundle {
  name: string;
  endName?: string;
  installScript?: string;
  [key: string]: unknown;
}

/**
 * Tool configuration
 */
export interface ToolConfig {
  commands: CommandBundle[];
  parseFunction?: AbstractParseFunction | string;
  executionTimeout: number;
  maxConsecutiveExecutionTimeouts: number;
  totalExecutionTimeout: number;
  submitCommand: string;
  useFunctionCalling: boolean;
  filter?: {
    blocklistErrorTemplate: string;
    blocklist: string[];
    blocklistStandalone: string[];
    blockUnlessRegex?: Record<string, string>;
  };
  formatErrorTemplate: string;
  commandDocs?: string;
  envVariables?: Record<string, string | number | boolean>;
}

/**
 * Tool handler for managing agent tools
 */
export class ToolHandler {
  config: ToolConfig;
  tools: CommandBundle[];
  private parser: AbstractParseFunction;
  private multilineCommands: Map<string, string> = new Map();

  constructor(config: ToolConfig) {
    this.config = config;
    this.tools = [];

    // Initialize parser
    if (typeof config.parseFunction === 'string') {
      this.parser = getParser(config.parseFunction);
    } else if (config.parseFunction) {
      this.parser = config.parseFunction;
    } else {
      this.parser = new ThoughtActionParser();
    }

    // Initialize multiline commands from config
    if (config.commands) {
      for (const cmd of config.commands) {
        if (cmd.endName) {
          this.multilineCommands.set(cmd.name, cmd.endName);
        }
      }
    }
  }

  async install(env: AgentEnvironment): Promise<void> {
    // Install tools in the environment
    // Set environment variables
    if (this.config.envVariables) {
      const stringEnvVars = Object.fromEntries(
        Object.entries(this.config.envVariables).map(([key, value]) => [key, String(value)]),
      );
      await env.setEnvVariables(stringEnvVars);
    }

    // Install each bundle if they exist
    if (this.config.commands) {
      const cwd = await env.communicate('pwd');

      // Process each tool bundle
      for (const bundle of this.config.commands) {
        if (bundle.installScript) {
          await env.communicate(bundle.installScript);
        }
      }

      // Return to original directory
      await env.communicate(`cd ${cwd}`);
    }
  }

  async getState(env: AgentEnvironment): Promise<Record<string, string>> {
    // Get current state from environment
    const state: Record<string, string> = {};

    // Get working directory
    if (env.getCwd) {
      state.workingDir = env.getCwd();
    }

    // Get open files
    if (env.getOpenFiles) {
      const openFiles = env.getOpenFiles();
      if (openFiles && openFiles.length > 0) {
        state.openFiles = openFiles.join(', ');
      }
    }

    // Get git status if available
    if (env.getGitStatus) {
      state.gitStatus = env.getGitStatus();
    }

    return state;
  }

  parseActions(output: string | ModelOutput): [string, string] {
    // Parse thought and action from model output using configured parser
    // Use strict mode to throw FormatError when parsing fails
    return this.parser.call(output, this.config.commands, true);
  }

  shouldBlockAction(action: string): boolean {
    // Check if action should be blocked
    action = action.trim();
    if (!action) {
      return false;
    }

    if (!this.config.filter) {
      return false;
    }

    // Check blocklist
    if (this.config.filter.blocklist) {
      for (const blocked of this.config.filter.blocklist) {
        if (action.startsWith(blocked)) {
          return true;
        }
      }
    }

    // Check standalone blocklist
    if (this.config.filter.blocklistStandalone && this.config.filter.blocklistStandalone.includes(action)) {
      return true;
    }

    // Check block unless regex
    if (this.config.filter.blockUnlessRegex) {
      const commandName = action.split(' ')[0];
      if (commandName in this.config.filter.blockUnlessRegex) {
        const regex = new RegExp(this.config.filter.blockUnlessRegex[commandName]);
        if (!regex.test(action)) {
          return true;
        }
      }
    }

    return false;
  }

  checkForSubmissionCmd(observation: string): boolean {
    // Check if observation contains submission command
    // Look for the special submission marker used by SWE-agent
    return observation?.includes('<<SWE_AGENT_SUBMISSION>>') || false;
  }

  guardMultilineInput(action: string): string {
    // Guard multiline input commands with heredoc syntax
    // This handles commands that can take multiline input

    for (const [cmdName, endName] of this.multilineCommands) {
      // Check if action starts with this command
      const regex = new RegExp(`^${cmdName}\\b`);
      if (regex.test(action)) {
        // Check if it already has the heredoc syntax
        if (!action.includes('<<')) {
          // Add heredoc syntax
          const lines = action.split('\n');
          if (lines.length > 1) {
            // It's a multiline command that needs guarding
            lines[0] = `${lines[0]} << '${endName}'`;
            lines.push(endName);
            return lines.join('\n');
          }
        }
        break; // Only handle the first matching command
      }
    }

    return action;
  }
}

/**
 * Environment interface for agent operations
 */
export interface AgentEnvironment {
  communicate(
    command: string,
    timeout?: number | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<string>;
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  setEnvVariables(vars: Record<string, string>): Promise<void>;
  executeCommand(command: string, options?: Record<string, unknown>): Promise<void>;
  interruptSession(): Promise<void>;
  getCwd?(): string;
  getOpenFiles?(): string[];
  getGitStatus?(): string;
  isAlive?(): boolean;
  repo?: { repoName: string };
  name?: string;
  hardReset?(): void;
}

/**
 * Logger interface
 */
export interface AgentLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  critical(message: string, ...args: unknown[]): void;
  warning(message: string, ...args: unknown[]): void;
}

/**
 * Action sampler configuration interface
 */
export interface ActionSamplerConfig {
  type: string;
  get(model: AbstractModel, tools: ToolHandler): AbstractActionSampler;
  [key: string]: unknown;
}

/**
 * Retry loop configuration interface
 */
export interface RetryLoopConfig {
  type: string;
  costLimit: number;
  maxAttempts?: number;
  minBudgetForNewAttempt?: number;
  [key: string]: unknown;
}

/**
 * Configuration for default agent
 */
export interface DefaultAgentConfig {
  name: string;
  templates: TemplateConfig;
  tools: ToolConfig;
  historyProcessors: AbstractHistoryProcessor[];
  model: ModelConfig;
  maxRequeries: number;
  actionSampler?: ActionSamplerConfig;
  type: 'default' | 'retry' | 'shell';
}

/**
 * Configuration for retry agent
 */
export interface RetryAgentConfig {
  name: string;
  agentConfigs: DefaultAgentConfig[];
  retryLoop: RetryLoopConfig;
  type: 'retry';
}

/**
 * Configuration for shell agent
 */
export interface ShellAgentConfig {
  name: string;
  templates: TemplateConfig;
  tools: ToolConfig;
  historyProcessors: AbstractHistoryProcessor[];
  model: ModelConfig;
  maxRequeries: number;
  type: 'shell';
}

export type AgentConfig = DefaultAgentConfig | RetryAgentConfig | ShellAgentConfig;

/**
 * Abstract base class for agents
 */
export abstract class AbstractAgent {
  static fromConfig(_config: AgentConfig): AbstractAgent {
    throw new Error('fromConfig must be implemented by subclasses');
  }
  abstract addHook(hook: AbstractAgentHook): void;
  abstract getTrajectoryData(): Record<string, unknown>;
  abstract step(): Promise<StepOutput>;
  abstract run(
    env: AgentEnvironment,
    problemStatement: ProblemStatement | ProblemStatementConfig,
    outputDir?: string,
  ): Promise<AgentRunResult>;
}

/**
 * Default agent implementation
 */
export class DefaultAgent extends AbstractAgent {
  name: string;
  model: AbstractModel;
  templates: TemplateConfig;
  tools: ToolHandler;
  historyProcessors: AbstractHistoryProcessor[];
  maxRequeries: number;
  logger: AgentLogger;

  env: AgentEnvironment | null = null;
  problemStatement: ProblemStatement | ProblemStatementConfig | null = null;
  trajPath: string | null = null;

  history: History = [];
  trajectory: Trajectory = [];
  info: AgentInfo = {};

  chook: CombinedAgentHook;
  replayConfig: AgentConfig | null = null;
  private _actionSampler: AbstractActionSampler | null = null;
  private nConsecutiveTimeouts: number = 0;
  private totalExecutionTime: number = 0;

  constructor(config: {
    templates: TemplateConfig;
    tools: ToolHandler;
    historyProcessors: AbstractHistoryProcessor[];
    model: AbstractModel;
    maxRequeries?: number;
    name?: string;
    catchErrors?: boolean;
    alwaysRequireZeroExitCode?: boolean;
    actionSamplerConfig?: ActionSamplerConfig;
  }) {
    super();
    this.name = config.name || 'main';
    this.model = config.model;
    this.templates = config.templates;
    this.tools = config.tools;
    this.historyProcessors = config.historyProcessors;
    this.maxRequeries = config.maxRequeries || 3;
    this.logger = logger;
    this.chook = new CombinedAgentHook();

    // Set parser based on model type
    if (this.model instanceof HumanThoughtModel) {
      this.tools.config.parseFunction = 'thought_action';
    } else if (this.model instanceof HumanModel) {
      this.tools.config.parseFunction = 'action_only';
    }

    if (config.actionSamplerConfig) {
      // Initialize action sampler if configured
      this._actionSampler = config.actionSamplerConfig.get(this.model, this.tools);
    }
  }

  static fromConfig(config: DefaultAgentConfig): DefaultAgent {
    // Deep copy config to avoid shared state between different instances
    const configCopy = JSON.parse(JSON.stringify(config)) as DefaultAgentConfig;
    const model = getModel(configCopy.model, configCopy.tools);
    return new DefaultAgent({
      templates: configCopy.templates,
      tools: new ToolHandler(configCopy.tools),
      historyProcessors: configCopy.historyProcessors,
      model,
      maxRequeries: configCopy.maxRequeries,
      actionSamplerConfig: configCopy.actionSampler,
    });
  }

  addHook(hook: AbstractAgentHook): void {
    hook.onInit(this);
    this.chook.addHook(hook);
  }

  get messages(): History {
    // Return processed history for this attempt
    const filteredHistory = this.history.filter(
      (entry) => 'agent' in entry && (entry as { agent: string }).agent === this.name,
    );

    // Chain history processors
    let messages = filteredHistory;
    for (const processor of this.historyProcessors) {
      messages = processor(messages);
    }

    return messages;
  }

  private appendHistory(item: HistoryItem & { agent: string; messageType: string }): void {
    this.chook.onQueryMessageAdded({
      agent: item.agent,
      role: item.role,
      content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
      messageType: item.messageType,
      isDemo: item.isDemo,
      thought: item.thought,
      action: item.action === null ? undefined : item.action,
      toolCalls: item.toolCalls
        ? item.toolCalls.map((tc) => ({
            id: tc.id || '',
            type: tc.type || 'function',
            function: JSON.stringify(tc.function),
          }))
        : null,
      toolCallIds: item.toolCallIds,
      thinkingBlocks: item.thinkingBlocks
        ? item.thinkingBlocks.map((tb) => ({
            type: tb.type,
            content: tb.content,
            startTime: String(tb.startTime || ''),
            endTime: String(tb.endTime || ''),
          }))
        : null,
    });
    this.history.push(item);
  }

  async setup(
    env: AgentEnvironment,
    problemStatement: ProblemStatement | ProblemStatementConfig,
    outputDir: string = '.',
  ): Promise<void> {
    // Setup the agent for a new instance
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    this.problemStatement = problemStatement;
    this.env = env;
    const iid = this.problemStatement.id;
    this.logger.info(`Setting up agent for instance ${iid}`);

    this.trajPath = path.join(outputDir, `${this.problemStatement.id}.traj`);
    this.logger.info(`Trajectory will be saved to ${this.trajPath}`);

    this.chook.onToolsInstallationStarted();
    await this.tools.install(this.env);
    this.chook.onSetupAttempt();

    this.info = {};
    // Get version from package.json
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8'));
      this.info.sweAgentVersion = packageJson.version || '1.0.0';
    } catch {
      this.info.sweAgentVersion = '1.0.0';
    }

    // Add system message, demonstrations, and instance template to history
    this.addSystemMessageToHistory();
    this.addDemonstrationsToHistory();
    const state = await this.tools.getState(this.env);
    this.addInstanceTemplateToHistory(state);

    this.chook.onSetupDone();
  }

  private getFormatDict(kwargs?: Record<string, unknown>): Record<string, unknown> {
    if (!this.problemStatement || !this.env) {
      return kwargs || {};
    }

    return {
      commandDocs: this.tools.config.commandDocs || '',
      ...this.tools.config.envVariables,
      ...kwargs,
      problemStatement: this.problemStatement.getProblemStatement(),
      repo: this.env.repo?.repoName || '',
      ...this.problemStatement.getExtraFields(),
    };
  }

  private addSystemMessageToHistory(): void {
    if (!this.problemStatement) {
      return;
    }

    const systemMsg = renderAdvancedTemplate(this.templates.systemTemplate, this.getFormatDict());
    this.logger.info(`SYSTEM (${this.name})\n${systemMsg}`);
    this.appendHistory({
      role: 'system',
      content: systemMsg,
      agent: this.name,
      messageType: 'system',
    });
  }

  private addDemonstrationsToHistory(): void {
    for (const demoPath of this.templates.demonstrations) {
      this.addDemonstrationToHistory(demoPath);
    }
  }

  private addDemonstrationToHistory(demonstrationPath: string): void {
    if (!this.templates.demonstrationTemplate && !this.templates.putDemosInHistory) {
      throw new Error('Cannot use demonstrations without a demonstration template or putDemosInHistory=true');
    }

    this.logger.info(`DEMONSTRATION: ${demonstrationPath}`);
    const demoText = fs.readFileSync(demonstrationPath, 'utf-8');
    let demoHistory: HistoryItem[];

    if (demonstrationPath.endsWith('.yaml')) {
      const parsed = parseYAML(demoText);
      if (parsed && typeof parsed === 'object' && 'history' in parsed) {
        demoHistory = (parsed as any).history;
      } else {
        throw new Error(`Invalid YAML demonstration file: no history found`);
      }
    } else {
      const parsed = JSON.parse(demoText) as { history: HistoryItem[] };
      demoHistory = parsed.history;
    }

    if (this.templates.putDemosInHistory) {
      // Add demonstrations to history step-by-step
      for (const entry of demoHistory) {
        if (entry.role !== 'system') {
          this.appendHistory({
            ...entry,
            isDemo: true,
            agent: entry.agent || this.name,
            messageType: entry.messageType || 'demonstration',
          });
        }
      }
    } else {
      // Add as single message
      const filteredDemo = demoHistory.filter((e) => e.role !== 'system');
      const demoMessage = filteredDemo
        .map((e) => (typeof e.content === 'string' ? e.content : JSON.stringify(e.content)))
        .join('\n');
      const demonstration = renderTemplate(this.templates.demonstrationTemplate || '', {
        demonstration: demoMessage,
      });

      this.appendHistory({
        agent: this.name,
        content: demonstration,
        isDemo: true,
        role: 'user',
        messageType: 'demonstration',
      });
    }
  }

  private addInstanceTemplateToHistory(state: Record<string, string>): void {
    // Add instance template to history
    const templates = [this.templates.instanceTemplate];
    if (this.templates.strategyTemplate) {
      templates.push(this.templates.strategyTemplate);
    }

    const formatDict = { ...this.getFormatDict(), ...state };
    const message = templates.map((t) => renderAdvancedTemplate(t, formatDict)).join('\n');

    this.appendHistory({
      role: 'user',
      content: message,
      agent: this.name,
      messageType: 'observation',
    });
  }

  getTrajectory(): Trajectory {
    return this.trajectory;
  }

  getTrajectoryData(): {
    trajectory: Trajectory;
    history: History;
    info: AgentInfo;
    replayConfig: string | null;
    environment: string;
  } {
    // Get all data saved in .traj files
    const attemptData = {
      trajectory: this.trajectory,
      history: this.history,
      info: this.info,
      replayConfig: this.replayConfig ? JSON.stringify(this.replayConfig) : null,
      environment: this.env?.name || 'unknown',
    };

    return attemptData;
  }

  saveTrajectory(): void {
    if (!this.trajPath) {
      return;
    }

    const data = this.getTrajectoryData();
    fs.writeFileSync(this.trajPath, JSON.stringify(data, null, 2));
  }

  private async forward(history: History): Promise<StepOutput> {
    // Forward the model without handling errors
    if (this.totalExecutionTime > this.tools.config.totalExecutionTimeout) {
      throw new TotalExecutionTimeExceededError();
    }

    const step: StepOutput = {
      done: false,
      thought: '',
      action: '',
      observation: '',
      submission: null,
      exitStatus: null,
      executionTime: 0,
      state: {},
      query: [],
      extraInfo: {},
      output: '',
      toolCalls: null,
      toolCallIds: null,
      thinkingBlocks: null,
      toTemplateFormatDict: function () {
        return {
          thought: this.thought || '',
          action: this.action || '',
          observation: this.observation || '',
          exitStatus: this.exitStatus,
        };
      },
    };

    step.query = history.map((h) => ({
      role: h.role,
      content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content),
      messageType: h.messageType,
    }));

    try {
      // Query model
      const historyForHook = history.map((h) => ({
        role: h.role,
        content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content),
        agent: h.agent || '',
      }));
      this.chook.onModelQuery(historyForHook, this.name);

      let output: ModelOutput;
      if (this._actionSampler && this.problemStatement) {
        const best = await this._actionSampler.getAction(this.problemStatement, this.trajectory, history);
        output = best.completion;
        step.extraInfo = { ...step.extraInfo, ...best.extraInfo };
      } else {
        const result = await this.model.query(history);
        output = Array.isArray(result) ? result[0] : result;
      }

      step.output = output.message;
      [step.thought, step.action] = this.tools.parseActions(output);
      step.thinkingBlocks = output.thinkingBlocks
        ? output.thinkingBlocks.map((tb) => ({
            type: 'thinking' as const,
            content: String(tb.content),
            startTime: typeof tb.startTime === 'number' ? tb.startTime : undefined,
            endTime: typeof tb.endTime === 'number' ? tb.endTime : undefined,
          }))
        : [];

      if (output.toolCalls) {
        step.toolCallIds = output.toolCalls.map((call: { id: string }) => call.id);
        step.toolCalls = output.toolCalls;
      }

      this.logger.info(`💭 THOUGHT\n${step.thought}\n\n🎬 ACTION\n${step.action}`);
      this.chook.onActionsGenerated(step);

      return await this.handleAction(step);
    } catch (error) {
      if (step.action === '' && step.thought === '') {
        // Parsing probably failed
        step.thought = step.output;
      }
      // Create a new error with step attached
      const enhancedError = Object.assign(error instanceof Error ? error : new Error(String(error)), { step });
      throw enhancedError;
    }
  }

  private async handleAction(step: StepOutput): Promise<StepOutput> {
    // Handle action execution
    if (this.tools.shouldBlockAction(step.action)) {
      throw new BlockedActionError();
    }

    if (step.action.trim() === 'exit') {
      this.logger.info('Exiting agent');
      step.done = true;
      step.observation = 'Exited';
      step.exitStatus = 'exit_command';
      if (!this.env) {
        throw new Error('Environment not initialized');
      }
      step.state = await this.tools.getState(this.env);
      return step;
    }

    this.chook.onActionStarted(step);
    const executionT0 = Date.now() / 1000;

    const runAction = this.tools.guardMultilineInput(step.action).trim();

    try {
      // Execute command in environment
      if (!this.env) {
        throw new Error('Environment not initialized');
      }
      step.observation = await this.env.communicate(runAction, {
        timeout: this.tools.config.executionTimeout,
      });
      this.nConsecutiveTimeouts = 0;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'CommandTimeoutError') {
        this.nConsecutiveTimeouts++;
        if (this.nConsecutiveTimeouts >= this.tools.config.maxConsecutiveExecutionTimeouts) {
          this.logger.critical('Exiting agent due to too many consecutive execution timeouts');
          throw error;
        }

        if (this.env) {
          await this.env.interruptSession();
        }
        step.observation = renderTemplate(this.templates.commandCancelledTimeoutTemplate, {
          ...this.getFormatDict(),
          timeout: this.tools.config.executionTimeout,
          command: runAction,
        });
      } else {
        throw error;
      }
    }

    step.executionTime = Date.now() / 1000 - executionT0;
    this.totalExecutionTime += step.executionTime;

    this.chook.onActionExecuted(step);
    if (!this.env) {
      throw new Error('Environment not initialized');
    }
    step.state = await this.tools.getState(this.env);

    // Check for special tokens in observation
    if (step.observation.includes(RETRY_WITH_OUTPUT_TOKEN)) {
      step.observation = step.observation.replace(RETRY_WITH_OUTPUT_TOKEN, '');
      throw new RetryWithOutputError();
    } else if (step.observation.includes(RETRY_WITHOUT_OUTPUT_TOKEN)) {
      step.observation = step.observation.replace(RETRY_WITHOUT_OUTPUT_TOKEN, '');
      throw new RetryWithoutOutputError();
    } else if (step.observation.includes(EXIT_FORFEIT_TOKEN)) {
      throw new ExitForfeitError();
    }

    return await this.handleSubmission(step);
  }

  private async handleSubmission(
    step: StepOutput,
    observation: string = '',
    forceSubmission: boolean = false,
  ): Promise<StepOutput> {
    // Check for submission in observation
    const isSubmission = this.tools.checkForSubmissionCmd(observation || step.observation);

    if (isSubmission || forceSubmission) {
      try {
        if (!this.env) {
          throw new Error('Environment not initialized');
        }
        const submission = await this.env.readFile('/root/model.patch', 'utf-8');
        if (submission.trim() !== '') {
          step.submission = submission;
        } else {
          step.submission = null;
        }
        step.observation = submission;

        if (!step.exitStatus) {
          step.exitStatus = 'submitted';
        } else if (step.submission) {
          step.exitStatus = `submitted (${step.exitStatus})`;
        }

        step.done = true;
        this.logger.info(`Found submission: ${submission}`);
      } catch (error) {
        this.logger.warning('Submission file not found');
      }
    }

    return step;
  }

  private addStepToTrajectory(step: StepOutput): void {
    const trajectoryStep: TrajectoryStep = {
      action: step.action,
      observation: step.observation,
      response: step.output,
      thought: step.thought,
      executionTime: step.executionTime,
      state: step.state,
      query: step.query,
      extraInfo: step.extraInfo,
    };

    this.trajectory.push(trajectoryStep);
  }

  async forwardWithHandling(history: History): Promise<StepOutput> {
    const handleErrorWithAutosubmission = async (exitStatus: string, message: string): Promise<StepOutput> => {
      this.logger.warning(message);
      return await this.attemptAutosubmissionAfterError({
        thought: message,
        exitStatus,
        output: message,
        done: true,
      } as StepOutput);
    };

    interface ErrorWithMetadata extends Error {
      step?: StepOutput;
      extraInfo?: Record<string, unknown>;
    }

    const handleErrorWithRetry = (error: ErrorWithMetadata, template: string, nRequeries: number): History => {
      this.logger.warning(`Requerying model after ${error.constructor.name} (${nRequeries}th requery)`);
      const step = error.step || ({} as StepOutput);
      this.addStepToTrajectory(step);

      const errorMessage = error.message || '';
      return this.getModelRequeryHistory(template, step, {
        exceptionMessage: errorMessage,
        ...error.extraInfo,
      });
    };

    let nFormatFails = 0;
    while (nFormatFails < this.maxRequeries) {
      try {
        return await this.forward(history);
      } catch (error) {
        // Handle different error types
        const errorObj = error as ErrorWithMetadata;
        const errorName = error instanceof Error ? error.name : '';

        if (errorName === 'KeyboardInterrupt' || errorName === 'EOFError') {
          throw error;
        }

        // Errors that cause requery
        if (
          errorName === 'FormatError' ||
          errorName === 'BlockedActionError' ||
          errorName === 'BashIncorrectSyntaxError' ||
          errorName === 'ContentPolicyViolationError'
        ) {
          nFormatFails++;

          let template = this.tools.config.formatErrorTemplate;
          if (errorName === 'BlockedActionError') {
            template = this.tools.config.filter?.blocklistErrorTemplate || template;
          } else if (errorName === 'BashIncorrectSyntaxError') {
            template = this.templates.shellCheckErrorTemplate;
          }

          history = handleErrorWithRetry(errorObj, template, nFormatFails);
          continue;
        }

        // Special retry tokens
        if (errorName === 'RetryWithOutputError') {
          history = handleErrorWithRetry(errorObj, this.templates.nextStepTemplate, nFormatFails);
          continue;
        }

        if (errorName === 'RetryWithoutOutputError') {
          continue; // Retry with same history
        }

        // Errors that cause exit
        if (errorName === 'ExitForfeitError') {
          return await handleErrorWithAutosubmission('exit_forfeit', 'Exiting due to forfeit');
        }

        if (errorName === 'TotalExecutionTimeExceededError') {
          return await handleErrorWithAutosubmission(
            'exit_total_execution_time',
            'Exit due to total execution time exceeded',
          );
        }

        if (errorName === 'CommandTimeoutError') {
          return await handleErrorWithAutosubmission(
            'exit_command_timeout',
            'Exit due to multiple consecutive command timeouts',
          );
        }

        if (errorName === 'ContextWindowExceededError') {
          return await handleErrorWithAutosubmission('exit_context', 'Exit due to context window');
        }

        // Handle all cost limit errors (base class and derived classes)
        if (
          errorName === 'CostLimitExceededError' ||
          errorName === 'InstanceCostLimitExceededError' ||
          errorName === 'TotalCostLimitExceededError' ||
          errorName === 'InstanceCallLimitExceededError'
        ) {
          return await handleErrorWithAutosubmission('exit_cost', 'Exit due to cost limit');
        }

        // Handle runtime/environment errors
        if (errorName === 'RuntimeError' || (error instanceof Error && error.message === 'SwerexException')) {
          return await handleErrorWithAutosubmission('exit_environment_error', 'Exit due to runtime error');
        }

        // Unknown errors
        return await handleErrorWithAutosubmission('exit_error', `Exit due to error: ${String(error)}`);
      }
    }

    // Too many retries
    return await handleErrorWithAutosubmission(
      'exit_format',
      'Exit due to repeated format/blocklist/bash syntax errors',
    );
  }

  getModelRequeryHistory(errorTemplate: string, step: StepOutput, kwargs: Record<string, unknown>): History {
    const formatDict = { ...kwargs, ...this.getFormatDict() };
    const errorMessage = renderTemplate(errorTemplate, formatDict);

    this.logger.warning(errorMessage);

    return [
      ...this.messages,
      {
        role: 'assistant',
        content: step.output,
        agent: this.name,
        messageType: 'assistant',
      },
      {
        role: 'user',
        content: errorMessage,
        agent: this.name,
        messageType: 'user',
      },
    ];
  }

  async attemptAutosubmissionAfterError(step: StepOutput): Promise<StepOutput> {
    this.logger.warning('Attempting autosubmission after error');
    step = { ...step, done: true };

    // Try to extract patch from environment
    if (this.env && this.env.isAlive && !this.env.isAlive()) {
      this.logger.error('Runtime is no longer alive');

      // Try to use diff from last trajectory step
      const lastStep = this.trajectory[this.trajectory.length - 1];
      if (lastStep && lastStep.state && lastStep.state.diff) {
        step.submission = lastStep.state.diff;
        if (step.submission) {
          step.observation = 'Environment died unexpectedly. Exited (autosubmitted)';
          step.exitStatus = `submitted (${step.exitStatus})`;
        }
      }
      return step;
    }

    // Try to run submission command
    const repoName = this.env?.repo?.repoName ? `/${this.env.repo.repoName}` : '/';
    const submissionCommand = 'git add -A && git diff --cached > /root/model.patch';

    try {
      this.env?.executeCommand(submissionCommand, { check: true, cwd: repoName });
    } catch (error) {
      this.logger.error(`Failed to execute submission command: ${error}`);
    }

    return await this.handleSubmission(step, '', true);
  }

  async step(): Promise<StepOutput> {
    // Run a single step of the agent
    this.chook.onStepStart();

    const nStep = this.trajectory.length + 1;
    this.logger.info(`${'='.repeat(25)} STEP ${nStep} ${'='.repeat(25)}`);

    const stepOutput = await this.forwardWithHandling(this.messages);

    // Add to history
    this.appendHistory({
      role: 'assistant',
      content: stepOutput.output,
      thought: stepOutput.thought,
      action: stepOutput.action,
      agent: this.name,
      toolCalls: stepOutput.toolCalls,
      messageType: 'action',
      thinkingBlocks: stepOutput.thinkingBlocks,
    });

    // Add observation to history
    let templates = [this.templates.nextStepTemplate];
    const observation = stepOutput.observation || '';
    if (observation.trim() === '') {
      templates = [this.templates.nextStepNoOutputTemplate || this.templates.nextStepTemplate];
    } else if (observation.length > this.templates.maxObservationLength) {
      templates = [this.templates.nextStepTruncatedObservationTemplate];
    }

    const formatDict = {
      ...this.getFormatDict(),
      observation: observation,
      elided_chars: observation.length - this.templates.maxObservationLength,
      max_observation_length: this.templates.maxObservationLength,
      ...stepOutput.state,
    };
    const observationMessage = templates.map((t) => renderTemplate(t, formatDict)).join('\n');

    this.appendHistory({
      role: 'user',
      content: observationMessage,
      agent: this.name,
      messageType: 'observation',
      toolCallIds: stepOutput.toolCallIds,
    });

    // Update info
    this.info.submission = stepOutput.submission;
    this.info.exitStatus =
      stepOutput.exitStatus !== null && stepOutput.exitStatus !== undefined ? stepOutput.exitStatus.toString() : null;
    const stats = this.model.getStats();
    this.info.modelStats = {
      instanceCost: stats.instanceCost,
      tokensSent: stats.tokensSent,
      tokensReceived: stats.tokensReceived,
      apiCalls: stats.apiCalls,
    };

    this.addStepToTrajectory(stepOutput);
    this.chook.onStepDone(stepOutput, this.info);

    return stepOutput;
  }

  async run(
    env: AgentEnvironment,
    problemStatement: ProblemStatement | ProblemStatementConfig,
    outputDir: string = '.',
  ): Promise<AgentRunResult> {
    // Run the agent on a problem instance
    await this.setup(env, problemStatement, outputDir);

    this.chook.onRunStart();
    let stepOutput: StepOutput = new StepOutputImpl();

    while (!stepOutput.done) {
      stepOutput = await this.step();
      this.saveTrajectory();
    }

    this.chook.onRunDone(this.trajectory, this.info);
    this.logger.info(`Trajectory saved to ${this.trajPath}`);

    const data = this.getTrajectoryData();
    return {
      info: data.info,
      trajectory: data.trajectory,
    };
  }
}

/**
 * Retry agent implementation
 */
export class RetryAgent extends AbstractAgent {
  private config: RetryAgentConfig;
  private hooks: AbstractAgentHook[] = [];
  private iAttempt: number = 0;
  private agent: DefaultAgent | null = null;
  private attemptData: Array<{
    trajectory: Trajectory;
    history: History;
    info: AgentInfo;
    replayConfig: string | null;
    environment: string;
  }> = [];
  private totalInstanceAttemptStats: InstanceStats;
  private chook: CombinedAgentHook;
  private trajPath: string | null = null;
  private problemStatement: ProblemStatement | null = null;
  private env: AgentEnvironment | null = null;
  private outputDir: string | null = null;
  private rloop: { getBest(): number | null; onSubmit(data: unknown): void; retry(): boolean } | null = null; // RetryLoop instance
  private logger: AgentLogger;

  constructor(config: RetryAgentConfig) {
    super();
    this.config = JSON.parse(JSON.stringify(config)); // Deep copy
    this.totalInstanceAttemptStats = new InstanceStats();
    this.chook = new CombinedAgentHook();
    this.logger = logger;
  }

  static fromConfig(config: RetryAgentConfig): RetryAgent {
    return new RetryAgent(config);
  }

  addHook(hook: AbstractAgentHook): void {
    this.chook.addHook(hook);
    this.hooks.push(hook);
  }

  setup(
    env: AgentEnvironment,
    problemStatement: ProblemStatement | ProblemStatementConfig,
    outputDir: string = '.',
  ): void {
    this.totalInstanceAttemptStats = new InstanceStats();
    this.problemStatement = problemStatement as ProblemStatement;
    this.trajPath = path.join(outputDir, `${this.problemStatement.id}.traj`);
    this.env = env;
    this.outputDir = outputDir;
    // Initialize retry loop based on config
    // this.rloop = getRetryLoopFromConfig(this.config.retryLoop, this.problemStatement);
  }

  private setupAgent(): DefaultAgent {
    const agentConfig = JSON.parse(
      JSON.stringify(this.config.agentConfigs[this.iAttempt % this.config.agentConfigs.length]),
    );

    const remainingBudget = this.config.retryLoop.costLimit - this.totalInstanceAttemptStats.instanceCost;
    if (remainingBudget < agentConfig.model.perInstanceCostLimit) {
      this.logger.debug(`Setting agent per-attempt cost limit to remaining budget: ${remainingBudget}`);
      agentConfig.model.perInstanceCostLimit = remainingBudget;
    }

    this.agent = DefaultAgent.fromConfig(agentConfig);
    for (const hook of this.hooks) {
      this.agent.addHook(hook);
    }

    const subAgentOutputDir = path.join(this.outputDir!, `attempt_${this.iAttempt}`);
    if (!this.env) {
      throw new Error('Environment not initialized');
    }
    this.agent.setup(this.env, this.problemStatement!, subAgentOutputDir);

    return this.agent;
  }

  private nextAttempt(): void {
    this.iAttempt++;
    if (this.env && this.env.hardReset) {
      this.env.hardReset();
    }
    this.setupAgent();
  }

  async step(): Promise<StepOutput> {
    if (!this.agent) {
      throw new Error('Agent not initialized');
    }

    // Failsafe cost check
    if (
      this.totalInstanceAttemptStats.instanceCost > 1.1 * this.config.retryLoop.costLimit &&
      this.config.retryLoop.costLimit > 0
    ) {
      this.logger.critical('Total instance cost exceeded cost limit. Triggering autosubmit.');
      return await this.agent.attemptAutosubmissionAfterError(new StepOutputImpl());
    }

    try {
      return await this.agent.step();
    } catch (error) {
      if (error instanceof Error && error.name === 'TotalCostLimitExceededError') {
        throw error;
      }
      this.logger.critical(`Error in agent step: ${String(error)}. Triggering autosubmit.`);
      return await this.agent.attemptAutosubmissionAfterError(new StepOutputImpl());
    }
  }

  private finalizeAgentRun(): void {
    if (!this.agent) {
      return;
    }

    this.agent.saveTrajectory();
    this.attemptData.push(this.agent.getTrajectoryData());
    this.totalInstanceAttemptStats = this.totalInstanceAttemptStats.add(this.agent.model.getStats());
  }

  getTrajectoryData(choose: boolean = false): {
    attempts: Array<{
      trajectory: Trajectory;
      history: History;
      info: AgentInfo;
      replayConfig: string | null;
      environment: string;
    }>;
    info?: AgentInfo & { bestAttemptIdx: number; modelStats: Record<string, number> };
    trajectory?: Trajectory;
  } {
    const data: {
      attempts: Array<{
        trajectory: Trajectory;
        history: History;
        info: AgentInfo;
        replayConfig: string | null;
        environment: string;
      }>;
      info?: AgentInfo & { bestAttemptIdx: number; modelStats: Record<string, number> };
      trajectory?: Trajectory;
    } = {
      attempts: this.attemptData,
    };

    if (choose && this.rloop) {
      try {
        const bestAttemptIdx = this.rloop.getBest() || 0;
        const attemptInfo = this.attemptData[bestAttemptIdx].info;
        data.info = {
          ...attemptInfo,
          bestAttemptIdx: bestAttemptIdx,
          modelStats: this.totalInstanceAttemptStats as unknown as Record<string, number>,
        };
        data.trajectory = this.attemptData[bestAttemptIdx].trajectory;
      } catch (error) {
        this.logger.critical(`Error getting best attempt index: ${error}. Setting to 0.`);
        const attemptInfo = this.attemptData[0].info;
        data.info = {
          ...attemptInfo,
          bestAttemptIdx: 0,
          modelStats: this.totalInstanceAttemptStats as unknown as Record<string, number>,
        };
        data.trajectory = this.attemptData[0].trajectory;
      }
    }

    return data;
  }

  saveTrajectory(choose: boolean = false): void {
    const data = this.getTrajectoryData(choose);
    if (this.trajPath) {
      fs.writeFileSync(this.trajPath, JSON.stringify(data, null, 2));
    }
  }

  async run(
    env: AgentEnvironment,
    problemStatement: ProblemStatement | ProblemStatementConfig,
    outputDir: string = '.',
  ): Promise<AgentRunResult> {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    this.setup(env, problemStatement, outputDir);

    this.chook.onRunStart();
    let stepOutput: StepOutput = new StepOutputImpl();
    this.setupAgent();

    while (!stepOutput.done) {
      stepOutput = await this.step();
      this.saveTrajectory(false);

      if (stepOutput.done && this.agent) {
        // Submit for review
        if (this.rloop) {
          this.rloop.onSubmit({
            trajectory: this.agent.getTrajectory(),
            info: this.agent.info,
            modelStats: this.agent.model.getStats(),
          });
        }

        this.finalizeAgentRun();
        this.saveTrajectory(false);

        if (this.rloop && this.rloop.retry()) {
          this.nextAttempt();
          stepOutput.done = false;
        }
      }
    }

    this.saveTrajectory(true);
    if (this.agent) {
      this.chook.onRunDone(this.agent.getTrajectory(), this.agent.info);
    }

    this.logger.info(`Trajectory saved to ${this.trajPath}`);

    const data = this.getTrajectoryData(true);
    return {
      info: data.info || {},
      trajectory: data.trajectory || [],
    };
  }
}

/**
 * Factory function to get agent from configuration
 */
export async function getAgentFromConfig(config: AgentConfig): Promise<AbstractAgent> {
  switch (config.type) {
    case 'default':
      return DefaultAgent.fromConfig(config as DefaultAgentConfig);
    case 'retry':
      return RetryAgent.fromConfig(config as RetryAgentConfig);
    case 'shell':
      // Dynamic import to avoid circular dependency
      const { ShellAgent } = require('./extra/shell-agent');
      return ShellAgent.fromConfig(config as DefaultAgentConfig);
    default:
      throw new Error(`Unknown agent type: ${(config as AgentConfig).type}`);
  }
}
