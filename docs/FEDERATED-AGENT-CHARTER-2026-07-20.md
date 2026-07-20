# Federated Agent Fleet Charter

**Status:** R2 implementation-ready proposal, manual merge only

**Version:** `1.0.0-proposal.1`

**Date:** 2026-07-20

**Scope:** Sol, Nubs' agent, Shaw's agent, team agents, and future agent runtimes operating across one shared Eliza work graph

**Normative schema:** [`federated-agent-charter.schema.json`](./federated-agent-charter.schema.json)

**Conformance test:** [`federated-agent-charter-conformance.test.mjs`](../scripts/federated-agent-charter-conformance.test.mjs)

This proposal extends `.github/FLEET.md`. Until maintainers approve and merge it, `.github/FLEET.md`, GitHub Project 12, repository protections, and human directions remain authoritative.

## 1. Problem and observed failures

The current guide establishes visible lane tags, issue claims, board states, evidence, and shared-lever etiquette. It does not provide a federated identity model, expiring leases, machine-checkable overlap rules, or an authority split between GitHub, Smithers, and Merge Steward.

The missing controls have already produced concrete failures:

1. Two agents independently created `.github/FLEET.md` plus Discussion 14308 and `docs/AGENT_COORDINATION.md` plus Discussion 14292. One agent then closed the room the fleet had adopted. This was duplicate governance work caused by no canonical work identity and no governance lease.
2. Two agents built and installed to the Seeker concurrently on 2026-07-05. This duplicated compute and forced a mid-air deconflict because the physical device had no exclusive lease.
3. A prod deploy claim remained silent for roughly two hours. Another lane correctly took over after the documented 30-minute timeout, but the takeover depended on prose and human interpretation instead of an atomic fencing token.
4. An agent attempted to rescue PR 15108 while its owner was actively committing. The second agent noticed the fresh branch activity and stood down, but only after work started. A branch/path collision should be rejected before mutation.
5. An agent copied the example lane tag `[cloud-agent]`, then corrected to `[stan-cloud]`. A display tag is not a durable identity.
6. Project 12, issue state, Discussion claims, PR branches, and runtime tasks can disagree. No immutable key joins them, and no deterministic rule chooses the winner.
7. Eliza Hub's Merge Steward and Smithers both model durable runs. Without a boundary, they become competing orchestration databases.

This charter makes these failures mechanically impossible or explicitly fail-closed.

## 2. Normative language and invariants

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative.

The fleet has nine hard invariants:

1. **One canonical work identity.** Every issue, task, branch, PR, Smithers run, claim, handoff, review, and merge receipt MUST reference one `workId`.
2. **One accountable owner per failure class.** Every active work item MUST map each relevant failure class to exactly one accountable owner. Helpers may be many. Accountability may not be duplicated or omitted.
3. **Leases, not announcements.** A claim is valid only while its TTL lease is active. Comments and labels mirror leases but do not create authority.
4. **Fenced mutation.** Every protected mutation MUST include the current lease generation. An expired owner's late write MUST be rejected even if the lease was later reacquired.
5. **Dependencies before dispatch.** A work item may enter implementation only when required predecessors are satisfied and no blocking collision edge exists.
6. **Independent review.** The implementation owner, their runtime alias, and their team MAY NOT satisfy independent review.
7. **Merge is a separate authority.** Work ownership does not imply merge authority. Sensitive work always needs an explicit human gate.
8. **One runtime for execution history.** Smithers owns replayable execution frames. Merge Steward owns reservation and landing policy. Neither schedules the other's domain.
9. **One write authority per forge epoch.** GitHub is authoritative now. Forgejo may shadow reads during rehearsal but MUST NOT become a second write authority without a signed cutover record.

## 3. Canonical identifiers

### 3.1 Work identity

The canonical identifier is:

```text
work:v1:<authority>:<repo-id>:<kind>:<native-id>
```

Examples:

```text
work:v1:github:elizaOS%2Feliza:issue:16632
work:v1:github:elizaOS%2Feliza:discussion:14308
work:v1:internal:elizaOS%2Feliza:task:01J38R5B6MY8B9K5QX0QJY2V7A
```

Rules:

- `authority` is the sole current work registry: `github`, `forgejo`, or `internal`.
- A GitHub issue-backed item uses the issue number as `native-id`; a PR is an artifact of that work, not a new work identity.
- Duplicate issues MUST resolve to the surviving issue's `workId`; the duplicate becomes an alias.
- A migration to Forgejo MUST retain the original `workId` and add a Forgejo alias. Work IDs do not change during forge migration.
- One branch and multiple PR attempts may belong to one `workId`, but only one attempt may be active per target forge and branch lane.

Required correlations:

```text
workId
parentWorkId?              # decomposition or incident parent
smithersRunId?             # execution history
elizaTaskId?               # existing task service
trajectoryId?              # model/action evidence
claimIds[]                 # ownership leases
branchRef?
pullRequestRefs[]
reviewReceiptIds[]
mergeReceiptId?
```

### 3.2 Agent and team identity

A lane tag is presentation only. Durable identity is:

```text
agent:v1:<team-id>:<principal-id>
team:v1:<organization>:<team-slug>
session:v1:<agent-id>:<runtime-instance-id>
```

Each registered agent MUST declare:

- immutable `agentId`
- `teamId`
- human-readable `displayTag`, such as `[sol-orch]`
- authenticated forge principals
- runtime principal and session ID
- capability set
- review independence group
- authorized pillars and maximum concurrent claims
- registration signer and status

Two sessions with the same `agentId` are the same reviewer and owner. Renaming `[sol-orch]` does not create independence. Two registered agents may share a team for implementation, but independent review requires a reviewer outside both the implementation owner's team and independence group. The review receipt's asserted `independenceGroup` is informational until it is matched against signed registry facts.

## 4. Authority layers

| Layer | Owns | Must not own |
| --- | --- | --- |
| Human owner/maintainer | objectives, risk acceptance, sensitive approvals, emergency override, merge authority policy | hidden implementation state |
| Work registry | canonical `workId`, aliases, lifecycle, pillar, accountable owners, dependency graph | execution replay, merge execution |
| Lease registry | TTL claims, resource-scoped generations, conflict decisions, handoffs, zombie recovery | deciding code quality |
| Smithers | durable execution frames, attempts, resume, fork, replay, node outputs | issue assignment, forge claims, PR creation, merge decisions |
| Eliza task/trajectory services | task semantics and model/action evidence | forge landing authority |
| Forge adapter | issues, branches, PRs, reviews, checks, protected refs | canonical cross-forge identity |
| Merge Steward | preflight, reservations, queue facts, integration checks, merge receipts | macro workflow scheduling or Smithers replay |
| CI | deterministic checks and artifacts | risk acceptance or owner identity |

External writes such as issue comments, branch pushes, PR creation, deploys, and merges are irreversible Smithers barriers. A replay MUST observe the existing receipt or create a new idempotency key. It MUST NOT repeat the external write merely because a frame was rewound.

## 5. Pillars and failure-class accountability

### 5.1 Pillar ownership

A pillar is a durable product or infrastructure boundary, not a temporary task label. Initial pillars SHOULD include:

```text
core-runtime
agent-orchestration
cloud-control-plane
cloud-inference
app-web
app-native
connectors
identity-auth
payments-money
schema-data
ci-build-release
security
quality-evidence
docs-governance
forge-landing
```

Each pillar has:

- one `accountableTeamId`
- optional primary `accountableAgentId`
- path/package selectors
- escalation owner
- default reviewers
- sensitive failure classes

Pillar ownership routes work and escalation. It does not grant a permanent edit lock. Work leases remain scoped and expiring.

### 5.2 One owner per failure class

Every active item MUST contain an `accountability` map for all applicable classes:

```text
requirements
implementation
test_evidence
security
migration_schema
money
runtime_operations
deployment
merge
human_acceptance
incident_command
```

Exactly one `accountableAgentId` or `accountableTeamId` owns each included class. Contributors and consulted reviewers are listed separately. An agent may own multiple classes, except:

- `implementation` and `independent_review` cannot resolve to the same independence group.
- `merge` cannot be implied by `implementation`.
- `human_acceptance` must resolve to a human principal.
- sensitive classes `security`, `migration_schema`, `money`, `deployment`, and `merge` require a second lane or human according to repository policy.

When a failure occurs, the owner for that failure class coordinates the response. This prevents two agents from both assuming another lane owns the same broken gate.

## 6. Claim and lease protocol

### 6.1 Lease scopes

Claims are leases over one or more resources:

```text
work
issue
pull_request
branch
path
package
pillar
environment
physical_device
database
secret_set
runner_pool
release_train
merge_lane
```

Lease modes:

- `exclusive`: no overlapping active lease may exist.
- `shared_read`: may coexist with reads, never with an exclusive mutation lease.
- `shared_write`: permitted only when the work graph proves disjoint paths and policy explicitly allows it.
- `review`: read plus review receipt authority, never implementation mutation.

Path overlap is prefix-aware after normalization. `packages/app` conflicts with `packages/app/src/x.ts`; `packages/app-old` does not. Package, pillar, environment, database, device, secret, release, and merge-lane claims are exact-match exclusive unless policy defines a hierarchy.

### 6.2 TTL defaults

| Scope | Default TTL | Renewal cadence | Grace before reclaim |
| --- | ---: | ---: | ---: |
| work/issue/task | 30 minutes | 10 minutes | 5 minutes |
| branch/path/package | 20 minutes | 5 minutes | 5 minutes |
| device/environment/database/secret | 10 minutes | 2 minutes | 2 minutes |
| deploy/promote/merge lane | 10 minutes | 2 minutes | 0 minutes after expiry |
| review | 60 minutes | 20 minutes | 10 minutes |

Policy may shorten TTLs. TTLs longer than 120 minutes require a reason and human approval. A blocked worker SHOULD release mutation scopes and retain at most the work-level coordination lease.

### 6.3 Atomic acquisition and fencing

Acquisition MUST be compare-and-set against all overlapping active leases and the resource fence for every normalized resource in the lease set. A successful response returns:

```json
{
  "claimId": "claim_01J...",
  "status": "active",
  "generation": 7,
  "acquiredAt": "2026-07-20T06:30:00.000Z",
  "expiresAt": "2026-07-20T06:50:00.000Z"
}
```

Every protected mutation includes `claimId` and `generation`, and the registry checks that pair against the current resource fence. On renewal, generation remains stable. On release, expiry, cancellation, transfer, or reclamation, the next acquisition increments the resource-scoped generation with a single CAS transaction. A write with an old generation returns `409 stale_fence`, including a worker that reacquired a different claim after its old fence expired.

No expiry is inferred from a client clock. The lease registry's clock is authoritative. Conformance fixtures use explicit timestamps so tests are deterministic.

### 6.4 Renewal, release, and blocked work

An owner MAY renew before expiry if:

- its session is healthy,
- the work item is not cancelled,
- its branch head or latest evidence changed within the policy window, or a blocking dependency is recorded,
- no human revoked the lease.

A renewal without progress after three periods changes the claim to `suspect`. A fourth no-progress renewal requires reviewer or coordinator approval.

Graceful completion releases all mutation leases with a reason and receipt. A terminal work state with active claims is a conformance failure.

### 6.5 Zombie reclamation

A claim is a zombie candidate when any of these are true:

- `expiresAt <= registryNow`
- owner session heartbeat is stale beyond TTL
- task/run is terminal but claim is active
- branch was deleted or superseded
- owner explicitly abandoned the task

Reclamation sequence:

1. Mark `suspect` and emit `claim.suspect`.
2. Fence old generation immediately for exclusive levers.
3. Wait scope grace period unless emergency policy permits immediate reclaim.
4. Re-read branch head, dirty workspace checkpoint, active PR, Smithers frame, and latest evidence.
5. Create a reclamation receipt with old owner, old generation, observed state, reason, and recovery plan.
6. Set old claim `expired` or `reclaimed`.
7. Acquire a new generation for the successor.
8. Require a handoff or forensic recovery note before mutation.

A reclaimed agent returning later MUST stop. It may contribute evidence or request a new lease, but may not resume with its old fence.

## 7. Dependency and collision graph

Each work item is a graph node. Edges are typed:

```text
requires              # hard predecessor
blocks                # inverse hard edge
duplicates            # aliases to survivor
supersedes            # old work must stop
stacks_on              # child PR waits for parent merge
shares_contract_with  # coordinate interface and evidence
collides_path          # overlapping file scope
collides_package       # overlapping package scope
collides_lever         # device/env/db/deploy/merge exclusivity
reviews                # reviewer dependency
hands_off_to           # ordered transfer
```

Dispatch algorithm:

1. Resolve duplicate/superseded aliases to the surviving `workId`.
2. Reject self-cycles and cycles among hard edges `requires`, `blocks`, and `stacks_on`.
3. Canonicalize hard edge endpoints before cycle detection and ordering: `A requires B` means `B -> A`; `A blocks B` means `A -> B`; `A stacks_on B` means `B -> A`.
4. Topologically order hard dependencies, tie-breaking lexicographically by `workId`.
5. Add computed collision edges from normalized claim scopes and current PR changed paths.
6. A node is `dispatchable` only if all hard predecessors are terminal-success, no foreign blocking lease exists, all required accountability classes have one owner, and a target branch is known.
7. Disjoint nodes may run in parallel. Shared package overlap is warning-level only if file scopes are disjoint and no shared contract is being changed.
8. If two active nodes collide, the earlier valid lease wins. For equal acquisition timestamps, the lexicographically smaller `claimId` wins. The loser becomes `blocked_collision` and is offered review or disjoint follow-up work.

The graph MUST be recomputed before branch creation, before push, when opening or updating a PR, before integration, and before merge.

## 8. Work lifecycle and handoffs

Lifecycle:

```text
proposed
ready
claimed
in_progress
blocked_dependency
blocked_collision
needs_agent_review
needs_human_review
merge_ready
merging
done
cancelled
```

Allowed transitions are listed in the schema. A forge board may mirror these using existing Project 12 columns. Mirror drift never changes canonical state by itself.

### 8.1 Handoff receipt

A handoff is a two-phase transfer:

1. `offered`: current owner freezes writes and records current branch head, Smithers frame, test/evidence state, dirty-work checkpoint, unresolved risks, next action, and leases proposed for transfer.
2. `accepted`: successor confirms the expected heads and prepares new lease generations without write authority until completion.
3. `completed`: old claims release, resource fences increment, new claims activate, and graph ownership changes in one atomic swap.

If the successor does not accept before `handoff.expiresAt`, the offer expires and the old owner either renews or releases. A comment saying "you take it" is not a handoff.

Required handoff payload:

```json
{
  "workId": "work:v1:github:elizaOS%2Feliza:issue:16632",
  "fromAgentId": "agent:v1:elizaOS:sol-orch",
  "toAgentId": "agent:v1:elizaOS:nubs-maintainer",
  "expectedBranchHead": "<40-or-64-hex-sha>",
  "smithersRunId": "smithers-p1-16638",
  "lastCompletedFrame": "test",
  "evidenceReceiptId": "evidence_01J...",
  "risks": ["manual merge required"],
  "nextAction": "independent review",
  "offeredAt": "2026-07-20T06:40:00.000Z",
  "expiresAt": "2026-07-20T07:10:00.000Z"
}
```

## 9. Evidence contract

Evidence is an immutable receipt, not prose confidence. Every delivery MUST include:

- `evidenceId`, `workId`, producer agent/session/team
- base and head commit SHA
- claim IDs and generations used
- Smithers run/node/attempt correlation when execution was framed
- commands with exit code, start/end time, environment fingerprint, and artifact digest
- deterministic test results
- real-flow artifacts where applicable
- negative/adversarial cases
- known failures and baseline distinction
- reviewer receipt references
- redaction manifest

Evidence levels:

- `E0`: assertion only, never merge-eligible.
- `E1`: static analysis or unit evidence.
- `E2`: integration evidence on the changed path.
- `E3`: real end-to-end flow in a representative environment.
- `E4`: human acceptance or production observation.

Policy selects minimum level by failure class. Auth, money, schema, deployment, physical-device, and user-visible launch gates require at least `E3`; a human gate may require `E4`. Mocked auth, fabricated state, a screenshot without a commit/environment binding, and a green-by-skip job do not satisfy `E3`.

A command result is accepted only if its artifact digest matches the stored artifact and `headSha` is an ancestor of or equal to the reviewed PR head according to policy. New commits invalidate prior review and evidence for changed paths.

## 10. Review, merge authority, and HITL gates

### 10.1 Independent review

A valid review receipt MUST bind:

- reviewer `agentId` or human principal
- reviewer `independenceGroup`
- `workId`, PR ref, exact head SHA, base SHA
- reviewed paths and failure classes
- verdict: `approve`, `request_changes`, or `abstain`
- findings and evidence references
- timestamp and signature/provider identity

The reviewer MUST NOT:

- be the implementation accountable owner,
- share the implementation owner's team,
- share the implementation owner's independence group,
- have authored commits in the reviewed head range,
- hold an active write lease over reviewed scope.

A changed head invalidates approval unless the adapter proves the delta is outside reviewed scope and policy permits partial carry-forward. Default behavior is invalidation.

### 10.2 Merge authority

Merge policy resolves in this order:

1. repository branch protection and required checks
2. explicit human restrictions
3. sensitive failure-class gates
4. charter review/evidence rules
5. queue policy
6. work-owner preference

Only an actor with an unexpired, signed `mergeAuthority` grant for the target branch may merge. The grant names signer, scope, epoch, approval, expiry, and revocation state. The implementation owner never gains merge authority from a work lease. Merge Steward may execute a merge only after policy is true on freshly fetched forge facts and it holds the merge-lane worker lease.

Governance and workflow documents, including this charter and `.github/FLEET.md`, are manual merge only.

### 10.3 Human-in-the-loop gates

HITL approval is mandatory for:

- production deploy or rollback
- money movement, billing behavior, grants, or financial limits
- destructive or irreversible schema/data operations
- secrets, identity-provider policy, access grants, or branch protection
- security risk acceptance
- physical-device destructive actions
- governance/workflow policy changes
- exceptions to evidence, review, or lease policy
- Forgejo authority cutover or dual-write enablement

Approval records MUST name the exact action, environment, commit, diff/risk digest, allowed actor, authorized human deciders, expiry, and whether approval is one-shot. `decidedBy` MUST be one of `allowedHumanIds`. One-shot approval consumption occurs atomically in the same transaction as the protected mutation. An approval for one command, head SHA, or deployment does not authorize a later mutation.

Emergency override requires a human, a reason, an expiry, affected resources, and an incident `workId`. It may reclaim leases but cannot make red required checks green or erase audit records.

## 11. GitHub-now adapter

GitHub remains the write authority until an approved cutover.

Mapping:

| Charter object | GitHub implementation now |
| --- | --- |
| work registry | repository-global registry adapter with GitHub issue/Project aliases; Project 12 is only the Launch QA mirror where applicable |
| lifecycle | Project 12 Status field |
| accountable owner | `Claimed by` field plus signed issue receipt |
| claim lease | external lease registry or Merge Steward DB; labels/comments are mirrors |
| graph | issue links plus machine-readable manifest in lease registry |
| branch | `agent/<agent-id>/<work-key>` or repository policy equivalent |
| review | GitHub review bound to head SHA plus review receipt |
| checks | GitHub Checks/Actions fetched fresh |
| merge | protected GitHub PR, manual or authorized queue |
| coordination | Discussion 14308 threads, informational mirror only |

The adapter MUST:

- use GitHub node IDs or repo plus number as aliases, never as cross-forge identity by themselves,
- preserve original `workId` across duplicates, moved board cards, branch retries, and forge migration,
- read Project 12 and Discussion state before dispatch,
- post concise claim/handoff/release mirrors with `workId`, owner, expiry, and claim ID,
- reconcile mirrors from the lease registry, not infer leases from old comments,
- fail closed if it cannot fetch current PR head, checks, reviews, or protections,
- never auto-close owner-only items without explicit authority.

## 12. Forgejo-later adapter and cutover

Forgejo rehearsal is read-only or disposable while GitHub remains authoritative. The current Eliza Hub package is implementation source, not evidence of an operated service.

Merge Steward's migration boundary:

- before implementation: preflight, conflict graph, reservations, registration facts
- after PR submission: PR facts, checks, integration train, merge receipt
- retained Steward state: reservations, landing receipts, branch-protection facts, queue observations, forge mutation receipts
- deprecated Steward state: macro task scheduling, replayable node attempts, long-running agent work cycles that duplicate Smithers frames
- never: independently replay or schedule Smithers implementation nodes

Smithers IDs and Eliza task IDs are correlations inside a Steward landing receipt. Steward run/node tables MUST NOT become a second macro workflow runtime. A Smithers external-write frame and a Steward/forge mutation share one idempotency key, so replay can observe or deduplicate the mutation but cannot perform it twice.

Cutover requires an append-only, signed `authorityEpochs[]` history and one active `authorityEpoch` record:

```json
{
  "repoId": "elizaOS/eliza",
  "epoch": 2,
  "writeAuthority": "forgejo",
  "effectiveAt": "2026-08-01T00:00:00.000Z",
  "githubMode": "read_mirror",
  "forgejoMode": "write",
  "forgejoBaseUrl": "https://git.example.org",
  "approvedBy": ["human:owner", "human:ops"],
  "rollbackUntil": "2026-08-08T00:00:00.000Z",
  "evidenceDigest": "sha256:...",
  "signatures": [{ "signer": "human:owner", "signature": "sig_..." }]
}
```

Before cutover, prove:

- private staging, OIDC, protected branches, isolated runners
- signed webhook replay suppression
- Postgres backup/restore
- registered agent identities
- reservation conflict and zombie-reclaim denial cases
- Smithers receipt correlation without duplicate scheduling
- one branch to PR to checks to dry-run merge receipt
- stale head, red check, missing review, missing reservation, replayed webhook, and concurrent merge-lane denial

There is no automatic bidirectional issue/PR synchronization. During migration, reconcile immutable commit SHA and `workId`, alert on divergence, and write only to the authority named by the active epoch. Delayed writes carrying a stale epoch are denied even if their underlying forge token is still valid.

## 13. Required service API

An implementation MAY be Merge Steward-backed, but these semantics are provider-neutral:

```text
POST /v1/identities/agents/register
GET  /v1/work/:workId
POST /v1/work/:workId/transition
POST /v1/work/:workId/graph/edges
POST /v1/preflight
POST /v1/claims/acquire
POST /v1/claims/:claimId/renew
POST /v1/claims/:claimId/release
POST /v1/claims/:claimId/reclaim
POST /v1/handoffs
POST /v1/handoffs/:handoffId/accept
POST /v1/evidence
POST /v1/reviews
POST /v1/approvals
POST /v1/merge/preflight
POST /v1/merge/execute
GET  /v1/reconciliation/:repoId
```

Mutation endpoints require an idempotency key. Protected mutations also require `claimId` and `generation`. Conflict responses MUST include the winning claim, overlapping resource, expiry, and permitted next actions without exposing secrets.

Audit events are append-only:

```text
identity.registered
work.created
work.transitioned
graph.edge_added
claim.acquired
claim.renewed
claim.suspect
claim.released
claim.expired
claim.reclaimed
handoff.offered
handoff.accepted
handoff.completed
evidence.recorded
review.recorded
approval.requested
approval.decided
merge.preflighted
merge.executed
authority.cutover
```

## 14. Deterministic conformance requirements

An implementation conforms only if it passes equivalent deterministic tests for:

1. canonical work ID parsing and alias preservation
2. identity uniqueness and lane-tag non-authority
3. exactly one accountable owner per failure class
4. active exclusive lease blocks overlap
5. prefix-aware path collision without false prefix matches
6. expiry and reclamation increment generation
7. stale-fence write rejection
8. no-progress renewal becomes suspect
9. hard dependency cycle rejection
10. deterministic topological order
11. collision winner determinism
12. handoff requires matching head and new generation
13. terminal work cannot retain active claims
14. same agent/session/team independence rejection
15. changed-head review invalidation
16. sensitive work requires HITL approval
17. implementation ownership does not confer merge authority
18. Smithers external-write replay barrier
19. one active forge write authority per epoch
20. GitHub/Forgejo mirror divergence detection

The checked-in test executes all 20 requirements independently, validates the canonical fixture with Draft 2020-12 JSON Schema, and includes 14 `GAP:` negative regressions for the R2 review findings. It covers canonical IDs and aliases, signed identity facts, resource-scoped fencing and CAS, handoffs, dependency direction, independent review, HITL consumption, merge authority, Smithers/Steward idempotency, signed authority epochs, stale write denial, and mirror divergence without network or wall-clock dependence.

## 15. Adoption plan

### Phase 0, approve semantics

- Review this proposal manually.
- Choose service owner and data owner.
- Resolve issue 16436's Eliza Hub ownership and repository boundary.
- Add team/agent registrations for Sol, Nubs' agent, Shaw's agent, and maintainers.

### Phase 1, GitHub authoritative

- Add `workId`, accountability, and graph fields to Project 12 or an attached registry.
- Back claims with TTL/generation storage.
- Keep Discussion 14308 and labels as mirrors.
- Require claim generation in deploy/device/database runbooks.
- Run conformance tests in advisory mode, then gate branch/deploy automation.

### Phase 2, Smithers correlation

- Persist `workId` in Smithers frame metadata.
- Keep issue assignment and merge outside Smithers.
- Add idempotency receipts around branch push, PR creation, deploy, and merge barriers.
- Prove resume/fork does not repeat external writes.

### Phase 3, Forgejo rehearsal

- Deploy private staging after ownership approval.
- Pull-mirror GitHub and run Merge Steward dry-run only.
- Reconcile by `workId` and commit SHA.
- Exercise denial and zombie-recovery cases.

### Phase 4, deliberate cutover

- Sign one authority epoch.
- Stop GitHub writes for the selected repo before enabling Forgejo writes.
- Keep rollback bounded and audited.
- Enable live merge only after protected branches, isolated checks, human gates, and backups are proven.

## 16. Decision record

This proposal chooses:

- GitHub as current source of truth.
- `.github/FLEET.md` as current human-facing coordination guide.
- `workId` plus TTL/fenced leases as the future coordination authority.
- Smithers as the only replayable execution/frame engine.
- Merge Steward as reservation and forge-landing policy, not a second scheduler.
- One accountable owner per failure class.
- Manual merge for governance/workflow policy.
- Forgejo only after an explicit, evidence-gated authority epoch.

It deliberately does not choose a hosted JJ platform. Local `jj` MAY provide source rewind for Smithers forks, while GitHub or Forgejo stores shared Git refs. Rewinding source does not undo external side effects.

[sol-orch]
