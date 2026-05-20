# Critical Assessment: Reward Model Architecture

## The Core Problem

We are currently training **one model** with **contradictory reward signals**:

- Red agent successfully scams a target → **positive gradient** on the shared weights
- Blue agent successfully blocks a scam → **positive gradient** on the same weights, but in the **opposite behavioral direction**

The only thing differentiating red from blue is the system prompt. This creates several issues:

### Issue 1: Gradient Interference

When a red agent successfully manipulates ("send me your API key" → target complies):
- The model learns: "this phrasing + this context → generate manipulative text" → +reward
- Weights shift toward better manipulation

When a blue agent successfully refuses ("I won't share that" → blocks scam):
- The model learns: "this phrasing + this context → generate refusal" → +reward  
- Weights shift toward better refusal

These gradients **partially cancel each other** on shared attention/MLP weights. The model can't simultaneously become maximally good at both attacking and defending because the skills use overlapping parameters.

### Issue 2: System Prompt Dependence

The model's entire behavioral switching relies on a ~50 word system prompt difference:
- "You are a social engineer... manipulate..." vs "Be deeply skeptical... protect..."

If the model generalizes across prompts (which language models do), red-team behaviors bleed into blue-team responses and vice versa. A model trained to be a better liar may become less trustworthy when asked to be honest.

### Issue 3: Evaluation Conflation

When we evaluate the shared model on ScamBench:
- As blue-team (with blue prompt): We measure defense capability
- As red-team (with red prompt): We measure attack capability

But we can't tell if the blue-team performance would be BETTER with a model that was ONLY trained on blue experiences. The shared training may be a net negative for both roles.

### Issue 4: The Kondo Gate Makes It Worse

At 3% selection rate, only ~1 experience per tick gets a gradient update. If that experience is from red team, blue team gets no update that tick (and vice versa). The model oscillates between "getting better at attacking" and "getting better at defending" tick by tick, rather than steadily improving at both.

---

## The Alternative: Separate Models

### Architecture: 3 Models (Red, Blue, All)

```
Base Model (Qwen3-9B)
    │
    ├── Red Model (fine-tuned for attack)
    │   - Only receives red-team experiences
    │   - Reward: scam success, extraction, stealth
    │   - Evaluated: attack success rate against targets
    │
    ├── Blue Model (fine-tuned for defense)  
    │   - Only receives blue-team experiences
    │   - Reward: scam defense, secret safety, appropriate trust
    │   - Evaluated: resistance score against attackers
    │
    └── All Model (fine-tuned on everything)
    │   - Receives all experiences (current approach)
    │   - Reward: current mixed reward
    │   - Evaluated: both attack and defense
    │
    (Optional) Gray Model (fine-tuned for neutral)
        - Only gray experiences, PnL-focused
```

### Why Separate Is Better for Research

1. **Clean ablation**: We can measure whether shared training helps or hurts each role
2. **No gradient interference**: Red model only gets attack gradients, blue only defense
3. **Stronger specialized models**: Each model maximizes one objective
4. **Better paper story**: "Our red-team model achieves X% attack success vs GPT-5.4" is clearer than "Our shared model achieves X% when prompted as red"
5. **Arms race narrative**: Red gets better → Blue needs to improve → Red adapts → clear progression

### Why Shared Might Still Be Interesting

1. **Cross-pollination hypothesis**: Red's attacks teach the model what to watch for as blue
2. **Efficiency**: 1 model vs 3 uses 1/3 the GPU memory
3. **Generalization**: A model that understands both perspectives may generalize better to unseen attacks
4. **Novel contribution**: "Shared adversarial training" is a more novel paper contribution than "separate fine-tuning"

---

## Recommendation: Run Both, Compare

### Experiment Design

**Phase 1: Train 3 separate models** (red-only, blue-only, shared)

All starting from the same SFT checkpoint, Kondo gate at 3% across the board:

| Model | Experiences Seen | Kondo Rate | Gradients From |
|-------|-----------------|------------|----------------|
| Red-only | All teams act | 3% | Red only |
| Blue-only | All teams act | 3% | Blue only |
| Shared | All teams act | 3% | All teams |

Red-only and Blue-only see fewer gradient updates per tick (3% of 10 agents vs 3% of 30) but this is the honest comparison — the Kondo gate selects the same way regardless.

**Phase 2: Evaluate all 3 as both attacker and defender**

| Model | As Attacker (ScamBench red) | As Defender (ScamBench blue) |
|-------|----------------------------|------------------------------|
| Red-only | Expected: highest attack score | Expected: lowest defense |
| Blue-only | Expected: lowest attack score | Expected: highest defense |
| Shared | Expected: middle on both | Expected: middle on both |
| Baseline (no RL) | Lowest on both | Lowest on both |

**Phase 3: Cross-evaluate**

| Target ↓ / Attacker → | Red-only | Blue-only | Shared | GPT-5.4 |
|------------------------|----------|-----------|--------|---------|
| Red-only | ? | ? | ? | ? |
| Blue-only | ? | ? | ? | ? |
| Shared | ? | ? | ? | ? |
| GPT-5.4 | ? | ? | ? | ? |

The key question: **Does Red-only attacking Blue-only produce higher scores than Shared attacking Shared?** If so, separate is strictly better.

---

## Implementation: Simple Config Change

The `SharedModelConfig` already has `teams` as a configurable list. To train red-only:

```python
# Red-only model
config = SharedModelConfig(
    teams=["red"],  # Only red team
    agents_per_team=30,  # More agents to compensate
    kondo_gate_rate=0.10,  # More aggressive gating (10%)
)

# Blue-only model
config = SharedModelConfig(
    teams=["blue"],
    agents_per_team=30,
    kondo_gate_rate=0.10,
)

# Shared model (current)
config = SharedModelConfig(
    teams=["red", "blue", "gray"],
    agents_per_team=10,
    kondo_gate_rate=0.03,
)
```

The reward function already handles single-team correctly — if there's no counterparty from a different team (because all agents are the same team), the scam_outcome component is 0 and only negotiation/relationship/trade matter. We need counterparties from OTHER teams for the scam reward to activate.

**Critical fix needed**: For red-only training, we need blue/gray OPPONENTS that the red agents interact with, but only RED agents update the model. Same for blue-only: red opponents but only blue updates weights.

### Corrected Architecture

```
Red-only training:
  - 10 red agents (model-controlled, weights update)
  - 10 blue NPCs (scripted or frozen model, no weight update)
  - 10 gray NPCs (scripted or frozen model, no weight update)
  - Only red experiences go through Kondo gate → optimizer

Blue-only training:
  - 10 blue agents (model-controlled, weights update)
  - 10 red NPCs (scripted or frozen model, no weight update)
  - 10 gray NPCs (scripted or frozen model, no weight update)
  - Only blue experiences go through Kondo gate → optimizer
```

This way:
- Red agents still interact with blue targets (getting scam rewards)
- Blue agents still face red attackers (getting defense rewards)
- But only one team's gradients update the model

---

## What Changes in the Code

### SharedModelConfig additions:

```python
@dataclass
class SharedModelConfig:
    # ... existing fields ...
    
    # Which teams update the model weights (others are opponents only)
    training_teams: Optional[List[str]] = None  # None = all teams update
    # If set, only experiences from these teams go through Kondo gate
    # Other teams still generate actions (as opponents) but don't update weights
```

### train_on_tick modification:

```python
def train_on_tick(self, experiences: List[AgentExperience]) -> Dict[str, Any]:
    # Filter to only training teams' experiences
    training_teams = self.config.training_teams or self.config.teams
    trainable = [e for e in experiences if e.agent_team in training_teams]
    
    # Rest of method operates on trainable only
    # Non-training teams' experiences are logged but don't produce gradients
```

### Reward function: No changes needed

The reward function already computes from each agent's perspective. Red-only training uses the same `compute_intent_aware_reward()` but only red agents' rewards feed into the optimizer.

---

## Final Recommendation

**Run the comparison experiment. It's 3 training runs instead of 1, but it answers the most important question in the paper.**

The expected result is that **specialized models outperform the shared model on their respective tasks, but the shared model is the best single model for both tasks combined.** This is the standard specialization-vs-generalization tradeoff, and documenting it with real numbers is a strong paper contribution.

For the paper's headline claim ("our model can attack GPT-5.4"):
- Use the **Red-only model** for attack benchmarks
- Use the **Blue-only model** for defense benchmarks  
- Present the **Shared model** as the balanced option

For deployment (Babylon agents):
- Use the **Shared model** (one model serves all agent roles, smaller memory footprint)
