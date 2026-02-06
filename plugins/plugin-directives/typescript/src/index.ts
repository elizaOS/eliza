/**
 * Plugin Directives - Inline directive parsing for Eliza agents
 *
 * Parses and applies inline directives from message text:
 * - /think or /t - Thinking level control
 * - /verbose or /v - Verbose output control
 * - /reasoning - Reasoning visibility
 * - /elevated - Elevated permissions
 * - /exec - Execution environment settings
 * - /model - Model selection
 * - /status - Status request
 */

import {
  type IAgentRuntime,
  type Plugin,
  type Provider,
  type ProviderResult,
  logger,
} from "@elizaos/core";

import {
  extractElevatedDirective,
  extractExecDirective,
  extractModelDirective,
  extractReasoningDirective,
  extractStatusDirective,
  extractThinkDirective,
  extractVerboseDirective,
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "./parsers";

import type {
  DirectiveState,
  ElevatedLevel,
  ParsedDirectives,
  ParseOptions,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "./types";

// Re-export types
export * from "./types";
export * from "./parsers";

// ============================================================================
// Session State Management
// ============================================================================

const sessionStates = new Map<string, DirectiveState>();

function getDefaultState(): DirectiveState {
  return {
    thinking: "low",
    verbose: "off",
    reasoning: "off",
    elevated: "off",
    exec: {},
    model: {},
  };
}

/**
 * Get directive state for a room
 */
export function getDirectiveState(roomId: string): DirectiveState {
  return sessionStates.get(roomId) ?? getDefaultState();
}

/**
 * Set directive state for a room
 */
export function setDirectiveState(roomId: string, state: DirectiveState): void {
  sessionStates.set(roomId, state);
}

/**
 * Clear directive state for a room
 */
export function clearDirectiveState(roomId: string): void {
  sessionStates.delete(roomId);
}

// ============================================================================
// Main Parse Function
// ============================================================================

/**
 * Parse all inline directives from message text
 */
export function parseDirectives(
  body: string,
  options?: ParseOptions,
): ParsedDirectives {
  const {
    cleaned: thinkCleaned,
    thinkLevel,
    rawLevel: rawThinkLevel,
    hasDirective: hasThinkDirective,
  } = extractThinkDirective(body);

  const {
    cleaned: verboseCleaned,
    verboseLevel,
    rawLevel: rawVerboseLevel,
    hasDirective: hasVerboseDirective,
  } = extractVerboseDirective(thinkCleaned);

  const {
    cleaned: reasoningCleaned,
    reasoningLevel,
    rawLevel: rawReasoningLevel,
    hasDirective: hasReasoningDirective,
  } = extractReasoningDirective(verboseCleaned);

  const {
    cleaned: elevatedCleaned,
    elevatedLevel,
    rawLevel: rawElevatedLevel,
    hasDirective: hasElevatedDirective,
  } = options?.disableElevated
    ? {
        cleaned: reasoningCleaned,
        elevatedLevel: undefined,
        rawLevel: undefined,
        hasDirective: false,
      }
    : extractElevatedDirective(reasoningCleaned);

  const {
    cleaned: execCleaned,
    execHost,
    execSecurity,
    execAsk,
    execNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions,
    invalidHost: invalidExecHost,
    invalidSecurity: invalidExecSecurity,
    invalidAsk: invalidExecAsk,
    invalidNode: invalidExecNode,
    hasDirective: hasExecDirective,
  } = extractExecDirective(elevatedCleaned);

  const allowStatusDirective = options?.allowStatusDirective !== false;
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } =
    allowStatusDirective
      ? extractStatusDirective(execCleaned)
      : { cleaned: execCleaned, hasDirective: false };

  const {
    cleaned: modelCleaned,
    rawModel,
    rawProfile,
    hasDirective: hasModelDirective,
  } = extractModelDirective(statusCleaned, {
    aliases: options?.modelAliases,
  });

  // Determine if message contains only directives
  const hasAnyDirective =
    hasThinkDirective ||
    hasVerboseDirective ||
    hasReasoningDirective ||
    hasElevatedDirective ||
    hasExecDirective ||
    hasModelDirective;
  const directivesOnly = hasAnyDirective && modelCleaned.trim().length === 0;

  return {
    cleanedText: modelCleaned,
    directivesOnly,
    hasThinkDirective,
    thinkLevel,
    rawThinkLevel,
    hasVerboseDirective,
    verboseLevel,
    rawVerboseLevel,
    hasReasoningDirective,
    reasoningLevel,
    rawReasoningLevel,
    hasElevatedDirective,
    elevatedLevel,
    rawElevatedLevel,
    hasExecDirective,
    execHost,
    execSecurity,
    execAsk,
    execNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions,
    invalidExecHost,
    invalidExecSecurity,
    invalidExecAsk,
    invalidExecNode,
    hasStatusDirective,
    hasModelDirective,
    rawModelDirective: rawModel,
    rawModelProfile: rawProfile,
  };
}

/**
 * Apply parsed directives to session state
 */
export function applyDirectives(
  roomId: string,
  directives: ParsedDirectives,
  persist = true,
): DirectiveState {
  const current = getDirectiveState(roomId);
  const updated = { ...current };

  if (directives.hasThinkDirective && directives.thinkLevel) {
    updated.thinking = directives.thinkLevel;
  }
  if (directives.hasVerboseDirective && directives.verboseLevel) {
    updated.verbose = directives.verboseLevel;
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    updated.reasoning = directives.reasoningLevel;
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    updated.elevated = directives.elevatedLevel;
  }
  if (directives.hasExecDirective) {
    updated.exec = {
      ...updated.exec,
      ...(directives.execHost && { host: directives.execHost }),
      ...(directives.execSecurity && { security: directives.execSecurity }),
      ...(directives.execAsk && { ask: directives.execAsk }),
      ...(directives.execNode && { node: directives.execNode }),
    };
  }
  if (directives.hasModelDirective && directives.rawModelDirective) {
    const parts = directives.rawModelDirective.split("/");
    if (parts.length === 2) {
      updated.model = {
        provider: parts[0],
        model: parts[1],
        authProfile: directives.rawModelProfile,
      };
    } else {
      updated.model = {
        model: directives.rawModelDirective,
        authProfile: directives.rawModelProfile,
      };
    }
  }

  if (persist) {
    setDirectiveState(roomId, updated);
  }

  return updated;
}

/**
 * Format directive state for display
 */
export function formatDirectiveState(state: DirectiveState): string {
  const lines: string[] = [];
  lines.push(`Thinking: ${state.thinking}`);
  lines.push(`Verbose: ${state.verbose}`);
  lines.push(`Reasoning: ${state.reasoning}`);
  lines.push(`Elevated: ${state.elevated}`);
  if (state.model.provider || state.model.model) {
    const modelStr = state.model.provider
      ? `${state.model.provider}/${state.model.model}`
      : state.model.model;
    lines.push(
      `Model: ${modelStr}${state.model.authProfile ? ` @${state.model.authProfile}` : ""}`,
    );
  }
  return lines.join("\n");
}

/**
 * Format acknowledgment for directive-only messages
 */
export function formatDirectiveAcknowledgment(
  directives: ParsedDirectives,
): string {
  const changes: string[] = [];

  if (directives.hasThinkDirective) {
    changes.push(`Thinking: ${directives.thinkLevel ?? "status"}`);
  }
  if (directives.hasVerboseDirective) {
    changes.push(`Verbose: ${directives.verboseLevel ?? "status"}`);
  }
  if (directives.hasReasoningDirective) {
    changes.push(`Reasoning: ${directives.reasoningLevel ?? "status"}`);
  }
  if (directives.hasElevatedDirective) {
    changes.push(`Elevated: ${directives.elevatedLevel ?? "status"}`);
  }
  if (directives.hasModelDirective) {
    changes.push(`Model: ${directives.rawModelDirective ?? "status"}`);
  }

  return changes.length > 0 ? `✓ ${changes.join(", ")}` : "No changes applied";
}

// ============================================================================
// Provider
// ============================================================================

/**
 * Provider that exposes current directive state to the agent
 */
export const directiveStateProvider: Provider = {
  name: "DIRECTIVE_STATE",
  description: "Current directive levels (thinking, verbose, model, etc.)",

  async get(runtime, message, _state): Promise<ProviderResult> {
    const roomId = message.roomId;
    const directives = getDirectiveState(roomId);

    return {
      text: formatDirectiveState(directives),
      values: {
        thinkingLevel: directives.thinking,
        verboseLevel: directives.verbose,
        reasoningLevel: directives.reasoning,
        elevatedLevel: directives.elevated,
        modelProvider: directives.model.provider ?? "",
        modelName: directives.model.model ?? "",
        isElevated: directives.elevated !== "off",
      },
      data: { directives },
    };
  },
};

// ============================================================================
// Plugin Export
// ============================================================================

/**
 * Plugin Directives
 *
 * Provides inline directive parsing for Eliza agents, allowing users to
 * control thinking levels, verbosity, model selection, and more through
 * inline commands in their messages.
 */
export const directivesPlugin: Plugin = {
  name: "directives",
  description:
    "Inline directive parsing (@think, @model, @verbose, etc.) for controlling agent behavior",

  providers: [directiveStateProvider],

  config: {
    DEFAULT_THINKING: "low",
    DEFAULT_VERBOSE: "off",
    ALLOW_ELEVATED: "true",
    ALLOW_EXEC: "false",
  },

  tests: [
    {
      name: "directive-parsing",
      tests: [
        {
          name: "Parse think directive",
          fn: async (_runtime: IAgentRuntime) => {
            const result = parseDirectives("/think:high hello world");
            if (!result.hasThinkDirective) {
              throw new Error("Should detect think directive");
            }
            if (result.thinkLevel !== "high") {
              throw new Error(`Expected 'high', got '${result.thinkLevel}'`);
            }
            if (result.cleanedText !== "hello world") {
              throw new Error(
                `Expected 'hello world', got '${result.cleanedText}'`,
              );
            }
            logger.success("Think directive parsed correctly");
          },
        },
        {
          name: "Parse verbose directive",
          fn: async (_runtime: IAgentRuntime) => {
            const result = parseDirectives("/v on test message");
            if (!result.hasVerboseDirective) {
              throw new Error("Should detect verbose directive");
            }
            if (result.verboseLevel !== "on") {
              throw new Error(`Expected 'on', got '${result.verboseLevel}'`);
            }
            logger.success("Verbose directive parsed correctly");
          },
        },
        {
          name: "Parse model directive",
          fn: async (_runtime: IAgentRuntime) => {
            const result = parseDirectives(
              "/model anthropic/claude-3-opus what is 2+2",
            );
            if (!result.hasModelDirective) {
              throw new Error("Should detect model directive");
            }
            if (result.rawModelDirective !== "anthropic/claude-3-opus") {
              throw new Error(
                `Expected 'anthropic/claude-3-opus', got '${result.rawModelDirective}'`,
              );
            }
            logger.success("Model directive parsed correctly");
          },
        },
        {
          name: "Detect directive-only message",
          fn: async (_runtime: IAgentRuntime) => {
            const result = parseDirectives("/think:high /verbose on");
            if (!result.directivesOnly) {
              throw new Error("Should detect directive-only message");
            }
            logger.success("Directive-only detection works correctly");
          },
        },
        {
          name: "Parse multiple directives",
          fn: async (_runtime: IAgentRuntime) => {
            const result = parseDirectives(
              "/think:medium /v full /elevated on hello",
            );
            if (
              !result.hasThinkDirective ||
              !result.hasVerboseDirective ||
              !result.hasElevatedDirective
            ) {
              throw new Error("Should detect all directives");
            }
            if (result.thinkLevel !== "medium") {
              throw new Error(`Expected 'medium', got '${result.thinkLevel}'`);
            }
            if (result.verboseLevel !== "full") {
              throw new Error(`Expected 'full', got '${result.verboseLevel}'`);
            }
            if (result.elevatedLevel !== "on") {
              throw new Error(`Expected 'on', got '${result.elevatedLevel}'`);
            }
            if (result.cleanedText !== "hello") {
              throw new Error(`Expected 'hello', got '${result.cleanedText}'`);
            }
            logger.success("Multiple directives parsed correctly");
          },
        },
        {
          name: "Session state management",
          fn: async (_runtime: IAgentRuntime) => {
            const roomId = "test-room-123";
            clearDirectiveState(roomId);

            const directives = parseDirectives("/think:high /verbose on");
            applyDirectives(roomId, directives);

            const state = getDirectiveState(roomId);
            if (state.thinking !== "high") {
              throw new Error(
                `Expected thinking 'high', got '${state.thinking}'`,
              );
            }
            if (state.verbose !== "on") {
              throw new Error(`Expected verbose 'on', got '${state.verbose}'`);
            }

            clearDirectiveState(roomId);
            logger.success("Session state management works correctly");
          },
        },
      ],
    },
  ],

  async init(_config, runtime) {
    logger.log("[plugin-directives] Initializing directive parser");
  },
};

export default directivesPlugin;
