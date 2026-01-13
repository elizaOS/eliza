/**
 * Test utilities tests
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import { DefaultAgentConfig, ToolConfig } from '../src/agent/agents';
import { InstantEmptySubmitModel, PredeterminedTestModel, ModelConfig } from '../src/agent/models';
import { EmptyProblemStatement, TextProblemStatement } from '../src/agent/problem-statement';
import { DockerDeploymentConfig } from '../src/environment/deployment';

/**
 * Check if Docker is available on the system
 */
export function isDockerAvailable(): boolean {
  try {
    // Check if Docker socket exists
    if (process.platform !== 'win32' && !fs.existsSync('/var/run/docker.sock')) {
      return false;
    }

    // Try to run docker version command
    execSync('docker version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Skip test if Docker is not available
 */
export function skipIfNoDocker(testName: string = 'test'): void {
  if (!isDockerAvailable()) {
    console.warn(`⚠️  Skipping ${testName}: Docker is not available`);
    // Use Jest's conditional test skipping
    return process.exit(0); // This will cause the test to be skipped
  }
}

/**
 * Conditionally run test based on Docker availability
 */
export const describeWithDocker = isDockerAvailable() ? describe : describe.skip;
export const itWithDocker = isDockerAvailable() ? it : it.skip;

/**
 * Create a test agent configuration
 */
export function createTestAgentConfig(options: { model: ModelConfig; parseFunction?: unknown }): DefaultAgentConfig {
  return {
    name: 'test-agent',
    type: 'default',
    model: options.model,
    tools: {
      commands: [],
      parseFunction: options.parseFunction,
      executionTimeout: 10,
      maxConsecutiveExecutionTimeouts: 3,
      totalExecutionTimeout: 100,
      submitCommand: 'submit',
      useFunctionCalling: false,
      formatErrorTemplate: 'Error: {error}',
    } as ToolConfig,
    templates: {
      systemTemplate: '',
      instanceTemplate: '',
      nextStepTemplate: 'Observation: {observation}',
      nextStepTruncatedObservationTemplate: 'Observation: {observation}',
      maxObservationLength: 10000,
      demonstrations: [],
      putDemosInHistory: false,
      disableImageProcessing: false,
      shellCheckErrorTemplate: 'Shell check error',
      commandCancelledTimeoutTemplate: 'Command cancelled',
    },
    historyProcessors: [],
    maxRequeries: 3,
  };
}

/**
 * Create an empty problem statement
 */
export function createEmptyProblemStatement(): EmptyProblemStatement {
  return new EmptyProblemStatement();
}

/**
 * Create a text problem statement
 */
export function createTextProblemStatement(text: string, id?: string): TextProblemStatement {
  return new TextProblemStatement({
    text,
    id: id || 'test-id',
    extraFields: {},
  });
}

/**
 * Create an instant empty submit model
 */
export function createInstantEmptySubmitModel(): InstantEmptySubmitModel {
  const config = {
    name: 'instant_empty_submit' as const,
    delay: 0,
    perInstanceCostLimit: 0,
    totalCostLimit: 0,
    perInstanceCallLimit: 0,
  };
  const tools: ToolConfig = {
    commands: [],
    useFunctionCalling: false,
    submitCommand: 'submit',
    executionTimeout: 10,
    maxConsecutiveExecutionTimeouts: 3,
    totalExecutionTimeout: 100,
    formatErrorTemplate: 'Error: {error}',
  };

  return new InstantEmptySubmitModel(config, tools);
}

/**
 * Create a predetermined test model
 */
export function createPredeterminedTestModel(responses: Array<string | any>): PredeterminedTestModel {
  const tools: ToolConfig = {
    commands: [],
    useFunctionCalling: false,
    submitCommand: 'submit',
    executionTimeout: 10,
    maxConsecutiveExecutionTimeouts: 3,
    totalExecutionTimeout: 100,
    formatErrorTemplate: 'Error: {error}',
  };

  return new PredeterminedTestModel(responses, tools);
}

/**
 * Create test deployment config
 */
export function createTestDeploymentConfig(): DockerDeploymentConfig {
  return {
    type: 'docker',
    image: 'python:3.11',
    pythonStandaloneDir: '/root',
    volumes: {},
    environment: {},
    removeOnStop: true,
    workDir: '/workspace',
  };
}
