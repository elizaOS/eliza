/**
 * Types for ELIZA Classic Plugin
 */

/**
 * A pattern rule with regex and response templates
 */
export interface ElizaRule {
  /** Regex pattern to match against input */
  pattern: RegExp;
  /** Array of response templates with $1, $2, etc. placeholders */
  responses: string[];
}

/**
 * A keyword pattern group with weight and rules
 */
export interface ElizaPattern {
  /** Keyword to trigger this pattern group */
  keyword: string;
  /** Priority weight (higher = more priority) */
  weight: number;
  /** Rules to apply when keyword matches */
  rules: ElizaRule[];
}

/**
 * Configuration for ELIZA response generation
 */
export interface ElizaConfig {
  /** Maximum responses to remember for avoiding repetition */
  maxHistorySize?: number;
  /** Custom patterns to add or override defaults */
  customPatterns?: ElizaPattern[];
  /** Custom default responses */
  customDefaultResponses?: string[];
}

/**
 * Result of ELIZA pattern matching
 */
export interface ElizaMatchResult {
  /** The matched pattern */
  pattern: ElizaPattern;
  /** The matched rule */
  rule: ElizaRule;
  /** Captured groups from the regex */
  captures: string[];
}




