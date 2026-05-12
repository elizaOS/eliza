"""C17en_devops_sop_design grader — multi-turn user-agent consultation: DevOps SOP Design."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA181DevopsSopDesignGrader(UserAgentClarifyGraderBase):
    """DevOps SOP Design — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.25 * numerical + 0.40 * content
    """

    DOMAIN = "DevOps SOP Design"
    MUST_ASK = [
        "What is the specific organizational problem or pain point driving this request (e.g., which teams are out of the loop)?",
        "What deliverable format do you need — a quick recommendation, a full SOP document, or something else?",
        "Which specific roles/teams need to be notified and what are their responsibilities in the release process?",
        "Do you need escalation paths or failure-handling procedures included?",
        "What CI/CD platform and Jira tier are you using? What is the current Slack/Confluence setup?",
        "Are there any conflicting stakeholder requirements or budget constraints?",
    ]

    CLARIFICATION_RUBRIC = """Evaluate the quality of the assistant's information gathering throughout the conversation (0.0-1.0).
Not just the first round — look at whether the assistant progressively deepened its understanding across the entire dialogue.

## Batch 1 — Basic parameters (must collect; missing any => cap at 0.7)
  - The specific organizational pain point (which teams are out of the loop and how)
  - Deliverable format (full SOP document for eng-leads sync)
  - Which roles/teams need notifications (Eng, QA, CS, TAM) and their responsibilities
  - Whether escalation paths and failure-handling are needed

## Batch 2 — Technical environment (good consultant probes further; each item adds score)
  - CI/CD platform (GitHub Actions) and deployment trigger mechanism (release/staging branch merge)
  - Jira tier (Cloud Premium) and whether Deployments feature is enabled
  - Current Slack setup (manual posting, existing channels, fragile custom bot)
  - Confluence setup (manual Release Notes page creation, often late)
  - Team size and structure (~40 engineers/4 squads, 6 QA, 8 CS, 4 TAMs)

## Batch 3 — Deep details (excellent consultant digs into these)
  - Deployment tracking status contradiction (engineer says configured, user doesn't see data)
  - Stakeholder conflict (VP wants zero manual steps vs Head of CS wants human review gate)
  - Forge migration concern (rumor about Jira Automation webhook deprecation)
  - Budget constraint (no new paid tools this quarter)

Scoring:
- 1.0: All Batch 1 collected + probed into Batch 2 (3+ items) + asked about 2+ Batch 3 items
- 0.8-0.9: All Batch 1 + most of Batch 2 + touched 1 Batch 3 item
- 0.7: All Batch 1 collected, but did not probe into Batch 2 or 3
- 0.4-0.6: Batch 1 missing 1-2 items
- 0.1-0.3: Almost no proactive questioning; gave answer based on initial prompt alone
- 0.0: No clarification behavior at all

Notes:
- If the user proactively provided some information, the assistant only needs to ask about what is missing
- Questions should be natural and well-organized, not feel like an interrogation
- Asking about technical environment and constraints is essential for a credible SOP"""

    TRAJECTORY_RUBRIC = """Evaluate the entire conversation trajectory — how well the assistant tracked intent, used tools, and managed the dialogue (0.0-1.0).
Do not just evaluate the final answer; examine each turn of the conversation.

## Evaluation Dimensions

### 1. Information Gap Identification
- The initial query is broad; the assistant should recognize it lacks specifics about the user's CI/CD stack, Jira tier, current notification setup, team structure, and constraints
- Did the assistant identify these gaps early and ask systematically, or did it jump to a generic answer first?

### 2. Contradiction Detection
- The user will reveal that their DevOps engineer claims Jira Deployment Tracking is configured, but the user cannot see deployment data in the board view
- Did the assistant catch this contradiction and explore possible causes (permissions, misconfiguration, API vs UI mismatch)?
- The user's VP wants zero manual steps but the Head of CS wants a human review gate — did the assistant recognize this as a conflict and propose a reconciliation?

### 3. Requirement Evolution Tracking
- The conversation may evolve from "best practices question" to "build me a full SOP"
- Did the assistant adapt its depth and format accordingly?

### 4. Tool Usage Quality (web_search and web_fetch)
This task involves time-sensitive technical information — a good assistant should search to verify rather than rely on potentially outdated training data.

**Search necessity:**
- Jira Deployments API maturity and current capabilities — should search to verify
- Whether Atlassian is actually deprecating "incoming webhook" triggers in Jira Automation in favor of Forge — the user heard a rumor and a good assistant should verify
- GitHub Actions deployment event triggers and Jira integration options
- Current Slack API best practices for webhook reliability

**Search quality scoring:**
- Excellent (no deduction): Targeted searches (1-4), results correctly integrated into recommendations
- Good (deduct 0.05): Searched but queries imprecise, needed 5-6 attempts
- Fair (deduct 0.10): Excessive searching (7+) or repeated searches for same topic
- Poor (deduct 0.15): Searched but ignored or misinterpreted results
- No search (deduct 0.10): Did not search at all, gave recommendations based purely on training data for time-sensitive technical claims. Reduced to 0.05 deduction if training data happened to be accurate

### 5. Conversation Pacing
- Did the assistant give interim summaries or structure proposals before diving into the full SOP?
- Did it confirm understanding before producing a lengthy deliverable?

### 6. Computation Tool Usage
- If the assistant used Bash to generate a template, validate YAML/JSON configs, or draft the SOP structure — this shows thoroughness
- Not required, but a positive signal if used appropriately

## Scoring
- 1.0: Every turn shows precise intent tracking; contradictions identified and explored; tools used efficiently; pacing appropriate
- 0.7-0.9: Overall good tracking, tools used reasonably, minor gaps in one dimension
- 0.4-0.6: Noticeable gaps — missed contradictions, or poor tool usage, or jumped to answer without sufficient information
- 0.1-0.3: Multiple turns show intent misunderstanding or information loss
- 0.0: Completely failed to track user intent"""

    NUMERICAL_RUBRIC = """Evaluate the technical accuracy of the assistant's recommendations (0.0-1.0).
This is NOT about numerical calculations — it is about whether tool references, API names, configuration steps, and architectural claims are factually correct.

## Topic Consistency (pre-check)
The original question is about automated release notifications across Jira, Slack, and Confluence triggered by CI staging deployments.
If the assistant's final answer completely deviates from this topic, score 0.

## Technical Accuracy Checkpoints

### Jira Integration (verify each claim)
| Claim Area | Correct Reference | Common Errors |
|---|---|---|
| Jira Deployments API | Uses REST API v2 or Jira Cloud DevOps endpoints under /rest/deployments/0.1 (or the newer builds/deployments API) | Confusing it with Jira Server APIs, or citing non-existent endpoints |
| Jira Automation triggers | "Deployment status changed" trigger exists in Jira Cloud; "incoming webhook" trigger is available (as of 2025, NOT deprecated despite Forge push) | Claiming incoming webhook trigger is deprecated, or claiming triggers that don't exist |
| Jira Cloud Premium features | Deployments feature is available on Jira Cloud (Free, Standard, Premium, Enterprise) via connecting CI/CD tools | Claiming it requires Enterprise tier only |

### Slack Integration
| Claim Area | Correct Reference | Common Errors |
|---|---|---|
| Webhook approach | Slack Incoming Webhooks or Slack API chat.postMessage via bot token | Citing deprecated legacy webhook URLs without noting migration |
| Channel routing | Can route to multiple channels programmatically based on payload content | Claiming Slack webhooks are limited to a single channel |

### GitHub Actions Integration
| Claim Area | Correct Reference | Common Errors |
|---|---|---|
| Deployment events | GitHub Actions supports "deployment" and "deployment_status" events; also supports creating deployments via API | Confusing workflow_run with deployment events |
| Jira integration | Official GitHub for Jira app or direct API calls from workflow steps | Citing non-existent native integration |

### Confluence Integration
| Claim Area | Correct Reference | Common Errors |
|---|---|---|
| Page creation API | Confluence Cloud REST API v2 (/wiki/api/v2/pages) or v1 (/wiki/rest/api/content) | Citing Server-only APIs for a Cloud instance |
| Automation | Can be triggered from CI pipeline via API call, or via Confluence automation rules | Claiming Confluence has native CI/CD triggers |

### Forge Migration (critical — the user asked about this rumor)
| Claim Area | Correct Reference | Common Errors |
|---|---|---|
| Forge vs Jira Automation | Forge is Atlassian's app development platform; Jira Automation is a separate feature. Atlassian has been pushing Forge for custom apps but has NOT deprecated Jira Automation's incoming webhook trigger as of 2025 | Confirming the deprecation rumor as fact, or completely ignoring the question |
| Recommendation | A good answer acknowledges the Forge direction while noting that Jira Automation webhooks remain functional today, and recommends monitoring Atlassian's roadmap | Recommending a full Forge rewrite unnecessarily, or dismissing the concern entirely |

## Scoring Rules (strict)
- 1.0: All API references, tool names, and architectural claims are verifiably correct; Forge question addressed accurately
- 0.7-0.9: Most technical references correct; minor inaccuracies in 1-2 areas (e.g., slightly wrong API path but correct concept)
- 0.4-0.6: Several technical inaccuracies, or major error in one area (e.g., confirming the Forge deprecation rumor as fact)
- 0.2-0.3: Multiple major technical errors that would lead to a broken implementation
- 0.0-0.1: Completely fabricated technical details or fundamentally wrong architecture"""

    CONTENT_RUBRIC = """Evaluate the content quality of the assistant's final SOP deliverable (0.0-1.0).
Do not evaluate technical accuracy (that is scored separately) — focus on completeness, structure, domain expertise, and decision quality.

## Topic Consistency (pre-check)
The original question is about automated release notifications across Jira, Slack, and Confluence for staging deployments.
If the assistant's final answer completely deviates from this topic, score 0.

## User's Full Context (revealed gradually in conversation)
  - Pain point: QA misses staging deploys, CS can't time client comms, TAMs blindsided
  - Deliverable: Full SOP for Monday eng-leads sync
  - Teams: Eng (~40, 4 squads), QA (6), CS (8), TAM (4)
  - CI/CD: GitHub Actions, merge to release/staging branch
  - Jira Cloud Premium, Deployments feature not yet enabled
  - Slack: manual posting, fragile custom bot, dedicated channels exist
  - Confluence: manual Release Notes page, often late
  - Contradiction: DevOps engineer says Deployment Tracking configured, but user sees no data
  - Conflict: VP wants zero manual steps vs Head of CS wants human review gate
  - Rumor: Jira Automation incoming webhook trigger may be deprecated for Forge
  - Budget: No new paid tools this quarter

## Key Contradiction (high-quality answers should address)
  - The DevOps engineer claims Jira Deployment Tracking is set up via REST API, but the user sees nothing in the board view. Possible causes: the deployment data is being sent but the Deployments panel isn't enabled on the board, permissions issue, or the integration was never completed properly.
  - VP vs Head of CS conflict: Zero automation vs human gate. A good SOP reconciles this with a "conditional gate" pattern — auto-notify internal teams (Eng, QA) immediately, but route CS/TAM notifications through a review step (e.g., Slack approval workflow or Jira transition gate).

## Evaluation: Complete Decision Chain (6 steps)

### Step 1: Architecture Design (required; missing => cap at 0.4)
- Proposed a clear notification flow: CI event -> multiple notification targets
- Covered all three tools (Jira, Slack, Confluence) with specific trigger mechanisms
- Addressed the "native Jira trigger vs CI webhook" question with a clear recommendation

### Step 2: Contradiction and Conflict Resolution (key differentiator, +0.15)
- **Deployment tracking investigation**: Acknowledged the discrepancy between engineer's claim and user's observation; proposed diagnostic steps (check board settings, verify API responses, check permissions) (+0.05)
- **Stakeholder conflict reconciliation**: Proposed a workable pattern that satisfies both VP (automation) and Head of CS (human review) — e.g., auto-notify Eng/QA immediately, CS/TAM get draft notification that requires approval (+0.05)
- **Forge rumor handling**: Addressed the Forge migration concern with actionable guidance — build on current stable features but design for portability (+0.05)

### Step 3: Role-Based Notification Matrix (required; missing => cap at 0.6)
- Defined what each team (Eng, QA, CS, TAM) receives, when, via which channel
- Specified notification content differences per role (Eng gets technical details, CS gets client-impact summary, TAM gets feature highlights)

### Step 4: Domain Expertise (bonus items, each +0.04)
- **Escalation paths**: Defined specific failure scenarios (webhook fails, Jira API down, Slack message not delivered) with escalation procedures and owners (+0.04)
- **Idempotency and retry logic**: Mentioned the need for idempotent webhook handlers or retry mechanisms to handle the "fragile bot" problem (+0.04)
- **Deployment environment progression**: Addressed how the SOP extends from staging to production (or explicitly scoped it to staging only with a note about future extension) (+0.04)
- **Audit trail / observability**: Recommended logging notification delivery status for debugging (addressing the current "fragile bot" issue) (+0.04)
- **Rollback notification handling**: Covered what happens when a staging deployment is rolled back — reverse notifications or status updates (+0.04)

### Step 5: Actionable Recommendations (bonus, +0.05)
- Gave specific, prioritized implementation steps (what to do first, second, third)
- Considered the budget constraint (no new paid tools) and worked within existing licenses
- Recommendations are tailored to the user's specific stack, not generic advice

### Step 6: Document Quality (bonus, +0.04)
- SOP is structured with clear sections, suitable for an eng-leads sync meeting
- Includes ownership assignments, review cadence, and version control
- Uses tables, checklists, or structured formatting for easy reference

## Scoring Summary
- Step 1 + Step 3 both satisfied: base score 0.5
- Step 2 (contradictions/conflicts): up to +0.15 (this is the key differentiator)
- Step 4 each expertise item: +0.04 (max +0.20)
- Step 5: +0.05
- Step 6: +0.04
- Theoretical max path: 0.5 + 0.15 + 0.20 + 0.05 + 0.04 = 0.94
- Exceptionally insightful answers (e.g., identified risks the user didn't think of) may reach 1.0"""

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

        # 3. Technical accuracy (25%)
        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] numerical/technical score: {numerical_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] numerical judge failed: {exc}")

        # 4. Content quality (40%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 20% trajectory + 25% numerical + 40% content
        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.25 * numerical_score +
            0.40 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.20 "
              f"+ numerical={numerical_score:.2f}*0.25 + content={content_score:.2f}*0.40)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
