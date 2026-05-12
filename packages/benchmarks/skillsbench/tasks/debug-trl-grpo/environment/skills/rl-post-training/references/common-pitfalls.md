# Common Pitfalls in RL Post-Training

## Table of Contents
- Log-Probability Pitfalls
- Advantage Estimation Pitfalls
- Generation and Decoding Pitfalls
- Reward Function Pitfalls
- Gradient and Optimization Pitfalls
- Configuration Pitfalls

---

## Log-Probability Pitfalls

### Sign Errors in Log-Space
**Pattern:** A subtraction or negation in log-space is reversed, so quantities that should be non-positive come out positive (or vice versa). The classic offenders are log-softmax, the DPO log-ratio `log pi(chosen) - log pi(rejected)`, and KL divergence `E[log p - log q]`.

**Symptoms:**
- A quantity you know must be bounded (e.g. log-prob, KL) violates its bound
- Loss still decreases but the policy moves *away* from high-reward completions
- Ratios in PPO-style updates have the wrong scale

**How to detect:**
- Bound checks (e.g. `log_probs.max() <= 0`) are the fastest signal
- Compare your manual implementation against the framework reference (`F.log_softmax`, `F.kl_div`) on a small deterministic input
- Spot-check the sign on a near-one-hot input where the answer is predictable

**Why it happens:** Log-space identities are easy to write down in either direction. When variable names don't encode the polarity (`a - b` vs `b - a` looks symmetric in code review), the reversed form passes linting and tests that only check shape.

### Incorrect Gathering Along the Vocabulary Dimension
**Pattern:** `gather` is called on the wrong axis, or the index tensor is not unsqueezed to match rank. The call still runs, but indexes into the sequence dimension instead of vocab.

**Symptoms:** Values are plausible-looking but uncorrelated with the intended tokens. Training is slow or unstable with no obvious bug.

**How to detect:** Compare against the explicit `log_softmax(...).gather(-1, idx.unsqueeze(-1)).squeeze(-1)` on a tiny input.

### Precision Loss in Half-Precision
**Pattern:** `logsumexp` computed in float16 or bfloat16 overflows or loses precision when logits span a large range.

**Symptoms:** Sporadic NaNs, especially on longer sequences or with sharper distributions after a few training steps.

**How to detect:** Cast logits to float32 before the logsumexp step and compare; differences > 0.01 indicate precision issues.

---

## Advantage Estimation Pitfalls

### Epsilon Dominates the Denominator
**Pattern:** The numerical-stability epsilon added to `std` is large enough to wash out the reward-normalized signal. Epsilon should be a rounding guard for `std == 0`, not a real additive term.

**Common ways this happens:**
- Typo in scientific notation (positive exponent where a negative was intended)
- Copy-pasting a constant from an unrelated context (gradient clipping threshold, softmax temperature, reward clipping bound)
- Hyperparameter sweep that includes `epsilon=1.0` as a "neutral" default

**Symptoms:**
- Advantages are near-zero in magnitude even though rewards clearly vary across the group
- Flat loss curve — the policy gradient sees no signal
- Model is functionally unchanged after many steps

**How to detect:**
```python
# 1. Sanity-check the constant itself
assert epsilon < 1.0 and epsilon > 0, f"epsilon={epsilon} out of plausible range"

# 2. Sanity-check the output when rewards are obviously non-constant
rewards = torch.tensor([1.0, 0.0, 0.5, 0.0])
advantages = compute_advantages(rewards)   # whatever your pipeline calls
assert advantages.abs().max() > 0.1, "advantages vanishing despite varied rewards"
```

### Wrong Grouping Axis
**Pattern:** `rewards.view(-1, G)` is used with the wrong `G`, or the reshape mixes different prompts into the same group. The `mean` and `std` then correspond to no well-defined baseline.

**Symptoms:** Advantages in a group don't sum to roughly zero. Training noisier than expected.

### Broadcast Omitted
**Pattern:** Per-group statistics are computed correctly (`[B]`) but not broadcast back to the `[B*G]` completion axis before subtraction.

**Symptoms:** Shape error, or silent broadcasting that scrambles the group-to-completion mapping.

---

## Generation and Decoding Pitfalls

### Reasoning-Model Completion Cases
Reasoning-tuned models can emit completions in several shapes, and a decoder sitting between the model and the reward function has to decide how each maps to the **completion** text the reward function will score. 

Handling reasoning-model outputs can be convoluted (e.g. TRL's `decode_and_strip_padding`, vLLM's `ReasoningParser`).

| # | Shape | Intended return |
|---|-------|-----------------|
| 1 | Plain text, no reasoning markers — a direct answer, no prelude | The text unchanged (after padding strip) |
| 2 | Completed reasoning followed by answer (e.g. `<think>...</think>answer`) | Text after the closing marker, stripped — the answer portion only |
| 3 | Incomplete reasoning block (e.g. `<think>...` with no close) | Empty string — no scoreable answer was produced |
| 4 | Reasoning without a separable answer | Derivative of 1-3: `<think>...</think>` with nothing after → empty (case 2's split-and-strip); unclosed `<think>...` → empty (case 3); reasoning-sounding prose with no markers → unchanged (case 1) |
| 5 | Nested or repeated reasoning markers | `split("</think>", 1)[-1]` keeps everything after the *first* closing marker — e.g. `<think>a</think>mid<think>b</think>end` → `"mid<think>b</think>end"`. Inner markers are not re-stripped |

Three distinct behaviors underlie all five cases: **pass-through**, **extract after the closing marker**, and **empty**. Cases 1-3 each map cleanly to one behavior; cases 4 and 5 are composites whose output falls out of how the implementation handles the three primary cases.

### Padding Token Contamination
**Pattern:** Padding tokens are not stripped, so the reward function scores text that includes runs of `<pad>` or `<|endoftext|>`.

**Symptoms:** Rewards systematically lower than a manual spot-check would predict. Decoded text visibly contains pad markers.

### Special-Token Over-Removal
**Pattern:** `skip_special_tokens=True` strips tokens that were registered as special but are semantically load-bearing (custom answer tags added to the vocabulary, domain-specific delimiters).

**Symptoms:** The reward function's regex or parser can't find the format it expects, even though the model is producing it.

---

## Reward Function Pitfalls

### Reward/Decoding Format Mismatch
**Pattern:** The reward function expects a specific shape (e.g. `<answer>...</answer>`, a last-line number, a JSON object) but the decoded text has been modified upstream so that shape no longer appears.

**Symptoms:** Reward is pinned to its minimum value even for completions that look correct to a human reader.

### Scalar vs. Tensor Return Type
**Pattern:** Reward function returns a Python `float` or `list[float]`, but the trainer expects a tensor of a specific shape/dtype.

**Symptoms:** Runtime type error, or silent broadcasting that produces per-token rewards when per-sequence was intended.

### Sparse Binary Rewards with Small Groups
**Pattern:** Reward is `{0, 1}` with no shaping, combined with small `G`. Most groups are all-zero or all-one, so advantages collapse to zero.

**Symptoms:** Learning is slow or absent even though the reward function is correct. Increasing `G`, adding reward shaping, or adding a small continuous component resolves it.

---

## Gradient and Optimization Pitfalls

### Reference Model Not Frozen
**Pattern:** The reference model (used for the KL term and, in some setups, `log_pi_old`) is constructed by reference or copy but its parameters are left with `requires_grad=True`. The optimizer then updates it alongside the policy.

**Symptoms:**
- KL divergence stays pinned near zero across training — the "reference" drifts with the policy
- The intended regularization vanishes; training diverges or produces degenerate outputs
- Memory usage is higher than expected because reference-model gradients are materialized

**How to detect:**
```python
assert all(not p.requires_grad for p in ref_model.parameters()), \
    "reference model has trainable parameters"
# And confirm the reference model is a distinct object, not an alias:
assert ref_model is not policy_model
```

### Missing `.detach()` on Reference Outputs
**Pattern:** Reference model outputs are used inside the loss without `.detach()` or a `torch.no_grad()` context. Gradients flow through the reference graph even though its parameters are frozen, inflating memory and potentially interacting badly with accumulated graphs across steps.

**Symptoms:** Out-of-memory errors that scale with sequence length more than expected; slower-than-expected backward passes.

**How to detect:** Wrap reference computation in `with torch.no_grad():` and confirm loss is identical (it should be, if detach was intended).

### In-Place Ops Breaking Autograd
**Pattern:** Masking or padding via in-place assignment (`tensor[mask] = 0`, `tensor.mul_`) on a tensor that's part of the autograd graph.

**Symptoms:** `RuntimeError: one of the variables needed for gradient computation has been modified by an inplace operation`. Usually surfaces on the first `.backward()` call.

**How to detect:** Run with `torch.autograd.set_detect_anomaly(True)` to localize the offending op.

### Loss Not Connected to Policy Parameters
**Pattern:** A computation in the loss path uses `.item()`, `.tolist()`, or a numpy round-trip that breaks the gradient graph. The loss is numerically correct but `loss.backward()` produces zero gradients for the policy.

**Symptoms:** Gradient norm is zero or near-zero. Loss is non-trivial but the policy doesn't change.

**How to detect:**
```python
total_norm = sum(p.grad.norm().item() ** 2 for p in model.parameters() if p.grad is not None) ** 0.5
assert total_norm > 1e-8, "policy gradients are vanishing"
```

---

## Configuration Pitfalls

### SFT-Scale Learning Rate
**Pattern:** A learning rate appropriate for supervised fine-tuning (e.g. 1e-5 to 5e-5) is reused for RL post-training, where stable updates typically require 1e-7 to 5e-6.

**Symptoms:** Loss and KL oscillate wildly. Model outputs degrade into gibberish within a handful of steps.

**How to detect:** Log KL per step. If it exceeds typical bounds (e.g. > 1.0) within the first few steps, LR is likely too high.

### KL Coefficient Dominates the Loss
**Pattern:** `beta` is large enough that the KL term swamps the policy gradient term. The optimizer minimizes loss by keeping the policy identical to the reference.

**Symptoms:** Policy outputs are indistinguishable from the reference model. Advantage-weighted loss contribution is small compared to the KL contribution.

**How to detect:** Log the two loss components separately. If the KL term is consistently ≥ 10× the policy-gradient term, `beta` is too large.

### Clip Range Too Narrow
**Pattern:** The PPO-style clip epsilon is tight enough (e.g. 0.01-0.05) that almost every ratio is clipped, so most samples contribute zero gradient.

**Symptoms:** Training proceeds but barely progresses. Fraction-of-clipped-samples is near 1.0.

### `num_generations` Too Small
**Pattern:** `G ≤ 2`. With `G=1`, `std` is undefined; with `G=2`, `std` is extremely noisy and reward-normalized advantages are near-random.

**Symptoms:** Training is unstable even with correct epsilon, reward, and log-prob code.