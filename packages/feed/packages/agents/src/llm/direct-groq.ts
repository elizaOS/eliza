/**
 * Direct Groq LLM calls
 *
 * Supports Groq models for fast inference.
 * All LLM calls are automatically logged to trajectory logger if available.
 *
 * IMPORTANT FOR RL TRAINING:
 * - When runtime is provided, trajectory context is automatically extracted
 * - Every LLM call is logged with EXACT input/output for training data
 * - Purpose field tracks call type: action, reasoning, evaluation, response
 */

import { createGroq } from '@ai-sdk/groq';
import { GROQ_MODELS } from '@babylon/shared';
import type { IAgentRuntime } from '@elizaos/core';
import { generateText } from 'ai';
import {
  ensureTrajectoryStep,
  getTrajectoryContext,
  type RuntimeTrajectoryLogger,
} from '../plugins/plugin-trajectory-logger/src/action-interceptor';
import { isPromptLoggingEnabled, logPrompt } from '../utils/prompt-logger';
import { buildReasoningTraceMetadata } from './reasoning-trace';

function getRuntimeSetting(
  runtime: IAgentRuntime | undefined,
  key: string
): string | undefined {
  if (!runtime) {
    return undefined;
  }

  const value = runtime.getSetting(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveGroqBaseURL(runtime: IAgentRuntime | undefined): string {
  // When ElizaCloud is configured, route through its OpenAI-compatible proxy
  const elizacloudKey =
    getRuntimeSetting(runtime, 'ELIZACLOUD_API_KEY') ||
    process.env.ELIZACLOUD_API_KEY;
  if (elizacloudKey) {
    const base = (
      getRuntimeSetting(runtime, 'ELIZACLOUD_API_URL') ||
      process.env.ELIZACLOUD_API_URL ||
      'https://www.elizacloud.ai'
    ).replace(/\/$/, '');
    return `${base}/api/v1`;
  }
  return (
    getRuntimeSetting(runtime, 'GROQ_BASE_URL') ||
    process.env.GROQ_BASE_URL ||
    'https://api.groq.com/openai/v1'
  );
}

function resolveGroqModel(params: {
  modelSize?: 'small' | 'large';
  runtime?: IAgentRuntime;
}): string {
  const defaultSmall = process.env.GROQ_SMALL_MODEL || GROQ_MODELS.FREE.modelId;
  const defaultLarge = process.env.GROQ_LARGE_MODEL || GROQ_MODELS.PRO.modelId;

  const smallModel =
    getRuntimeSetting(params.runtime, 'GROQ_SMALL_MODEL') || defaultSmall;
  const largeModel =
    getRuntimeSetting(params.runtime, 'GROQ_LARGE_MODEL') || defaultLarge;
  const primaryModel =
    getRuntimeSetting(params.runtime, 'GROQ_PRIMARY_MODEL') || largeModel;

  if (params.modelSize === 'small') {
    return smallModel;
  }
  if (params.modelSize === 'large') {
    return largeModel;
  }

  return primaryModel;
}

export async function callGroqDirect(params: {
  prompt: string;
  system?: string;
  modelSize?: 'small' | 'large';
  temperature?: number;
  maxTokens?: number;
  trajectoryLogger?: RuntimeTrajectoryLogger;
  trajectoryId?: string;
  purpose?: 'action' | 'reasoning' | 'evaluation' | 'response' | 'other';
  actionType?: string;
  runtime?: IAgentRuntime; // Pass runtime to access settings
}): Promise<string> {
  // Auto-extract trajectory context from runtime if not explicitly provided
  // This ensures ALL LLM calls are logged for RL training
  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;

  if (!trajectoryLogger && !trajectoryId && params.runtime) {
    const context = getTrajectoryContext(params.runtime);
    if (context) {
      trajectoryLogger = context.logger;
      trajectoryId = context.trajectoryId;
    }
  }

  // Resolve API key: prefer GROQ_API_KEY, fall back to ELIZACLOUD_API_KEY
  const apiKey =
    getRuntimeSetting(params.runtime, 'GROQ_API_KEY') ||
    process.env.GROQ_API_KEY ||
    getRuntimeSetting(params.runtime, 'ELIZACLOUD_API_KEY') ||
    process.env.ELIZACLOUD_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No API key for inference — set GROQ_API_KEY or ELIZACLOUD_API_KEY'
    );
  }

  const elizacloudKey =
    getRuntimeSetting(params.runtime, 'ELIZACLOUD_API_KEY') ||
    process.env.ELIZACLOUD_API_KEY;
  const isElizaCloud = !!elizacloudKey;

  const groq = createGroq({
    apiKey,
    baseURL: resolveGroqBaseURL(params.runtime),
    ...(isElizaCloud ? { headers: { 'X-API-Key': apiKey } } : {}),
  });

  const model = resolveGroqModel({
    modelSize: params.modelSize,
    runtime: params.runtime,
  });

  const startTime = Date.now();

  // Add timeout to prevent hanging (60 seconds default, configurable)
  const timeoutMs = params.maxTokens && params.maxTokens < 500 ? 20000 : 60000; // Shorter timeout for small outputs

  const result = await Promise.race([
    generateText({
      model: groq.languageModel(model),
      prompt: params.prompt,
      system: params.system,
      temperature: params.temperature ?? 0.7,
      maxOutputTokens: params.maxTokens ?? 8192,
      maxRetries: 2,
      experimental_telemetry: { isEnabled: false },
    }),
    new Promise<{ text: string }>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`LLM call timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);

  const latencyMs = Date.now() - startTime;

  // Log to trajectory if available (CRITICAL for RL training data collection)
  let stepId: string | null = null;
  if (params.runtime) {
    const activeStep = await ensureTrajectoryStep(params.runtime);
    if (activeStep) {
      trajectoryLogger = activeStep.logger;
      trajectoryId = activeStep.trajectoryId;
      stepId = activeStep.stepId;
    }
  } else if (trajectoryLogger && trajectoryId) {
    stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
  }

  if (trajectoryLogger && trajectoryId && stepId) {
    const reasoningMetadata = buildReasoningTraceMetadata(result.text);
    trajectoryLogger.logLLMCall(stepId, {
      model,
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      response: result.text,
      temperature: params.temperature ?? 0.7,
      maxTokens: params.maxTokens ?? 8192,
      purpose: params.purpose || 'action',
      actionType: params.actionType,
      latencyMs,
      promptTokens: undefined, // Token counts not available from Groq SDK
      completionTokens: undefined,
      ...reasoningMetadata,
    });
  }

  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: params.actionType || params.purpose || 'groq_direct',
      input: `System: ${params.system || ''}\n\nUser: ${params.prompt}`,
      output: result.text,
      metadata: {
        provider: 'groq',
        model,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
      },
    });
  }

  // Forward to DAG trace bridge if active (game-tick observability)
  try {
    const { getAgentLLMBridge } = require('@babylon/shared');
    const bridge = getAgentLLMBridge();
    if (bridge) {
      bridge({
        provider: 'groq',
        model,
        promptType: params.actionType || params.purpose || 'agent-groq-direct',
        format: 'text',
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        systemPrompt: params.system || '',
        userPrompt: params.prompt,
        rawResponse: result.text,
        parsedResponse: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: latencyMs,
        success: true,
      });
    }
  } catch {
    // Bridge not available — fine
  }

  return result.text;
}
