import type {
  TraceSpan,
  TraceSpanCategory,
  TraceSpanStatus,
  TraceSpanAttribute,
  InputOutputData,
  TraceRecord,
} from '@evilmartians/agent-prism-types';
import type { RunDetail, RunEvent, RunSummary } from '@elizaos/api-client';

/**
 * Adapter to convert ElizaOS RunDetail data to Agent Prism TraceSpan format
 */
export class ElizaSpanAdapter {
  /**
   * Convert ElizaOS RunDetail to Agent Prism TraceSpans with hierarchical structure
   */
  convertRunDetailToTraceSpans(runDetail: RunDetail): TraceSpan[] {
    const events = runDetail.events;
    if (!events || events.length === 0) {
      return [];
    }

    // Sort events by timestamp
    const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);

    // Track actions and their attempts
    const actionMap = new Map<string, TraceSpan>();
    const attemptMap = new Map<string, TraceSpan>();
    const rootSpans: TraceSpan[] = [];

    sortedEvents.forEach((event, index) => {
      switch (event.type) {
        case 'RUN_STARTED': {
          // Create root run span
          const runSpan = this.createRunSpan(runDetail, event);
          rootSpans.push(runSpan);
          break;
        }

        case 'ACTION_STARTED': {
          const actionName =
            (event.data.actionName as string) ||
            (event.data.actionId as string) ||
            `Action ${index}`;
          const actionKey = (event.data.actionId as string) || actionName;

          let actionSpan = actionMap.get(actionKey);
          if (!actionSpan) {
            // Create new action span
            actionSpan = {
              id: `action-${actionKey}`,
              title: actionName,
              type: 'agent_invocation' as TraceSpanCategory,
              status: 'pending' as TraceSpanStatus,
              startTime: new Date(event.timestamp),
              endTime: new Date(event.timestamp), // Will be updated on completion
              duration: 0,
              raw: JSON.stringify(event, null, 2),
              attributes: this.convertEventDataToAttributes(event.data),
              children: [],
            };
            actionMap.set(actionKey, actionSpan);
            rootSpans.push(actionSpan);
          }

          // Create attempt span
          const attemptIndex = (actionSpan.children?.length || 0) + 1;
          const attemptSpan: TraceSpan = {
            id: `attempt-${actionKey}-${attemptIndex}`,
            title: `Attempt ${attemptIndex}`,
            type: 'span' as TraceSpanCategory,
            status: 'pending' as TraceSpanStatus,
            startTime: new Date(event.timestamp),
            endTime: new Date(event.timestamp),
            duration: 0,
            raw: JSON.stringify(event, null, 2),
            attributes: this.convertEventDataToAttributes(event.data),
            children: [],
          };

          actionSpan.children = [...(actionSpan.children || []), attemptSpan];
          attemptMap.set(actionKey, attemptSpan);
          break;
        }

        case 'ACTION_COMPLETED': {
          const actionName =
            (event.data.actionName as string) ||
            (event.data.actionId as string) ||
            `Action ${index}`;
          const actionKey = (event.data.actionId as string) || actionName;
          const actionSpan = actionMap.get(actionKey);
          const attemptSpan = attemptMap.get(actionKey);

          // Extract input/output if available
          const prompt = this.extractPrompt(event.data);
          const response = this.extractResponse(event.data);

          if (attemptSpan) {
            const success = (event.data.success as boolean | undefined) !== false;
            attemptSpan.status = success ? 'success' : 'error';
            attemptSpan.endTime = new Date(event.timestamp);
            attemptSpan.duration = event.timestamp - attemptSpan.startTime.getTime();
            if (prompt) attemptSpan.input = prompt;
            if (response) attemptSpan.output = response;
            attemptMap.delete(actionKey);
          }

          if (actionSpan) {
            const success = (event.data.success as boolean | undefined) !== false;
            actionSpan.status = success ? 'success' : 'error';
            actionSpan.endTime = new Date(event.timestamp);
            actionSpan.duration = event.timestamp - actionSpan.startTime.getTime();
            if (prompt && !actionSpan.input) actionSpan.input = prompt;
            if (response && !actionSpan.output) actionSpan.output = response;
          }
          break;
        }

        case 'MODEL_USED': {
          const modelType = (event.data.modelType as string) || 'Model Call';

          // Extract prompt and response from event data
          const prompt = this.extractPrompt(event.data);
          const response = this.extractResponse(event.data);

          const modelSpan: TraceSpan = {
            id: `model-${index}`,
            title: modelType,
            type: 'llm_call' as TraceSpanCategory,
            status: 'success' as TraceSpanStatus,
            startTime: new Date(event.timestamp),
            endTime: new Date(event.timestamp + ((event.data.executionTime as number) || 0)),
            duration: (event.data.executionTime as number) || 0,
            raw: JSON.stringify(event, null, 2),
            attributes: this.convertEventDataToAttributes(event.data),
            input: prompt,
            output: response,
            tokensCount: this.extractTokensCount(event.data),
            cost: this.extractCost(event.data),
          };

          // Attach to current attempt or action
          const actionContext = (event.data.actionContext as string | undefined) || undefined;
          const targetKey = actionContext || Array.from(attemptMap.keys()).pop();

          if (targetKey) {
            const attemptSpan = attemptMap.get(targetKey);
            if (attemptSpan) {
              attemptSpan.children = [...(attemptSpan.children || []), modelSpan];
            } else {
              // Fallback to action
              const actionSpan = actionMap.get(targetKey);
              if (actionSpan && actionSpan.children && actionSpan.children.length > 0) {
                const lastAttempt = actionSpan.children[actionSpan.children.length - 1];
                lastAttempt.children = [...(lastAttempt.children || []), modelSpan];
              }
            }
          } else {
            rootSpans.push(modelSpan);
          }
          break;
        }

        case 'EVALUATOR_COMPLETED': {
          const evaluatorName = (event.data.evaluatorName as string) || `Evaluator ${index}`;
          const evaluatorSpan: TraceSpan = {
            id: `evaluator-${index}`,
            title: evaluatorName,
            type: 'chain_operation' as TraceSpanCategory,
            status: 'success' as TraceSpanStatus,
            startTime: new Date(event.timestamp),
            endTime: new Date(event.timestamp),
            duration: 0,
            raw: JSON.stringify(event, null, 2),
            attributes: this.convertEventDataToAttributes(event.data),
          };
          rootSpans.push(evaluatorSpan);
          break;
        }

        case 'EMBEDDING_EVENT': {
          const status = (event.data.status as string) || 'completed';
          const embeddingSpan: TraceSpan = {
            id: `embedding-${index}`,
            title: `Embedding ${status}`,
            type: 'embedding' as TraceSpanCategory,
            status: status === 'failed' ? 'error' : 'success',
            startTime: new Date(event.timestamp),
            endTime: new Date(event.timestamp + ((event.data.durationMs as number) || 0)),
            duration: (event.data.durationMs as number) || 0,
            raw: JSON.stringify(event, null, 2),
            attributes: this.convertEventDataToAttributes(event.data),
          };

          // Attach to current attempt or action
          const targetKey = Array.from(attemptMap.keys()).pop();
          if (targetKey) {
            const attemptSpan = attemptMap.get(targetKey);
            if (attemptSpan) {
              attemptSpan.children = [...(attemptSpan.children || []), embeddingSpan];
            }
          } else {
            rootSpans.push(embeddingSpan);
          }
          break;
        }

        default:
          break;
      }
    });

    return rootSpans;
  }

  /**
   * Create a root run span from RunDetail
   */
  private createRunSpan(runDetail: RunDetail, startEvent: RunEvent): TraceSpan {
    const summary = runDetail.summary;
    const duration = summary.durationMs || 0;
    const startTime = new Date(startEvent.timestamp);
    const endTime = new Date(startEvent.timestamp + duration);

    return {
      id: summary.runId,
      title: `Run ${new Date(summary.startedAt || Date.now()).toLocaleTimeString()}`,
      type: 'agent_invocation' as TraceSpanCategory,
      status: this.convertRunStatus(summary.status),
      startTime,
      endTime,
      duration,
      raw: JSON.stringify(runDetail, null, 2),
      attributes: [
        { key: 'run.id', value: { stringValue: summary.runId } },
        { key: 'run.status', value: { stringValue: summary.status } },
        ...(summary.messageId
          ? [{ key: 'message.id', value: { stringValue: summary.messageId } }]
          : []),
        ...(summary.roomId ? [{ key: 'room.id', value: { stringValue: summary.roomId } }] : []),
      ] as TraceSpanAttribute[],
      children: [],
    };
  }

  /**
   * Convert RunStatus to TraceSpanStatus
   */
  private convertRunStatus(status: string): TraceSpanStatus {
    switch (status) {
      case 'completed':
        return 'success';
      case 'error':
        return 'error';
      case 'timeout':
        return 'warning';
      case 'started':
        return 'pending';
      default:
        return 'pending';
    }
  }

  /**
   * Convert event data to TraceSpanAttribute array
   */
  private convertEventDataToAttributes(data: Record<string, unknown>): TraceSpanAttribute[] {
    return Object.entries(data).map(([key, value]) => ({
      key,
      value: this.convertValueToAttributeValue(value),
    }));
  }

  /**
   * Convert a value to TraceSpanAttributeValue
   */
  private convertValueToAttributeValue(value: unknown): {
    stringValue?: string;
    intValue?: string;
    boolValue?: boolean;
  } {
    if (typeof value === 'string') {
      return { stringValue: value };
    }
    if (typeof value === 'number') {
      return { intValue: value.toString() };
    }
    if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    return { stringValue: JSON.stringify(value) };
  }

  /**
   * Safely coerce a possibly numeric value (number or numeric string) to number
   */
  private coerceToNumber(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  /**
   * Extract tokens count from event data
   */
  private extractTokensCount(data: Record<string, unknown>): number | undefined {
    // Prefer explicit direct fields if present, even if they sum to 0
    const hasInputTokens = Object.prototype.hasOwnProperty.call(data, 'inputTokens');
    const hasOutputTokens = Object.prototype.hasOwnProperty.call(data, 'outputTokens');
    if (hasInputTokens || hasOutputTokens) {
      const input = this.coerceToNumber((data as Record<string, unknown>)['inputTokens']) ?? 0;
      const output = this.coerceToNumber((data as Record<string, unknown>)['outputTokens']) ?? 0;
      return input + output;
    }

    // Helper to extract from a usage-like object
    const extractFromUsage = (usageContainer: unknown): number | undefined => {
      if (!usageContainer || typeof usageContainer !== 'object') return undefined;
      const container = usageContainer as Record<string, unknown>;
      const totalTokens = this.coerceToNumber(container['total_tokens']);
      if (totalTokens !== undefined) return totalTokens;
      const hasPrompt = Object.prototype.hasOwnProperty.call(container, 'prompt_tokens');
      const hasCompletion = Object.prototype.hasOwnProperty.call(container, 'completion_tokens');
      if (hasPrompt || hasCompletion) {
        const prompt = this.coerceToNumber(container['prompt_tokens']) ?? 0;
        const completion = this.coerceToNumber(container['completion_tokens']) ?? 0;
        return prompt + completion;
      }
      return undefined;
    };

    // Try response.usage object (common in LLM responses)
    if (data.response && typeof data.response === 'object') {
      const response = data.response as Record<string, unknown>;
      const fromResponseUsage = extractFromUsage(response['usage']);
      if (fromResponseUsage !== undefined) return fromResponseUsage;
    }

    // Try top-level usage object
    const fromTopLevelUsage = extractFromUsage(data['usage']);
    if (fromTopLevelUsage !== undefined) return fromTopLevelUsage;

    return undefined;
  }

  /**
   * Extract cost from event data
   */
  private extractCost(data: Record<string, unknown>): number | undefined {
    // Try direct cost field
    if (data.cost && typeof data.cost === 'number') {
      return data.cost;
    }

    // Try response.cost
    if (data.response && typeof data.response === 'object') {
      const response = data.response as Record<string, unknown>;
      if (response.cost && typeof response.cost === 'number') {
        return response.cost;
      }
    }

    return undefined;
  }

  /**
   * Extract prompt/input from event data
   */
  private extractPrompt(data: Record<string, unknown>): string | undefined {
    // Handle multiple prompts array (from actions)
    if (data.prompts && Array.isArray(data.prompts)) {
      const prompts = data.prompts as Array<{ prompt?: string; modelType?: string }>;
      if (prompts.length > 0) {
        return prompts
          .map((p, idx) => {
            const header =
              prompts.length > 1
                ? `[Prompt ${idx + 1}${p.modelType ? ` - ${p.modelType}` : ''}]\n`
                : '';
            return header + (p.prompt || '');
          })
          .join('\n\n---\n\n');
      }
    }

    // Try direct prompt field
    if (data.prompt && typeof data.prompt === 'string') {
      return data.prompt;
    }

    // Try params.prompt
    if (data.params && typeof data.params === 'object') {
      const params = data.params as Record<string, unknown>;
      if (params.prompt && typeof params.prompt === 'string') {
        return params.prompt;
      }
      // Return formatted params if no specific prompt
      const { prompt: _, ...otherParams } = params;
      if (Object.keys(otherParams).length > 0) {
        return JSON.stringify(otherParams, null, 2);
      }
    }

    // Try input field
    if (data.input && typeof data.input === 'string') {
      return data.input;
    }

    return undefined;
  }

  /**
   * Extract response/output from event data
   */
  private extractResponse(data: Record<string, unknown>): string | undefined {
    // Handle response object
    if (data.response) {
      if (typeof data.response === 'string') {
        return data.response;
      }
      if (typeof data.response === 'object') {
        const response = data.response as Record<string, unknown>;

        // Extract text content from common response structures
        if (response.content && typeof response.content === 'string') {
          return response.content;
        }
        if (response.text && typeof response.text === 'string') {
          return response.text;
        }
        if (response.message && typeof response.message === 'string') {
          return response.message;
        }

        // Format the full response
        return JSON.stringify(response, null, 2);
      }
      return String(data.response);
    }

    // Try output field
    if (data.output) {
      if (typeof data.output === 'string') {
        return data.output;
      }
      return JSON.stringify(data.output, null, 2);
    }

    // Try result field (for action results)
    if (data.result) {
      if (typeof data.result === 'string') {
        return data.result;
      }
      return JSON.stringify(data.result, null, 2);
    }

    return undefined;
  }

  /**
   * Convert RunSummary to TraceRecord for TraceList component
   */
  convertRunSummaryToTraceRecord(summary: RunSummary): TraceRecord {
    // Use first 8 characters of runId for compact display
    const shortId = summary.runId.slice(0, 8);
    return {
      id: summary.runId,
      name: `Run ${shortId}`,
      spansCount: Object.values(summary.counts || {}).reduce((a, b) => a + b, 0),
      durationMs: summary.durationMs || 0,
      agentDescription: `Status: ${summary.status}`,
      startTime: summary.startedAt || undefined,
    };
  }
}

// Export a singleton instance
export const elizaSpanAdapter = new ElizaSpanAdapter();
