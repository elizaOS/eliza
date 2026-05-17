# TRL Codebase — Detailed Module Guide

## Table of Contents
- Trainer Layer
- Utility Module (trainer/utils.py)
- Models Layer
- Data Utilities
- Configuration Details

## Trainer Layer

### Common Trainer Pattern
Every TRL trainer follows this pattern:
1. Extends `transformers.Trainer` (inherits training loop, checkpointing, logging)
2. Defines a custom `compute_loss` method for its objective
3. Optionally overrides `training_step` for generation-based methods
4. Uses a corresponding `*Config` dataclass for hyperparameters

### SFTTrainer
Standard supervised fine-tuning. Key features:
- Dataset packing (multiple examples per sequence for efficiency)
- Configurable `max_seq_length` and `dataset_text_field`
- Supports instruction-tuning formats via `formatting_func`

### DPOTrainer
Direct Preference Optimization — learns from preference pairs without RL.
- Requires paired (chosen, rejected) examples
- `beta` controls KL constraint strength
- Multiple loss variants: `sigmoid` (default), `hinge`, `ipo`, `kto_pair`
- Can run reference-free (no frozen model needed)

### GRPOTrainer
Group Relative Policy Optimization — see the `grpo` skill for algorithm details.
- Overrides `training_step` to add generation phase
- `_generate_and_score_completions` handles sampling + reward scoring
- `compute_loss` implements clipped surrogate + KL objective

### KTOTrainer
Kahneman-Tversky Optimization — learns from unpaired binary feedback.
- Does not require paired preferences (just good/bad labels)
- `desirable_weight` / `undesirable_weight` control loss asymmetry
- Uses a KL term estimated from a reference model

### OnlineDPOTrainer
Online variant of DPO that generates completions during training.
- Similar generation loop to GRPO
- Pairs completions by reward ranking for DPO-style loss
- Combines benefits of online generation with DPO's stability

## Utility Module (trainer/utils.py)

### `selective_log_softmax`
Memory-efficient per-token log-probability computation. Takes `logits [B, T, V]` and an index tensor `[B, T]`, and returns per-token log-probabilities `[B, T]` — the same values `F.log_softmax(logits, -1).gather(-1, index.unsqueeze(-1)).squeeze(-1)` would produce, without materializing the vocab-sized intermediate tensor.

Used by: GRPOTrainer, DPOTrainer, OnlineDPOTrainer — any trainer needing per-token log probabilities.

Read `trainer/utils.py` directly before modifying. Key invariants the implementation must satisfy are listed in the `rl-post-training` skill.

### `decode_and_strip_padding`
Converts token ID tensors to the text strings passed to the reward function. Handles padding, decoder artefacts, and any reasoning-block conventions the library supports.

Used by: GRPOTrainer, OnlineDPOTrainer — any trainer that generates and decodes completions.

Before changing behavior here, enumerate the completion shapes the model can emit and confirm each is handled; the current policy for complete, incomplete, and absent reasoning blocks is defined in the implementation.

### Padding Utilities
- `pad(tensors, padding_value, padding_side)` — Pad list of variable-length tensors to uniform length
- `pad_to_length(tensor, length, padding_value)` — Pad or truncate to exact length

## Models Layer

### AutoModelForCausalLMWithValueHead
Wraps a causal LM with an additional linear head that outputs scalar values. Used by PPO-style trainers that need a critic (not used by GRPO, DPO, or SFT).

### PreTrainedModelWrapper
Base class for model wrappers that need to modify forward pass behavior while preserving the underlying model's API.

## Data Utilities

### data_utils.py
- `maybe_extract_prompt` — Extracts prompt from conversation-format datasets
- `apply_chat_template` — Applies tokenizer chat template to conversation data
- Dataset formatting helpers for various training paradigms

## Configuration Details

All configs inherit standard `TrainingArguments` fields (learning rate, batch size, gradient accumulation, etc.) and add trainer-specific parameters.

### GRPOConfig Specifics
| Parameter | Typical Value | Purpose |
|-----------|--------------|---------|
| `num_generations` | 4-16 | Completions per prompt for advantage estimation |
| `max_completion_length` | 256-1024 | Max tokens per completion |
| `beta` | 0.01-0.1 | KL penalty coefficient |
| `epsilon` | 0.1-0.2 | Clipping range for surrogate objective |
| `temperature` | 0.7-1.0 | Sampling temperature for generation |
| `reward_functions` | list | Callable reward functions |

### DPOConfig Specifics
| Parameter | Typical Value | Purpose |
|-----------|--------------|---------|
| `beta` | 0.1 | KL constraint strength |
| `loss_type` | "sigmoid" | DPO loss variant |
| `reference_free` | False | Whether to skip reference model |
| `label_smoothing` | 0.0 | Smoothing for preference labels |
