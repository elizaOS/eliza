import { z } from 'zod';

// Base schema for any evaluation
type EvaluationType = 'string_contains' | 'regex_match' | 'file_exists' | 'trajectory_contains_action' | 'llm_judge';

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
    service: z.string(),
    method: z.string(),
    // The 'when' clause specifically checks arguments now.
    when: z.object({
        args: z.array(z.any())
    }).optional(),
    response: z.any(),
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
    lang: z.string(),
    code: z.string(),
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