/**
 * TypeScript types rules and configuration
 */

/**
 * Rule definition structure matching Cursor IDE rules format
 */
export interface Rule {
  name: string;
  description?: string;
  globs?: string[];
  alwaysApply: boolean;
  content: string | RuleContent;
}

/**
 * Structured rule content
 */
export interface RuleContent {
  title?: string;
  guidelines?: string[];
  overview?: string;
  projectStructure?: ProjectStructure;
}

/**
 * Project structure information
 */
export interface ProjectStructure {
  mainEntryPoints: EntryPoint[];
  mainClass: ClassInfo;
  executionEnvironment: ExecutionEnvironment;
  tools: ToolsInfo;
  inspectors: Inspector[];
}

export interface EntryPoint {
  path: string;
  description: string;
  type: 'single' | 'batch' | 'other';
}

export interface ClassInfo {
  name: string;
  path: string;
  description: string;
}

export interface ExecutionEnvironment {
  type: string;
  description: string;
  interfaceClass?: ClassInfo;
  interfaceProject?: string;
}

export interface ToolsInfo {
  location: string;
  organization: string;
  deployment: string;
}

export interface Inspector {
  name: string;
  path: string;
  type: 'cli' | 'web';
  description: string;
}

/**
 * Coding guidelines configuration
 */
export interface CodingGuidelines {
  language: 'python' | 'typescript';
  version: string;
  rules: CodingRule[];
}

export interface CodingRule {
  id: string;
  category: 'style' | 'imports' | 'api' | 'documentation' | 'filesystem';
  rule: string;
  enforcement?: 'required' | 'recommended' | 'optional';
  alternatives?: string[];
}

/**
 * Complete rules configuration
 */
export interface RulesConfig {
  general: CodingGuidelines;
  projectOverview: ProjectStructure;
  cursorRules?: Rule[];
}
