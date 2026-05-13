---
name: rl-post-training
description: Diagnostic guide for RL-based post-training of language models (GRPO, PPO, REINFORCE, DPO). Use proactively when debugging a training pipeline that shows no improvement, loss anomalies, reward stagnation, NaN gradients, or other unexpected behavior during reinforcement learning fine-tuning. Work through all pipeline stages — reward, advantages, log-probs, loss, generation/decoding — before concluding the diagnosis is complete; stopping after one or two fixes is a common failure mode. Covers log-probability math, advantage estimation, numerical stability, reward processing, and generation/decoding pipeline issues.
---

# RL Post-Training — Concepts & Diagnostic Guide

## Core Concepts

RL post-training optimizes a language model's policy using reward signals. The standard pipeline:

```
prompt → generate completions → score with reward → compute advantages → policy gradient update
```

Each stage has distinct failure modes. When a model "shows no improvement," the bug could be anywhere in this pipeline.

## Diagnostic Methodology

When RL training produces no improvement, work through these stages in order. Each stage depends on the previous one being correct.

### Stage 1: Verify Reward Signal
- Are rewards non-constant? If all rewards are identical, there is no learning signal.
- Do rewards correlate with completion quality? Spot-check decoded completions against their scores.
- Is the reward function being called on the correct text? Check that decoding/stripping preserves the content the reward function needs to evaluate.

### Stage 2: Verify Advantage Computation
- Are advantages non-zero when rewards vary? If they collapse to ~0, the policy gradient vanishes.
- Check the magnitude and dtype of every numerical-stability constant in the advantage path (additive epsilons, clipping bounds). Compare each to what the math requires.
- Check the group size `G`. `G ≤ 2` makes `std` either undefined or extremely noisy.

### Stage 3: Verify Log-Probability Computation
- Verify bounds: log-probs of valid tokens must be non-positive.
- Compare your implementation against `F.log_softmax` on a small deterministic input — a numerical match rules out sign errors, wrong gathering axis, and off-by-one subtraction.
- On a near-one-hot input, confirm the dominant token's log-prob is close to 0 (not close to the min).

### Stage 4: Verify Loss Computation
- Is the loss changing across steps? Flat loss suggests zero gradients upstream.
- Log the KL term and the policy-gradient term separately. Either dominating the other is diagnostic.
- Check the fraction of clipped samples. Near-100% clipping means the clip range is starving the signal.

### Stage 5: Verify Generation and Decoding
- Are padding and decoder artefacts stripped from the text the reward function sees?
- Does every completion shape your model can emit survive the decoding path with non-empty output where a human would expect non-empty output? Include degenerate cases (no formatting markers, only a prefix, only a suffix) in the round-trip test.
- Print or log a sample of the actual strings handed to the reward function — mismatches between "what the model generated" and "what the reward saw" are often visible at a glance.

## Fixing, Not Rewriting

A bug in a branched function is a bug in one branch, not a verdict on the whole function. Before editing:

- Enumerate the input shapes the function handles today and the output each branch produces. The branches exist because callers rely on them.
- Identify which input-output pairs violate the intended contract. Those are the only branches you need to change.
- If your diff collapses a multi-branch function to a one-liner, you have almost certainly broken a contract a different caller depends on. Re-read the call sites before committing.

The same principle applies to epsilon values, sign conventions, and clipping bounds — if a constant looks wrong, replace it with a correct constant; don't remove the surrounding numerical-stability logic.

## Key Mathematical Invariants

These invariants should always hold. If any is violated, there is a bug.

| Invariant | What it means | How to check |
|-----------|--------------|-------------|
| `log_prob <= 0` | Log of a probability is non-positive | `assert (log_probs <= 1e-6).all()` |
| log-probs match `F.log_softmax` | Manual implementation equals the reference | `torch.allclose(manual, F.log_softmax(...).gather(...))` |
| `sum(softmax(logits)) == 1` | Probabilities sum to 1 | `assert torch.allclose(softmax.sum(-1), ones)` |
| `0 < epsilon << 1` | Additive epsilons exist for numerical stability only | `assert 0 < epsilon < 1` |
| `advantages != 0` when rewards vary | Non-constant rewards yield non-zero advantages | `assert advantages.abs().max() > 0.1` |
| Decoding preserves content | Every generation shape the model emits survives the decode path with the content a human reader would expect | Round-trip representative samples; confirm non-empty where non-empty is expected |

## Common Pitfall Categories

Detailed pitfall catalog with examples is in `references/common-pitfalls.md`. Summary:

1. **Sign errors in log-space** — log-softmax, KL divergence, DPO log-ratio
2. **Numerical stability constants out of range** — additive epsilons, clip bounds, temperature
3. **String processing in decoding** — cleanup that blanks shapes the rules didn't anticipate
4. **Reward / decoding format mismatch** — reward function sees text with the shape it needs removed
5. **Reference model drift** — reference model not frozen, or gradients flowing through it
6. **Gradient flow breakage** — detached tensors, in-place ops, `.item()`/numpy round-trips in the loss path
7. **Configuration misuse** — SFT-scale LR, KL coefficient dominating, clip range too tight, `G` too small

## Available References

| File | Contents | When to load |
|------|----------|-------------|
| `references/common-pitfalls.md` | Catalog of pitfall categories with symptoms and detection strategies | When you have a suspicious area and want to match it against known pattern shapes |
| `references/diagnostic-workflow.md` | Stage-by-stage diagnostic procedures with verification snippets | When you need guidance on which invariant to check in which order |
| `scripts/verify_pipeline.py` | Runnable diagnostic that prints log-prob / advantage / decoding values on small fixed inputs so you can compare them against the invariants above | Before declaring a fix done: run this and inspect the output, paying attention to lines marked `?` |
