import { SDKMessage } from '@anthropic-ai/claude-code';

export interface GateConfig {
  name: string;
  maxTurns: number;
  prompt: string;
  systemPrompt?: string;
  validation: (context: MigrationContext) => Promise<boolean>;
  onMessage?: (message: SDKMessage, context: MigrationContext) => void;
  retryStrategy?: {
    maxAttempts: number;
    backoffMs: number;
  };
  requiredGuides?: string[];
}

export interface MigrationContext {
  repoPath: string;
  sessionId?: string;
  currentGate: number;
  messages: SDKMessage[];
  metadata: MigrationMetadata;
  guides: Map<string, string>;
}

export interface MigrationMetadata {
  pluginName?: string;
  packageName?: string;
  version?: string;
  hasActions: boolean;
  hasProviders: boolean;
  hasServices: boolean;
  hasEvaluators: boolean;
  filesAnalyzed: Set<string>;
  filesModified: Set<string>;
  filesCreated: Set<string>;
  testsCreated: Set<string>;
  currentCoverage?: number;
  buildPassing: boolean;
  typeCheckPassing: boolean;
}

export interface GateResult {
  gateIndex: number;
  gateName: string;
  passed: boolean;
  attempts: number;
  duration: number;
  messages: SDKMessage[];
  error?: Error;
  validationDetails?: any;
}

export interface MigrationResult {
  success: boolean;
  branchName: string;
  repoPath: string;
  duration: number;
  totalCost: number;
  gateResults: GateResult[];
  error?: Error;
  summary?: MigrationSummary;
}

export interface MigrationSummary {
  filesModified: number;
  filesCreated: number;
  testsCreated: number;
  finalCoverage: number;
  totalTurns: number;
  totalCost: number;
}
