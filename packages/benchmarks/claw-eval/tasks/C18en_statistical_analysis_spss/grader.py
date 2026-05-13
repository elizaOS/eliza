"""C18en_statistical_analysis_spss grader — multi-turn user-agent consultation: Statistical Analysis SPSS."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA182StatisticalAnalysisSpssGrader(UserAgentClarifyGraderBase):
    """Statistical Analysis SPSS — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "Statistical Analysis SPSS"
    MUST_ASK = [
        "What is the exact design structure (number of between-subjects groups and within-subjects time points)?",
        "What are the sample sizes per group, and are they balanced?",
        "How was missing data handled, and what is the pattern of missingness?",
        "What do the assumption tests show (Levene's test, Box's M, Mauchly's sphericity)?",
        "What is the dependent variable and its measurement properties?",
        "What does the variance pattern look like across cells (especially across time points by group)?",
    ]

    CLARIFICATION_RUBRIC = """Evaluate the quality of the assistant's clarification questions throughout the conversation (0.0-1.0).
Do not just look at the first turn — evaluate the entire conversation for information gathering depth.

## Batch 1 — Basic Setup (must collect; missing any → cap at 0.7)
  - Design structure: how many between-subjects groups and within-subjects levels
  - Sample sizes per group
  - The specific error message details (singular matrix vs other warnings)
  - Which SPSS procedure was used (GLM Repeated Measures)

## Batch 2 — Design Details (good assistants ask these; each adds points)
  - What is the dependent variable and how is it measured
  - Whether groups were balanced at baseline
  - Number of time points and what they represent
  - Whether the variance patterns differ across groups/time points

## Batch 3 — Deep Investigation (excellent assistants probe here; required for 0.9+)
  - Missing data: how many cases, which time points, what pattern (MCAR/MAR/MNAR)
  - How missing data was handled (listwise deletion vs other methods)
  - Levene's test results at each time point
  - Whether the missingness might be related to the outcome (non-random dropout)

## Scoring
- 1.0: Systematically collected all Batch 1 + most Batch 2 + probed into Batch 3 (missing data pattern, Levene's results)
- 0.8-0.9: All Batch 1 + most Batch 2 + at least 1 Batch 3 item
- 0.7: All Batch 1 collected but no deeper probing
- 0.4-0.6: Batch 1 partially collected (missed sample size or design details)
- 0.1-0.3: Almost no proactive questioning; jumped to generic advice
- 0.0: No clarification behavior at all

Notes:
- If the user proactively provided some information, the assistant only needs to ask about what is missing
- Questions should be natural and systematic, not feel like a checklist interrogation
- Asking about missing data handling and variance patterns is what separates a competent statistician from a generic helper"""

    TRAJECTORY_RUBRIC = """Evaluate the entire conversation trajectory for intent understanding and response quality (0.0-1.0).
Do not just evaluate the final answer — examine every turn of the conversation.

## Evaluation Dimensions

### 1. Diagnostic Reasoning Path
- Did the assistant form and test hypotheses about the root cause of the Box's M error?
- Did the assistant correctly shift from "design matrix problem" (user's framing) to "covariance matrix problem" (actual cause)?
- Did the assistant connect multiple pieces of evidence (small n, unequal variance, missing data) into a coherent diagnosis?

### 2. Information Integration
- When the user revealed variance heterogeneity (Batch 2), did the assistant immediately connect this to Box's M?
- When the user revealed the missing data pattern (high-anxiety dropouts, Batch 3), did the assistant recognize this as potentially MAR/MNAR?
- Did the assistant connect Levene's significance at post/3mo with the variance heterogeneity pattern?

### 3. Tool Usage Quality
- If the assistant used computation tools for df calculations, effect sizes, or power: was the usage efficient and correct?
- If the assistant searched for SPSS documentation or statistical methodology: were queries targeted and results integrated?
- Scoring:
  - Efficient, targeted tool use (1-3 calls with clear purpose): no penalty
  - Moderate tool use (4-5 calls): -0.05
  - Excessive/unfocused tool use (6+ calls) or repeated searches: -0.10 to -0.15
  - No tool use when calculations were needed: -0.10

### 4. Conversation Flow
- Did the assistant ask questions in a logical sequence (basic setup → design details → assumptions → missing data)?
- Did the assistant provide interim insights as information was gathered, or stay silent until the end?
- Did the assistant appropriately handle the user's impatience and manuscript deadline pressure?

### 5. Correction of Misconceptions
- Did the assistant address the user's misconception that "singular design matrix" means a design problem?
- Did the assistant correct the belief that Box's M makes Levene's redundant?
- Did the assistant explain why listwise deletion is problematic in this case?

## Scoring
- 1.0: Every turn demonstrates expert-level diagnostic reasoning; misconceptions corrected diplomatically; tool usage efficient and purposeful
- 0.7-0.9: Good diagnostic path with minor gaps; most misconceptions addressed; tool use reasonable
- 0.4-0.6: Partial diagnosis; some misconceptions uncorrected; tool use inefficient or absent when needed
- 0.1-0.3: Poor diagnostic reasoning; generic advice without connecting to user's specific situation
- 0.0: No meaningful diagnostic trajectory"""

    NUMERICAL_RUBRIC = """Evaluate ONLY the numerical/statistical accuracy of the assistant's response (0.0-1.0).
Do not consider content quality or communication style — only whether the numbers and statistical claims are correct.

## Topic Consistency (pre-check)
The topic is mixed ANOVA diagnostics for a 2×4 design with ~50 participants.
If the assistant's response is completely off-topic, score 0 immediately.

## Design Parameters (from user's information)
  - Design: 2 (between: treatment vs control) × 4 (within: pre, post, 1-month, 3-month follow-up)
  - N per group: ~25 (total ~50)
  - After listwise deletion: N = 47 (3 removed)
  - DV: anxiety score (continuous)

## Reference Values (computed programmatically)

### Degrees of Freedom
| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Between-subjects (Group) df | **1** | exact |
| Error (between) df | **45** | ±1 (depending on how assistant accounts for deletion) |
| Within-subjects (Time) df | **3** | exact |
| Interaction (Group × Time) df | **3** | exact |
| Error (within) df | **135** | ±3 |

### Greenhouse-Geisser Epsilon Interpretation
| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| GG epsilon lower bound | **0.333** (= 1/(b-1) = 1/3) | ±0.01 |
| Threshold for HF vs GG correction | **0.75** | exact (this is the standard Girden 1992 criterion) |
| If ε > 0.75 | use Huynh-Feldt | — |
| If ε < 0.75 | use Greenhouse-Geisser | — |

### Effect Size Benchmarks
| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Small partial η² | **0.01** | exact |
| Medium partial η² | **0.06** | exact |
| Large partial η² | **0.14** | exact |
| η² to Cohen's f formula | **f = √(η²/(1-η²))** | exact formula |
| Small Cohen's f | **0.10** | exact |
| Medium Cohen's f | **0.25** | exact |
| Large Cohen's f | **0.40** | exact |

### Covariance Matrix Parameters
| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Unique elements in 4×4 covariance matrix | **10** (= 4×5/2) | exact |
| n-to-parameter ratio (per group) | **~2.3** (≈23/10) | ±0.3 |
| Minimum recommended n per cell | **≥20** (rule of thumb) | approximate |

## Scoring Rules (strict — do not let content quality influence this)
- 1.0: All verifiable numbers within tolerance; df structure correct; GG epsilon interpretation correct; effect size conversions correct
- 0.7-0.9: df structure correct; most statistical claims accurate; minor errors in secondary calculations (e.g., exact epsilon bounds)
- 0.4-0.6: Some df values correct but key errors (e.g., wrong error df, incorrect GG threshold, wrong effect size benchmarks)
- 0.2-0.3: Multiple numerical errors; fundamental statistical relationships incorrect
- 0.0-0.1: No numerical content provided, or pervasive errors throughout
- If the assistant states clearly wrong statistical relationships (e.g., "Box's M tests sphericity" or "GG correction threshold is 0.50"), score ≤ 0.3 regardless of other calculations"""

    CONTENT_RUBRIC = """Evaluate the content quality of the assistant's response (0.0-1.0).
Do not consider numerical accuracy — only diagnosis depth, domain knowledge, and recommendation quality.

## Topic Consistency (pre-check)
The topic is diagnosing and resolving a Box's M / singular matrix warning in a 2×4 mixed ANOVA.
If the response is completely off-topic, score 0.

## User's Full Situation (revealed across conversation)
  - 2(treatment vs control) × 4(pre/post/1mo/3mo) mixed ANOVA on anxiety scores
  - ~25 per group, 50 total, 47 after listwise deletion of 3 participants
  - Box's M warning about "singular or nearly singular design matrix"
  - Treatment group variance inflates at post and follow-up time points
  - Levene's test significant at post and 3-month but not pre or 1-month
  - 3 missing participants: 2 had high anxiety at post-test, 1 missed 3-month follow-up
  - User used listwise deletion
  - User dismissed Levene's as redundant with Box's M
  - User prefers SPSS menus over syntax
  - Manuscript revise-and-resubmit due in 3 weeks

## Key Contradictions (high-quality answers should identify and explain)
The user holds several misconceptions that a skilled statistical consultant should address:

1. **"Singular design matrix" ≠ design problem**: The error is actually about the covariance matrix being ill-conditioned, not the design matrix. The real cause is variance heterogeneity combined with small sample sizes making the pooled covariance matrix nearly singular. (+0.05 for identifying this)

2. **Listwise deletion is inappropriate here**: The missingness pattern (high-anxiety dropouts) strongly suggests MAR or MNAR, not MCAR. Listwise deletion under non-MCAR produces biased estimates. Mixed models handle MAR properly via ML/REML. (+0.05 for identifying this)

3. **Levene's is NOT redundant with Box's M**: Box's M tests equality of entire covariance matrices; Levene's tests equality of marginal variances at each time point. Both being significant is compounding evidence of heterogeneity — more concerning than either alone. (+0.05 for explaining this distinction)

## Evaluation Criteria: Complete Decision Chain

### Step 1: Accurate Diagnosis (required — missing this → cap at 0.4)
- Correctly identifies that the error stems from covariance matrix ill-conditioning, not a literal design matrix problem
- Connects small sample + unequal variances + listwise deletion as contributing factors
- Explains why ~25 per group with 4 time points (10 covariance parameters) is marginal

### Step 2: Contradiction Identification and Correction (+0.15 max)
- Corrects "singular design matrix" misconception (+0.05)
- Identifies listwise deletion as inappropriate given non-random missingness (+0.05)
- Explains why Box's M and Levene's are not redundant (+0.05)

### Step 3: Alternative Analysis Recommendation (required — missing this → cap at 0.6)
- Recommends Linear Mixed Model (LMM) as primary alternative
- Explains WHY LMM is better: handles unequal variances, uses all data under MAR assumption, no sphericity requirement, flexible covariance structures
- Provides SPSS menu instructions: Analyze → Mixed Models → Linear

### Step 4: Domain Knowledge Application (each item +0.04)
- **Covariance structure selection**: Mentions unstructured, compound symmetry, AR(1), or heterogeneous options and when to use each (+0.04)
- **ML vs REML estimation**: Explains when to use ML (model comparison) vs REML (parameter estimation) (+0.04)
- **Sphericity and its relationship to this problem**: Explains that sphericity is a special case of compound symmetry and why it matters for repeated measures (+0.04)
- **Power implications**: Discusses how switching from listwise deletion ANOVA to LMM may actually increase power by using all available data (+0.04)
- **Reporting guidance**: Advises on how to report the switch from ANOVA to LMM in the manuscript (reviewer expectations) (+0.04)

### Step 5: Actionable Recommendation (+0.05)
- Gives a clear, specific recommendation tailored to the user's situation (3-week deadline, menu preference, manuscript context)
- Addresses the user's core question: "Are my results unusable?" with a nuanced answer

### Step 6: Practical Steps (+0.04)
- Provides concrete SPSS menu navigation steps for running LMM
- Specifies what options to select (covariance structure, fixed effects, random effects)
- Mentions how to handle the 3 previously-deleted participants (include them back)

## Scoring Summary
- Step 1 + Step 3 both present: base score 0.5
- Step 2 (contradictions): up to +0.15
- Step 4 (domain knowledge): up to +0.20
- Step 5: +0.05
- Step 6: +0.04
- Theoretical max via rubric: 0.5 + 0.15 + 0.20 + 0.05 + 0.04 = 0.94
- Exceptionally thorough answers with additional insights: up to 1.0"""

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

        # 2. Trajectory quality (20%) — full conversation diagnostic reasoning
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
