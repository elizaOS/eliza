/**
 * Directive types for inline message parsing
 */

// Thinking/reasoning level control
export type ThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type VerboseLevel = "off" | "on" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ElevatedMode = "off" | "ask" | "full";

// Exec directive types
export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";

export interface ExecConfig {
  host?: ExecHost;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
}

export interface ModelConfig {
  provider?: string;
  model?: string;
  authProfile?: string;
}

/**
 * Parsed inline directives from message text
 */
export interface ParsedDirectives {
  // Cleaned text with directives removed
  cleanedText: string;
  directivesOnly: boolean;

  // Thinking directive
  hasThinkDirective: boolean;
  thinkLevel?: ThinkLevel;
  rawThinkLevel?: string;

  // Verbose directive
  hasVerboseDirective: boolean;
  verboseLevel?: VerboseLevel;
  rawVerboseLevel?: string;

  // Reasoning directive
  hasReasoningDirective: boolean;
  reasoningLevel?: ReasoningLevel;
  rawReasoningLevel?: string;

  // Elevated directive
  hasElevatedDirective: boolean;
  elevatedLevel?: ElevatedLevel;
  rawElevatedLevel?: string;

  // Exec directive
  hasExecDirective: boolean;
  execHost?: ExecHost;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execNode?: string;
  rawExecHost?: string;
  rawExecSecurity?: string;
  rawExecAsk?: string;
  rawExecNode?: string;
  hasExecOptions: boolean;
  invalidExecHost: boolean;
  invalidExecSecurity: boolean;
  invalidExecAsk: boolean;
  invalidExecNode: boolean;

  // Status directive
  hasStatusDirective: boolean;

  // Model directive
  hasModelDirective: boolean;
  rawModelDirective?: string;
  rawModelProfile?: string;

}

/**
 * Full directive state for a session
 */
export interface DirectiveState {
  thinking: ThinkLevel;
  verbose: VerboseLevel;
  reasoning: ReasoningLevel;
  elevated: ElevatedLevel;
  exec: ExecConfig;
  model: ModelConfig;
}

/**
 * Options for parsing directives
 */
export interface ParseOptions {
  modelAliases?: string[];
  disableElevated?: boolean;
  allowStatusDirective?: boolean;
}

/**
 * Result of a single directive extraction
 */
export interface DirectiveExtractResult<T> {
  cleaned: string;
  level?: T;
  rawLevel?: string;
  hasDirective: boolean;
}
