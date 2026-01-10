export interface StrategySpec {
  goal: string;
  requirements: string[];
  constraints: Record<string, any>;
  expectedOutcome: string;
}

export interface ExecutionStep {
  id: string;
  action: string;
  inputs: Record<string, any>;
  dependencies: string[];
  optional: boolean;
}

export interface ExecutionDAG {
  steps: ExecutionStep[];
  edges: Array<[string, string]>;
  metadata: Record<string, any>;
}

export interface ExecutionResult {
  dagId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  completedSteps: string[];
  failedSteps: string[];
  results: Record<string, any>;
  errors: Record<string, string>;
}

export interface RequiredCapability {
  type: 'action' | 'provider' | 'service' | 'model';
  name: string;
  description?: string;
  required: boolean;
}

export interface CapabilityGap {
  capability: RequiredCapability;
  suggestions: string[];
  canGenerate: boolean;
}

export interface GenerationMethod {
  type: 'plugin' | 'mcp' | 'n8n' | 'custom';
  confidence: number;
  estimatedTime: number;
}

export enum MessageClassification {
  SIMPLE = 'simple',
  STRATEGIC = 'strategic',
  CAPABILITY_REQUEST = 'capability_request',
  RESEARCH_NEEDED = 'research_needed',
}
