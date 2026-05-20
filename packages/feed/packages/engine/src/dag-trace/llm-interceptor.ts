/**
 * LLM call interceptor for DAG tracing.
 *
 * Hooks into the global LLM call callback to capture full prompt/response
 * text and associate it with the current active DAG node.
 *
 * Also installs the agent LLM bridge so that LLM calls from @feed/agents
 * (callGroqDirect, callAgentLLM, etc.) are forwarded into the active trace.
 */

import type { AgentLLMBridgeData } from '@feed/shared';

import { getActiveTracer } from './tracer';
import type { LLMCallInput } from './types';

/**
 * Callback type matching the shape emitted by openai-client.ts after each LLM call.
 */
export type LLMCallCallback = (call: LLMCallInput) => void;

let globalLLMCallCallback: LLMCallCallback | null = null;

/**
 * Set the global LLM call callback.
 * Called by the dag-trace init to start capturing LLM calls.
 */
export function setLLMCallCallback(callback: LLMCallCallback | null): void {
  globalLLMCallCallback = callback;
}

/**
 * Get the current LLM call callback.
 * Used by openai-client.ts to check if tracing is active.
 */
export function getLLMCallCallback(): LLMCallCallback | null {
  return globalLLMCallCallback;
}

/**
 * Install the LLM interceptor that forwards calls to the active TickTracer.
 * Also installs the agent LLM bridge if @feed/shared provides it.
 */
export function installLLMInterceptor(): void {
  // Core engine LLM callback
  setLLMCallCallback((call: LLMCallInput) => {
    const tracer = getActiveTracer();
    if (tracer) {
      tracer.recordLLMCall(call);
    }
  });

  // Agent LLM bridge — forward agent package LLM calls into the DAG trace
  // Uses dynamic import to avoid hard dependency if shared doesn't have the bridge yet
  import('@feed/shared')
    .then((shared) => {
      if (typeof shared.setAgentLLMBridge === 'function') {
        shared.setAgentLLMBridge((data: AgentLLMBridgeData) => {
          const tracer = getActiveTracer();
          if (tracer) {
            // Apply defaults for optional fields to prevent NaN poisoning
            const call: LLMCallInput = {
              provider: '',
              model: '',
              promptType: 'agent',
              format: 'text',
              temperature: 0,
              maxTokens: 0,
              systemPrompt: '',
              userPrompt: '',
              rawResponse: '',
              parsedResponse: null,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              durationMs: 0,
              success: true,
              ...(data as Partial<LLMCallInput>),
            };
            // Ensure totalTokens is computed if not provided
            if (!call.totalTokens && (call.inputTokens || call.outputTokens)) {
              call.totalTokens = call.inputTokens + call.outputTokens;
            }
            tracer.recordLLMCall(call);
          }
        });
      }
    })
    .catch(() => {
      // @feed/shared may not have the bridge yet — that's fine
    });
}

/**
 * Remove the LLM interceptor.
 */
export function uninstallLLMInterceptor(): void {
  setLLMCallCallback(null);

  // Clear agent bridge
  import('@feed/shared')
    .then((shared) => {
      if (typeof shared.setAgentLLMBridge === 'function') {
        shared.setAgentLLMBridge(null);
      }
    })
    .catch(() => {
      // Fine if not available
    });
}
