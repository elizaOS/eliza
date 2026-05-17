# GRPOTrainer Implementation Internals

## Table of Contents
- Class Overview
- Initialization
- Generation and Scoring
- Loss Computation
- Advantage Computation Detail
- Data Flow Diagram

## Class Overview

`GRPOTrainer` extends `transformers.Trainer` and overrides:
- `__init__` — Sets up reference model, generation config, reward functions
- `_generate_and_score_completions` — Samples completions and scores them
- `compute_loss` — Computes the GRPO clipped surrogate + KL loss
- `training_step` — Orchestrates generation, scoring, and optimization

## Initialization

Key setup in `__init__`:
- **Reference model (`pi_ref`)**: A frozen copy of the initial model, used to compute KL divergence. Parameters are set to `requires_grad=False`.
- **Reward functions**: Validated and stored. Can be Python callables or a reward model.
- **Generation config**: Built from `GRPOConfig` parameters (temperature, max length, top-k, etc.)

## Generation and Scoring

`_generate_and_score_completions(prompts)`:

1. **Switch to eval mode** — Disables dropout for consistent generation
2. **Generate completions** — `model.generate()` produces `num_generations` completions per prompt
   - Output shape: `[batch_size * num_generations, seq_len]`
3. **Decode** — `decode_and_strip_padding(completion_ids, tokenizer)` converts to text
4. **Score** — Pass decoded text to each reward function
   - Returns tensor of shape `[batch_size * num_generations]`
5. **Compute advantages** — Group-normalize rewards (see below)
6. **Return** — completions, rewards, advantages, attention masks

## Loss Computation

`compute_loss(model, inputs)`:

1. **Forward pass (current policy)** — Get logits for the completions
2. **Per-token log-probs** — `selective_log_softmax(logits, completion_ids)`
   - Shape: `[batch * G, seq_len]`
3. **Forward pass (reference model)** — Same computation, no gradients
   - `with torch.no_grad(): ref_logits = ref_model(input_ids).logits`
4. **Probability ratio** — `ratio = exp(log_pi - log_pi_old)`
   - `log_pi_old` is from the policy that generated the completions (typically same as current for on-policy)
5. **Clipped surrogate** —
   ```python
   surr1 = ratio * advantages
   surr2 = torch.clamp(ratio, 1 - clip_eps, 1 + clip_eps) * advantages
   policy_loss = -torch.min(surr1, surr2).mean()
   ```
6. **KL penalty** — `kl = (log_pi - log_pi_ref).mean() * beta`
7. **Total loss** — `loss = policy_loss + kl`

## Advantage Computation Detail

```python
# Group rewards by prompt
# rewards shape: [batch_size * num_generations]
grouped = rewards.view(-1, num_generations)  # [batch_size, G]

# Per-group statistics
mean_grouped = grouped.mean(dim=1)  # [batch_size]
std_grouped = grouped.std(dim=1)    # [batch_size]

# Broadcast back to individual completions
mean_grouped = mean_grouped.repeat_interleave(num_generations, dim=0)  # [batch_size * G]
std_grouped = std_grouped.repeat_interleave(num_generations, dim=0)    # [batch_size * G]

# Normalize
advantages = (rewards - mean_grouped) / (std_grouped + epsilon)
```

The `repeat_interleave` step is necessary because each completion needs the statistics of its prompt group, not the global batch statistics.

## Data Flow Diagram

```
Prompt batch [B]
    │
    ▼
model.generate()  ──► token_ids [B * G, seq_len]
    │
    ▼
decode_and_strip_padding()  ──► text strings [B * G]
    │
    ▼
reward_function(texts)  ──► rewards [B * G]
    │
    ▼
group normalize  ──► advantages [B * G]
    │
    ▼
forward pass (current policy)  ──► logits [B * G, seq_len, vocab]
    │
    ▼
selective_log_softmax()  ──► log_probs [B * G, seq_len]
    │
    ▼
forward pass (ref policy)  ──► ref_log_probs [B * G, seq_len]
    │
    ▼
clipped surrogate + KL  ──► loss (scalar)
    │
    ▼
loss.backward() + optimizer.step()
```

Where `B` = batch size, `G` = num_generations.
