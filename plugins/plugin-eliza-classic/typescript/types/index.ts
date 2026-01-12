export interface ElizaRule {
  pattern: RegExp;
  responses: string[];
}

export interface ElizaPattern {
  keyword: string;
  weight: number;
  rules: ElizaRule[];
}

export interface ElizaConfig {
  maxHistorySize?: number;
  customPatterns?: ElizaPattern[];
  customDefaultResponses?: string[];
}

export interface ElizaMatchResult {
  pattern: ElizaPattern;
  rule: ElizaRule;
  captures: string[];
}
