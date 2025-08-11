import { z } from 'zod';

// Base schema for any evaluation
export type EvaluationType = 'string_contains' | 'regex_match' | 'file_exists' | 'trajectory_contains_action' | 'llm_judge';

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
});

const EvaluationSchema = z.discriminatedUnion('type', [
    StringContainsEvaluationSchema,
    RegexMatchEvaluationSchema,
    FileExistsEvaluationSchema,
    TrajectoryContainsActionSchema,
    LLMJudgeEvaluationSchema,
]);

const MockSchema = z.object({
    service: z.string().optional(),
    method: z.string(),
    // Enhanced 'when' clause with multiple matching strategies
    when: z.object({
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
    }).optional(),
    // Static response (existing)
    response: z.any(),
    // Dynamic response generation
    responseFn: z.string().optional(),
    // Error simulation
    error: z.object({
        code: z.string(),
        message: z.string(),
        status: z.number().optional(),
    }).optional(),
    // Response metadata
    metadata: z.object({
        delay: z.number().optional(), // Simulate network delay
        probability: z.number().min(0).max(1).optional(), // Random failure
    }).optional(),
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

const RunStepSchema = z.object({
    name: z.string().optional(),
    lang: z.string().optional(),
    code: z.string().optional(),
    input: z.string().optional(), // Natural language input to agent
    evaluations: z.array(EvaluationSchema),
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