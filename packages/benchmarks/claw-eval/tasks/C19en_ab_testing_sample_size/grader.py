"""C19en_ab_testing_sample_size grader — multi-turn user-agent consultation: A/B Testing Sample Size."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA192ABTestingSampleSizeGrader(UserAgentClarifyGraderBase):
    """A/B Testing Sample Size — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "A/B Testing Sample Size"
    MUST_ASK = [
        "Baseline save/collect rate",
        "Minimum detectable effect (MDE) — absolute or relative lift",
        "Number of variants (and whether there is a separate control group)",
        "Significance level (alpha) and statistical power",
        "Available daily traffic / impressions",
        "Desired test duration or timeline constraints",
    ]

    CLARIFICATION_RUBRIC = """Evaluate the quality of the assistant's clarification questions throughout the conversation (0.0-1.0).
Do not only look at the first turn — also consider whether the assistant progressively deepened its understanding across the entire dialogue.

## Batch 1 — Basic setup (must collect; missing any → cap at 0.7)
  - What platform / what metric (save rate on Xiaohongshu)
  - How many variants vs control (4 variants + 1 control = 5 groups)

## Batch 2 — Statistical parameters (must collect; missing any → cap at 0.7)
  - Baseline save rate (~3.2%)
  - Minimum detectable effect size (0.5 percentage points absolute)
  - Significance level (alpha = 0.05) and power (0.80)

## Batch 3 — Practical constraints (a good consultant probes further, +points for each)
  - Daily available traffic / impressions (~50,000)
  - Desired test duration (< 2 weeks)
  - Concerns about novelty effect or other biases
  - Whether the user is aware of the need for multiple comparison correction

Scoring:
- 1.0: All Batch 1+2 info collected AND proactively asked about 2+ items from Batch 3
- 0.8-0.9: All Batch 1+2 collected + asked about 1 item from Batch 3
- 0.7: Batch 1+2 collected but no deeper probing
- 0.4-0.6: Missing 1-2 items from Batch 1 or 2
- 0.1-0.3: Almost no proactive questioning; gave answer on incomplete info
- 0.0: No clarification behavior at all

Notes:
- If the user proactively provided some information, the assistant only needs to ask about what is missing
- Batch 3 information does not need to be collected in the first turn — natural follow-up questions across multiple turns are fine"""

    TRAJECTORY_RUBRIC = """Evaluate the entire conversation trajectory — the assistant's intent understanding and response quality across all turns (0.0-1.0).
Do not only judge the final answer; examine each turn.

## Evaluation Dimensions

### 1. Information Gap Identification
- The user's initial query is vague (just asks about "rough threshold" for sample size)
- Did the assistant immediately recognize the missing parameters (baseline rate, MDE, number of variants, alpha/power, traffic) and ask, rather than giving a vague answer first?

### 2. Multiple Comparison Awareness
- The user has 4 variants + 1 control = 4 pairwise comparisons
- Did the assistant proactively raise the issue of multiple comparisons / Bonferroni correction?
- This is the KEY differentiator — a strong assistant should bring this up without being asked
- If the assistant never mentions multiple comparison correction at all: cap trajectory score at 0.6

### 3. Information Update Tracking
- If the user reveals new information in later turns (e.g., daily traffic, novelty effect concern), does the assistant incorporate it into updated analysis?
- Does the assistant revise its calculations or recommendations when new constraints emerge?

### 4. Tool Use Quality (if the assistant used calculation or search tools)
- Did it use a computation tool for the sample size formula rather than doing mental math?
- Tool call timing: did it wait until it had enough parameters before computing?
- **Error handling:**
  - One correct call = optimal, no deduction
  - Error then self-correction = suboptimal, deduct 0.1-0.2
  - Error unnoticed, wrong result shown to user = serious, deduct 0.3-0.5

### 5. Search Tool Use
- A/B testing sample size is a well-established statistical topic; searching is optional but can be useful for verifying formulas or finding best practices on novelty effects
- Good: 1-3 targeted searches if used
- Acceptable: No search (topic is well-known)
- Poor: Excessive searching (6+ times) on basic statistics

### 6. Conversation Pacing
- Did the assistant provide intermediate conclusions at appropriate moments?
- Did it smoothly transition when the user introduced new concerns (novelty effect, time constraints)?

Scoring:
- 1.0: Perfect intent tracking every turn, proactively raised multiple comparisons, tool use efficient and correct
- 0.7-0.9: Good understanding, mentioned multiple comparisons, minor imperfections
- 0.4-0.6: Partial understanding, missed multiple comparison issue OR significant tool errors
- 0.1-0.3: Repeated misunderstandings or information loss across turns
- 0.0: Unable to track user intent at all"""

    NUMERICAL_RUBRIC = """Evaluate ONLY the numerical accuracy of the assistant's sample size calculations (0.0-1.0). Ignore content quality and advice.

## Topic Consistency (pre-check)
The original question is about A/B test sample size calculation for Xiaohongshu notes with save rate as the primary metric.
If the assistant's final answer completely deviates from this topic, score 0 for numerical accuracy.

## User Parameters (revealed during conversation)
  - Baseline save rate (p): 3.2% (0.032)
  - Minimum detectable effect (delta): 0.5 percentage points absolute (0.005)
  - Significance level (alpha): 0.05
  - Statistical power: 0.80 (beta = 0.20)
  - Number of variants: 4 (+ 1 control = 5 groups, 4 comparisons)
  - Daily traffic: 50,000 total

## Correct Reference Values (computed via two-proportion z-test formula)
Formula: n = (Z_{alpha/2} + Z_beta)^2 * 2p(1-p) / delta^2

### Without multiple comparison correction (alpha = 0.05):
| Check Item | Correct Value | Allowed Tolerance |
|------------|---------------|-------------------|
| Z_{alpha/2} | **1.960** | ±0.01 |
| n per group | **19,448** | ±500 (18,948–19,948) |

### With Bonferroni correction (alpha' = 0.05/4 = 0.0125):
| Check Item | Correct Value | Allowed Tolerance |
|------------|---------------|-------------------|
| Corrected alpha | **0.0125** | exact |
| Z_{alpha'/2} | **2.498** | ±0.01 |
| n per group | **27,637** | ±500 (27,137–28,137) |

### Derived values:
| Check Item | Correct Value | Allowed Tolerance |
|------------|---------------|-------------------|
| Total sample (5 groups, corrected) | **138,185** | ±3,000 |
| Per-group daily traffic | **10,000** | exact |
| Min days needed (corrected) | **~3 days** (statistically) | ±1 day |

## Scoring Rules (strictly enforce — do not let content quality affect this score)
- 1.0: Both uncorrected AND corrected sample sizes computed and within tolerance; total and days derived correctly
- 0.7-0.9: Corrected sample size correct; minor errors in derived values (total or days)
- 0.5-0.6: Only uncorrected sample size computed correctly (did not apply Bonferroni), OR corrected value has moderate error (±1000-2000)
- 0.3-0.4: Sample size computed but with significant errors (off by >2000), or used wrong formula
- 0.1-0.2: Attempted calculation but fundamentally wrong (e.g., wrong formula, wrong parameters)
- 0.0: No quantitative calculation provided, or parameters used are completely inconsistent with what user provided

## Important Notes
- If the assistant used a slightly different formula (e.g., using pooled proportion, or arcsin transformation), the result may differ slightly — allow wider tolerance (±1000) if the methodology is sound
- If the assistant correctly identified the need for Bonferroni correction but used a different correction method (e.g., Sidak, Holm), this is acceptable as long as the corrected alpha is reasonable
- The key distinction is whether the assistant recognized that 4 comparisons require correction at all"""

    CONTENT_RUBRIC = """Evaluate the content quality of the assistant's response (0.0-1.0). Do not consider numerical accuracy — only assess completeness, professionalism, and practical usefulness.

## Topic Consistency (pre-check)
If the assistant's answer completely deviates from A/B test sample size planning, score 0.

## Full User Context (revealed during conversation)
  - Running A/B test on Xiaohongshu notes, primary metric is save rate
  - 4 variants + 1 control, baseline ~3.2%, MDE 0.5% absolute
  - 50,000 daily impressions, want test to finish in under 2 weeks
  - Concerned about novelty effect
  - Not aware of multiple comparison correction issue

## Key Contradiction / Analytical Challenge
The user assumes standard alpha=0.05 works for all 4 comparisons. A knowledgeable assistant should:
  - Explain WHY multiple comparisons inflate the false positive rate (family-wise error rate)
  - Show the difference in required sample size before and after correction
  - Relate this back to the user's traffic and timeline constraints

## Evaluation: Complete Decision Framework (6 Steps)

### Step 1: Basic Sample Size Calculation (required; missing → cap at 0.4)
- Computed sample size per group using proper power analysis
- Showed the formula or methodology used
- Provided both uncorrected and corrected estimates

### Step 2: Multiple Comparison Correction (critical differentiator, +0.15)
This is the most important content dimension for this task:
- **Identified the problem**: Explained that 4 comparisons inflate Type I error rate (+0.05)
- **Applied correction**: Used Bonferroni (or equivalent) to adjust alpha (+0.05)
- **Quantified the impact**: Showed how correction increases the required sample size (+0.05)
- If the assistant never mentions multiple comparisons at all, this entire section scores 0

### Step 3: Practical Feasibility Analysis (required; missing → cap at 0.6)
- Translated sample size into days needed given 50,000 daily traffic
- Assessed whether the 2-week constraint is achievable
- Discussed the trade-off between statistical rigor and practical constraints

### Step 4: Domain Knowledge (bonus items, each +0.04)
- **Novelty effect**: Explained what it is and why short tests are vulnerable to it; recommended running for at least 1-2 full weeks even if sample size is reached sooner (+0.04)
- **Day-of-week effects**: Mentioned that user behavior varies by weekday/weekend, so test should cover full weekly cycles (+0.04)
- **Sequential testing / early stopping**: Mentioned alternatives like sequential analysis or group sequential designs that can allow valid early stopping (+0.04)
- **Effect of low base rate**: Noted that 3.2% save rate is relatively low, making it harder to detect small absolute changes; discussed relative vs absolute MDE (+0.04)

### Step 5: Practical Recommendation (bonus, +0.05)
- Gave a clear, actionable recommendation that balances statistical rigor with the user's constraints
- Recommendation accounts for multiple comparisons, novelty effect, and timeline

### Step 6: Implementation Guidance (bonus, +0.04)
- Provided concrete next steps (how to set up the test, how to allocate traffic, when to check results)
- Warned about common pitfalls (peeking at results, stopping early without proper adjustment)

## Score Summary
- Step 1 + Step 3 both satisfied: base score 0.5
- Step 2 (multiple comparisons): up to +0.15 (KEY differentiator)
- Step 4 each knowledge point: +0.04 (max +0.16)
- Step 5: +0.05
- Step 6: +0.04
- Theoretical max path: 0.5 + 0.15 + 0.16 + 0.05 + 0.04 = 0.90
- Exceptionally insightful response may reach 1.0"""

    # Keep FINAL_ANSWER_RUBRIC empty so base class won't make its own call
    FINAL_ANSWER_RUBRIC = ""

    def grade(self, messages, dispatches, task, audit_data=None, judge=None,
              media_events=None, env_snapshot=None):
        from claw_eval.models.trace import DimensionScores

        scores = DimensionScores()
        scores.safety = 1.0
        scores.robustness = 1.0

        if judge is None:
            return scores

        full_conversation = self.format_conversation_detailed(
            messages, include_tool_use=True, include_tool_result=True,
        )
        clarify_conversation, _ = self._split_phases(messages)
        prompt_text = task.prompt.text

        # 1. Clarification quality (15%)
        clarify_score = 0.0
        if self.CLARIFICATION_RUBRIC and clarify_conversation:
            try:
                result = judge.evaluate(prompt_text, clarify_conversation, "",
                                        self.CLARIFICATION_RUBRIC)
                clarify_score = result.score
                print(f"[grader] clarification score: {clarify_score:.2f} — {result.reasoning[:200]}")
            except Exception as exc:
                print(f"[grader] clarification judge failed: {exc}")

        # 2. Trajectory quality (20%) — full conversation intent understanding
        trajectory_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.TRAJECTORY_RUBRIC)
            trajectory_score = result.score
            print(f"[grader] trajectory score: {trajectory_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] trajectory judge failed: {exc}")

        # 3. Numerical accuracy (35%)
        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] numerical score: {numerical_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] numerical judge failed: {exc}")

        # 4. Content quality (30%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 20% trajectory + 35% numerical + 30% content
        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.35 * numerical_score +
            0.30 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.20 "
              f"+ numerical={numerical_score:.2f}*0.35 + content={content_score:.2f}*0.30)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
