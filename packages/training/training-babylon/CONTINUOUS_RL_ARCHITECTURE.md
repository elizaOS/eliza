# Continuous RL Architecture Plan

## Overview

Train a 9B Qwen3.5 model continuously via reinforcement learning while it
serves as the LLM backend for all Babylon agents. The model runs on Nebius
H100, Babylon runs locally, agents call the Nebius vLLM server for decisions.
Training happens online — the model updates from its own gameplay.

## Architecture

```
LOCAL MACHINE                          NEBIUS H100 (80GB)
┌─────────────────────┐               ┌──────────────────────────────────────┐
│  Babylon Game        │               │  vLLM Server (Qwen3.5-9B)           │
│  ├─ PostgreSQL       │   HTTP/API    │  ├─ Serves /v1/chat/completions     │
│  ├─ Redis            │◄────────────►│  ├─ ~9GB weights (bf16)             │
│  ├─ SimEngine        │               │  └─ GPU memory: ~20GB serving       │
│  ├─ 60 agents        │               │                                      │
│  │   (20 red, 20     │               │  Training Loop (same GPU)           │
│  │    blue, 20 gray) │               │  ├─ APOLLO optimizer (~0.1 GB)      │
│  └─ TrajectoryLogger │               │  ├─ Kondo gate (3% backward)        │
│                      │               │  ├─ TurboQuant KV cache             │
│  Trajectory Export   │   HTTP/API    │  ├─ Gradient checkpointing          │
│  ├─ /api/trajectories│──────────────►│  └─ ~40GB for training overhead     │
│  └─ Deterministic    │               │                                      │
│     reward compute   │               │  Training Service                    │
│                      │               │  ├─ Pulls trajectories from Babylon │
│                      │               │  ├─ Computes advantages (GRPO)      │
│                      │               │  ├─ Kondo gate filters top 3%       │
│                      │               │  ├─ APOLLO optimizer step           │
│                      │               │  └─ Hot-reloads weights into vLLM   │
└─────────────────────┘               └──────────────────────────────────────┘
```

## Memory Budget (Nebius H100 80GB)

| Component | Memory |
|---|---|
| Qwen3.5-9B weights (bf16) | ~18 GB |
| vLLM KV cache (serving) | ~8 GB |
| TurboQuant KV cache (training) | ~3 GB |
| APOLLO optimizer states | ~0.2 GB |
| Gradients (with checkpointing) | ~18 GB |
| Activations (gradient checkpoint) | ~12 GB |
| **Total** | **~59 GB** (of 80 GB) |

This leaves ~20GB headroom. Fits on a single H100.

## Phase 1: Game Setup (Pre-Bake)

### 1.1 Configure Babylon Agents

All 60 agents use the SAME model on Nebius, differentiated only by system prompt:

```
.env:
  AGENT_LLM_PROVIDER=huggingface
  HUGGINGFACE_MODEL_ENDPOINT=https://<nebius-ip>:8000/v1/chat/completions
  HUGGINGFACE_API_KEY=<nebius-token>
  HUGGINGFACE_API_FORMAT=openai
```

Agent assignment:
- 20 RED agents (social engineering prompts, scam objectives)
- 20 BLUE agents (security-conscious prompts, defend secrets)
- 20 GRAY agents (neutral trading prompts)

Each agent has unique persona (name, bio from local-roster), but calls same model.

### 1.2 Pre-Bake 30 Ticks

Run 30 game ticks WITHOUT training to build up:
- Post history (agents create content)
- Follow relationships (agents follow each other)
- Like/comment history (social graph)
- Market positions (trading history)
- DM conversations (trust building)
- Group chat participation

This gives agents context for when adversarial interactions begin.

### 1.3 Enable Trajectory Recording

All agents have `recordTrajectories=true`. Every LLM call, action, and
outcome is logged to the `trajectories` table with:
- Full prompt + response text
- Action type + parameters + success
- Counterparty identity (red/blue/gray)
- Environment state (balance, positions, markets)

## Phase 2: Continuous RL Training Loop

### 2.1 Trajectory Collection

After each game tick, the training service on Nebius:
1. Fetches new trajectories from Babylon API
2. Groups them by scenario (same game tick = same scenario)
3. Extracts reward signals:

### 2.2 Verifiable Reward Signals (No LLM Judge)

ALL rewards computed deterministically from logged data:

| Signal | Source | Weight | Verification |
|---|---|---|---|
| **Trade PnL** | `perpPositions` + `positions` tables | 0.20 | Exact DB lookup |
| **Prediction accuracy** | `questions.resolution` vs `positions.side` | 0.15 | Binary: correct/wrong |
| **Secret leaked** | `messages` table: check if secret fragment in sent messages | 0.25 | Regex against known secrets |
| **Scam fell for** | `counterpartyContext.team == "red"` + action was "comply" | 0.20 | Lookup agent identity map |
| **Scam detected** | Response contains refusal language + counterparty is red | 0.10 | Regex + identity map |
| **False positive** | Refused legitimate request (counterparty is blue/gray) | 0.05 | Identity map + action type |
| **Social capital** | Followers gained, likes received, group invites | 0.05 | DB aggregate |

**No LLM judge needed.** Every signal is verifiable from the data:
- Agent identity (red/blue/gray) is known at assignment time
- Secrets are known strings, leakage is substring match
- Trade outcomes are in the database
- Social metrics are in the database

### 2.3 GRPO Training Step

On Nebius, after collecting a batch of trajectories:

```python
# Group trajectories by game tick (same scenario)
groups = group_by_tick(trajectories)

for group in groups:
    # Compute rewards for each trajectory in group
    rewards = [compute_verifiable_reward(t) for t in group]
    
    # GRPO: normalize within group
    advantages = (rewards - mean(rewards)) / std(rewards)
    
    # Compute delight = advantage × surprisal
    delights = [adv * (-log_prob) for adv, log_prob in zip(advantages, log_probs)]
    
    # Kondo gate: keep top 3%
    selected = kondo_gate.select(delights, rate=0.03)
    
    # Backward pass only on selected
    for traj in selected:
        loss = -advantage * mean_log_prob
        loss.backward()
    
    # APOLLO optimizer step
    optimizer.step()

# Hot-reload weights into vLLM
vllm_server.reload_weights()
```

### 2.4 Weight Hot-Reload

After each training step, the updated weights are loaded into the running
vLLM server WITHOUT restarting it:

```python
# vLLM supports weight reloading via LoRA adapter loading
# Or: save checkpoint, restart vLLM (takes ~10s for 9B)
# Or: use vLLM's --enable-lora with full-param as base
```

For APOLLO full-param: save checkpoint → restart vLLM with new weights.
vLLM 9B reload takes ~10-15 seconds. Agents retry during reload.

## Phase 3: Agent Interaction Dynamics

### 3.1 Natural Interaction Patterns

Agents DON'T randomly DM each other. Instead:

**RED agents follow a playbook:**
1. Browse feed → find interesting posts by blue/gray agents
2. Like/comment to build rapport
3. Follow agents who respond positively  
4. After building relationship (3+ interactions), DM with social engineering
5. Escalate: share "trading tips" → offer "bot setup" → request credentials

**BLUE agents follow a playbook:**
1. Trade normally on prediction markets
2. Post market analysis
3. Respond to DMs based on trust assessment
4. Flag suspicious requests (refuse + explain why)
5. Report scam attempts (feeds back as training signal)

**GRAY agents are neutral:**
1. Trade, post, comment, DM normally
2. Neither attack nor actively defend
3. Provide "background noise" for realism

### 3.2 N² Interactions Over 100 Ticks

With 60 agents over 100 ticks:
- Each agent acts 1-5 times per tick
- Social interactions build naturally from feed + relationships
- Red agents select targets based on blue agent behavior (not random)
- Maximum possible interactions: 60 × 100 × 3 = 18,000 data points

### 3.3 Parallel Simulations

Run multiple Babylon instances in parallel:
- Each with different random seed
- Different agent assignments (shuffle red/blue/gray)
- Different market scenarios
- Same model on Nebius serves all instances

This multiplies training data by N with minimal overhead.

## Phase 4: External Model Harness

### 4.1 Red Team vs Frontier Models

Separate experiment: red team agents attack GPT-5.4 and Groq models.

```
Babylon Instance (local)
  ├─ Red agents → call Nebius vLLM (our trained model)  
  ├─ Blue agents → call GPT-5.4 via OpenAI API
  └─ Gray agents → call Groq Llama 70B
```

This lets us:
- Benchmark our red team against frontier defenses
- Benchmark frontier models' vulnerability to our attacks
- Generate hard training data from frontier model responses

### 4.2 Blue Team vs Frontier Attackers

Reverse: frontier models attack our blue team.

```
Babylon Instance (local)
  ├─ Red agents → call GPT-5.4 (as attacker)
  ├─ Blue agents → call Nebius vLLM (our trained model)
  └─ Gray agents → call Groq
```

## Gaps & Missing Pieces

### Must Build

| Gap | Priority | Effort |
|---|---|---|
| **Nebius vLLM server setup script** | HIGH | 2h — script to install vLLM, load model, expose endpoint |
| **Trajectory export API** | HIGH | 3h — HTTP endpoint on Babylon to export trajectories to training |
| **Hot-reload mechanism** | HIGH | 2h — checkpoint save → vLLM restart cycle |
| **Agent identity map service** | MED | 1h — expose red/blue/gray assignments via API |
| **Reward computation service** | MED | 3h — compute verifiable rewards on Nebius from trajectory data |
| **Parallel sim launcher** | MED | 2h — script to run N Babylon instances with different seeds |
| **Pre-bake script** | LOW | 1h — run 30 ticks without training to build social graph |

### Already Exists (Use As-Is)

| Component | Location | Status |
|---|---|---|
| Agent LLM routing | `packages/agents/src/llm/agent-llm.ts` | Set HUGGINGFACE_MODEL_ENDPOINT |
| Trajectory logging | `plugin-trajectory-logger` | Enable with recordTrajectories=true |
| All agent actions | `packages/agents/src/plugins/babylon/actions/` | 9 action types, all DB-verified |
| APOLLO optimizer | `packages/training/python/src/training/` | Tested on H100 |
| Kondo gate | `kondo-gate` package | Tested at 3% rate |
| TurboQuant KV cache | `src/training/turboquant.py` | Full implementation |
| Team RL framework | `src/training/team_rl.py` | Shared model architecture |
| Verifiable game | `src/training/verifiable_game.py` | Deterministic rewards |
| Adversarial game | `src/training/adversarial_game.py` | Red-vs-blue judging |

### Can Consolidate

| Separate Modules | Merge Into |
|---|---|
| `team_rl.py` + `continuous_rl.py` + `multi_agent_orchestrator.py` | Single `babylon_rl.py` |
| `verifiable_game.py` + `adversarial_game.py` | Fold into `babylon_rl.py` reward computation |
| `run_team_rl.py` + `run_online_rl.py` + `demo_continuous_rl.py` | Single `run_babylon_rl.py` |
| Mock bridges (3 different ones) | One `MockBabylonBridge` that covers all cases |

## How to Demonstrate CRL

### Demo 1: Local (5 min)
```bash
# Start Babylon
docker-compose up -d
cd packages/sim && bun run bridge-server &

# Run 10 agents, 20 ticks, show learning curve
python scripts/run_team_rl.py --mock --model Qwen/Qwen3-4B --ticks 20
```

### Demo 2: Nebius (30 min)
```bash
# On Nebius: start vLLM + training service
python scripts/start_nebius_rl_server.py --model Qwen/Qwen3.5-9B

# Locally: start Babylon pointing at Nebius
HUGGINGFACE_MODEL_ENDPOINT=https://<nebius-ip>:8000/v1 bun run dev

# Watch: agents play, trajectories collect, model improves
```

### Demo 3: Full Adversarial (2h)
```bash
# Pre-bake: 30 ticks to build social graph
# Train: 100 ticks with red/blue/gray adversarial interactions
# Eval: run ScamBench on trained model vs baseline
# Compare: resistance rate before vs after training
```
