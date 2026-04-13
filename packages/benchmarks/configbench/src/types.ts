/**
 * ConfigBench Types
 */

export type ScenarioCategory =
  | "secrets-crud"
  | "security"
  | "plugin-lifecycle"
  | "plugin-config"
  | "integration";

export type CheckSeverity = "critical" | "major" | "minor";
export type ChannelKind = "dm" | "public";

export interface ScenarioMessage {
  from: "user" | "agent";
  text: string;
}

export interface CheckVerdict {
  passed: boolean;
  expected: string;
  actual: string;
}

export interface ScenarioCheck {
  name: string;
  severity: CheckSeverity;
  evaluate: (result: ScenarioOutcome) => CheckVerdict;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  severity: CheckSeverity;
}

export interface GroundTruth {
  secretsSet?: Record<string, string>;
  secretsDeleted?: string[];
  shouldRefuseInPublic?: boolean;
  pluginsNotUnloaded?: string[];
  pluginActivated?: string;
  pluginDeactivated?: string;
}

export interface Scenario {
  id: string;
  name: string;
  category: ScenarioCategory;
  description: string;
  channel: ChannelKind;
  messages: ScenarioMessage[];
  groundTruth: GroundTruth;
  checks: ScenarioCheck[];
}

export interface ScenarioOutcome {
  scenarioId: string;
  agentResponses: string[];
  secretsInStorage: Record<string, string>;
  pluginsLoaded: string[];
  secretLeakedInResponse: boolean;
  leakedValues: string[];
  refusedInPublic: boolean;
  pluginActivated: string | null;
  pluginDeactivated: string | null;
  latencyMs: number;
  traces: string[];
  error?: string;
}

export interface Handler {
  name: string;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  run(scenario: Scenario): Promise<ScenarioOutcome>;
}

export interface ScenarioScore {
  scenarioId: string;
  scenarioName: string;
  category: ScenarioCategory;
  passed: boolean;
  score: number;
  securityViolation: boolean;
  latencyMs: number;
  checks: CheckResult[];
  traces: string[];
}

export interface CategoryScore {
  category: ScenarioCategory;
  scenarioCount: number;
  passedCount: number;
  averageScore: number;
  securityViolations: number;
}

export interface HandlerResult {
  handlerName: string;
  overallScore: number;
  securityScore: number;
  capabilityScore: number;
  categories: CategoryScore[];
  scenarios: ScenarioScore[];
  totalTimeMs: number;
}

export interface BenchmarkResults {
  timestamp: string;
  totalScenarios: number;
  handlers: HandlerResult[];
  validationPassed: boolean;
}

export interface MockPluginDefinition {
  name: string;
  requiredSecrets: Record<string, { required: boolean }>;
}
