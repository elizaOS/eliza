import { z } from 'zod';

// Base schema for any evaluation
// For scenario matrix testing, see matrix-schema.ts

// NEW: Enhanced evaluation result interfaces for ticket #5783
// These are ADDITIVE and maintain backward compatibility
export interface EnhancedEvaluationResult {
  evaluator_type: string;
  success: boolean;
  summary: string;
  details: Record<string, any>;
}

export interface LLMJudgeResult {
  qualitative_summary: string;
  capability_checklist: CapabilityCheck[];
}

export interface CapabilityCheck {
  capability: string;
  achieved: boolean;
  reasoning: string;
}

// Schema for enhanced evaluation result validation
export const EnhancedEvaluationResultSchema = z.object({
  evaluator_type: z.string(),
  success: z.boolean(),
  summary: z.string(),
  details: z.record(z.any()),
});

export const CapabilityCheckSchema = z.object({
  capability: z.string(),
  achieved: z.boolean(),
  reasoning: z.string(),
});

export const LLMJudgeResultSchema = z.object({
  qualitative_summary: z.string(),
  capability_checklist: z.array(CapabilityCheckSchema),
});

const BaseEvaluationSchema = z.object({
  type: z.string(),
});

const StringContainsEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('string_contains'),
  value: z.string(),
  case_sensitive: z.boolean().optional(),
});

const RegexMatchEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('regex_match'),
  pattern: z.string(),
});

const FileExistsEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('file_exists'),
  path: z.string(),
});

const TrajectoryContainsActionSchema = BaseEvaluationSchema.extend({
  type: z.literal('trajectory_contains_action'),
  action: z.string(),
});

const LLMJudgeEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('llm_judge'),
  prompt: z.string(),
  expected: z.string(),
  model_type: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  json_schema: z.record(z.any()).optional(), // JSON schema object for response validation
  capabilities: z.array(z.string()).min(1, 'Capabilities array must not be empty').optional(), // Custom capabilities for evaluation
});

const ExecutionTimeEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('execution_time'),
  max_duration_ms: z.number(),
  min_duration_ms: z.number().optional(),
  target_duration_ms: z.number().optional(),
});

// NEW: Conversation-specific evaluation schemas
const ConversationLengthEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('conversation_length'),
  min_turns: z.number().int().min(1).optional(),
  max_turns: z.number().int().min(1).optional(),
  optimal_turns: z.number().int().min(1).optional(),
  target_range: z
    .array(z.number().int())
    .length(2)
    .optional()
    .refine((arr) => !arr || arr[0] < arr[1], {
      message: 'target_range: first value (min) must be less than second value (max)',
    }),
});

const ConversationFlowEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('conversation_flow'),
  required_patterns: z.array(
    z.enum([
      'question_then_answer',
      'problem_then_solution',
      'clarification_cycle',
      'empathy_then_solution',
      'escalation_pattern',
    ])
  ),
  flow_quality_threshold: z.number().min(0).max(1).optional().default(0.7),
});

const UserSatisfactionEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('user_satisfaction'),
  satisfaction_threshold: z.number().min(0).max(1).optional().default(0.7),
  indicators: z
    .object({
      positive: z.array(z.string()).optional(),
      negative: z.array(z.string()).optional(),
    })
    .optional(),
  measurement_method: z
    .enum(['sentiment_analysis', 'keyword_analysis', 'llm_judge'])
    .optional()
    .default('llm_judge'),
});

const ContextRetentionEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('context_retention'),
  test_memory_of: z.array(z.string()),
  retention_turns: z.number().int().min(1).optional().default(3),
  memory_accuracy_threshold: z.number().min(0).max(1).optional().default(0.8),
});

export const EvaluationSchema = z.discriminatedUnion('type', [
  StringContainsEvaluationSchema,
  RegexMatchEvaluationSchema,
  FileExistsEvaluationSchema,
  TrajectoryContainsActionSchema,
  LLMJudgeEvaluationSchema,
  ExecutionTimeEvaluationSchema,
  // NEW conversation evaluators
  ConversationLengthEvaluationSchema,
  ConversationFlowEvaluationSchema,
  UserSatisfactionEvaluationSchema,
  ContextRetentionEvaluationSchema,
]);

const MockSchema = z.object({
  service: z.string().optional(),
  method: z.string(),
  // Enhanced 'when' clause with multiple matching strategies
  when: z
    .object({
      // Exact argument matching (existing)
      args: z.array(z.any()).optional(),
      // Input parameter matching (extracted from args)
      input: z.record(z.any()).optional(),
      // Request context matching
      context: z.record(z.any()).optional(),
      // Custom JavaScript matcher function
      matcher: z.string().optional(),
      // Partial argument matching
      partialArgs: z.array(z.any()).optional(),
    })
    .optional(),
  // Static response (existing)
  response: z.any(),
  // Dynamic response generation
  responseFn: z.string().optional(),
  // Error simulation
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      status: z.number().optional(),
    })
    .optional(),
  // Response metadata
  metadata: z
    .object({
      delay: z.number().optional(), // Simulate network delay
      probability: z.number().min(0).max(1).optional(), // Random failure
    })
    .optional(),
});

// Plugin configuration schema
const PluginConfigSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  config: z.record(z.any()).optional(),
  enabled: z.boolean().optional().default(true),
});

const PluginReferenceSchema = z.union([
  z.string(), // Simple string reference
  PluginConfigSchema, // Full configuration object
]);

const SetupSchema = z.object({
  mocks: z.array(MockSchema).optional(),
  virtual_fs: z.record(z.string()).optional(),
});

// NEW: Conversation configuration schema
const ConversationConfigSchema = z.object({
  max_turns: z.number().int().min(2).max(20),
  timeout_per_turn_ms: z.number().int().min(1000).optional().default(30000),
  total_timeout_ms: z.number().int().min(10000).optional().default(300000),

  user_simulator: z.object({
    model_type: z.string().optional().default('TEXT_LARGE'),
    temperature: z.number().min(0).max(2).optional().default(0.7),
    max_tokens: z.number().int().min(50).max(500).optional().default(200),
    persona: z.string(),
    objective: z.string(),
    style: z.string().optional(),
    constraints: z.array(z.string()).optional().default([]),
    emotional_state: z.string().optional(),
    knowledge_level: z
      .enum(['beginner', 'intermediate', 'expert'])
      .optional()
      .default('intermediate'),
  }),

  termination_conditions: z
    .array(
      z.object({
        type: z.enum([
          'max_turns_reached',
          'user_expresses_satisfaction',
          'agent_provides_solution',
          'conversation_stuck',
          'escalation_needed',
          'goal_achieved',
          'custom_condition',
        ]),
        description: z.string().optional(),
        keywords: z.array(z.string()).optional(),
        llm_judge: z
          .object({
            prompt: z.string(),
            threshold: z.number().min(0).max(1).optional().default(0.8),
          })
          .optional(),
      })
    )
    .optional()
    .default([]),

  turn_evaluations: z.array(EvaluationSchema).optional().default([]),
  final_evaluations: z.array(EvaluationSchema).optional().default([]),

  debug_options: z
    .object({
      log_user_simulation: z.boolean().optional().default(false),
      log_turn_decisions: z.boolean().optional().default(false),
      export_full_transcript: z.boolean().optional().default(true),
    })
    .optional()
    .default({}),
});

const RunStepSchema = z.object({
  name: z.string().optional(),
  lang: z.string().optional(),
  code: z.string().optional(),
  input: z.string().optional(), // Natural language input to agent
  evaluations: z.array(EvaluationSchema),

  // NEW: Optional conversation configuration
  conversation: ConversationConfigSchema.optional(),
});

const JudgmentSchema = z.object({
  strategy: z.enum(['all_pass', 'any_pass']),
});

export const ScenarioSchema = z.object({
  name: z.string(),
  description: z.string(),
  plugins: z.array(PluginReferenceSchema).optional(),
  environment: z.object({
    type: z.enum(['e2b', 'local']),
  }),
  setup: SetupSchema.optional(),
  run: z.array(RunStepSchema),
  judgment: JudgmentSchema,
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type PluginReference = z.infer<typeof PluginReferenceSchema>;

// NEW: Centralized Run Data Interfaces for Ticket #5786

/**
 * Trajectory step interface (matches GitHub ticket #5785 specification)
 */
export interface TrajectoryStep {
  /** Step type: 'thought', 'action', or 'observation' */
  type: 'thought' | 'action' | 'observation';

  /** ISO timestamp string */
  timestamp: string;

  /** Step content based on type */
  content:
    | string
    | {
        name: string;
        parameters: Record<string, any>;
      }
    | any;
}

/**
 * Performance and resource metrics for a scenario run
 */
export interface ScenarioRunMetrics {
  /** Total execution time in seconds */
  execution_time_seconds: number;

  /** Number of LLM API calls made during the run */
  llm_calls: number;

  /** Total tokens consumed (input + output) */
  total_tokens: number;

  /** Additional custom metrics */
  [key: string]: number;
}

/**
 * Comprehensive result structure for a single scenario run.
 * This is the master interface for ticket #5786 that consolidates
 * all data from a scenario execution into a structured JSON output.
 */
export interface ScenarioRunResult {
  /** Unique identifier for this specific run */
  run_id: string;

  /** Identifier linking this run to a specific matrix combination */
  matrix_combination_id: string;

  /** The specific parameter values used for this run */
  parameters: Record<string, any>;

  /** Performance and resource metrics collected during execution */
  metrics: ScenarioRunMetrics;

  /** The final text/object response from the agent to the user */
  final_agent_response?: string;

  /** Array of structured evaluation results from the EvaluationEngine */
  evaluations: EnhancedEvaluationResult[];

  /** Array of trajectory steps showing the agent's cognitive process */
  trajectory: TrajectoryStep[];

  /** Error message if the run failed unexpectedly (null for successful runs) */
  error: string | null;
}

// Zod schema for validation of ScenarioRunResult
export const ScenarioRunResultSchema = z.object({
  run_id: z.string().min(1, 'Run ID cannot be empty'),
  matrix_combination_id: z.string().min(1, 'Matrix combination ID cannot be empty'),
  parameters: z.record(z.any()),
  metrics: z
    .object({
      execution_time_seconds: z.number().min(0),
      llm_calls: z.number().int().min(0),
      total_tokens: z.number().int().min(0),
    })
    .catchall(z.number()), // Allow additional numeric metrics
  final_agent_response: z.string().optional(),
  evaluations: z.array(EnhancedEvaluationResultSchema),
  trajectory: z.array(
    z.object({
      type: z.enum(['thought', 'action', 'observation']),
      timestamp: z.string().refine((val) => !isNaN(Date.parse(val)), {
        message: 'Timestamp must be a valid ISO string',
      }),
      content: z.any(),
    })
  ),
  error: z.string().nullable(),
});
