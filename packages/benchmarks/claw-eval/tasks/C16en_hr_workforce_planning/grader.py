"""C16en_hr_workforce_planning grader — multi-turn user-agent consultation: HR Workforce Planning."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA175HrWorkforcePlanningGrader(UserAgentClarifyGraderBase):
    """HR Workforce Planning — multi-turn user-agent evaluation."""

    DOMAIN = "HR Workforce Planning"
    MUST_ASK = [
        "What is the time horizon for the scenario modeling (e.g., next quarter, end of year)?",
        "Which team(s) or department(s) should the modeling focus on?",
        "What specific scenarios or variables does the VP want to see (e.g., attrition rates, backfill timelines, open reqs)?",
        "Do you have historical attrition data and current headcount data available to share, and in what format?"
]

    CLARIFICATION_RUBRIC = """Evaluate the quality of the assistant's clarification questions in the early part of the conversation (0.0-1.0).

The assistant should proactively ask about these key pieces of information:
  - What is the time horizon for the scenario modeling (e.g., next quarter, end of year)?
  - Which team(s) or department(s) should the modeling focus on?
  - What specific scenarios or variables does the VP want to see (e.g., attrition rates, backfill timelines, open reqs)?
  - Do you have historical attrition data and current headcount data available to share, and in what format?

Scoring criteria:
- 1.0: Proactively and systematically asked about all key information; questions are clear and well-organized
- 0.7-0.9: Asked about most key information, missed 1 item, but overall questioning logic is clear
- 0.4-0.6: Only asked about some information, or questions were disorganized, requiring user to repeatedly fill in gaps
- 0.1-0.3: Almost no proactive questioning; gave an answer based on incomplete information
- 0.0: No clarification behavior at all

Notes:
- If the user proactively provided some information, the assistant only needs to ask about what is missing
- Questions should be natural and friendly, not feel like an interrogation"""

    FINAL_ANSWER_RUBRIC = """Evaluate the quality of the assistant's final answer (0.0-1.0).

## Hidden Information (user's real parameters revealed during conversation — use to verify whether the assistant collected key information)
  - time_horizon: Through end of year (roughly 6 months)
  - focus_team: Platform engineering team specifically, after losing two senior engineers recently
  - scenarios_needed: Different attrition scenarios showing impact on platform engineering capacity; three approved reqs are open but recruiting has been slow
  - data_availability: User has historical attrition by team and current headcount with levels from BambooHR, willing to paste it directly
  - urgency: VP review moved to Friday — no time to onboard a new tool; needs the assistant to help build the scenario model directly

## Expected Output
A structured workforce scenario model framework for platform engineering through end of year, incorporating variable attrition rates, current headcount by level, the two recent senior departures, three open reqs with realistic fill-rate assumptions, and resulting capacity projections under best/base/worst cases.

## Reference Answer (Ground Truth — a standard answer generated from the complete hidden information, for quality comparison)
  Great question — there *are* tools that integrate with BambooHR for workforce planning (ChartHop, Orgnostic, Runn, even Visier Lite), but given your VP review is Friday, onboarding a new tool isn't realistic. Let's build the scenario model right now instead. Here's what I'd suggest:

**Platform Engineering Capacity Scenario Model (Now → End of Year)**

Before I build it out, I'd normally ask: What's the time horizon? Which team? What scenarios does the VP want? But based on your situation — let me frame this directly.

**Current State:**
- 2 senior engineers recently departed
- 3 approved reqs open (recruiting slow)
- Starting headcount: [paste your BambooHR data and I'll plug it in]

**Assumptions to set (you fill in):**
- Current team size by level (Sr/Mid/Jr)
- Historical annual attriti
  ...

## Evaluation Criteria (check each item)
  - Asks clarifying questions about time horizon, target team, and desired scenarios before attempting to build a model
  - Adapts from tool recommendation mode to hands-on scenario modeling assistance once urgency and constraints are revealed
  - Produces a structured scenario framework with at least three attrition scenarios (e.g., best/base/worst) and quantified capacity impact
  - Incorporates the specific context: two recent senior engineer departures, three open reqs with slow recruiting pipeline, and historical attrition data
  - Presents output in a format suitable for a VP-level review (clear, concise, decision-oriented)

## Scoring Levels
Compare the assistant's answer against the reference answer above:
- 1.0: Answer quality matches or exceeds the reference; key information and conclusions are consistent
- 0.7-0.9: Most key content covered; minor differences but direction is correct
- 0.4-0.6: Some key points covered, but missing important content or significant deviations
- 0.1-0.3: Large gap from reference answer; key conclusions missing or wrong
- 0.0: No useful answer provided"""

    TRAJECTORY_RUBRIC = """Evaluate the conversation trajectory quality (0.0-1.0).

## Key dimensions
- Did the assistant recognize the shift from "tool recommendation" to "build the model for me" when urgency was revealed?
- Did the assistant track evolving requirements (VP review moved to Friday, no time for new tools)?
- Tool use: did it use Bash to build actual scenario calculations?
- Search: did it search for BambooHR integration options or workforce planning best practices?

Scoring:
- 1.0: Perfect intent tracking, adapted to urgency, efficient tool use
- 0.7-0.9: Good tracking, minor gaps
- 0.4-0.6: Missed the urgency pivot or poor tool use
- 0.0-0.3: Failed to track user intent"""

    NUMERICAL_RUBRIC = """Evaluate numerical accuracy of workforce scenario modeling (0.0-1.0).

## Reference calculations (if the assistant builds a scenario model)
- Attrition rate scenarios: best (5%), base (10-15%), worst (20-25%) annual
- For a team of ~12 engineers losing 2 seniors: capacity impact = 2/12 = 16.7% immediate reduction
- 3 open reqs with typical fill time 3-6 months: expected fills by EOY under different scenarios
- Capacity projection: current headcount - attrition + new hires over 6 months

Scoring:
- 1.0: All scenario calculations correct, realistic assumptions
- 0.5-0.9: Scenarios built but some numbers off or assumptions unrealistic
- 0.0-0.4: No quantitative modeling or major calculation errors"""

    CONTENT_RUBRIC = """Evaluate content quality (0.0-1.0).

## Essential elements (missing → cap at 0.4)
- Structured scenario framework (best/base/worst cases)
- Quantified capacity projections incorporating the 2 departures and 3 open reqs

## Important (missing → cap at 0.6)
- Adapted from tool recommendation to hands-on modeling when urgency revealed
- Output suitable for VP-level review (concise, decision-oriented)

## Domain knowledge (+0.04 each)
- Realistic fill-rate assumptions for senior engineering roles
- Backfill vs. new hire distinction
- Contractor/interim staffing as risk mitigation
- Impact of seniority mix on team capacity (not just headcount)

## Scoring
- 1.0: Complete scenario model ready for VP review + domain expertise
- 0.5-0.8: Partial model or missing key elements
- 0.0-0.4: No structured output"""

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

        clarify_score = 0.0
        if self.CLARIFICATION_RUBRIC and clarify_conversation:
            try:
                result = judge.evaluate(prompt_text, clarify_conversation, "",
                                        self.CLARIFICATION_RUBRIC)
                clarify_score = result.score
                print(f"[grader] clarification score: {clarify_score:.2f}")
            except Exception as exc:
                print(f"[grader] clarification judge failed: {exc}")

        trajectory_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.TRAJECTORY_RUBRIC)
            trajectory_score = result.score
            print(f"[grader] trajectory score: {trajectory_score:.2f}")
        except Exception as exc:
            print(f"[grader] trajectory judge failed: {exc}")

        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] numerical score: {numerical_score:.2f}")
        except Exception as exc:
            print(f"[grader] numerical judge failed: {exc}")

        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.25 * numerical_score +
            0.40 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f}")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
