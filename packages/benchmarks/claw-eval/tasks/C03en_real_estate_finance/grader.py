"""C03en_real_estate_finance grader — multi-turn user-agent consultation: 房地产金融."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA3Grader(UserAgentClarifyGraderBase):
    """房地产金融 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "房地产金融"
    MUST_ASK = [
        "Asset location (city/metro area)",
        "Financial fundamentals (NOI, purchase price / valuation)",
        "Operating assumptions (vacancy rate, expense ratio)",
        "Financing structure (LTV, interest rate, amortization term)",
    ]

    CLARIFICATION_RUBRIC = """Evaluate the assistant's information-gathering quality throughout the conversation (0.0-1.0).
Look at not just the first turn, but the entire dialogue — did the assistant progressively collect the information needed to build a proper financial model?

## Basic Information Layer (must collect; missing any one item caps score at 0.7)
  - Asset geographic location (city/metro)
  - NOI and purchase price / going-in cap rate
  - Vacancy rate assumption
  - Expense ratio

## Deep Information Layer (a strong advisor probes further; each item covered adds credit)
  - Financing structure: LTV, loan rate, amortization term
  - Desired hold period and exit cap rate assumption
  - Rent growth assumption the user wants stress-tested (3.5% is stated but needs validation)
  - Whether the user wants levered or unlevered analysis (or both)

Scoring rubric:
- 1.0: All basic info collected + proactively asked about 2+ deep items
- 0.8-0.9: All basic info collected + asked about 1 deep item
- 0.7: All basic info collected but no deep probing
- 0.4-0.6: 1-2 basic items missing
- 0.1-0.3: Almost no proactive questioning
- 0.0: No clarification behavior at all

Notes:
- If the user volunteered some information, the assistant only needs to ask for what is missing
- Deep info need not be asked in the first turn; it can emerge naturally later in the conversation"""

    TRAJECTORY_RUBRIC = """Evaluate the assistant's intent understanding and response quality across the ENTIRE conversation (0.0-1.0).
Do not focus only on the final answer — examine each turn.

## Evaluation Dimensions

### 1. Information Gap Detection
- The user's initial query is a high-level market question ("is 3.5% rent growth defensible?") with NO asset-specific data
- Did the assistant recognize in the first turn that asset-level parameters are needed before any modeling, or did it give a generic answer first?

### 2. Information Correction Capture
- The user may revise or add parameters mid-conversation (e.g., correcting vacancy from 5% to 7%, adding expense ratio, providing debt terms)
- Did the assistant pick up each correction and incorporate it into subsequent analysis?

### 3. Need Evolution Tracking
- The user's need evolves: from "gut check on rent growth" → "stress test at 7% vacancy" → "build full DCF" → "add leverage"
- Did the assistant keep up with the natural evolution, or mechanically answer only the original question?

### 4. Tool Usage Quality (if the assistant used calculation tools)
- Did it invoke tools when precise computation was needed (debt service, DCF table) rather than doing mental math?
- Was tool timing appropriate (after collecting enough parameters)?
- **Error and correction standards (strictly enforced):**
  - One-shot correct result = best, no deduction
  - Error caught and self-corrected = acceptable, deduct 0.1-0.2
  - Error not caught, wrong result presented to user = serious, deduct 0.3-0.5
  - Self-correction should NOT be treated as a bonus; it is a recovery from a mistake

### 5. Conversation Pacing
- Did the assistant provide interim conclusions at appropriate moments rather than asking question after question?
- When the user pivoted topics, did the assistant transition smoothly?

### 6. Search Tool Usage Quality (if web_search / web_fetch available)
This task involves time-sensitive information (current multifamily rent growth projections, CBRE/M&M reports, interest rates). A good assistant should search rather than rely on memory.

**Search necessity:**
- User asks about "latest projections from major firms" — did the assistant search for current CBRE, Marcus & Millichap, or RealPage data?
- Did the assistant verify current interest rate environment rather than assuming?

**Search quality assessment:**
- Excellent (no deduction): Precise queries, 1-3 searches covering key info, results correctly integrated
- Good (deduct 0.05): Searched but queries not precise, needed 4-5 attempts
- Fair (deduct 0.1): Over-searched (6+ times) or duplicated queries
- Poor (deduct 0.15): Searched but results not used, or wrong info not filtered
- No search (deduct 0.1): Did not use search tools at all, relied on memory for time-sensitive data. If memory-based info happens to be correct, reduce penalty to 0.05

## Scoring
- 1.0: Every turn demonstrates precise understanding, zero missed corrections, perfect need evolution tracking, efficient tool use
- 0.7-0.9: Generally accurate, reasonable tool use, occasional imprecision in one turn
- 0.4-0.6: Several turns show clear misunderstanding (missed parameter corrections, ignored need shifts), or tool misuse
- 0.1-0.3: Repeated intent misunderstanding across turns
- 0.0: Completely fails to track user intent"""

    NUMERICAL_RUBRIC = """Evaluate ONLY the numerical/computational accuracy of the assistant's answers (0.0-1.0). Ignore content quality, advice quality — focus exclusively on whether the numbers are correct.

## Topic Consistency (pre-check)
The original question is about a multifamily real estate acquisition: rent growth assumption validation, NOI stress test, leveraged cash flow, and DCF analysis for an Indianapolis asset.
If the assistant's final answer completely deviates from this topic, numerical accuracy = 0.

## User-Provided Parameters
  - Purchase Price: $10,000,000
  - NOI: $620,000 (going-in cap rate 6.2%)
  - Vacancy: 7%, Expense Ratio: 42%
  - Financing: 65% LTV ($6.5M loan), 5.4% interest, 30-year amortization
  - Rent growth assumption: 3.5%/year
  - Exit cap rate: 6.5%

## Correct Reference Values (programmatically computed)

**Reverse-Engineering Revenue:**

| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Gross Potential Revenue (GPR) | **$1,149,425** | +/- $20,000 |
| Effective Gross Income (EGI at 7% vac) | **$1,068,966** | +/- $20,000 |
| Operating Expenses (42% of EGI) | **$448,966** | +/- $15,000 |
| NOI verification | **$620,000** | +/- $5,000 |

**Debt Service:**

| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Monthly debt payment | **$36,500** | +/- $500 |
| Annual debt service | **$437,994** | +/- $5,000 |
| DSCR | **1.42x** | +/- 0.05 |

**Year 1 Leveraged Cash Flow:**

| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Pre-tax cash flow (BTCF) | **$182,006** | +/- $10,000 |
| Cash-on-Cash return | **5.20%** | +/- 0.3% |

**5-Year DCF (3.5% rent growth):**

| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Year 5 NOI | **$711,464** | +/- $15,000 |
| Exit value (NOI_Y5 / 6.5%) | **$10,945,604** | +/- $200,000 |
| Loan balance at Year 5 | **~$6,002,000** | +/- $100,000 |
| Net equity proceeds | **~$4,944,000** | +/- $200,000 |

## Scoring Rules (strictly enforce — do not let content quality influence)
- 1.0: All verifiable numbers within tolerance
- 0.7-0.9: Core metrics correct (NOI, debt service, DSCR), minor DCF deviations
- 0.4-0.6: Debt service or NOI off by 5-15%
- 0.2-0.3: Fundamental errors in debt service or NOI calculation
- 0.0-0.1: Core metrics off by >20%, or parameters used don't match user's inputs
- If the assistant used different inputs than the user provided (e.g., used $8M price when user said $10M), score 0"""

    CONTENT_RUBRIC = """Evaluate the content quality of the assistant's answer (0.0-1.0). Ignore numerical accuracy — focus on completeness, professionalism, and practical usefulness.

## Topic Consistency (pre-check)
The original question is about multifamily rent growth assumptions and deal analysis for an Indianapolis property.
If the assistant's final answer completely deviates from this topic, content quality = 0.

## User's Complete Situation (revealed progressively in conversation)
  - Stabilized multifamily asset in Indianapolis (Midwest secondary market), 120 units, Class B+ garden-style
  - NOI $620K, purchase price $10M (6.2% going-in cap)
  - 7% vacancy (stressed from current 5%), 42% expense ratio (excluding capex reserves)
  - Capex reserves: $500/unit/year = $60K/year on top of the 42%
  - 65% LTV at 5.4% fixed, 30-year amortization (CMBS loan with yield maintenance penalty for first 3 years)
  - Wants to validate 3.5% annual rent growth assumption
  - Wants stress test and 5-year DCF with 6.5% exit cap
  - Also debating 7-year hold with 6.0% exit cap if rates stay high
  - Holds ~$150K in NXRT (multifamily REIT) — potential concentration risk
  - Considering 1031 exchange from a duplex sold last year (180-day identification window)

## Key Contradiction (high-quality answers should detect and analyze)
The user states NOI = $620K with "current 5% vacancy" and 42% expense ratio for a 120-unit property. Reverse-engineering:
  - If NOI = $620K and OpEx = 42% of EGI, then EGI = $620K / (1 - 0.42) = ~$1,069K
  - At 5% vacancy, GPR = EGI / 0.95 = ~$1,125K → per-unit rent = ~$781/mo
  - But alternatively: EGI = NOI / 0.58 = ~$1,069K, OpEx = ~$449K, GPR = ~$1,149K → NOI back-calc = ~$633K
  - The ~$13K gap between stated $620K and back-calculated $633K suggests either rounding or unreported other income (laundry, parking, late fees)
A strong assistant should notice this minor discrepancy and ask about other income sources rather than accepting $620K at face value.

## Evaluation: Multi-Step Decision Chain

### Step 1: Market Assessment (required — missing this caps score at 0.4)
- Did the assistant evaluate the 3.5% rent growth assumption against current market data?
- Did it reference specific industry sources (CBRE, Marcus & Millichap, RealPage, CoStar)?
- Did it distinguish between national averages and Indianapolis/Midwest specifics?

### Step 2: Information Verification & Contradiction Handling (+0.10)
This is a key differentiator between an average and an excellent assistant:
- **NOI cross-check**: Did the assistant reverse-engineer GPR from NOI using the stated vacancy and expense ratio, and notice the ~$13K discrepancy between stated $620K NOI and the ~$633K back-calculation? (+0.04)
- **Other income inquiry**: Did the assistant ask about ancillary income sources (laundry, parking, pet fees, late charges) that could explain the gap? (+0.03)
- **Capex treatment clarity**: Did the assistant confirm whether capex reserves ($60K) are below-the-line or already embedded in the expense ratio, since this materially affects NOI? (+0.03)
- If the assistant simply accepted all user-provided numbers without any cross-verification, this step scores 0

### Step 3: Deal Fundamentals (required — missing this caps score at 0.5)
- Reverse-engineered revenue from NOI (showing GPR → EGI → OpEx → NOI)
- Computed debt service and DSCR
- Calculated leveraged cash flow and cash-on-cash return

### Step 4: Stress Test Analysis (+0.05)
- Analyzed impact of vacancy stress (e.g., 7% vs 5% or 10%)
- Discussed what happens to DSCR under stress scenarios
- Identified the thin spread between going-in cap (6.2%) and cost of debt (5.4%)

### Step 5: DCF Model (+0.05)
- Built a 5-year projection with year-by-year NOI growth
- Applied exit cap rate to calculate terminal value
- Provided unlevered and/or levered IRR estimates

### Step 6: Domain Knowledge Application (bonus, each item +0.04)
- **Capex reserves treatment**: Correctly distinguished between capex reserves as a below-the-line deduction vs. part of the 42% expense ratio, and reflected this in cash flow projections (+0.04)
- **CMBS yield maintenance**: Addressed the yield maintenance prepayment penalty on the CMBS loan and its impact on the year-5 exit — calculated the penalty cost or flagged it as a material drag on exit proceeds (+0.04)
- **1031 exchange timing**: Flagged the 180-day identification window constraint from the user's duplex sale and discussed how it interacts with acquisition timing (+0.04)
- **Concentration risk**: Identified that combining a direct Indianapolis multifamily acquisition with the existing $150K NXRT position creates concentrated Midwest multifamily exposure and suggested portfolio diversification considerations (+0.04)
- **Multi-scenario hold period**: Modeled both the 5-year/6.5% exit cap and the 7-year/6.0% exit cap scenarios (as the user requested), comparing IRRs and recommending which hold period is more attractive given the rate environment (+0.04)

### Step 7: Risk Assessment & Recommendation (+0.05)
- Identified key risks: thin positive leverage spread, rent growth sensitivity
- Gave a clear recommendation on base case vs. optimistic assumptions
- Suggested conservative underwriting (e.g., "use 2.5-3.0% as base, 3.5% as upside")

### Step 8: Actionable Output Format (+0.05)
- Used structured tables for the DCF and cash flow summary
- Provided clear, scannable formatting appropriate for a real estate professional

## Scoring Summary
- Step 1 + Step 3 both met: baseline 0.50
- Step 2 (contradiction handling): up to +0.10 (key differentiator)
- Step 4 (stress test): +0.05
- Step 5 (DCF model): +0.05
- Step 6 domain knowledge: each item +0.04 (max +0.20)
- Step 7 (risk & recommendation): +0.05
- Step 8 (output format): +0.05
- Theoretical max path: 0.50 + 0.10 + 0.05 + 0.05 + 0.20 + 0.05 + 0.05 = 1.00
- Outstanding performance (0.90+) requires at least partial credit on contradiction handling AND 3+ domain knowledge items"""

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
