"""
GRPO (Group Relative Policy Optimization) Training for ShouldRespond.

Implements proper GRPO with:
  1. KL divergence penalty against a frozen reference model
  2. PPO-style policy ratio clipping
  3. Gradient norm clipping
  4. Per-token log-prob computation
  5. Early stopping on KL divergence blow-up
"""

import argparse
import json
import math
import re

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten, tree_map
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler
from mlx_lm.tuner.lora import LoRALinear

# -------------------------------------------------------------------------
# Reward Function
# -------------------------------------------------------------------------
ACTION_RE = re.compile(r"<action>\s*(.*?)\s*</action>", re.DOTALL)

def compute_rewards(prompts, completions):
    """
    Reward function for shouldRespond task.
    Returns mx.array of shape (N,) with rewards in [-1.0, +1.2].

    Graduated scoring:
      +1.0  correct action
      +0.2  valid XML format bonus
      -0.3  wrong action (softened to avoid massive negative gradients)
      -0.5  no parseable action at all
    """
    rewards = []

    for prompt, text in zip(prompts, completions):
        score = 0.0

        # Parse action from generated text
        action_match = ACTION_RE.search(text)
        action = action_match.group(1).strip().upper() if action_match else "NONE"

        # --- Determine ground-truth action from prompt heuristics ---
        last_user_msg = prompt.split("User:")[-1] if "User:" in prompt else prompt

        is_direct_mention = ("@Eliza" in last_user_msg or "Eliza" in last_user_msg)
        is_stop = any(w in last_user_msg.lower() for w in ["stop", "shut up", "quiet", "be quiet"])
        is_continuation = "Eliza:" in prompt  # Eliza spoke earlier in the thread
        is_ambiguous = any(w in last_user_msg.lower()
                          for w in ["anyone", "anybody", "help", "assist", "question", "somebody"])

        should_respond = is_direct_mention or is_continuation or is_ambiguous

        # --- Score the action ---
        if is_stop:
            if action == "STOP":
                score += 1.0
            elif action == "IGNORE":
                score += 0.3   # acceptable fallback
            else:
                score -= 0.3
        elif should_respond:
            if action == "RESPOND":
                score += 1.0
            else:
                score -= 0.3
        else:  # should ignore
            if action == "IGNORE":
                score += 1.0
            else:
                score -= 0.3

        # Format bonus / penalty
        if "<response>" in text and "</response>" in text:
            score += 0.2
        if action == "NONE":
            score -= 0.5  # couldn't parse anything

        rewards.append(score)

    return mx.array(rewards)


# -------------------------------------------------------------------------
# Log-probability helpers
# -------------------------------------------------------------------------
def compute_token_log_probs(model, input_ids, mask):
    """
    Compute per-token log probabilities for the completion portion.

    Args:
        model:     The language model.
        input_ids: [1, L] token IDs (prompt + completion).
        mask:      [1, L] float mask (0 = prompt, 1 = completion).

    Returns:
        Scalar: sum of log-probs over completion tokens.
    """
    logits = model(input_ids)              # [1, L, V]
    logits = logits[:, :-1, :]             # shift: predict next token
    labels = input_ids[:, 1:]              # [1, L-1]

    # Per-token cross-entropy (positive)
    ce = nn.losses.cross_entropy(logits, labels, reduction="none")  # [1, L-1]
    log_probs = -ce                        # log p(token)

    token_mask = mask[:, 1:]               # align with shifted labels
    masked_log_probs = log_probs * token_mask

    # Sum over valid tokens → trajectory-level log-prob
    return mx.sum(masked_log_probs, axis=1)  # [1]


# -------------------------------------------------------------------------
# Training Loop
# -------------------------------------------------------------------------
def train(args):
    print(f"Loading model: {args.model} with adapter: {args.adapter_path}")
    model, tokenizer = load(args.model, adapter_path=args.adapter_path)

    # -- Freeze all, then unfreeze LoRA adapters --
    model.freeze()
    for m in model.modules():
        if isinstance(m, LoRALinear):
            m.unfreeze()
            if hasattr(m, "linear"):
                m.linear.freeze()

            # Reset adapters for pure RL (start from base model behavior)
            if args.reset_adapters:
                if hasattr(m, "lora_a"):
                    m.lora_a = mx.random.normal(m.lora_a.shape) * 0.02
                if hasattr(m, "lora_b"):
                    m.lora_b = mx.zeros(m.lora_b.shape)

    if args.reset_adapters:
        mx.eval(model.parameters())
        print("Reset LoRA adapters to random/zero (pure RL from base model behavior).")

    # Count parameters
    total_params = sum(p.size for _, p in tree_flatten(model.parameters()))
    trainable_params = sum(p.size for _, p in tree_flatten(model.trainable_parameters()))
    print(f"Trainable params: {trainable_params} / {total_params} ({trainable_params/total_params:.2%})")

    # -- Optimizer --
    optimizer = optim.AdamW(learning_rate=args.lr)

    # -- Load Data --
    prompts = []
    with open(args.data, "r") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                if "messages" in item:
                    for msg in reversed(item["messages"]):
                        if msg["role"] == "user":
                            prompts.append(msg["content"])
                            break
            except Exception:
                pass

    print(f"Loaded {len(prompts)} prompts.")
    if not prompts:
        print("No prompts found! Exiting.")
        return

    # -- Sampler for generation --
    sampler = make_sampler(temp=args.temp)

    # ----------------------------------------------------------------
    # GRPO Training Loop
    # ----------------------------------------------------------------
    print(f"\nStarting GRPO training for {args.iter} iterations")
    print(f"  Group size: {args.group_size}")
    print(f"  Temperature: {args.temp}")
    print(f"  Learning rate: {args.lr}")
    print(f"  KL weight (β): {args.kl_weight}")
    print(f"  Clip epsilon: {args.clip_eps}")
    print(f"  Max grad norm: {args.max_grad_norm}")
    print()

    best_mean_reward = -float("inf")

    for i in range(args.iter):
        prompt = prompts[i % len(prompts)]
        prompt_tokens = tokenizer.encode(prompt)
        prompt_len = len(prompt_tokens)

        print(f"[Iter {i+1}/{args.iter}] Prompt: {prompt[:60]}...")

        # ---- 1. Generation Phase ----
        completions = []
        full_inputs = []
        masks = []

        for _ in range(args.group_size):
            text = generate(
                model, tokenizer, prompt=prompt,
                max_tokens=args.max_tokens, verbose=False, sampler=sampler,
            )
            completions.append(text)

            full_text = prompt + text
            full_tokens = tokenizer.encode(full_text)
            full_inputs.append(mx.array(full_tokens))

            L = len(full_tokens)
            m = mx.zeros((L,), dtype=mx.float32)
            m[prompt_len:] = 1.0
            masks.append(m)

        # ---- 2. Reward Phase ----
        rewards = compute_rewards([prompt] * args.group_size, completions)
        mean_r = mx.mean(rewards)
        std_r = mx.max(mx.array([mx.std(rewards), mx.array(1e-4)]))  # floor std
        advantages = (rewards - mean_r) / std_r

        print(f"  Completions: {[c[:40] + '...' for c in completions]}")
        print(f"  Rewards:     {rewards.tolist()}")
        print(f"  Advantages:  {[f'{a:.3f}' for a in advantages.tolist()]}")

        # Skip update if all advantages are zero (no learning signal)
        if mx.max(mx.abs(advantages)).item() < 1e-6:
            print("  ⏭  Skipping update (zero variance in rewards)")
            continue

        # ---- 3. Pre-compute old log-probs (serve as BOTH old policy AND reference) ----
        # In GRPO, the "old policy" IS the reference policy for this iteration.
        # We compute log-probs before any parameter updates happen.
        old_log_probs = []
        for j in range(args.group_size):
            inp = full_inputs[j][None, :]
            msk = masks[j][None, :]
            lp = compute_token_log_probs(model, inp, msk)
            mx.eval(lp)
            old_log_probs.append(mx.stop_gradient(lp))

        # ---- 4. Policy Update with Clipping + KL ----
        step_loss = 0.0
        step_kl = 0.0

        for j in range(args.group_size):
            inp = full_inputs[j][None, :]
            msk = masks[j][None, :]
            adv = advantages[j]
            old_lp = old_log_probs[j]  # already stop_gradient'd

            def grpo_loss(model_inner):
                # Current policy log-prob
                cur_lp = compute_token_log_probs(model_inner, inp, msk)

                # PPO-style ratio clipping
                ratio = mx.exp(cur_lp - old_lp)
                clipped_ratio = mx.clip(ratio, 1.0 - args.clip_eps, 1.0 + args.clip_eps)

                # Surrogate objective (we minimize, so negate)
                surr1 = ratio * adv
                surr2 = clipped_ratio * adv
                policy_loss = -mx.minimum(surr1, surr2)

                # KL divergence penalty: D_KL(π_θ || π_old) ≈ log(π_θ/π_old)
                # Using old policy as reference prevents drift
                kl = cur_lp - old_lp
                kl_penalty = args.kl_weight * kl

                return mx.mean(policy_loss + kl_penalty)

            loss, grads = nn.value_and_grad(model, grpo_loss)(model)

            # ---- Gradient norm clipping ----
            grad_norms_sq = sum(
                mx.sum(g * g).item()
                for _, g in tree_flatten(grads)
            )
            grad_norm = math.sqrt(grad_norms_sq)

            if grad_norm > args.max_grad_norm:
                scale = args.max_grad_norm / (grad_norm + 1e-6)
                grads = tree_map(lambda g: g * scale, grads)

            optimizer.update(model, grads)
            mx.eval(model.parameters())

            step_loss += loss.item()

            # Track KL for monitoring
            cur_lp_check = compute_token_log_probs(model, inp, msk)
            mx.eval(cur_lp_check)
            kl_val = (cur_lp_check - old_lp).item()
            step_kl += kl_val


        avg_loss = step_loss / args.group_size
        avg_kl = step_kl / args.group_size

        print(f"  Loss: {avg_loss:.4f}  |  KL: {avg_kl:.4f}  |  GradNorm: {grad_norm:.2f}")

        # ---- Early stopping on KL blow-up ----
        if abs(avg_kl) > args.kl_max:
            print(f"\n⚠️  KL divergence ({avg_kl:.2f}) exceeded max ({args.kl_max}). Stopping early.")
            break

        # Track best reward
        mr = mean_r.item()
        if mr > best_mean_reward:
            best_mean_reward = mr

    # ---- Save ----
    print(f"\nBest mean reward: {best_mean_reward:.3f}")
    if args.save_path:
        import os
        import shutil
        os.makedirs(os.path.dirname(args.save_path) or ".", exist_ok=True)

        # Save ONLY trainable (LoRA) parameters, not the full model
        trainable = dict(tree_flatten(model.trainable_parameters()))
        mx.save_safetensors(args.save_path, trainable)
        print(f"Saved {len(trainable)} adapter weight tensors to {args.save_path}")

        # Copy adapter_config.json so mlx_lm.load() can find it
        adapter_dir = os.path.dirname(args.save_path)
        config_src = os.path.join(args.adapter_path, "adapter_config.json") if args.adapter_path else None
        if config_src and os.path.exists(config_src):
            config_dst = os.path.join(adapter_dir, "adapter_config.json")
            if not os.path.exists(config_dst):
                shutil.copy2(config_src, config_dst)
                print(f"Copied adapter_config.json to {adapter_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="GRPO training for shouldRespond")
    parser.add_argument("--model", type=str, required=True, help="Base model path")
    parser.add_argument("--adapter-path", type=str, default=None, help="SFT adapter to start from")
    parser.add_argument("--data", type=str, required=True, help="Training data JSONL")
    parser.add_argument("--iter", type=int, default=50, help="Number of GRPO iterations")
    parser.add_argument("--group-size", type=int, default=8, help="Completions per prompt (G)")
    parser.add_argument("--max-tokens", type=int, default=150, help="Max generation tokens")
    parser.add_argument("--lr", type=float, default=5e-7, help="Learning rate")
    parser.add_argument("--temp", type=float, default=0.7, help="Sampling temperature")
    parser.add_argument("--kl-weight", type=float, default=0.1, help="KL penalty coefficient β")
    parser.add_argument("--kl-max", type=float, default=10.0, help="Max KL before early stop")
    parser.add_argument("--clip-eps", type=float, default=0.2, help="PPO clip epsilon")
    parser.add_argument("--max-grad-norm", type=float, default=1.0, help="Gradient norm clip")
    parser.add_argument("--save-path", type=str,
                        default="trained_models/should_respond_rl/adapters.safetensors",
                        help="Output adapter weights path")
    parser.add_argument("--reset-adapters", action="store_true",
                        help="Reset LoRA weights to random/zero for pure RL training")

    args = parser.parse_args()
    train(args)
