# Agent Coordination In GitHub

This is the canonical workflow for coordinating humans and coding agents in
`elizaOS/eliza` with GitHub Issues, Projects, Pull Requests, and Discussions.
Do not make a tracking issue comment thread the only place where agents can
learn the rules.

## Where Guidance Lives

- `AGENTS.md` / `CLAUDE.md`: mandatory bootstrap rules every coding agent is
  expected to read.
- `docs/AGENT_COORDINATION.md`: the full project, kanban, discussion, and
  tracking-issue workflow.
- Package-local `AGENTS.md` / `CLAUDE.md`: package-specific build/test/layout
  notes only.
- `README.md`: human-facing discovery links, not the full operating contract.
- GitHub Project readmes: board-specific links and column semantics.
- Issue bodies: work-specific scope, acceptance criteria, and evidence plans.
- Discussions: live coordination, handoffs, and decisions. If a decision changes
  the workflow, roll it back into this doc or the relevant issue body.

## Surface Contracts

- **Issues are work cards.** Use one issue per bug, task, follow-up, or
  verifiable slice. The issue owns scope, acceptance criteria, blockers, and
  evidence links.
- **Projects are state.** The GitHub Project board owns current status,
  ordering, and ownership fields. Do not duplicate the same work into another
  board unless a maintainer explicitly creates a successor board.
- **Pull requests are code plus proof.** A PR links its issue/card and carries
  the `PR_EVIDENCE.md` proof needed to review the change without reading the
  code.
- **Discussions are coordination rooms.** Use Discussions for intros, handoffs,
  long-form status, noisy coordination, and cross-card questions. Do not use a
  Discussion as the only acceptance record for a task.
- **Tracking issues are summaries, not chat rooms.** Epics and trackers are
  useful for goals and rollups. When comments become a live chat log, create or
  move to a Discussion and edit the tracker body to point there.

## Project Board Fields

Use the fields already present on the active board before adding new ones.

- `Status`: must reflect the real state of the card.
- `Claimed by`: the lane tag or agent tag doing the work, for example
  `[cloud-agent]`.
- `Assignees`: GitHub users responsible for the work or operating the agent.
- `Labels`: area and workflow labels. Use existing labels when they fit.
- Linked pull requests: keep PRs connected to their work issue.

Standard status flow:

1. `Todo`: ready and unclaimed.
2. `Claimed`: an owner has committed to the card but is not actively mutating
   code or infrastructure yet.
3. `In progress`: the owner is actively working.
4. `Needs-agent-verify`: the owner posted evidence and another agent should
   check it.
5. `needs-human-verify`: agent verification is done or not applicable; a human
   needs to test or approve.
6. `Done`: only the managing human or maintainer moves cards here unless the
   board explicitly says otherwise.

## Agent Session Bootstrap

Before claiming work:

1. Read root `AGENTS.md` or `CLAUDE.md`.
2. Read every package-local `AGENTS.md` or `CLAUDE.md` for files you expect to
   touch.
3. Read `PR_EVIDENCE.md`.
4. Read the active Project readme and scan the board columns.
5. Read the issue/card you plan to claim, linked PRs, and the newest relevant
   Discussion updates.
6. Check for an already-open PR or claimed card before starting. Avoid competing
   PRs for the same scope.

## Claim Loop

1. Pick a `Todo` card that matches your abilities and access.
2. Comment on the work issue: `CLAIMING: <scope>` and sign with your lane tag.
3. Set `Status = Claimed` and `Claimed by = <tag>` on the Project item.
4. Move to `In progress` when you start mutating code, configs, deployments, or
   shared resources.
5. If the work needs a shared lever such as production deploys, staging
   environments, DNS, secrets, billing, or a rollback, comment
   `CLAIMING LEVER: <thing>` before touching it and release the lever when done.
6. Post concise progress updates on the issue or Discussion when useful. If you
   are blocked for more than 30 minutes, state the blocker and either unclaim or
   switch to an unblocked card.
7. When complete, post evidence on the issue and PR, move the card to
   `Needs-agent-verify` or `needs-human-verify` as the board rules require, then
   stop mutating that scope unless review asks for changes.

## New Work

If you find new work while doing a card:

1. Create a new issue with a narrow scope, acceptance criteria, and evidence
   plan. Use the `Agent work item` template when the task is intended for the
   agent kanban.
2. Add the issue to the active Project board.
3. Put it in `Todo` unless you are explicitly claiming it now.
4. Cross-link the parent issue, current Discussion, and any discovering PR.
5. Continue your current card unless the new issue is a blocking defect.

Do not keep a private scratch list as the real backlog. If work is real, it gets
an issue/card.

## Evidence And Verification

`PR_EVIDENCE.md` is binding for every PR and coordinated work card.

- Evidence belongs on the PR and the work issue. Discussions can link to it, but
  should not be the only durable record.
- UI work needs before/after screenshots, a video walkthrough, frontend logs,
  backend logs where applicable, and device/platform captures where applicable.
- Agent, model, prompt, provider, and action changes need real live-model
  trajectories, not deterministic proxy-only proof.
- Domain changes need domain artifacts: DB rows, memories, scheduled tasks,
  generated files, wallet/on-chain outputs, deployed URLs, or equivalent proof.
- A different agent should verify `Needs-agent-verify` cards. Do not verify your
  own evidence unless the board explicitly allows it.
- Only a human or maintainer moves cards to `Done` unless the board explicitly
  delegates that authority.

## Discussions

Use Discussions when an issue thread is becoming a coordination room.

Good Discussion content:

- agent intros and lane ownership,
- multi-card status summaries,
- handoffs between humans and agents,
- questions that affect several cards,
- decisions that need visibility before becoming issue or doc updates.

Bad Discussion content:

- the only acceptance criteria for a task,
- the only proof that a PR works,
- hidden changes to the workflow,
- card state that is not reflected on the Project board.

When a Discussion creates a durable decision, update the relevant issue, Project
readme, or this doc in the same work session.

## Tracking Issue Migration

When a tracking issue has become too large to onboard from:

1. Create a Discussion for ongoing coordination.
2. Edit the tracker body so the first screen points to the Project board, the
   Discussion, and this doc.
3. Keep the tracker as historical context and a summary of the launch or epic.
4. Move new chat, intros, and handoffs to the Discussion.
5. Convert unresolved findings into focused issues/cards.
6. Close the tracker only when its board/card definition of done is satisfied,
   or when a maintainer explicitly replaces it with a successor tracker.

## Current Launch QA Routing

As of 2026-07-05:

- Board: https://github.com/orgs/elizaOS/projects/12
- Coordination Discussion: https://github.com/orgs/elizaOS/discussions/14292
- Tracker/history: https://github.com/elizaOS/eliza/issues/13406
- Evidence standard: `PR_EVIDENCE.md`

For this push, use the Project board as state, the Discussion as the active
coordination room, focused issues as work cards, and PRs as code plus evidence.
