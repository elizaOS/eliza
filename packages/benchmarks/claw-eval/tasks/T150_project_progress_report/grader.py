"""T150_project_progress_report grader — English variant of T184zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T149zh_project_progress_report")


class ProjectProgressReportGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only.

    All scoring logic (tool gates, LLM judge calls, weighting) is inherited
    from the ZH base grader unchanged.
    """

    _PROGRESS_RUBRIC = """\
Evaluate the accuracy of progress data for three projects (0.0-1.0).

## Alpha Project (Progress ~75%, on track)
To-dos (4): TODO-601 completed, TODO-602 completed, TODO-603 in_progress, TODO-604 completed
Completion rate: 3/4 = 75% (or ~60-80% combining meeting action items)
Action items: 5 (3 from NOTE-601 + 2 from NOTE-602), 3 completed, 1 in progress, 1 not started
Status: On track, technical feasibility report in progress

## Beta Project (Progress ~20-45%, severely delayed)
To-dos (5): TODO-605 completed, TODO-606 in_progress, TODO-607 pending (blocked), TODO-608 pending, TODO-609 in_progress
Completion rate: 1/5 = 20% (combining action items ~30-45%)
Action items: 5 (3 from NOTE-603 + 2 from NOTE-604), 1 completed, 2 in progress/blocked, 2 pending
Status: Delayed by ~1 week, has blocked items

## Gamma Project (Progress ~90-100%, near completion)
To-dos (3): TODO-610 completed, TODO-611 completed, TODO-612 completed
Completion rate: 3/3 = 100% (but 3/24 delivery review has no notes, overall ~90%)
Action items: 2 (from NOTE-605), all completed
Status: Near completion

## Strict scoring
- 0.9-1.0: All three projects' progress data accurate, completion rates correctly calculated
- 0.7-0.8: At least 2 projects' progress accurate
- 0.4-0.6: At least 1 project accurate, others roughly correct
- 0.0-0.3: Progress data seriously wrong or missing
"""

    _RISK_RUBRIC = """\
Evaluate the completeness and accuracy of risk identification (0.0-1.0).

## Risks that must be identified

### Beta Project Critical Risks (most important)
1. TODO-607 Frontend prototype design blocked -- waiting for third-party API docs, and already overdue (due 3/22)
2. TODO-608 API development pending (high priority) -- depends on unfinished database design (TODO-606)
3. Overall progress behind by ~1 week (NOTE-604 meeting conclusion explicitly states this)
4. Third-party API documentation block is the core bottleneck, affecting both frontend and backend

### Alpha Project Attention Items
5. TODO-603 Technical feasibility report due 3/25, still in progress -- needs monitoring
6. NOTE-602 action item 2 (microservice architecture plan) depends on feasibility report -- cascading dependency

### Gamma Project Attention Items
7. evt_606 (3/24 delivery review) has no meeting notes -- needs follow-up

## Strict scoring
- 0.9-1.0: All Beta core risks (1-4) identified, Gamma missing notes also flagged
- 0.7-0.8: Beta main risks identified (at least 3)
- 0.4-0.6: Some risks identified but incomplete
- 0.0-0.3: Critical risks not identified
"""

    _REPORT_RUBRIC = """\
Evaluate the completeness and professionalism of the progress report (0.0-1.0).

## A qualifying report should include
1. Structured report grouped by project (one section each for Alpha/Beta/Gamma)
2. Meeting list and note summaries for each project
3. Action item checklist with completion status comparison
4. To-do completion rate statistics
5. Project leads and contact information (email/phone)
6. Risk annotations and recommendations
7. Priority or attention ranking across projects (Beta needs most attention)

## Lead Contact Information
- Wang Ming (Project Manager): wangming@company.com, 13900139001 -> Alpha, Gamma
- Li Hua (Architect): lihua@company.com, 13900139002 -> Alpha
- Zhao Lei (Product Manager): zhaolei@company.com, 13900139003 -> Beta, Gamma
- Zhang Wei (Backend Dev): zhangwei@company.com, 13900139004 -> Beta
- Ma Qiang (Ops): maqiang@company.com, 13900139005 -> Alpha
- Zhou Ming (Frontend Dev): zhouming@company.com, 13900139006 -> Beta

## Strict scoring
- 0.9-1.0: All 7 items included, clear and professional structure
- 0.6-0.8: 5-6 items, reasonable structure
- 0.3-0.5: 3-4 items, missing key information
- 0.0-0.2: Report incomplete or unstructured
"""
