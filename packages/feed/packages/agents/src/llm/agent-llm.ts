/**
 * Agent LLM Provider
 *
 * LLM interface for autonomous agents supporting multiple inference backends:
 * - HuggingFace: Cloud inference endpoints for trained models
 * - Phala: Trusted execution environment for secure inference
 * - Ollama: Local inference for development and fine-tuned models
 * - Groq: Cloud inference with fast response times (default)
 *
 * @remarks
 * This provider is exclusively for autonomous agents. Core game systems
 * (MarketDecisionEngine, etc.) use BabylonLLMClient with Groq/Claude/OpenAI.
 *
 * @example
 * ```typescript
 * const response = await callAgentLLM({
 *   prompt: 'Analyze market conditions',
 *   system: 'You are a trading agent',
 *   archetype: 'trader',
 *   temperature: 0.7,
 * });
 * ```
 *
 * @packageDocumentation
 */

import type { IAgentRuntime } from '@elizaos/core';
import {
  ensureTrajectoryStep,
  getTrajectoryContext,
  type RuntimeTrajectoryLogger,
} from '../plugins/plugin-trajectory-logger/src/action-interceptor';
import { logger } from '../shared/logger';
import { callGroqDirect } from './direct-groq';
import { callOllama } from './ollama-provider';
import { buildReasoningTraceMetadata } from './reasoning-trace';

/**
 * Supported LLM provider types for agent inference
 */
export type AgentLLMProvider = 'huggingface' | 'phala' | 'ollama' | 'groq';

/**
 * Determines the configured LLM provider from environment variables
 *
 * @returns The configured provider, defaulting to 'groq' if not specified
 * @internal
 */
function getConfiguredProvider(): AgentLLMProvider {
  const provider = process.env.AGENT_LLM_PROVIDER?.toLowerCase();
  if (provider === 'huggingface' || provider === 'hf') return 'huggingface';
  if (provider === 'phala') return 'phala';
  if (provider === 'ollama' || provider === 'local') return 'ollama';
  return 'groq';
}

/**
 * Parameters for agent LLM inference calls
 */
export interface AgentLLMParams {
  /** User prompt text */
  prompt: string;
  /** System prompt for model context */
  system?: string;
  /** Agent archetype for model selection */
  archetype?: string;
  /** Sampling temperature (0-1) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Trajectory logger for RL training data collection */
  trajectoryLogger?: RuntimeTrajectoryLogger;
  /** Trajectory ID for logging context */
  trajectoryId?: string;
  /** Purpose of the LLM call for training categorization */
  purpose?: 'action' | 'reasoning' | 'evaluation' | 'response' | 'other';
  /** Specific action type being performed */
  actionType?: string;
  /** Agent runtime for context extraction */
  runtime?: IAgentRuntime;
}

/**
 * Calls HuggingFace inference endpoint
 *
 * Supports both standard Inference API and OpenAI-compatible Inference Endpoints.
 * Configure via HUGGINGFACE_API_FORMAT environment variable.
 *
 * @param params - LLM call parameters
 * @returns Generated text response
 * @throws Error if API key or endpoint not configured
 * @internal
 */
async function callHuggingFace(params: AgentLLMParams): Promise<string> {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  const endpoint = process.env.HUGGINGFACE_MODEL_ENDPOINT;
  const apiFormat = process.env.HUGGINGFACE_API_FORMAT || 'inference';

  if (!apiKey) {
    throw new Error('HUGGINGFACE_API_KEY not set');
  }
  if (!endpoint) {
    throw new Error('HUGGINGFACE_MODEL_ENDPOINT not set');
  }

  const startTime = Date.now();

  const messages: Array<{ role: string; content: string }> = [];
  if (params.system) {
    messages.push({ role: 'system', content: params.system });
  }
  messages.push({ role: 'user', content: params.prompt });

  let requestBody: string;
  let requestUrl = endpoint;

  if (apiFormat === 'openai') {
    requestBody = JSON.stringify({
      model: process.env.HUGGINGFACE_MODEL_NAME || 'default',
      messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
    });
    if (!endpoint.includes('/chat/completions')) {
      requestUrl = endpoint.replace(/\/$/, '') + '/v1/chat/completions';
    }
  } else {
    requestBody = JSON.stringify({
      inputs: messages,
      parameters: {
        temperature: params.temperature ?? 0.7,
        max_new_tokens: params.maxTokens ?? 2048,
        return_full_text: false,
      },
    });
  }

  // Retry with backoff for vLLM reload windows (connection refused / 503)
  const maxRetries = 3;
  const retryDelays = [5000, 10000, 15000]; // 5s, 10s, 15s
  let response: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: AbortSignal.timeout(120000),
      });

      if (response.ok) break;

      // Retry on 503 (vLLM reloading) or 502 (reverse proxy during reload)
      if (
        (response.status === 503 || response.status === 502) &&
        attempt < maxRetries
      ) {
        const delay = retryDelays[attempt] ?? 15000;
        logger.warn(
          `HuggingFace/vLLM returned ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      const errorText = await response.text();
      throw new Error(
        `HuggingFace API error: ${response.status} - ${errorText}`
      );
    } catch (error) {
      lastError = error as Error;
      const isRetryable =
        error instanceof TypeError || // fetch network error (connection refused)
        (error as { code?: string }).code === 'ECONNREFUSED' ||
        (error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED';

      if (isRetryable && attempt < maxRetries) {
        const delay = retryDelays[attempt] ?? 15000;
        logger.warn(
          `HuggingFace/vLLM connection failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${(error as Error).message}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }

  if (!response || !response.ok) {
    throw (
      lastError || new Error('HuggingFace API request failed after retries')
    );
  }

  const data = (await response.json()) as
    | Array<{ generated_text: string }>
    | { generated_text: string }
    | { choices?: Array<{ message?: { content: string } }> };
  const latencyMs = Date.now() - startTime;

  let responseText: string;
  if ('choices' in data && data.choices) {
    responseText = data.choices[0]?.message?.content || '';
  } else if (Array.isArray(data)) {
    responseText = data[0]?.generated_text || '';
  } else if ('generated_text' in data) {
    responseText = data.generated_text || '';
  } else {
    responseText = '';
  }

  await logToTrajectory(params, 'huggingface', responseText, latencyMs);

  return responseText;
}

/**
 * Calls Phala TEE endpoint for secure inference
 *
 * @param params - LLM call parameters
 * @returns Generated text response
 * @throws Error if endpoint not configured
 * @internal
 */
async function callPhala(params: AgentLLMParams): Promise<string> {
  const endpoint = process.env.PHALA_ENDPOINT;

  if (!endpoint) {
    throw new Error('PHALA_ENDPOINT not set');
  }

  const startTime = Date.now();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.archetype
        ? `babylon-${params.archetype}`
        : 'babylon-default',
      messages: [
        ...(params.system ? [{ role: 'system', content: params.system }] : []),
        { role: 'user', content: params.prompt },
      ],
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Phala API error: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content: string } }>;
    response?: string;
  };
  const latencyMs = Date.now() - startTime;

  const responseText =
    data.choices?.[0]?.message?.content || data.response || '';

  await logToTrajectory(params, 'phala', responseText, latencyMs);

  return responseText;
}

/**
 * Calls Ollama for local inference
 *
 * Delegates to the shared ollama-provider implementation for consistency.
 *
 * @param params - LLM call parameters
 * @returns Generated text response
 * @internal
 */
async function callOllamaLocal(params: AgentLLMParams): Promise<string> {
  return callOllama({
    prompt: params.prompt,
    system: params.system,
    archetype: params.archetype,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    trajectoryLogger: params.trajectoryLogger,
    trajectoryId: params.trajectoryId,
    purpose: params.purpose,
    actionType: params.actionType,
    runtime: params.runtime,
  });
}

/**
 * Logs LLM call to trajectory logger for RL training data collection
 *
 * @param params - Original LLM call parameters
 * @param model - Model identifier used for the call
 * @param response - Generated response text
 * @param latencyMs - Call latency in milliseconds
 * @param tokenCounts - Optional token usage statistics
 * @internal
 */
async function logToTrajectory(
  params: AgentLLMParams,
  model: string,
  response: string,
  latencyMs: number,
  tokenCounts?: { promptTokens?: number; completionTokens?: number }
): Promise<void> {
  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;

  if (!trajectoryLogger && !trajectoryId && params.runtime) {
    const context = getTrajectoryContext(params.runtime);
    if (context) {
      trajectoryLogger = context.logger;
      trajectoryId = context.trajectoryId;
    }
  }

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
    const reasoningMetadata = buildReasoningTraceMetadata(response);
    trajectoryLogger.logLLMCall(stepId, {
      model,
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      response,
      temperature: params.temperature ?? 0.7,
      maxTokens: params.maxTokens ?? 2048,
      purpose: params.purpose || 'action',
      actionType: params.actionType,
      latencyMs,
      promptTokens: tokenCounts?.promptTokens,
      completionTokens: tokenCounts?.completionTokens,
      ...reasoningMetadata,
    });
  }

  // Forward to DAG trace bridge if active (game-tick observability)
  try {
    const { getAgentLLMBridge } = require('@babylon/shared');
    const bridge = getAgentLLMBridge();
    if (bridge) {
      bridge({
        provider: model.includes('/') ? model.split('/')[0] : 'agent',
        model,
        promptType: params.actionType || params.purpose || 'agent-llm',
        format: 'text',
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 2048,
        systemPrompt: params.system || '',
        userPrompt: params.prompt,
        rawResponse: response,
        parsedResponse: null,
        inputTokens: tokenCounts?.promptTokens ?? 0,
        outputTokens: tokenCounts?.completionTokens ?? 0,
        totalTokens:
          (tokenCounts?.promptTokens ?? 0) +
          (tokenCounts?.completionTokens ?? 0),
        durationMs: latencyMs,
        success: true,
      });
    }
  } catch {
    // Bridge not available
  }
}

/**
 * Main entry point for agent LLM inference calls
 *
 * Routes calls to the configured provider based on AGENT_LLM_PROVIDER environment variable.
 * Automatically logs all calls to trajectory logger for RL training data collection.
 *
 * @param params - LLM call parameters including prompt, system context, and configuration
 * @returns Generated text response from the configured provider
 * @throws Error if provider is misconfigured or unavailable
 *
 * @example
 * ```typescript
 * const response = await callAgentLLM({
 *   prompt: 'What should I trade?',
 *   system: 'You are a trading agent',
 *   archetype: 'trader',
 *   purpose: 'action',
 * });
 * ```
 */
export async function callAgentLLM(params: AgentLLMParams): Promise<string> {
  const provider = getConfiguredProvider();

  logger.debug(
    'Agent LLM call',
    {
      provider,
      archetype: params.archetype,
      purpose: params.purpose,
    },
    'AgentLLM'
  );

  switch (provider) {
    case 'huggingface':
      return callHuggingFace(params);

    case 'phala':
      return callPhala(params);

    case 'ollama':
      return callOllamaLocal(params);

    case 'groq':
    default:
      return callGroqDirect({
        prompt: params.prompt,
        system: params.system,
        modelSize: 'large',
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        trajectoryLogger: params.trajectoryLogger,
        trajectoryId: params.trajectoryId,
        purpose: params.purpose,
        actionType: params.actionType,
        runtime: params.runtime,
      });
  }
}

/**
 * Checks the configured LLM provider status and availability
 *
 * Performs health checks for the configured provider and returns detailed status information.
 *
 * @returns Provider status including configuration state, availability, and details
 *
 * @example
 * ```typescript
 * const status = await getAgentLLMStatus();
 * console.log(`Provider: ${status.provider}, Available: ${status.available}`);
 * ```
 */
export async function getAgentLLMStatus(): Promise<{
  provider: AgentLLMProvider;
  configured: boolean;
  available: boolean;
  details: Record<string, string | boolean>;
  model?: string;
  error?: string;
}> {
  const provider = getConfiguredProvider();
  const details: Record<string, string | boolean> = {};

  let configured = false;
  let available = false;

  switch (provider) {
    case 'huggingface':
      configured =
        !!process.env.HUGGINGFACE_API_KEY &&
        !!process.env.HUGGINGFACE_MODEL_ENDPOINT;
      details.hasApiKey = !!process.env.HUGGINGFACE_API_KEY;
      details.endpoint = process.env.HUGGINGFACE_MODEL_ENDPOINT || 'not set';
      if (configured) {
        try {
          const response = await fetch(
            process.env.HUGGINGFACE_MODEL_ENDPOINT!,
            {
              method: 'HEAD',
              headers: {
                Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
              },
              signal: AbortSignal.timeout(5000),
            }
          );
          available = response.ok || response.status === 405;
        } catch (error) {
          available = false;
          details.healthcheck = 'unreachable';
          return {
            provider,
            configured,
            available,
            details,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      break;

    case 'phala':
      configured = !!process.env.PHALA_ENDPOINT;
      details.endpoint = process.env.PHALA_ENDPOINT || 'not set';
      if (configured) {
        try {
          const response = await fetch(`${process.env.PHALA_ENDPOINT}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          available = response.ok;
        } catch (error) {
          available = false;
          details.healthcheck = 'unreachable';
          return {
            provider,
            configured,
            available,
            details,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      break;

    case 'ollama':
      const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      configured = true;
      details.endpoint = ollamaUrl;
      try {
        const response = await fetch(`${ollamaUrl}/api/tags`, {
          signal: AbortSignal.timeout(5000),
        });
        available = response.ok;
        if (available) {
          const data = (await response.json()) as {
            models?: Array<{ name: string }>;
          };
          details.models = (data.models?.length || 0).toString();
        }
      } catch {
        available = false;
      }
      break;

    case 'groq':
    default:
      configured = !!process.env.GROQ_API_KEY;
      details.hasApiKey = !!process.env.GROQ_API_KEY;
      available = configured;
      break;
  }

  return { provider, configured, available, details };
}
