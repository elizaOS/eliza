"""T09en_ticket_triage grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T017zh_ticket_triage")


class TicketTriageGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    # ------------------------------------------------------------------ #
    # LLM Judge rubric (English)
    # ------------------------------------------------------------------ #

    _TRIAGE_ANALYSIS_RUBRIC = """\
Evaluate the agent's ability to classify tickets, group related ones, and \
identify the red herring.
Score each of the three parts separately, then compute a weighted final \
score (0-1).

=== Part 1: Ticket Classification Quality (weight 30%) ===
The 10 tickets should be classified by category:
- CRM-related: TK-1001, TK-1003, TK-1006 (system faults)
- Hardware: TK-1002, TK-1008
- Network: TK-1005
- Service requests: TK-1004, TK-1007
- Other: TK-1009 (training survey), TK-1010 (email signature)

Each ticket should also receive a reasonable priority assignment.

Part 1 scoring:
- 0.9-1.0: All tickets correctly classified with reasonable priorities
- 0.7-0.8: Most tickets classified correctly, priorities mostly reasonable
- 0.5-0.6: About half the tickets classified correctly
- 0.3-0.4: Only a few tickets classified
- 0.0-0.2: Almost no classification

=== Part 2: CRM Ticket Grouping (weight 45%) ===
TK-1001, TK-1003, TK-1006 are all CRM system faults that should be identified as:
- Sharing the same root cause (CRM system issue)
- Needing batch handling/escalation
- Priority should be urgent/high

Part 2 scoring:
- 0.9-1.0: Clearly identified all three tickets as related, stated common root \
cause, recommended batch handling
- 0.6-0.8: Identified 2-3 tickets as related but root cause analysis unclear
- 0.3-0.5: Mentioned CRM tickets but didn't explicitly group them
- 0.0-0.2: Failed to identify CRM ticket correlation

=== Part 3: Red Herring Exclusion (weight 25%) ===
TK-1009 is a CRM training satisfaction survey, NOT a system fault:
- Although the title contains "CRM", it's unrelated to the system faults in \
TK-1001/1003/1006
- Should be explicitly excluded from the CRM fault group
- Should be classified as training/HR matter, not system fault

Part 3 scoring:
- 0.9-1.0: Clearly stated TK-1009 is not a system fault, correctly excluded \
from CRM fault group
- 0.5-0.8: Distinguished TK-1009 but explanation not explicit enough
- 0.0-0.4: Incorrectly grouped TK-1009 with CRM faults, or made no distinction

Output the final weighted score: score = 0.3×Part1 + 0.45×Part2 + 0.25×Part3"""
