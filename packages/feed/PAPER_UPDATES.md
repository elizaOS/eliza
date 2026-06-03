# Proposed Paper Updates

Based on the gap analysis between the paper (`paper/feed_scam_defense_paper.tex`) and current implementation.

---

## Critical Updates (Must Fix)

### 1. RLVR Results Separation
**Current**: Table 1 shows identical SFT and RLVR attack scores (48.93).
**Fix**: Either (a) run real RLVR with the new shared-model pipeline and show separation, or (b) present honestly as "SFT results; RLVR stage in progress."
**New data available**: Online RL on Nebius producing real training curves.

### 2. Benchmark Version Update (V2 → V3)
**Current**: Paper uses V2 (256 scenarios, old scorer with 3 known bugs).
**Fix**: Rerun all results on V3 (344 scenarios, corrected scorer). Update:
- Table 1: 194 → 344 scenarios, 531 → ~700 stages
- Threat taxonomy placeholders: fill all 13 `\placeholder{}` values
- Add 3 new categories: malicious-tool, research-assisted (expanded), admin-privilege

### 3. Action Vocabulary Fix
**Current**: Model outputs `comply` 79% of the time; scorer gives 2/100 for legitimate scenarios.
**Impact**: Fixing this normalization would boost legitimate score from ~5 → 60-80, overall from ~62 → ~75+.
**Fix**: Add `comply` → `engage_legitimate` mapping in scorer's action normalization.

### 4. Training Data Category Gaps
**Current**: 4 ScamBench categories have ZERO training records:
- Advance-fee fraud (24 scenarios, 0 training)
- Credential theft (27 scenarios, 0 training)
- Impersonation (18 scenarios, 0 training)
- Interpersonal abuse (14 scenarios, 0 training)

**Fix**: Generate training data for these categories from the existing ScamBench scenarios (use export_scam_defense_trajectories.py).

---

## New Sections to Add

### 5. Shared-Model Architecture (Section 4.x)
**Content**: Describe the shared-model approach where one model serves all teams (red/blue/gray) with team-specific system prompts. Cross-pollination: red's successful attacks teach the model what to defend against when playing blue.

Key points:
- Single model, 3 team prompts, N agents per team
- Kondo gate at 3% selects most informative experiences
- APOLLO optimizer for efficient full-parameter updates
- TurboQuant KV cache for fast inference during generation
- Intent-aware reward function using counterparty ground truth

### 6. Adversarial Arms Race (Section 7.x)
**Content**: Present the arms race experiment where red-team and blue-team models improve simultaneously. Show learning curves at various tick counts.

**Data from Nebius training** (tick 50 checkpoint):
- 1500 experiences (500/team)
- Blue team leading: reward=0.078 (defensive behavior paying off)
- Red team: reward=0.055 (attacks generating some reward)
- Gray team: reward=0.044 (baseline trading)

### 7. Frontier Model Attack Results (Section 7.x)
**Content**: Table showing our trained red-team model's attack success rate against GPT-5.4, Sonnet 4.5, and baseline Qwen-9B. Attacker metrics: success rate, secret extraction, stealth rate, efficiency.

### 8. New Action Types (Section 3.x)
**Content**: SHARE_INFORMATION (verifiable keyword-based intel search) and REQUEST_PAYMENT (labeled payment negotiation). These create measurable, non-fabricated social dynamics.

### 9. Online Continuous RL (Section 4.x)
**Content**: Describe the online training loop where the model runs on GPU, queries the Feed simulation for scenarios, generates actions, receives intent-aware rewards, and updates weights continuously.

---

## Placeholder Values to Fill

Replace 13 `\placeholder{}` in threat taxonomy table (lines 394-406):

| Category | Paper Value | V3 Actual |
|----------|-------------|-----------|
| Prompt injection | \placeholder{42} | 95 |
| Credential theft | \placeholder{18} | 27 |
| Social engineering | \placeholder{34} | 52 |
| Impersonation | \placeholder{22} | 18 |
| Secret exfiltration | \placeholder{12} | 14 |
| Advance-fee fraud | \placeholder{8} | 24 |
| Research-assisted | \placeholder{6} | 9 |
| Interpersonal abuse | \placeholder{4} | 14 |
| Legitimate | \placeholder{48} | 133 |
| Total scenarios | \placeholder{194} | 344 |
| Total stages | \placeholder{531} | ~700 |
| Registers | \placeholder{12} | 12 |

---

## Results Tables to Update

### Table 1: Main Results
Add columns for:
- Online RL (shared model)
- Arms race (tick 100, 200, 500)

### Table 2: Per-Category
Fill in advance-fee fraud and interpersonal abuse rows (currently "---").

### New Table: Attacker Effectiveness
| Model | Success Rate | Secret Extraction | Stealth | Efficiency | Overall |
|-------|-------------|-------------------|---------|-----------|---------|
| Scripted | baseline | baseline | baseline | baseline | baseline |
| Baseline Qwen-9B | not measured | not measured | not measured | not measured | not measured |
| Feed Red-9B | not measured | not measured | not measured | not measured | not measured |

### New Table: Competitive Matrix
| Target ↓ / Attacker → | Scripted | Feed Red | vs Baseline |
|------------------------|----------|-------------|-------------|
| GPT-5.4 | not measured | not measured | +X% |
| Sonnet 4.5 | not measured | not measured | +X% |
| Baseline Qwen-9B | not measured | not measured | +X% |
| Feed Blue-9B | not measured | not measured | +X% |

---

## Draft Notes to Remove

Lines with `\draftnote` warnings (lines 690, 734, 797, 1113) should be resolved and removed before submission.

---

## Appendix Updates

### Appendix A: Reproducibility
- Fill `\CorpusTotalRecords{}` → 15,260
- Fill `\ScamBenchTotalScenarios{}` → 344
- Add commands for all 5 experiments (link to EXPERIMENTS.md)

### Appendix C: Remaining Work
Update status of items:
- RLVR stage: "In progress → Results available from online RL"
- Training data alignment: "4 categories need data → Add export from ScamBench"
- Scaling to 9B: "Regression observed → New shared-model approach avoids this"
- Human evaluation: "UI built → Waiting for participants"
