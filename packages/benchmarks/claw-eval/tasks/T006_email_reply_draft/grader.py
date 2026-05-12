"""T03en_email_reply_draft grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T005zh_email_reply_draft")


class EmailReplyDraftGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    # ------------------------------------------------------------------ #
    # LLM Judge rubrics (English)
    # ------------------------------------------------------------------ #

    _CLIENT_DRAFT_QUALITY_RUBRIC = """\
Evaluate the quality of the agent's draft reply to the client (client@bigcorp.com).

Context: The client (Director Liu / BigCorp) emailed about a project delay. \
The agent needs to draft a professional reply.

A good client reply draft should include:
1. Acknowledging the project delay / progress issue
2. Providing specific action plans or steps to accelerate
3. Referencing key entities (client name/company, project details)
4. Professional and sincere tone showing client care
5. Mentioning relevant timelines or delivery dates

Scoring:
- 0.9-1.0: Draft is professional and complete — covers delay explanation, \
action plan, timeline commitment, appropriate tone
- 0.7-0.8: Draft covers main points but something is incomplete
- 0.4-0.6: Draft is too brief, missing concrete actions or timeline info
- 0.1-0.3: Draft exists but has almost no substantive content
- 0.0: No draft reply to client at all"""

    _THREAD_AWARENESS_RUBRIC = """\
Evaluate whether the agent identified the email thread relationship and \
demonstrated thread awareness in its reply.

Key thread information:
- msg_104 is a follow-up to msg_101 (same client client@bigcorp.com, same \
topic: project delay)
- msg_104 shows the client's urgency (waited a full day with no reply, \
management is asking)
- A good reply should show understanding of this thread context

Thread awareness indicators:
1. Draft acknowledges the client's multiple messages (e.g., "regarding your \
earlier message...")
2. Uses reply_to_message_id field to link to the original email
3. Reply reflects awareness of the client's urgency level
4. Treats both emails (msg_101 and msg_104) as the same issue

Scoring:
- 0.9-1.0: Clearly identified the thread, reply shows understanding of \
multiple messages and urgency
- 0.6-0.8: Identified thread but not fully reflected in draft
- 0.3-0.5: Some signs of thread awareness but not explicit
- 0.0-0.2: No thread awareness, treated each email independently"""

    _BOSS_DRAFT_QUALITY_RUBRIC = """\
Evaluate the quality of the agent's draft reply to the boss (boss@company.com).

Context: The boss forwarded a competitor analysis report (msg_105) about \
competitor Product A's pricing analysis. The agent needs to draft an \
appropriate reply.

A good boss reply draft should include:
1. Referencing the competitor analysis / report content
2. Showing understanding of the report or providing initial thoughts
3. Tone appropriate for upward communication

Scoring:
- 0.9-1.0: Draft is highly relevant to the competitor analysis report, \
with substantive response
- 0.6-0.8: Mentions the report but response lacks depth
- 0.3-0.5: Mentions the boss but weak connection to report content
- 0.0-0.2: No draft reply to boss or completely irrelevant content"""
