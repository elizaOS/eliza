/**
 * Utility functions to map ElizaOS action data to prompt-kit Tool component format
 */

import type { ToolPart } from '@/components/ui/tool';

export interface ElizaActionData {
  actionName: string;
  actionStatus: 'executing' | 'completed' | 'failed' | 'pending';
  actionId: string;
  actionResult?: any;
  runId: string;
  error?: string;
  input?: Record<string, unknown>;
  metadata?: any;
}

/**
 * Maps ElizaOS action status to Tool component state
 */
export function mapElizaStatusToToolState(status: string): "input-streaming" | "input-available" | "output-available" | "output-error" {
  switch(status) {
    case "executing": return "input-streaming";
    case "completed": return "output-available";
    case "failed": return "output-error";
    case "pending": return "input-available";
    default: return "input-available";
  }
}

/**
 * Extracts input parameters from ElizaOS action data
 */
export function extractActionInput(actionData: ElizaActionData): Record<string, unknown> {
  // Try to extract input from various possible sources
  if (actionData.input) {
    return actionData.input;
  }
  
  if (actionData.metadata?.input) {
    return actionData.metadata.input;
  }
  
  if (actionData.metadata?.parameters) {
    return actionData.metadata.parameters;
  }
  
  // If no explicit input, create a basic one from available data
  return {
    actionName: actionData.actionName,
    runId: actionData.runId,
  };
}

/**
 * Extracts output data from ElizaOS action result
 */
export function extractActionOutput(actionData: ElizaActionData): Record<string, unknown> {
  if (actionData.actionResult) {
    // If actionResult has specific structure, extract relevant parts
    if (typeof actionData.actionResult === 'object') {
      const { success, text, data, values, ...rest } = actionData.actionResult;
      return {
        success,
        text,
        data,
        values,
        ...rest,
      };
    }
    return { result: actionData.actionResult };
  }
  
  // Return basic output info
  return {
    status: actionData.actionStatus,
    actionId: actionData.actionId,
  };
}

/**
 * Main function to convert ElizaOS action data to Tool component format
 */
export function mapElizaActionToToolPart(actionData: ElizaActionData): ToolPart {
  return {
    type: actionData.actionName,
    state: mapElizaStatusToToolState(actionData.actionStatus),
    input: extractActionInput(actionData),
    output: extractActionOutput(actionData),
    toolCallId: actionData.actionId,
    errorText: actionData.error,
  };
}
