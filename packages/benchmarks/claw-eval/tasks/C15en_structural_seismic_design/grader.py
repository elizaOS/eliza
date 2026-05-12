"""C15en_structural_seismic_design grader — multi-turn user-agent consultation: Structural / Seismic Facade Design."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA173StructuralSeismicFacadeDesiGrader(UserAgentClarifyGraderBase):
    """Structural / Seismic Facade Design — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "Structural / Seismic Facade Design"
    MUST_ASK = [
        "Which code system applies — IBC/ASCE 7 or GB 50011 (Chinese seismic code)?",
        "Cladding material, dead load, and subframe system",
        "Seismic intensity zone and design PGA",
        "Building height, number of stories, and floor level of the element",
        "Cantilever projection depth and current bracket/connection arrangement",
        "Panel dimensions and story height (for force calculation)",
        "Inter-story drift ratio and building importance class",
    ]

    CLARIFICATION_RUBRIC = """Evaluate the quality of the assistant's information gathering throughout the conversation (0.0-1.0).
Not only the first round of questions, but whether the assistant progressively deepened its inquiry to collect all decision-critical information.

## Basic Information (must collect; missing any item caps score at 0.7)
  - Which code system applies (GB 50011 vs IBC/ASCE 7)
  - Cladding system type and approximate dead load
  - Seismic intensity zone and design PGA
  - Building type, number of stories, and which floor the element is on
  - Cantilever projection depth

## Deeper Information (a good consultant would probe further; each item adds credit)
  - Exact dead load (0.8 kN/m²) and panel dimensions (1.5m × 3.0m)
  - Story height (3.3m) — needed for drift calculation
  - Current bracket arrangement (top-fixed only vs top-and-bottom)
  - What the reviewer specifically cited and what the structural engineer said
  - Inter-story drift ratio from structural analysis
  - Building importance class (丙类 vs 乙类)
  - Thermal expansion gap dimension (15mm)

## Scoring Criteria
- 1.0: All basic info collected + proactively asked for 3+ deeper items
- 0.8-0.9: All basic info collected + proactively asked for 1-2 deeper items
- 0.7: All basic info collected, but no deeper probing
- 0.4-0.6: Basic info missing 1-2 items
- 0.1-0.3: Almost no proactive questioning; gave an answer based on incomplete information
- 0.0: No clarification behavior at all

Notes:
- If the user proactively provided some information, the assistant only needs to ask about what is missing
- Deeper information need not be asked all at once — natural follow-up across multiple turns is fine"""

    TRAJECTORY_RUBRIC = """Evaluate the entire conversation trajectory — the assistant's understanding, responsiveness, and tool use quality (0.0-1.0).
Do not just evaluate the final answer; examine each turn.

## Evaluation Dimensions

### 1. Information Gap Identification
- The user's initial query is vague ("a clause about cantilever projections," "some recent code updates")
- Did the assistant immediately recognize missing critical parameters (which code, which clause, what building, what cladding) and ask before giving substantive advice?
- Or did it guess/assume and give a generic answer first?

### 2. Contradiction Detection
Two contradictions are embedded in the user's information:
- **Code clause vs cantilever limit**: The user says "the review office flagged clause 3.4.3" AND "the structural engineer said the 1200mm projection violates the cantilever limit." GB 50011 clause 3.4.3 is about general nonstructural seismic performance requirements, NOT a specific cantilever dimension limit. A good assistant should notice these might be different provisions and ask for clarification.
- **Drift ratio anomaly**: The user mentions a drift ratio of ~1/600 for a 9-story RC frame, described as "close to the 1/550 limit." For a typical 9-story RC frame under frequent earthquake, drift ratios of 1/800 to 1/1200 are more common. 1/600 is unusually high and may indicate the engineer was quoting the rare earthquake (elastic-plastic) drift, or the structure has stiffness issues. A perceptive assistant would flag this.

Scoring for contradiction handling:
- Noticed both contradictions and analyzed them: no deduction
- Noticed one contradiction: -0.05 to -0.10
- Noticed neither: -0.15 to -0.20

### 3. Need Evolution Tracking
- The user's need evolves from "check the code clause" to "give me a bracket connection detail concept to present to the structural engineer"
- Did the assistant track this evolution and shift from code interpretation to practical design guidance?

### 4. Tool Use Quality (computation tools)
- Did the assistant use Bash for seismic force calculations rather than mental arithmetic?
- Timing: calculated after collecting sufficient parameters, not before
- **Error handling (strict)**:
  - One-shot correct = best, no deduction
  - Error then self-correction = acceptable, deduct 0.1-0.2
  - Error undetected, wrong result presented = serious, deduct 0.3-0.5

### 5. Search Tool Use Quality
This task involves Chinese building codes (GB 50011, JGJ 133) which have specific clause numbers and provisions. A good assistant should search to verify:
- The exact content of GB 50011 clause 3.4.3 and Appendix M
- JGJ 133 provisions for curtain wall seismic design
- Current interpretation or commentary on the cantilever vs. supported cladding distinction

**Search quality assessment:**
- Excellent (no deduction): Targeted searches for specific code clauses, 1-3 searches covering key references, results correctly integrated
- Good (deduct 0.05): Searched but queries not precise enough, 4-5 searches needed
- Fair (deduct 0.10): Excessive searching (6+ times) or repeated searches for same content
- Poor (deduct 0.15): Searched but results not used, or incorrect information not filtered
- No search (deduct 0.10): Did not search at all, relied on memory for specific code clause content — risk of hallucinating clause details. If memory was actually correct, reduce deduction to 0.05

### 6. Conversation Pacing
- Did the assistant give intermediate conclusions at appropriate points, rather than only asking questions endlessly?
- When the user asked follow-up questions, did the assistant transition smoothly?

## Scoring Levels
- 1.0: Every turn shows precise understanding; contradictions caught and analyzed; tools used efficiently; need evolution tracked perfectly
- 0.7-0.9: Overall good understanding; tool use mostly appropriate; may have missed one contradiction or had minor tool use issues
- 0.4-0.6: Some turns show clear misunderstanding (e.g., ignored the code clause confusion, missed drift anomaly); or poor tool use
- 0.1-0.3: Multiple turns with intent misunderstanding or information loss
- 0.0: Complete failure to track user intent"""

    NUMERICAL_RUBRIC = """Evaluate ONLY the numerical/engineering calculation accuracy in the assistant's response (0.0-1.0). Ignore content quality, advice quality, etc. — only check whether the numbers are correct.

## Topic Consistency (pre-check)
The original question is about seismic facade design under GB 50011 — cantilever projections, cladding seismic forces, and bracket connections.
If the assistant's final answer completely deviates from this topic, score 0.

## User-Provided Parameters
  - Applicable code: GB 50011, intensity 7度, PGA 0.10g
  - Cladding dead load: 0.8 kN/m² all-in
  - Building: 9-story RC frame, element at 4th floor (~mid-height)
  - Cantilever projection: 1200 mm
  - Panel size: ~1.5m × 3.0m, story height: 3.3m
  - Drift ratio from structural analysis: ~1/600

## Correct Reference Values (computed by program)

**Seismic Force on Cladding (GB 50011 Appendix M method):**

| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Height ratio z/H (4th floor / 9 stories) | **0.444** | ±0.05 |
| Position coefficient ζ1 = 1 + z/H | **1.444** | ±0.1 |
| αmax (intensity 7, frequent earthquake) | **0.08** | exact |
| F_ek per unit area | **0.092 kN/m²** | ±0.02 kN/m² |

**Seismic Force (JGJ 133 curtain wall method, alternative):**

| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Dynamic amplification βE | **5.0** | ±1.0 |
| qEk per unit area | **0.32 kN/m²** | ±0.08 kN/m² |

**Bracket Connection Forces (for 1.5m × 3.0m panel at 1.2m standoff):**

| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Panel weight | **3.60 kN** | ±0.5 kN |
| Dead load eccentricity moment | **4.32 kN·m** | ±0.6 kN·m |
| Horizontal reaction per bracket (from eccentricity) | **1.44 kN** | ±0.3 kN |
| Vertical force per bracket | **1.80 kN** | ±0.3 kN |

**Inter-Story Drift Check:**

| Check Item | Correct Value | Tolerance |
|------------|---------------|-----------|
| Drift limit (frequent, RC frame): 1/550 × 3300mm | **6.0 mm** | ±1.0 mm |
| Drift limit (rare earthquake): 1/50 × 3300mm | **66.0 mm** | ±10 mm |

## Scoring Rules (strict — do not let content quality influence this score)
- 1.0: All verifiable numbers within tolerance; both seismic force and bracket force calculations correct
- 0.7-0.9: Seismic force calculation correct; bracket force or drift calculations have small deviations
- 0.4-0.6: One major calculation method correct but the other has significant errors; or used wrong αmax / wrong formula
- 0.2-0.3: Basic approach correct but most numerical results are outside tolerance
- 0.0-0.1: Used wrong code entirely (e.g., ASCE 7 formula instead of GB 50011); or no calculations at all
- If the assistant used parameters inconsistent with what the user provided (e.g., different PGA, different dead load), score 0"""

    CONTENT_RUBRIC = """Evaluate the content quality of the assistant's response (0.0-1.0). Do not consider numerical accuracy — only completeness, professional depth, and practical usefulness.

## Topic Consistency (pre-check)
The original question is about seismic facade design under GB 50011. If the response completely deviates from this topic, score 0.

## User's Full Situation (revealed gradually during conversation)
  - 9-story RC frame, 4th floor, 1200mm aluminum cladding projection on steel subframe
  - GB 50011, intensity 7度, PGA 0.10g, dead load 0.8 kN/m²
  - Reviewer flagged clause 3.4.3; structural engineer said 1200mm violates cantilever limit
  - Current subframe: top-fixed brackets only (single anchor row into slab edge beam), no bottom restraint
  - Structural drift ratio ~1/600, building importance class 丙类 (C)
  - 15mm thermal gap in horizontal joints
  - User wants a bracket connection detail concept to present to the structural engineer

## Key Contradictions (high-quality answers should detect and analyze)

**Contradiction 1: Code clause vs cantilever limit**
- User says "review office flagged clause 3.4.3" AND "structural engineer said 1200mm violates cantilever limit"
- GB 50011 clause 3.4.3 is about general nonstructural seismic requirements, NOT a dimensional cantilever limit
- A good assistant should recognize these are likely different provisions and clarify

**Contradiction 2: Drift ratio anomaly**
- User reports drift ratio ~1/600 for a 9-story RC frame
- Typical frequent-earthquake drift for such buildings is 1/800 to 1/1200
- 1/600 being "close to" the 1/550 limit is unusual — may be rare-earthquake drift or a stiffness issue
- A good assistant should question which load case the 1/600 corresponds to

## Evaluation Criteria — Complete Decision Chain (6 Steps)

### Step 1: Code Framework and Classification (essential — missing caps at 0.4)
- Correctly identifies GB 50011 (not IBC) as the governing code
- Explains clause 3.4.3 and references Appendix M for nonstructural elements
- Mentions JGJ 133 as the companion curtain wall standard
- Clearly distinguishes supported cladding (top-and-bottom anchorage) from true structural cantilever per code definitions

### Step 2: Contradiction Analysis (key differentiator, +0.15)
- **Code clause clarification**: Notes that clause 3.4.3 and "cantilever limit" may be different provisions, explains what each actually covers (+0.05)
- **Drift ratio questioning**: Flags that 1/600 is unusually close to the limit for a 9-story RC frame under frequent earthquake, suggests verifying which load case applies (+0.05)
- **Cross-verification**: Uses calculated seismic forces or code provisions to verify whether the 1200mm projection is actually problematic under the correct interpretation (+0.05)
- If the assistant simply accepts all user-provided information without verification, this item scores 0

### Step 3: Seismic Force Analysis (essential — missing caps at 0.6)
- Computes or estimates seismic force on the cladding using GB 50011 Appendix M or JGJ 133 method
- Uses the correct parameters (PGA 0.10g, position factor for 4th floor, dead load 0.8 kN/m²)
- Compares seismic force to wind load or other lateral loads for context

### Step 4: Professional Knowledge (bonus, each +0.04)
- **Cantilever vs. supported distinction with citation**: Provides specific code clause or commentary references the user can cite in a meeting, not just a general statement (+0.04)
- **Drift accommodation design**: Analyzes whether the 15mm thermal gap is sufficient for seismic drift and explains what additional clearance is needed (+0.04)
- **Connection redundancy**: Explains why single-row top-fixed brackets fail the code check and why top-and-bottom restraint changes the structural classification (+0.04)
- **Importance class implications**: Notes that 丙类 building has specific coefficient values, and whether upgrading to 乙类 would change the design requirements (+0.04)

### Step 5: Connection Detail Concept (+0.05)
- Proposes a top-and-bottom bracket arrangement with clear load path description
- Addresses key design considerations: gravity load bearing, seismic restraint, thermal movement, drift accommodation
- Detail is specific enough for the user to have a credible technical discussion with the structural engineer

### Step 6: Actionable Next Steps (+0.04)
- Provides specific actions: which calculations to prepare, what to discuss with the structural engineer, how to respond to the reviewer
- Uses structured format (table or checklist) for easy reference

## Scoring Summary
- Step 1 + Step 3 both satisfied: base score 0.5
- Step 2 (contradiction analysis): up to +0.15 (the key differentiator)
- Step 4 each knowledge point: +0.04 (max +0.16)
- Step 5: +0.05
- Step 6: +0.04
- Theoretical max path: 0.5 + 0.15 + 0.16 + 0.05 + 0.04 = 0.90
- Exceptionally thorough answers may receive up to 1.0"""

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
