import { z } from 'zod';

// Base schema for any evaluation
type EvaluationType = 'string_contains' | 'regex_match' | 'trajectory_contains_action' | 'llm_judge';

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

const TrajectoryContainsActionSchema = BaseEvaluationSchema.extend({
    type: z.literal('trajectory_contains_action'),
    action: z.string(),
});

const LLMJudgeEvaluationSchema = BaseEvaluationSchema.extend({
    type: z.literal('llm_judge'),
    prompt: z.string(),
    expected: z.string(),
});

const EvaluationSchema = z.discriminatedUnion('type', [
    StringContainsEvaluationSchema,
    RegexMatchEvaluationSchema,
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
    plugins: z.array(z.string()).optional(),
    environment: z.object({
        type: z.enum(['e2b', 'local']),
    }),
    setup: SetupSchema.optional(),
    run: z.array(RunStepSchema),
    judgment: JudgmentSchema,
});

export type Scenario = z.infer<typeof ScenarioSchema>;