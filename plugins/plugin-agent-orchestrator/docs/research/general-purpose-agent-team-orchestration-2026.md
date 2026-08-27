# General-purpose agent-team orchestration research

Date: 2026-08-27

## Research question

How should elizaOS let one agent accept a small outcome-oriented request, decide whether a team is useful, assemble that team, delegate work, change roles and membership, protect scoped information and authority, verify artifacts, and return to the human only when the goal is complete or blocked?

This explanation compares primary academic sources, official system documentation, source repositories, and the current elizaOS implementation. It separates demonstrated behavior, documented product behavior, and proposed design.

## Conclusion

elizaOS needs a durable organization service above agent execution. A group chat, a collection of prompt personas, and a subprocess manager are not organization state.

This is a bounded documentation audit, not a systematic proof about every agent system. Among the systems and versions reviewed in this report, no system documented the full combination of:

- task-conditioned team formation
- transferable organizational roles
- authority that can only narrow during delegation
- read-time information authorization
- restart-safe work dependencies
- artifacts with provenance and acceptance policy
- bounded human escalation
- organization-level evaluation

The organization service must be host-neutral. It must work when the members are Eliza runtimes, ACP coding sessions, remote A2A agents, services, humans, or a mixture. `plugin-agent-orchestrator` is a coding-specific, terminal-gated execution backend. It contains useful machinery, but it cannot own a general organization that must also run on mobile, store-distributed, cloud, or non-terminal hosts.

The design follows these findings:

1. Team formation is optional. The organization may select one agent, a centralized team, a decentralized team, or a hybrid.
2. Delegation is a typed transition with an accountable actor, work contract, authority, deadline, result, and terminal state.
3. Agent identity, organization membership, executor instance, role assignment, and work assignment are separate concepts.
4. The runtime enforces authority and information access. A model may propose a change but cannot authorize its own proposal.
5. Work and accepted artifacts are the source of organizational truth. Conversation is supporting evidence.
6. Existing elizaOS scheduling, permissions, Lane, Wave, Swarm, and coding-task mechanisms need an ownership and migration decision before new equivalents are added.
7. Evaluate the organization, not only its final prose.

## What current systems establish

### OpenClaw

OpenClaw provides separate sub-agent sessions, non-blocking spawn, requester-directed completion events, configurable nesting, concurrency limits, per-parent child limits, cascade stop, agent allowlists, and tool restrictions by depth. A depth-one child may coordinate leaf workers. Completion moves up the requester chain.

These are useful execution controls, but they are not process or security isolation. A workspace is a working directory, not a sandbox. Sandboxing is off by default. Sub-agents share Gateway process resources. Shared authentication profiles remain available as fallbacks, and plugin stores are not necessarily separated by agent. Direct announce is best effort. OpenClaw documents queued completion and owner or task projections as the restart-surviving delivery paths.

OpenClaw does not document transferable role tenure, acceptance-governed work graphs, attenuated delegation grants, or organization-wide artifact policy.

Sources: [sub-agents](https://docs.openclaw.ai/tools/subagents), [multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent), [sandboxing](https://docs.openclaw.ai/gateway/sandboxing), [session tools](https://docs.openclaw.ai/session-tool), and [ACPX](https://github.com/openclaw/acpx).

### Grok Build and Grok Bot

Grok Build is xAI's open-source coding agent. It supports interactive and headless execution, ACP, skills, plugins, hooks, MCP servers, and parallel child sessions. It is relevant as a coding executor, not as the owner of general organization state.

Grok Bot is a persistent personal-agent product. Official documentation describes named bots with memory, files, browser state, routines, inter-bot messages, shared threads, group chats, result files, ownership transfer, and approval cards.

The team metaphor does not imply isolation. A member's bots share one virtual machine, files, browser sessions, command-line credentials, and local-computer permission. Bots are not security boundaries. Hosted MCP sign-in tokens are an exception: xAI says they remain on Cursor's backend rather than the shared virtual machine. Grok Bot requires stored data and uses Cursor authentication and account privacy settings. Deleting a bot does not delete shared virtual-machine files or browser sessions. The action-audit view is documented as coming. The product has no bot-specific spending limit or user-selected model.

Auto Review is model-based. xAI says it complements, rather than replaces, least privilege. Approval governs the proposed action and cannot reverse earlier work. Approval cards are therefore neither authority grants nor rollback.

Sources: [Grok Build](https://docs.x.ai/build/overview), [Grok Build extensions](https://docs.x.ai/build/features/skills-plugins-marketplaces), [Grok Build source](https://github.com/xai-org/grok-build), [Grok Bot](https://docs.x.ai/grok-bot/overview), [files and results](https://docs.x.ai/grok-bot/files-and-results), [approvals and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy), and [teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises).

### OpenAI Agents SDK

The OpenAI Agents SDK supports manager-as-tools and handoff patterns. Applications may also implement deterministic chains, parallel execution, evaluator loops, and structured routing. The SDK supports sessions, serializable `RunState`, approval pauses, and resume.

These are run and composition mechanisms. They are not a multi-writer organization ledger. A restored state needs exclusive access to its original session history. Applications must not resume independent snapshots concurrently against the same session. Changed or ambiguous history requires application repair. Serialized application context may expose secrets.

Handoffs remain inside one run. Input guardrails cover the first agent, and output guardrails cover the final agent. Applications must authorize handoff metadata in `on_handoff` before side effects and apply tool guardrails to sensitive calls.

Sources: [orchestration](https://openai.github.io/openai-agents-python/multi_agent/), [handoffs](https://openai.github.io/openai-agents-python/handoffs/), [guardrails](https://openai.github.io/openai-agents-python/guardrails/), [human approval](https://openai.github.io/openai-agents-python/human_in_the_loop/), [run state](https://openai.github.io/openai-agents-python/ref/run_state/), and [context](https://openai.github.io/openai-agents-python/context/).

### AutoGen and Magentic-One

Magentic-One uses an Orchestrator that maintains task and progress ledgers, replans after stalls, and directs a configured roster of specialists. Microsoft evaluated it on GAIA, AssistantBench, and WebArena. Current AutoGen teams expose termination conditions, turn limits, stall handling, and `save_state()` and `load_state()`. Saving a running team can produce inconsistent state, so safe recovery needs quiescence or transactional snapshots.

Its execution boundary needs caution. `MagenticOne` uses Docker when available and otherwise falls back to local execution. Without an `approval_func`, code can execute without approval. Microsoft warns about webpage prompt injection and recommends containers, restricted network and data access, and human oversight.

Magentic-One demonstrates ledger-based coordination during a run. It does not demonstrate dynamic authority or role transfer. The specialist roster is configured by the application.

Sources: [Magentic-One paper](https://arxiv.org/abs/2411.04468), [AutoGen paper](https://arxiv.org/abs/2308.08155), [Magentic-One API](https://microsoft.github.io/autogen/dev/reference/python/autogen_ext.teams.magentic_one.html), and [team state](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html).

### Anthropic research and Claude Agent Teams

Anthropic's research system uses a lead researcher, parallel sub-agents, follow-up delegation, synthesis, and citation processing. Anthropic reports a 90.2 percent relative improvement over one Opus 4 agent on an internal evaluation. It also reports that ordinary agents used about four times the tokens of chat and multi-agent research used about fifteen times the tokens of chat.

Anthropic says this design fits breadth-first work with independent directions. It fits dependency-heavy work and shared-context work poorly. Weak delegation caused duplicate work and gaps. Early versions spawned too many agents and searched indefinitely.

Claude Code Agent Teams provide separate sessions and context windows, a shared dependency-aware task list, teammate self-claim, and direct mailboxes. They do not provide workspace isolation. Teammates can overwrite the same file. The lead cannot transfer leadership, teammates cannot spawn teammates, and one session can own only one team. Teammates inherit the lead's permission settings at spawn. Operators may change an individual mode afterward, and permission requests move to the lead. If the lead uses `--dangerously-skip-permissions`, every teammate inherits it.

Sources: [Anthropic research system](https://www.anthropic.com/engineering/multi-agent-research-system), [Claude Agent Teams](https://code.claude.com/docs/en/agent-teams), and [Claude sub-agents](https://code.claude.com/docs/en/sub-agents).

### Google ADK and A2A

Google ADK supports hierarchical composition, model-driven transfers, and sequential, parallel, and loop agents. These sub-agents are components in one application invocation. They are not evidence of independently deployed persistent runtimes.

A2A addresses communication with independent agent systems. Agent Cards advertise skills and endpoints. Tasks exchange messages, status, and structured Artifact containers made of text, file, or data Parts.

An Agent Card is a remote self-description, not verified capability evidence. A member registry needs issuer trust, capability probes, authorization-aware discovery, cache invalidation, and anti-spoofing policy. Sensitive cards require authorization. Credentials belong out of band, not as static card secrets. A2A does not define team formation, artifact provenance, acceptance, role tenure, or authority attenuation.

An A2A executor adapter also needs task-scope authorization before it reveals task existence, per-task credential isolation, authenticated push notifications, duplicate and replay handling, idempotent delivery, and webhook URL validation against SSRF. A2A leaves authorization policy to each agent.

Sources: [Google ADK](https://developers.googleblog.com/agent-development-kit-easy-to-build-multi-agent-applications/), [A2A specification](https://a2a-protocol.org/latest/specification/), and [A2A discovery](https://a2a-protocol.org/latest/topics/agent-discovery/).

### LangGraph, CrewAI, and SemaClaw

LangGraph provides checkpointed graph execution, interrupts, replay, and subgraphs. Resuming an interrupt restarts the interrupted node, so earlier side effects must be idempotent. Default per-invocation subgraphs support parallel calls with separate checkpoint namespaces. Stable identity for persistent subgraphs still needs explicit node naming and state mapping. Dynamically tool-wrapped sub-agents cannot be discovered statically for nested state inspection.

CrewAI separates crews from flows. A hierarchical manager delegates and validates predefined work. Flows provide event-driven control and persistence. Crew roles remain configured objects. CrewAI's version 1.15.2 conversational-flow guide also documented snapshot-selection problems when class-level persistence recorded intermediate states; treat that as a version-specific observation, not a verified limitation of the current release.

SemaClaw is separate from OpenClaw. Its paper and repository document two-stage decomposition, a deterministic DAG runner, persistent and virtual agents, a behavioral PermissionBridge, reusable workflows, and DAG history. These are author claims and source surfaces, not independent proof of OS isolation, credential attenuation, or adversarial security.

Sources: [LangGraph subgraphs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs), [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [CrewAI hierarchical process](https://docs.crewai.com/en/learn/hierarchical-process), [CrewAI flows](https://docs.crewai.com/en/concepts/flows), [CrewAI conversational persistence](https://github.com/crewAIInc/crewAI/blob/main/docs/v1.15.2/en/guides/flows/conversational-flows.mdx), [SemaClaw paper](https://arxiv.org/abs/2604.11548), and [SemaClaw source](https://github.com/midea-ai/SemaClaw).

### Role-based LLM systems

CAMEL demonstrated prompt-induced two-agent role play. ChatDev evaluated a predefined software-development chat chain. MetaGPT evaluated software roles shaped by standard operating procedures and structured intermediate outputs. ChatDev and MetaGPT reported improvements relative to their selected baselines.

AgentVerse evaluates staged recruitment and collaboration. DyLAN selects and prunes an agent network for benchmark tasks. These papers evaluate task performance, not authorization. elizaOS must not use peer scores as authority evidence.

Sources: [CAMEL](https://arxiv.org/abs/2303.17760), [ChatDev](https://arxiv.org/abs/2307.07924), [MetaGPT](https://arxiv.org/abs/2308.00352), [AgentVerse](https://arxiv.org/abs/2308.10848), and [DyLAN](https://arxiv.org/abs/2310.02170).

## Earlier multi-agent work remains useful

The Contract Net Protocol defines announcement, eligibility, bid, award, subcontract, and report states. It is a stronger typed starting point than prose-only assignment. It does not address truthful LLM capability claims, modern identity, privacy, budgets, or adversarial bidding.

Blackboard architectures separate problem state from control policy. For elizaOS, a globally visible board would be unsafe. The organization needs authorized projections rather than one shared transcript.

SharedPlans formalizes joint activity, partial plans, intentions, and contracting out. STEAM adds a hierarchy of joint intentions, monitoring, communication about changed commitments, and reorganization in simulated domains. These systems support explicit commitments and repair events instead of inferring teamwork from conversation.

Sources: [Contract Net](https://doi.org/10.1109/TC.1980.1675516), [blackboard architecture](https://doi.org/10.1016%2F0004-3702%2885%2990063-3), [SharedPlans](https://doi.org/10.1016%2F0004-3702%2895%2900103-4), and [STEAM](https://arxiv.org/abs/cs/9709101).

## More agents are not always better

The current version of "Towards a Science of Scaling Agent Systems" evaluates 260 configurations across six benchmarks, five architectures, and three model families. The architectures are single-agent, independent, centralized, decentralized, and hybrid.

Under matched reasoning-token budgets:

- The best relative change on Finance Agent was positive 80.8 percent.
- Decentralized coordination improved BrowseComp by 9.2 percent.
- All four multi-agent architectures scored 39 to 70 percent below the single-agent baseline on PlanCraft.

The paper's predictive framework identified the reported optimal strategy for 87 percent of held-out configurations. These benchmark results motivate measurement, not a universal router. elizaOS should measure task decomposability, tool intensity, baseline capability, and coordination overhead.

Resource-allocation experiments also found that explicit worker capability information improved allocation in the tested setting. A plan-first method performed better than a reactive orchestrator for concurrent actions. Capability evidence still needs runtime verification.

MultiAgentBench reports that graph topology performed best in its research scenario and that cognitive planning improved milestone achievement by 3 percent. Topology effects depend on the task.

Sources: [scaling agent systems](https://arxiv.org/abs/2512.08296), [self-resource allocation](https://arxiv.org/abs/2504.02051), and [MultiAgentBench](https://arxiv.org/abs/2503.01935).

## Known failure modes

Cemri et al. developed a taxonomy through grounded-theory analysis of 150 traces with expert-human annotation. The paper then applied its annotation pipeline to 1,642 traces from seven multi-agent frameworks. The current version identifies fourteen modes under three categories: system design, inter-agent misalignment, and task verification.

In two case studies, prompt and topology interventions improved accuracy and reduced failure modes as measured by the paper's automated annotator. Topology changes were more effective in both case studies. These case studies do not establish a general remedy.

MAST directly motivates runtime tests for:

- repeated or derailed work
- missed stopping conditions
- premature termination
- ignored or withheld information
- reasoning and action mismatch
- incomplete or incorrect verification

The proposed elizaOS organization adds tests for circular waits, runaway fan-out, dissent preservation, and escalation without a specific missing decision.

Source: [Why Do Multi-Agent LLM Systems Fail?, current v3](https://arxiv.org/html/2503.13657v3).

Recent preprints on authenticated delegation and collaborative memory motivate scoped delegation, provenance, and read-time policy. They do not establish production security or reliable translation from natural language to access policy. Collaborative Memory reports controlled or synthetic evaluation and acknowledges that policy breaches can still occur. Treat these papers as design input, not proof of enforcement.

Sources: [Authenticated Delegation](https://arxiv.org/html/2501.09674) and [Collaborative Memory](https://arxiv.org/html/2505.18279).

## Current elizaOS position

### Useful existing mechanisms

`plugin-agent-orchestrator` already owns real ACP coding sessions, durable coding-task snapshots, coordinator and contributor completion roles, acceptance evidence, retries, spend controls, workspace management, and Smithers execution. Smithers is enabled by default unless `ELIZA_ORCHESTRATOR_SMITHERS=0`.

The repository also has overlapping coordination mechanisms that the first report missed:

- `LanePlan` and `LaneSpec` own dependencies, scope, forbidden paths, collision checks, acceptance criteria, and bounded parallelism.
- `WaveSupervisor` owns refill, salvage, concurrency, budgets, and collision behavior across coding work.
- Core exports `ISwarmCoordinatorService`; the coding plugin implements it.
- Core trust types already define contextual roles, permission constraints, expiring delegations, revocation, elevation, access decisions, and `delegatable` action metadata.
- The repository has both SQL runtime entity and relationship stores and separate agent knowledge-graph stores. The design must choose a canonical cross-host principal namespace and define mappings to both store families.

These mechanisms are inputs to the design, not automatic foundations. `ContextualPermissionSystem.addDelegation()` accepts a delegation without proving that the delegator holds delegable authority, and its delegation map is process-local. Successful decisions can remain cached for five minutes, but revocation does not invalidate those cached allows. Delegated checks match only action and resource, ignoring permission context and constraints. Elevation checks match the action but not the resource or context. The organization work must deepen or migrate this subsystem rather than introduce an unrelated `AuthorityGrant` implementation.

Repository sources: [`plugin-agent-orchestrator` registration](../../src/index.ts), [coding-task store](../../src/services/orchestrator-task-store.ts), [Lane planner](../../src/services/lane-planner.ts), [Wave supervisor](../../src/services/wave-supervisor.ts), [core Swarm contract](../../../../packages/core/src/types/swarm-coordinator.ts), [permission contracts](../../../../packages/core/src/features/trust/types/permissions.ts), and [permission service](../../../../packages/core/src/features/trust/services/ContextualPermissionSystem.ts).

### Evidence limits of the current arena

The Lighthouse scenarios run multiple real Eliza runtimes and test addressed delegation, changed requirements, stopping behavior, and canary non-disclosure. The seats and conversations are predefined. Confidentiality grading scans for known strings.

This is behavioral evidence for those runs. It does not prove retrieval-time authorization, resistance to paraphrased disclosure, dynamic recruitment, role transfer, or durable organization state.

### Ownership matrix required before implementation

Complete this matrix from source and callers before adding new domain types:

| Existing concept | Keep | Generalize | Adapt | Retire |
| --- | --- | --- | --- | --- |
| Core role and permission delegation | | | | |
| Entity and relationship stores | | | | |
| Coding task snapshot | | | | |
| Lane plan | | | | |
| Wave supervisor | | | | |
| Swarm coordinator contract | | | | |
| Smithers run | | | | |
| ACP session | | | | |
| Scenario arena | | | | |
| Canonical principal identity and store mappings | | | | |
| Organization-host lease and failover | | | | |
| Cross-host callback and notification routing | | | | |

The first implementation pass resolves the matrix as follows:

| Existing concept | Decision | First-pass boundary |
| --- | --- | --- |
| Core role and permission delegation | Generalize | Remains the eventual authority engine; the organization aggregate does not create parallel grants. |
| Entity and relationship stores | Adapt | Map their tenant-local UUIDs to a canonical organization principal identifier in a later identity experiment. |
| Coding task snapshot | Adapt | Remains coding-adapter state and never stores private organization artifacts. |
| Lane plan | Adapt | Candidate coding-work planner behind the organization work contract. |
| Wave supervisor | Adapt | Candidate coding execution supervisor, not organization owner. |
| Swarm coordinator contract | Generalize later | Preserve its chat/activity consumers while organization authority stays independent. |
| Smithers run | Adapt | Durable coding-work executor behind an executor adapter. |
| ACP session | Adapt | Ephemeral executor binding, never a member identity. |
| Scenario arena | Generalize | Evaluation harness for organization invariants and topology comparisons. |
| Canonical principal identity and store mappings | Defer behind an explicit boundary | The first aggregate uses opaque canonical principal identifiers; SQL and knowledge-graph mappings require Experiment 3. |
| Organization-host lease and failover | Defer | A single host owns Experiment 1; distributed activation is forbidden until a fenced lease owner exists. |
| Cross-host callback and notification routing | Defer | No remote executor activation in Experiment 1. Later adapters must use authenticated, idempotent callbacks. |

This selects a narrow incubation boundary rather than the final service package. Host-neutral command and aggregate contracts belong in core because runtimes and non-coding plugins must share them. The Node-only orchestrator plugin may host the first filesystem persistence adapter, with no ACP, Smithers, workspace, or GitHub dependencies. Promotion into a dedicated host-neutral plugin remains contingent on the later identity, authorization, and deployment experiments.

The deployment audit must decide which host owns the organization lease when several runtimes participate. It must define sponsor death, lease renewal, split-brain prevention, reconnect, callback routing, and failover. Package placement alone does not answer deployment ownership.

## Revised architecture

Use a host-neutral organization owner and execution adapters:

```text
Human or sponsoring Eliza agent
              |
              v
Host-neutral OrganizationService
  goal and topology decision
  membership and executor bindings
  role assignments
  work and acceptance
  authority policy
  authorized artifact projections
  budgets, repair, escalation, and outcomes
              |
     +--------+---------+----------+---------+
     |                  |                    |
     v                  v                    v
Eliza runtime     ACP coding adapter    A2A adapter
adapter           plugin-agent-         remote agents
                  orchestrator
     |                  |                    |
     +------------------+--------------------+
                        |
                        v
             scoped artifacts and audit
```

Do not choose the final package until the ownership matrix and deployment audit are complete. The domain contract may belong in core if independent plugins need it. Persistence and policy may belong in a host-neutral plugin or agent service. The ACP coding plugin remains the coding adapter.

## Domain requirements

The earlier type sketch was too weak. It allowed cross-organization references, stale grants, cycles, suspended assignees, and non-atomic transfers. Start from aggregates and commands, not free-standing interfaces.

### Separate membership from execution

An organization member is an accountable participant. An executor binding identifies how that participant acts now.

```ts
type MemberKind = "eliza_agent" | "human" | "service" | "external_agent";

type ExecutorBinding =
  | ElizaRuntimeBinding
  | AcpSessionBinding
  | A2aEndpointBinding
  | HumanInboxBinding
  | ServiceBinding;
```

Each binding needs its own instance identity, credential principal, endpoint or session, liveness, capability evidence, and version. Do not award work or authority to a copied capability profile or a bare `agentId`.

### Enforce information access at every read

An artifact scope needs more than a label. The access contract must include:

- requesting principal and active executor binding
- organization membership and active role assignments
- readable audience or policy reference
- grant, delegation, and revocation lineage
- purpose and resource being requested
- deterministic authorization decision
- filtered list, search, event, artifact, and task projections
- audit of allowed and denied reads

Define an observation model for unauthorized principals. Authorization predicates must run inside storage queries before search, sorting, counting, pagination, aggregation, or event subscription. The policy must cover row existence, counts, order, page tokens, revision and event-sequence gaps, usage changes, denial-audit visibility, notifications, timing, and cache keys. Filtering a result after the store sorts or limits it still leaks information.

The current whole-document coding-task store and unrestricted task-detail route cannot store private organization data safely. Do not place private facts in that aggregate. Build authorized projections before running private scheduling or procurement scenarios.

Repository prompt integrity still applies. Authorization may remove content the principal cannot access. It must not truncate, summarize, or compact authorized model-facing content.

### Commit state, command receipt, and audit atomically

The first experiment should retain snapshot truth. One atomic organization record must contain the revision, current state, idempotency receipts, and appended audit entries. Compare-and-swap checks apply to the whole record. This works for database, file, and memory stores without assuming a cross-record transaction.

If audit volume later requires separate records, use a transactional outbox. Define backend-specific recovery, delivery idempotency, duplicate handling, and the policy for a committed state whose audit delivery remains pending. Do not write state and audit independently.

If later requirements justify event sourcing, design it as a migration with:

- monotonic event sequence
- expected revision
- atomic append and projection
- versioned event schemas
- snapshot version
- idempotency keys
- replay and migration tests

### Fence transfers across external boundaries

A role transfer cannot be one atomic write when it stops ACP sessions, revokes credentials, or activates remote A2A agents. Model it as a durable protocol:

1. `prepare`: validate the target and persist the proposed transfer.
2. `fence`: increment an authority generation or lease. Every authorized action checks that generation.
3. `activate`: deliver idempotent adapter commands through a durable outbox.
4. `finalize`: move work and mark the old assignment inactive after acknowledgements.

The aggregate needs explicit `transferring`, `reconciling`, and failed-transfer states. A database rollback cannot undo a remote command. Recovery must reconcile the persisted generation, old executor, new executor, in-flight work, artifact provenance, and outbox receipts.

Work dependencies must be organization-local and acyclic. Assignment must require an active member, active executor binding, active role, and valid grant. Artifact kinds should use a registered discriminated union or a schema identifier with boundary validation, not an unchecked `string`.

## Implementation experiments

Do not combine the whole design in one scenario. Run these experiments in order.

### Experiment 1: persistence and concurrency

Implement one organization aggregate whose immutable revision contains snapshot state, revision, idempotency receipts, and audit entries. Test concurrent publication, interrupted candidate writes, retry, resume, stale revision rejection, and duplicate command delivery. If a transactional outbox is selected instead, test every half-committed state and recovery rule.

### Experiment 2: authorization noninterference

Implement principal-aware artifact writes and authorized read projections. Apply policy inside each query before search, sort, count, pagination, aggregation, and subscription. Test the complete observation model, including list, detail, search, event, model-context, timing, notification, cache, usage, and page-token behavior. Test revocation and cached-decision invalidation.

### Experiment 3: membership and executor bindings

Bind one persistent Eliza runtime, one ACP session, and one simulated external endpoint as distinct executor variants. Verify liveness, credential principal, capability evidence, replacement, and revocation.

### Experiment 4: work and acceptance

Integrate or migrate the existing Lane, Wave, Swarm, and coding-task concepts into one ownership model. Run a small acyclic work graph with one producer, a configured acceptance policy, deterministic evidence, rejection, and resubmission.

### Experiment 5: one fenced reorganization

Introduce one changed requirement. Run one prepare, fence, activate, and finalize transfer. Inject a failure before and after each persistence and adapter boundary. Verify generation checks, stale-executor denial, durable outbox recovery, in-flight work, narrowed authority, and artifact provenance.

### Experiment 6: topology evaluation

Only after the invariants pass, compare one agent, a fixed centralized team, and dynamic selection under the same models, tools, acceptance policy, and reasoning-token budget. Use one decomposable domain and one sequential domain before expanding the matrix.

## Evaluation measures

Record and grade:

- whether team use was justified
- verified capability coverage
- decomposition and dependency correctness
- duplicate, abandoned, or circular work
- authority expansion attempts
- unauthorized reads and inference channels
- provenance and acceptance evidence
- disagreement preservation
- recovery from failure and changed requirements
- stalls, loops, cancellation, and fan-out
- necessary and unnecessary human interruptions
- terminal-decision correctness
- elapsed time, model calls, tool calls, tokens, and cost
- state recovery and idempotent delivery

Run each live evaluation more than once. Preserve full trajectories and complete authorized model context.

## Decisions for the next design pass

1. Make the organization owner host-neutral.
2. Keep ACP, A2A, Smithers, and Eliza runtimes behind executor adapters.
3. Finish the ownership matrix before adding another work graph or permission system.
4. Make membership, executor binding, role, authority, work, and artifact provenance distinct.
5. Enforce information policy on storage queries and every read projection.
6. Commit snapshot state, revision, command receipts, and audit entries in one atomic record for the first experiment.
7. Reuse or migrate core permission delegation. Add authority attenuation and durable storage before relying on it.
8. Treat capability advertisements as claims that need evidence and freshness.
9. Apply a configured, risk-based acceptance policy. A distinct reviewer is required only when the policy calls for one.
10. Prove invariants in separate experiments before comparing autonomous team quality.

## Primary starting sources

- [Contract Net](https://doi.org/10.1109/TC.1980.1675516)
- [SharedPlans](https://doi.org/10.1016%2F0004-3702%2895%2900103-4)
- [STEAM](https://arxiv.org/abs/cs/9709101)
- [AutoGen](https://arxiv.org/abs/2308.08155)
- [AgentVerse](https://arxiv.org/abs/2308.10848)
- [DyLAN](https://arxiv.org/abs/2310.02170)
- [Magentic-One](https://arxiv.org/abs/2411.04468)
- [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)
- [Scaling Agent Systems](https://arxiv.org/abs/2512.08296)
- [Authenticated Delegation](https://arxiv.org/abs/2501.09674)
- [Collaborative Memory](https://arxiv.org/abs/2505.18279)
- [OpenClaw sub-agents](https://docs.openclaw.ai/tools/subagents)
- [Anthropic multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/multi_agent/)
- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Grok Build](https://docs.x.ai/build/overview)
