"""T146_task_backtracking grader — English variant of T180zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T145zh_task_backtracking")


class TaskBacktrackingGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only.

    All scoring logic (tool gates, LLM judge calls, weighting) is inherited
    from the ZH base grader unchanged.
    """

    _STATUS_RUBRIC = """\
Evaluate the accuracy of the assistant's status assessment for 3 follow-up items (0.0-1.0).

## Statuses that must be accurately determined
1. Q1 Summary Report (msg_1001 <-> TODO-801)
   - Status: in_progress, 60% complete
   - Data collection and preliminary analysis completed
   - Remaining: add March data, write summary section
   - Deadline: March 28 (2 days left)

2. Customization Proposal (msg_1002 <-> TODO-802)
   - Status: pending, 30% complete
   - Blocked: waiting for client to confirm 3rd requirement
   - Original 3/20 delivery already overdue
   - Key point: delay is not our fault, client requirements not finalized

3. Performance Evaluation Form (msg_1003 <-> TODO-803)
   - Status: completed, submitted on 3/23
   - HR may not have checked the system records

## Strict scoring
- 0.9-1.0: All 3 statuses correct, including progress and blocking information
- 0.7-0.8: All 3 roughly correct but missing details
- 0.5-0.6: 2 correct
- 0.3-0.4: Only 1 correct
- 0.0-0.2: Status assessments wrong
"""

    _CONTEXT_RUBRIC = """\
Evaluate whether the assistant integrated meeting note context (0.0-1.0).

## Meeting note information that must be referenced
1. NOTE-801 (Q1 Report Discussion)
   - Director Wang's 3 specific requirements (March data + year-over-year comparison + Q2 outlook)
   - Li Hua responsible for technical section data

2. NOTE-802 (Customization Proposal Discussion)
   - Client raised 3 customization requirements, first 2 are feasible
   - 3rd item (dashboard customization) needs client confirmation -> this is the specific explanation for the blocking reason
   - "Start full development only after confirmation"

3. NOTE-803 (Performance Discussion)
   - Confirmed that the evaluation form was mostly completed during the meeting
   - Completion time aligns with TODO-803

## Strict scoring
- 0.9-1.0: All 3 meeting notes correctly referenced, clear correlation analysis with task statuses
- 0.7-0.8: At least 2 meeting notes referenced
- 0.5-0.6: Meeting notes referenced but no deep correlation analysis
- 0.3-0.4: Only checked to-dos, did not check meeting notes
- 0.0-0.2: Did not check meeting notes
"""

    _RESPONSE_RUBRIC = """\
Evaluate the professionalism and relevance of the reply email drafts (0.0-1.0).

## Requirements for 3 replies

### Reply 1: To Director Wang (Q1 Report)
- Report current progress (60%) and completed portions
- Explain that March data and year-over-year analysis are being added per the 3/20 meeting requirements
- Commit to on-time submission by 3/28
- Tone: respectful to superior, concise and clear

### Reply 2: To Client Zhang Ming (Customization Proposal)
- Explain delay reason: 3rd requirement pending client internal confirmation
- State that first 2 items are ready for delivery
- Ask client to confirm 3rd requirement ASAP
- Provide estimated delivery time after confirmation (e.g., 2 weeks)
- Tone: professional, balanced, tactfully urge the client

### Reply 3: To HR Li Wei (Performance Evaluation)
- Inform that it was completed and submitted to the system on 3/23
- Ask them to confirm receipt
- Tone: friendly, brief

## Strict scoring
- 0.9-1.0: All 3 replies drafted, content accurate, tone appropriate, targeted
- 0.7-0.8: All 3 replies but some lack details
- 0.5-0.6: Only 2 drafted or content not targeted enough
- 0.3-0.4: Only 1 drafted
- 0.0-0.1: No reply drafts created
"""
