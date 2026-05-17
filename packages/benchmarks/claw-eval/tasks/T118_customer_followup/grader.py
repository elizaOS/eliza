"""T118_customer_followup grader — English variant of T152zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T117zh_customer_followup")


class CustomerFollowupGrader(_Base):  # type: ignore[misc]
    """English grader for T153: identify customers needing follow-up and draft emails.

    Inherits scoring logic from T152zh and overrides only Chinese rubric strings.
    """

    _IDENTIFICATION_RUBRIC = """\
Evaluate the accuracy of the assistant's identification of customers needing follow-up (0.0-1.0).

## Correct answer (today is 2026-03-26, threshold 30 days)
Need follow-up:
1. CUS-701 Dingxin Software (VIP) -- last contact Feb 10, 44 days ago -> needs follow-up
2. CUS-704 Public Institution (standard) -- last contact Jan 15, 70 days ago -> needs follow-up
3. CUS-705 Sunlight Media (VIP) -- last contact Feb 5, 49 days ago -> needs follow-up

Do not need follow-up:
- CUS-702 Hanhai E-commerce -- Mar 20 (6 days ago) -> not needed
- CUS-703 Wantong Logistics -- Feb 25 (29 days ago) -> not needed (under 30 days)
- CUS-706 Qianfeng Tech -- status=churned -> must be excluded

## Key judgments
- CUS-703 (29 days) should not be included (boundary case)
- CUS-706 must absolutely not be included (churned)

## Strict scoring
- 0.9-1.0: 3 correctly identified + correctly excluded CUS-703 and CUS-706
- 0.7-0.8: 3 correct but exclusion reasoning not clearly stated
- 0.4-0.6: 2 correct
- 0.0-0.3: Identification errors or churned customer included
"""

    _DIFFERENTIATION_RUBRIC = """\
Evaluate the differentiation between VIP and standard customer email styles (0.0-1.0).

## VIP customer emails (CUS-701 Dingxin, CUS-705 Sunlight) should include
- Formal salutation and greeting
- Reference to the partnership/history
- Expression of appreciation and importance of the client
- Personalized content (referencing email records)
  - CUS-701: respond to Q2 partnership plan discussion
  - CUS-705: follow up on upgrade interest, provide proposal information

## Standard customer email (CUS-704 Public Institution) should include
- Friendly but concise tone
- Inquiry about usage and satisfaction
- Willingness to help

## Strict scoring
- 0.9-1.0: Styles clearly differentiated, VIP more formal + personalized, standard more concise
- 0.6-0.8: Some differentiation but not pronounced enough
- 0.3-0.5: Email styles are similar
- 0.0-0.2: No drafts written or completely templated
"""

    _DRAFT_RUBRIC = """\
Evaluate the content quality of email drafts (0.0-1.0).

## Quality draft criteria
1. References historical communication content (for customers with email records)
2. Includes a clear follow-up purpose
3. Proposes next steps (schedule meeting, understand needs, etc.)
4. Tone appropriate for the customer relationship
5. Drafts are saved only, not sent directly

## Strict scoring
- 0.9-1.0: All 3 drafts have personalized content and clear purpose
- 0.6-0.8: At least 2 drafts have personalized content
- 0.3-0.5: Drafts too generic
- 0.0-0.2: No drafts written
"""
