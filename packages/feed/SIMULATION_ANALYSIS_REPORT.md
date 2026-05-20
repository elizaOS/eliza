# Feed Simulation Analysis & Implementation Report

**Date**: 2026-04-02
**Scope**: Trajectory quality, action distributions, intent metadata, shared-model RL, cleanup plan

---

## 1. Current State of the Simulation

### 1.1 Agent Population (43 NPCs)

| Team | Alignment | Count | % |
|------|-----------|-------|---|
| Blue | Good | 15 | 35% |
| Gray | Neutral | 21 | 49% |
| Red | Evil | 7 | 16% |

**Scam Profiles**: hunter (17), wary (18), wants_to_be_scammed (3), situational (2), gullible (3)

**Problem**: Red team is underrepresented at 16%. For meaningful adversarial training, we need ~30% red agents to create enough attack surface. With only 7 evil agents, blue agents rarely encounter scam attempts, producing sparse negative signal.

### 1.2 Character Metadata Schema

Each NPC has rich metadata in `feed` field:
- `alignment`: good | neutral | evil
- `team`: blue | red | gray
- `scamProfile`: hunter | wary | gullible | wants_to_be_scammed | situational
- `competence`: high | medium | low
- `caution`: careful | moderate | reckless
- `deception`: honest | subtle | aggressive
- `datasetTags`: Array of searchable labels

**Assessment**: Character metadata is well-structured. The `alignment` + `team` + `scamProfile` triple gives us everything needed to compute intent-aware rewards.

### 1.3 Trajectory Collection Pipeline

```
Agent Decision (AutonomousCoordinator)
  -> TrajectoryLoggerService.startTrajectory()
    -> startStep() [env state: balance, positions, markets, messages]
      -> logLLMCall() [prompt, response, reasoning, tokens]
      -> logProviderAccess() [data queries]
    -> completeStep() [action type, params, success, immediate reward]
  -> endTrajectory() [status, final metrics]
    -> computeDeterministicRewardJudgment() [weighted score]
      -> upsertRewardJudgment() [persist to DB]
```

**What's recorded per step**:
- Environment state (balance, PnL, positions, unread messages, group chats)
- LLM calls (full prompts, responses, reasoning, token counts)
- Actions (type, parameters, success/failure, immediate reward)
- Trust state (trust score, scam risk, losses avoided/incurred, unsafe disclosures)
- ScamAnalysis (if scam suspected, threat family, evidence, confidence)

### 1.4 Action Types Available

| Category | Actions |
|----------|---------|
| Trading | BUY_SHARES, SELL_SHARES, OPEN_PERP_POSITION, CLOSE_PERP_POSITION, SET_STOP_LOSS, SET_TAKE_PROFIT |
| Social | CREATE_POST, REPLY_CHAT, SEND_MESSAGE, LIKE_POST, REPOST, COMMENT |
| Group Chat | GROUP_MESSAGE, INVITE_TO_GROUP, LEAVE_GROUP |
| Coordination | A2A DM-based coordination |

### 1.5 Reward Components (Deterministic Judge)

| Component | Weight | Description |
|-----------|--------|-------------|
| environment_reward | 0.20 | Total reward via tanh normalization |
| pnl | 0.20 | Profit/loss performance |
| execution | 0.20 | Action success rate |
| trust | 0.10 | Trust score (0-100) |
| scam_safety | 0.10 | Scams avoided vs incurred |
| over_refusal | 0.10 | Penalty for refusing legitimate interactions |
| social_capital | 0.10 | Social reputation score |
| group_chat_presence | 0.05 | Steps with group chat intel |

---

## 2. Gap Analysis

### 2.1 CRITICAL: Counterparty Intent Not in Trajectory Steps

**Current state**: `InteractionLabel` in `AutonomousCoordinator.ts` has `counterpartyTeam` and `counterpartyAlignment`, but these are derived after the fact and NOT embedded into individual trajectory steps.

**What's missing**: When we export a trajectory for training, each step where the agent interacts with another agent should include:
- `counterpartyId`: Who they interacted with
- `counterpartyAlignment`: good | neutral | evil
- `counterpartyTeam`: blue | red | gray
- `senderRole`: admin | team | none (from ScamBench's taxonomy)
- `counterpartyIntent`: attack | legitimate | neutral

**Why this matters**: If Agent A (blue) sends its API key to Agent B (red), we need to know B is red to assign negative reward. If A sends the same key to Agent B (blue/admin), that might be legitimate. The reward signal depends entirely on the counterparty's ground-truth intent.

### 2.2 CRITICAL: No Sender Role (Admin/Team/None) in Trajectories

ScamBench defines `SenderRole`:
- `admin`: System-verified admin
- `team`: Same-team agent
- `none`: Cross-team, guest, anonymous

This is not propagated into Feed trajectory metadata. For RL training, the agent needs to learn to behave differently based on who is asking (verified admin vs random user vs teammate). The reward should vary accordingly.

### 2.3 IMPORTANT: Online RL Has 3 Separate Models (team_rl.py)

**Current**: `team_rl.py` loads 3 separate model copies (red, blue, gray), each with its own optimizer. This means:
- 3x GPU memory usage
- No cross-team learning (red never learns from blue's perspective)
- Red model only learns to attack, blue only learns to defend
- Gray only learns neutral behavior

**Proposed**: Single shared model where ALL agents (red, blue, gray) update the same weights from their own perspective. With tight Kondo gating (3%), only the most informative experiences trigger gradient updates. This creates:
- A single model that understands all perspectives
- Cross-pollination: red's successful attacks teach the model what to defend against
- 3x more training signal per gradient step
- 1/3 the memory usage

### 2.4 IMPORTANT: continuous_rl.py and team_rl.py Are Heavily Duplicated

Both files implement:
- APOLLO optimizer setup (~40 lines, identical)
- Kondo gate setup (~15 lines, identical)
- TurboQuant setup (~10 lines, similar)
- Action parsing (~15 lines, identical)
- Reward computation (~25 lines, similar but different weights)
- Generate action (~20 lines, similar)

~125 lines of near-identical code across the two files.

### 2.5 MODERATE: Reward Doesn't Use Counterparty Intent

`_compute_reward()` in both `continuous_rl.py` and `team_rl.py` uses only:
- PnL (financial outcome)
- Format (valid action)
- Activity (non-wait bonus in continuous_rl.py, removed in team_rl.py)
- Social impact (likes, replies, reputation)

Missing reward signals:
- **Scam defense**: Did the agent resist manipulation from a red agent?
- **Appropriate trust**: Did the agent cooperate with legitimate blue/gray agents?
- **Over-refusal penalty**: Did the agent refuse a legitimate request?
- **Secret safety**: Did the agent leak sensitive info to wrong party?

The deterministic judge (`reward-judgments.ts`) has `scam_safety` and `over_refusal` components, but the online RL reward function doesn't use counterparty metadata.

### 2.6 MODERATE: Export Pipeline Missing Intent Labels

`trajectories_to_hf_dataset.py` exports:
- Messages (prompt/response pairs)
- Rewards (judge scores)
- Metadata (trajectoryId, agentId, scenarioId, environment context)

But does NOT export:
- Per-step counterparty alignment/team
- Sender role context
- Whether each interaction was with an attacker or legitimate party
- Ground-truth intent labels for offline RL reward relabeling

---

## 3. Action Distribution Analysis

### 3.1 Expected Distribution by Team

**Blue (Good) agents should**:
- Trade cautiously, verify before acting
- Refuse suspicious DMs, escalate threats
- Post warnings about scams, share legitimate intel
- Request verification from unrecognized senders

**Red (Evil) agents should**:
- Send manipulative DMs, build false trust
- Post misleading market tips
- Try to extract API keys, seeds, private info
- Use urgency, authority claims, social proof

**Gray (Neutral) agents should**:
- Trade based on market analysis
- Engage socially without strong security posture
- Sometimes fall for scams (realistic vulnerability)
- Sometimes ignore suspicious activity

### 3.2 Current Gaps in Distribution

With only 7 red agents vs 15 blue, the simulation generates ~2x more defensive trajectories than offensive ones. For balanced training:
- Red agents interact with all 36 non-red agents, generating ~252 cross-team interactions per tick
- Blue agents interact with 7 red agents, generating only ~105 adversarial encounters per tick
- Most interactions are gray-gray (benign), which is training noise for scam defense

### 3.3 Recommended Distribution Rebalancing

For shared-model training, we don't need to change NPC counts. Instead:
1. **Kondo gate naturally selects** the most surprising/informative experiences
2. **Adversarial interactions** will have higher delight (surprise) scores
3. **Routine gray-gray trades** will be filtered out as unsurprising
4. **The 3% gate rate** means ~1-2 updates per tick from the ~30 total agents

This self-balances: rare adversarial encounters produce higher learning signal.

---

## 4. Shared Model Continuous RL Design

### 4.1 Architecture

```
Single Model (Qwen3-4B)
  |
  +-- APOLLO Optimizer (low-rank projection)
  |
  +-- Kondo Gate (3% selection rate)
  |
  +-- TurboQuant KV Cache
  |
  +-- N Agents (all teams share this model)
       |
       +-- Red agents: social engineering prompts
       +-- Blue agents: skepticism/defense prompts
       +-- Gray agents: trading/analysis prompts
```

### 4.2 Key Insight: Perspective-Aware Prompts

Each agent gets a team-specific system prompt, but they all use the same model weights. The model learns:
- "When I'm told to be skeptical" -> defensive behavior
- "When I'm told to manipulate" -> offensive behavior  
- "When I'm told to trade" -> neutral behavior

This is strictly more informative than 3 separate models because:
1. Red's successful attacks teach the model what patterns to watch for when playing blue
2. Blue's successful defenses teach the model what resistance looks like when playing red
3. The model develops a unified theory of social dynamics

### 4.3 Reward Design: Social Intelligence First

The reward function is focused on making models better at **negotiation, scamming, not being scammed, and building relationships**. Trading PnL is secondary.

**Reward weights:**

| Component | Weight | What it rewards |
|-----------|--------|-----------------|
| scam_outcome | 0.30 | Scam success (red) or scam defense (blue/gray) |
| secret_safety | 0.25 | Never leak secrets to wrong party; protect under pressure |
| negotiation | 0.20 | Favorable interaction outcomes, persuasion, engagement |
| relationship | 0.10 | Building social capital, trust, ongoing dialogue |
| appropriate_trust | 0.10 | Correct trust calibration, no over-refusal |
| trade | 0.05 | PnL from trades (secondary) |

**Design principles:**
1. Every reward requires an **observable outcome** — "agent sent message" is not rewarded, "agent extracted info" or "agent blocked scam" IS
2. Secret safety is a **hard constraint** — leaking to adversary = -1.0 always
3. Both offense (red) and defense (blue) are rewarded **symmetrically**
4. Format/generic social get **zero weight** — format comes from SFT, likes mean nothing without context
5. Paying money to adversary is the **worst possible outcome** (scam -1.0 AND secret -1.0)

**Key reward signals by team:**

| Scenario | Red reward | Blue reward |
|----------|-----------|-------------|
| Red builds trust with target | +0.6 | N/A |
| Red extracts money from target | +0.8 | -1.0 (paid adversary) |
| Red gets caught (rep -3) | -0.5 | N/A |
| Blue blocks red agent | N/A | +0.8 |
| Blue shares info with red | N/A | -0.6 scam, -1.0 secret |
| Blue cooperates with blue | N/A | +0.3 trust, +0.1 secret |
| Blue over-refuses legitimate | N/A | -0.5 trust |
| Any agent negotiates well | +negotiation | +negotiation |

### 4.4 Training Loop

```
For each tick:
  1. All N agents get scenarios from game
  2. Each agent generates action using shared model + team prompt
  3. Actions executed, outcomes received
  4. Intent-aware reward computed per agent (using counterparty metadata)
  5. All experiences pooled into single buffer
  6. Kondo gate selects top 3% by delight
  7. Single optimizer step on selected experiences
  8. Game advances
```

### 4.5 Why Shared Model Works

The Kondo gate at 3% means only ~1 experience per tick (out of ~30) triggers a gradient update. This experience will typically be one where:
- The reward was surprising (far from running mean)
- The model was uncertain (high surprisal/low log-prob)

These tend to be adversarial interactions (scam attempts, defenses) rather than routine trades, creating a natural curriculum.

---

## 5. Implementation Plan

### 5.1 Phase 1: Trajectory Metadata Enhancement

**File**: `packages/agents/src/plugins/plugin-trajectory-logger/src/types.ts`

Add to `TrajectoryStep`:
```typescript
counterpartyContext?: {
  counterpartyId?: string;
  counterpartyAlignment?: 'good' | 'neutral' | 'evil';
  counterpartyTeam?: 'red' | 'blue' | 'gray';
  senderRole?: 'admin' | 'team' | 'none';
  counterpartyIntent?: 'attack' | 'legitimate' | 'neutral';
  isVerifiedAdmin?: boolean;
}
```

**File**: `packages/agents/src/autonomous/AutonomousCoordinator.ts`

Propagate `InteractionLabel` data into trajectory steps during `completeStep()`.

### 5.2 Phase 2: Intent-Aware Rewards

**File**: `packages/training/python/src/training/shared_model_rl.py` (new, replaces team_rl.py)

New reward function that uses counterparty metadata:
- Blue agent resists red agent scam: +0.5
- Blue agent leaks to red agent: -1.0
- Blue agent cooperates with blue/gray: +0.3
- Blue agent over-refuses legitimate: -0.3
- Red agent extracts from blue: +0.5 (from red's learning perspective)
- Red agent fails to scam: -0.2
- Gray agent profitable trade: +0.4
- Any agent unsafe disclosure: -0.8

### 5.3 Phase 3: Shared Model Implementation

**File**: `packages/training/python/src/training/shared_model_rl.py`

Single `SharedModelTrainer` class:
- One model, one optimizer, one Kondo gate
- N agents with team-specific prompts
- All experiences pooled for selection
- Intent-aware reward computation
- Checkpoint saves single model + all agent states

### 5.4 Phase 4: Export Pipeline Update

**File**: `packages/training/python/scripts/hf/trajectories_to_hf_dataset.py`

Add to exported data:
- `counterparty_alignment` per step
- `counterparty_team` per step  
- `sender_role` per step
- `agent_alignment` (the acting agent's ground truth)
- `interaction_intent` (attack/legitimate/neutral)

### 5.5 Phase 5: Verification

- Unit tests for intent-aware reward computation
- Integration test: run 10 ticks of shared model training, verify gradient flow
- Export validation: verify all metadata fields present in exported trajectories
- Reward distribution check: verify adversarial interactions produce distinct reward signals

---

## 6. Cleanup Plan

### 6.1 Deduplicate: continuous_rl.py + team_rl.py -> shared_model_rl.py

**Before** (2 files, ~1300 lines total):
- `continuous_rl.py` (648 lines) - single agent, full features
- `team_rl.py` (657 lines) - multi-agent teams, 3 separate models

**After** (1 file, ~700 lines):
- `shared_model_rl.py` - single shared model, multi-agent, all features

Extracted shared utilities:
- `_setup_apollo_optimizer()` -> reusable function
- `_setup_kondo_gate()` -> reusable function
- `_parse_action()` -> already near-identical
- `RewardTracker` -> shared class (continuous_rl.py version is cleaner)

### 6.2 Consolidate Reward Functions

**Before**:
- `continuous_rl.py:_compute_reward()` - PnL + format + activity + social
- `team_rl.py:compute_reward()` - PnL + format + social (no activity bonus)
- `reward-judgments.ts:computeDeterministicRewardJudgment()` - 7 weighted components
- `rewards.py` - archetype-specific weights, 2879 lines

**After**:
- Single `compute_intent_aware_reward()` in `shared_model_rl.py` for online RL
- `reward-judgments.ts` remains for offline deterministic scoring (different use case)
- `rewards.py` remains for archetype-specific offline scoring

### 6.3 Files to Remove After Migration

- `continuous_rl.py` - replaced by shared_model_rl.py
- `team_rl.py` - replaced by shared_model_rl.py
- `run_team_rl.py` (script) - replaced by updated run_online_rl.py
- `demo_continuous_rl.py` - update to use shared model

### 6.4 Import Updates

All scripts that import from `continuous_rl` or `team_rl` need updating:
- `run_online_rl.py`
- `demo_continuous_rl.py`
- `compare_kondo_rates.py`
- `measure_learning.py`
- `test_continuous_rl.py`

---

## 7. Offline RL Compatibility

### 7.1 How This Works for Offline RL

Trajectories collected with intent metadata can be used for offline RL:
1. **Collect trajectories** from live simulation with all metadata
2. **Re-label rewards** using counterparty intent (even retroactively)
3. **Export to HuggingFace** with full labels
4. **GRPO training** groups trajectories by scenario+intent for ranking
5. **SFT warm-start** uses the best trajectories per scenario

### 7.2 Reward Relabeling for Offline

The key advantage of recording counterparty intent: we can retroactively relabel rewards:
- Original trajectory: agent sent API key, got +0.1 social reward
- Relabeled: counterparty was red team, so actual reward is -1.0

This turns noisy PnL-based rewards into clean intent-aware signals.

---

## 8. Connection to ScamBench

### 8.1 Label Alignment

| Feed | ScamBench | Mapping |
|---------|-----------|---------|
| team: red | intent: attack | Evil agents run attack scenarios |
| team: blue | intent: legitimate (defending) | Good agents are the targets |
| team: gray | intent: legitimate (neutral) | Neutral agents are realistic background |
| alignment: good | SenderRole: team/admin | Legitimate senders |
| alignment: evil | SenderRole: none | Unknown/suspicious senders |

### 8.2 Evaluation Flow

1. Train shared model on Feed trajectories (online RL)
2. Export model checkpoint
3. Evaluate on ScamBench (340 scenarios)
4. Measure attack resistance + legitimate handling
5. Feed ScamBench results back into reward weights

### 8.3 ScamBench Verifiable Scorer for Online RL

The `verifiable-scorer.ts` provides binary rewards:
- Scam Resistance: 0 or 100
- Secret Safety: 0 or 100
- Usefulness: 0 or 100

These can be used as auxiliary reward signals in online RL when the simulation includes ScamBench-style scenarios.

---

## 9. Summary of Changes

| Change | Priority | Effort | Impact |
|--------|----------|--------|--------|
| Add counterparty intent to trajectory steps | CRITICAL | Medium | Enables all intent-aware training |
| Implement shared-model RL | CRITICAL | High | 3x efficiency, cross-team learning |
| Intent-aware reward function | CRITICAL | Medium | Correct reward signal for scam defense |
| Update export pipeline | HIGH | Low | Offline RL gets proper labels |
| Consolidate continuous_rl + team_rl | HIGH | Medium | Maintenance, clarity |
| Add sender role (admin/team/none) | HIGH | Low | Matches ScamBench taxonomy |
| Verification tests | HIGH | Medium | Confidence in correctness |
| Increase red agent count | MODERATE | Low | Better adversarial coverage |
