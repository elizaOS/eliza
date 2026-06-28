export const meta = {
  name: 'alberta-retention-tournament-verify',
  description: 'Adversarially verify the Alberta retention tournament: recompute metrics from raw matrices, check headline claims, synthesize a report.',
  phases: [
    { title: 'Verify', detail: 'one independent verifier per variant; recompute ACC/BWT/Forgetting from raw matrices' },
    { title: 'Synthesize', detail: 'check headline claims, pick winner, draft report' },
  ],
}

const BASE = args && args.base ? args.base : 'packages/robot/evidence/alberta_retention_tournament'
const VARIANTS = [
  { name: 'linear', learner: 'alberta', label: 'linear sparse_gated (lookup retention)' },
  { name: 'cbp_none', learner: 'alberta_cbp', label: 'MLP+CBP, single head (no retention mechanism)' },
  { name: 'cbp_frozen', learner: 'alberta_cbp', label: 'MLP, frozen random trunk + per-task heads (CBP off)' },
  { name: 'cbp_multihead', learner: 'alberta_cbp', label: 'MLP, plastic trunk + per-task heads + CBP' },
  { name: 'cbp_warmupfrz', learner: 'alberta_cbp', label: 'MLP, warmup-then-consolidate trunk + per-task heads' },
]

const VERIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    variant: { type: 'string' },
    primary_learner: { type: 'string' },
    seeds: { type: 'integer' },
    recomputed: {
      type: 'object', additionalProperties: false,
      properties: { acc: { type: 'number' }, bwt: { type: 'number' }, forgetting: { type: 'number' } },
      required: ['acc', 'bwt', 'forgetting'],
    },
    reported: {
      type: 'object', additionalProperties: false,
      properties: { acc: { type: 'number' }, bwt: { type: 'number' }, forgetting: { type: 'number' } },
      required: ['acc', 'bwt', 'forgetting'],
    },
    matches_reported: { type: 'boolean' },
    mean_diagonal: { type: 'number' },
    mean_final: { type: 'number' },
    ppo_acc: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['variant', 'primary_learner', 'seeds', 'recomputed', 'reported', 'matches_reported', 'mean_diagonal', 'mean_final', 'ppo_acc'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    winner: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { claim: { type: 'string' }, holds: { type: 'boolean' }, evidence: { type: 'string' } },
        required: ['claim', 'holds', 'evidence'],
      },
    },
    ppo_consistent: { type: 'boolean' },
    report_markdown: { type: 'string' },
    verdict: { type: 'string' },
  },
  required: ['winner', 'claims', 'ppo_consistent', 'report_markdown', 'verdict'],
}

phase('Verify')
const verified = await parallel(VARIANTS.map((v) => () =>
  agent(
    `You are an adversarial verifier. Read the continual-learning benchmark JSON at \`${BASE}/${v.name}/continual_benchmark.json\`.

This run trained learners sequentially on a 4-task continual benchmark; for each (learner, seed) the JSON's \`results\` list has an entry {name, matrix (TxT), baseline, metrics, seed}. \`matrix[i][j]\` = eval return on task j after training phase i.

Do NOT trust the reported \`metrics\`/\`summary\`. Independently recompute, for the PRIMARY learner "${v.learner}" (averaged over its seeds), using numpy via the repo venv (\`cd packages/robot && JAX_PLATFORMS=cpu .venv/bin/python\`):
  - ACC = mean_j R[T-1][j]
  - BWT = mean_{j<T-1} (R[T-1][j] - R[j][j])
  - Forgetting = mean_{j<T-1} max(0, max_{j<=l<T} R[l][j] - R[T-1][j])
  - mean_diagonal = mean_j R[j][j]   (how well each task was learned the moment it finished training)
  - mean_final = mean_j R[T-1][j]    (retained performance at end of stream)
Also read the reported summary mean for acc/bwt/forgetting for "${v.learner}", and extract ppo's reported mean ACC from the same JSON (for cross-run consistency).

Set matches_reported=true iff your recomputed acc/bwt/forgetting agree with the reported means within 0.5 absolute. Report seeds = number of seeds for the primary learner. Be precise; this is variant "${v.name}" (${v.label}).`,
    { schema: VERIFIER_SCHEMA, label: `verify:${v.name}`, phase: 'Verify' },
  ).then((r) => ({ ...r, _name: v.name })),
))

const ok = verified.filter(Boolean)

phase('Synthesize')
const synthesis = await agent(
  `You are synthesizing the Alberta continual-learning RETENTION tournament. Here are the independently re-verified results (one per variant), as JSON:

${JSON.stringify(ok, null, 2)}

Context: the question is whether a nonlinear MLP+Continual-Backprop controller can match the linear sparse_gated controller's near-zero forgetting while having MORE capacity (better per-task learning), and beat PPO. "Retention" = low Forgetting / BWT near 0. "Capacity" = high mean_diagonal (how well each task is learned). The reference points are variant "linear" (the lookup that retains perfectly but is capacity-limited) and ppo.

Evaluate these headline claims and mark each holds/true-or-false with concrete numbers as evidence:
1. cbp_frozen retains: its Forgetting <= linear.Forgetting + 1.0 AND BWT >= -1.5.
2. The retention mechanism matters: cbp_frozen Forgetting is much lower than cbp_none Forgetting.
3. Nonlinear capacity beats the linear lookup: cbp_frozen mean_diagonal >= linear mean_diagonal.
4. cbp_frozen beats the PPO baseline on ACC: cbp_frozen ACC > ppo ACC.
5. Harness sanity: ppo ACC is consistent across all runs (same seeds/env) — set ppo_consistent accordingly (within ~0.5).
6. Also report the plastic-trunk tradeoff: cbp_multihead vs cbp_frozen on ACC and Forgetting.

Pick the overall winner (the variant that best combines retention + capacity + beating ppo). Then write \`report_markdown\`: a concise, honest markdown report with (a) a results table (variant | ACC | BWT | Forgetting | mean_diagonal[capacity] | mean_final[retained]), (b) the claim checks with numbers, (c) the plasticity/retention tradeoff in plain language, (d) any caveats (2 seeds = noisy; toy joint_reach env). Do not overclaim. Set verdict to a one-paragraph bottom line.`,
  { schema: SYNTH_SCHEMA, label: 'synthesize', phase: 'Synthesize' },
)

return { verified: ok, synthesis }
