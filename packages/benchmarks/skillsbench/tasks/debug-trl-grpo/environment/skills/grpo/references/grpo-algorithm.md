# GRPO Algorithm — Mathematical Formulation

## Table of Contents
- Overview and Motivation
- Notation
- Algorithm Steps
- Log-Probability Computation
- Advantage Estimation
- Policy Gradient Loss
- KL Divergence Penalty
- Relationship to PPO and REINFORCE

## Overview and Motivation

Group Relative Policy Optimization (GRPO) was introduced by DeepSeek as a variant of PPO that eliminates the need for a learned value function (critic). Instead of estimating advantages via a critic, GRPO computes advantages by comparing rewards within a group of completions sampled for the same prompt.

This simplification:
- Removes the value function training loop entirely
- Reduces memory footprint (no critic model)
- Avoids value function approximation errors
- Is well-suited for reasoning tasks where reward is sparse (correct/incorrect)

## Notation

| Symbol | Meaning |
|--------|---------|
| `pi_theta` | Current policy (the model being trained) |
| `pi_ref` | Reference policy (frozen copy of the initial model) |
| `pi_old` | Policy that generated the current batch (usually = pi_theta from previous step) |
| `x` | Input prompt |
| `y_i` | i-th completion sampled for prompt x |
| `G` | Number of completions per prompt (`num_generations`) |
| `r(x, y_i)` | Reward for completion y_i given prompt x |
| `A_i` | Advantage estimate for completion y_i |
| `beta` | KL penalty coefficient |
| `epsilon` | Clipping parameter for the surrogate objective |

## Algorithm Steps

For each training batch:

### Step 1: Sample Completions
For each prompt `x` in the batch, sample `G` completions from the current policy:
```
y_1, y_2, ..., y_G ~ pi_old(·|x)
```

### Step 2: Compute Rewards
Evaluate each completion with the reward function:
```
r_i = R(x, y_i)    for i = 1, ..., G
```

### Step 3: Compute Group-Relative Advantages
Normalize rewards within each group:
```
A_i = (r_i - mean(r_1, ..., r_G)) / (std(r_1, ..., r_G) + epsilon)
```

Where `epsilon` is a small constant (e.g. 1e-4) for numerical stability. This value must be small enough that it does not materially affect the denominator when `std > 0`.

### Step 4: Compute Per-Token Log Probabilities
For each completion `y_i = (t_1, t_2, ..., t_L)`:
```
log_pi_theta(t_j | x, t_<j) = logit(t_j) - logsumexp(logits)
```

The per-token log probability is the log-softmax of the logit at the selected token position. This is mathematically equivalent to:
```
log_pi(t_j) = log(softmax(logits)[t_j]) = logit(t_j) - log(sum(exp(logits)))
```

**Key property:** Log probabilities are always non-positive, since `softmax(logits)[t_j] in (0, 1]`.

Sequence-level log probability is the sum over tokens:
```
log_pi(y_i | x) = sum_j log_pi(t_j | x, t_<j)
```

### Step 5: Compute Clipped Surrogate Loss
```
rho_i = exp(log_pi_theta(y_i|x) - log_pi_old(y_i|x))

L_clip = min(rho_i * A_i, clip(rho_i, 1-eps, 1+eps) * A_i)
```

### Step 6: Compute KL Penalty
```
KL(pi_theta || pi_ref) = E_y~pi_theta[log_pi_theta(y|x) - log_pi_ref(y|x)]
```

### Step 7: Final Loss
```
L = -E[L_clip] + beta * KL(pi_theta || pi_ref)
```

## Log-Probability Computation — Detail

The standard implementation computes log-softmax via the log-sum-exp trick for numerical stability, producing non-positive per-token log-probabilities. An efficient "selective" variant avoids materializing the full `[batch, seq_len, vocab_size]` log-softmax tensor by only computing log-probs at the selected token indices. The math is identical — verify any implementation against `F.log_softmax` on a small deterministic input.

## Advantage Estimation — Detail

GRPO's group-relative advantage replaces the critic-based advantage in PPO:

```
mu_group = (1/G) * sum(r_i for i in group)
sigma_group = sqrt((1/(G-1)) * sum((r_i - mu_group)^2))
A_i = (r_i - mu_group) / (sigma_group + epsilon)
```

**Properties:**
- Within each group, advantages sum to approximately zero
- High-reward completions get positive advantages, low-reward get negative
- The epsilon prevents division by zero when all rewards in a group are identical

**Failure modes:**
- If the additive epsilon is not small relative to typical `std` values, it dominates the denominator and the advantage signal is washed out — the model then receives no learning signal
- If `G` is too small (e.g. G=1), std is undefined; G=2 gives very noisy estimates
- If the reward function is degenerate (always returns the same value), all advantages are zero regardless of epsilon

## Relationship to PPO and REINFORCE

| Aspect | REINFORCE | PPO | GRPO |
|--------|-----------|-----|------|
| Advantage | Reward - baseline | Critic estimate (GAE) | Group-relative normalization |
| Critic | No | Yes (value head) | No |
| Clipping | No | Yes | Yes |
| KL penalty | Optional | Optional | Yes (typically) |
| Memory | Low | High (critic) | Medium |

GRPO can be seen as PPO with the critic replaced by a batch-statistics baseline, making it closer to REINFORCE with variance reduction through grouping.
