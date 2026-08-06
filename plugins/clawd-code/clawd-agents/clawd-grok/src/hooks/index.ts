export { getMatchingHooks, loadHooksConfig } from "./config.js";
export { execCommandHook, executeHooks } from "./executor.js";
export type {
  AggregatedHookResult,
  BaseHookInput,
  CommandHook,
  HookCommand,
  HookEvent,
  HookInput,
  HookMatcher,
  HookOutput,
  HookResult,
  HooksConfig,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "./types.js";
export { getMatchQuery, HOOK_EVENTS, isHookEvent } from "./types.js";

import { getMatchingHooks, loadHooksConfig } from "./config.js";
import { executeHooks } from "./executor.js";
import type {
  AggregatedHookResult,
  HookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "./types.js";
import { getMatchQuery } from "./types.js";

function emptyResult(): AggregatedHookResult {
  return {
    blocked: false,
    blockingErrors: [],
    preventContinuation: false,
    additionalContexts: [],
    results: [],
  };
}

/**
 * Fire hooks for a generic event. Loads config, matches, and executes.
 * Swallows all errors so hooks never crash the agent.
 */
export async function executeEventHooks(
  input: HookInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  try {
    const config = loadHooksConfig();
    const matchValue = getMatchQuery(input);
    const hooks = getMatchingHooks(config, input.hook_event_name, matchValue);
    if (hooks.length === 0) return emptyResult();
    return await executeHooks(hooks, input, cwd, signal);
  } catch {
    return emptyResult();
  }
}

/**
 * Fire PreToolUse hooks. Returns the aggregated result which may block execution.
 */
export async function executePreToolHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  const input: PreToolUseHookInput = {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sessionId,
    cwd,
  };
  return executeEventHooks(input, cwd, signal);
}

/**
 * Fire PostToolUse hooks after a successful tool execution.
 */
export async function executePostToolHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: Record<string, unknown>,
  cwd: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  const input: PostToolUseHookInput = {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: toolOutput,
    session_id: sessionId,
    cwd,
  };
  return executeEventHooks(input, cwd, signal);
}

/**
 * Fire PostToolUseFailure hooks after a tool execution fails.
 */
export async function executePostToolFailureHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  error: string,
  cwd: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  const input: PostToolUseFailureHookInput = {
    hook_event_name: "PostToolUseFailure",
    tool_name: toolName,
    tool_input: toolInput,
    error,
    session_id: sessionId,
    cwd,
  };
  return executeEventHooks(input, cwd, signal);
}
