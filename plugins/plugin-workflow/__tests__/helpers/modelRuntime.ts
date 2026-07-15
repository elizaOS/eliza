/**
 * Real AgentRuntime harness for workflow-generation tests. Model handlers are
 * the only mocked boundary; routing, settings, and `useModel` dispatch remain real.
 */
import { mock } from 'bun:test';
import { AgentRuntime, createCharacter, ModelType } from '@elizaos/core';
import { InMemoryDatabaseAdapter } from '../../../../packages/core/src/database/inMemoryAdapter.ts';

type ModelMock = ReturnType<typeof mock>;

export interface ModelRuntimeOptions {
  settings?: Record<string, unknown>;
  useModel?: ModelMock;
}

/** External model double that supports structured and text workflow calls. */
export function createModelMock(schemaResult?: Record<string, unknown>): ModelMock {
  return mock((_type: string, opts: Record<string, unknown>) => {
    if (opts.responseSchema || opts.schema) return Promise.resolve(schemaResult || {});

    const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
    const dataSection = '\n\nData:\n';
    const dataIndex = prompt.lastIndexOf(dataSection);
    if (dataIndex !== -1) return Promise.resolve(prompt.slice(dataIndex + dataSection.length));

    const jsonIndex = prompt.lastIndexOf('\n\n{');
    if (jsonIndex !== -1) return Promise.resolve(prompt.slice(jsonIndex + 2));
    return Promise.resolve('');
  });
}

export function createModelRuntime(options: ModelRuntimeOptions = {}): AgentRuntime {
  const runtime = new AgentRuntime({
    character: createCharacter({
      name: 'WorkflowGenerationIntegrationAgent',
      settings: options.settings ?? {},
    }),
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: 'fatal',
    enableAutonomy: false,
  });
  const model = options.useModel ?? createModelMock();

  for (const modelType of [ModelType.TEXT_SMALL, ModelType.TEXT_LARGE]) {
    runtime.registerModel(
      modelType,
      async (_runtime, params) => model(modelType, params, 'openai'),
      'openai'
    );
  }
  return runtime;
}
