# Orchestrator hardening audit — 2026-07

> **Status as of 2026-07-02.** This report backs issue #11028; fixes have been
> landing since it was written. Findings below already fixed on `develop`
> (each re-verified in source):
>
> - Prose-mined URLs no longer labelled `verifiedUrls` to the judge — #11012.
> - `auto-validate` route refuses criteria-free tasks (422) — #11015.
> - Supervisor tick overlap guarded — #11019; stuck-task staleness surfaced
>   instead of deduped silent — #11059.
> - Workspace context no longer advertises busy sub-agents as reusable;
>   phantom empty task view dropped — #11061.
> - "stop `<code-action>`" no longer cancels a live turn — #11062; the
>   interrupt/queue/deliver decision is now model-backed — #11210.
> - SSRF DNS-rebinding TOCTOU closed (vetted answer pinned to the
>   connection) — #11146, fail-closed follow-up #11204.
> - LifeOps keyword gate no longer suppresses coding tasks phrased as
>   to-dos — #11202.
> - Task-store concurrency: serialized first load — #11128; lock-free RMW +
>   delete correctness — #11197; delete/write race (tombstone + dirty
>   tracking) — #11205.
> - Archive/reopen/pause action wiring re-landed after the stale #11271
>   regression — #11216 / #11344 fixed by #11368.
>
> In flight: terminal-status dedup #11220.
> Still open under #11028: substring completion relay gate
> (`completionHasVerificationFailure` on rendered prose), hardcoded `codex`
> terminal fallback, slang-regex control inference + dead `_infer*` filter
> helpers, blanket `ELIZA_*` env forwarding (deny-list added, broad prefix
> remains).

Adversarial review of `plugins/plugin-agent-orchestrator` (~39K LOC, 94 test
files, 1,156 test cases) plus its benchmarks/scenarios. Goal: hunt for the
failure modes the maintainer flagged — **text-evaluation where LLM judgment
belongs, unnecessary hardcode, fallbacks/defaults that mask a broken pipeline,
LARP (code that looks like it works but doesn't), loop/timeout/race bugs, and
security holes** — then fix, test, and report.

Method: 8 parallel read-only auditors (task lifecycle, routing/frameworks,
verification/grilling, ACP transport/sessions, supervisor/broker/providers,
actions/wiring, workspace/API security, test-quality). **Every finding was then
re-verified against `origin/develop`** — the initial pass ran against a branch
839 commits behind develop, and the active test/CI swarm had already fixed
several issues. Only findings confirmed live on develop are listed below.

## Headline

- The **test suite is real**, not LARP: ~1,156 cases, ~86% genuinely exercise
  product code, **zero** pure-can't-fail tests found. The `router-loop-guard`
  property/fuzz test (400 seeded orderings vs an independent oracle) is
  exemplary. Weaknesses are narrow: a circular fixture-judge scenario, dormant
  env-gated "live" tests that silently no-op in CI, and brittle prompt-substring
  assertions.
- The **verification core is genuinely LLM-driven on develop** and fail-closed
  at the model boundary. Crucially, the swarm has already **wired the two
  anti-fabrication layers** that the stale branch left as dead code:
  `runIndependentVerification` (execution-grounded re-check) and the
  `parseCompletionEnvelope` / `envelopeCorrection` structural gate are now called
  in `autoVerifyCompletion`. The `runHealthCheck` respawn-cascade (the "dog site
  got flipped to errored + respawn" loop) is also already fixed (grace window +
  descriptive-not-imperative status). The `#8875` per-origin spawn cap was armed
  for web/dashboard in #10890.
- Remaining defects are concentrated in **secondary text-eval heuristics**,
  **provider LARP**, **actions intent-parsing**, and **two real security holes**.

## Fixed in this pass

| # | Area | Severity | Status |
|---|---|---|---|
| S1 | Git-remote command injection / RCE (`workspace-service.ts` — `ext::`, `--upload-pack=`, `file://` reach `git` verbatim) | **critical** | ✅ PR #10980 |
| S2 | Spend-cap bypass via attacker-declared `$0` (`spend-allowance.ts` — `hint ?? default` returns 0) | **high** | ✅ PR #10980 |
| T1 | Positive count masks an explicit failure marker in the completion relay gate (`sub-agent-completion.ts`) | medium | ✅ PR #10984 |

### S1 — git-remote command injection (PR #10980)
`git ls-remote` and the credential-safe `git clone` override passed the repo
string to git with no scheme allowlist, no `--` separator, and no
`GIT_ALLOW_PROTOCOL`. `normalizeRepositoryInput` returns unknown inputs
unchanged, so `ext::sh -c "…"` (git's ext helper → **host RCE**),
`--upload-pack=…` (argument injection), and `file:///…` (local disclosure)
reached git. Reachable from a sub-agent's model/attacker-influenced repo
argument. Fixed with `assertSafeGitRemote` (https/http/ssh + scp-ssh allowlist),
a `--` separator, and `GIT_ALLOW_PROTOCOL=http:https:ssh`.

### S2 — spend-cap `$0` bypass (PR #10980)
`estimateSelfSpendCostUsd` metered self-spend against the caller-supplied
`spendEstimateUsd`; `hint ?? CONTAINER_DAILY_COST_USD` returned 0 for a declared
0 (nullish `??` misses 0). `spendEstimateUsd: 0` → unlimited spend under any cap.
Fixed: 0 for a paid command → human-confirm; containers floored at base cost.

### T1 — failure-marker ordering (PR #10984)
`completionHasFailureMarkerWithoutPositiveEvidence` checked positive-count regex
before the explicit tool-failure regex, so "tests failed, exit code 1, but found
5 files" relayed as success. Reordered so an explicit failure marker wins.

## Confirmed on develop — remaining work (not yet fixed)

Ranked by the maintainer's priorities (text-eval-vs-LLM and LARP first).

### Verification / completion text-eval
- **`orchestrator-task-service.ts` (~1058):** URLs regex-mined from the
  sub-agent's free-text summary (`collectUrls([summary, …])`) are merged into a
  field named **`verifiedUrls`** and handed to the completion judge as
  *verified* evidence — but they were never probed. A sub-agent can pass by
  writing "Deployed to https://…". Fix: keep mined URLs in a separate
  `mentionedUrls`; only reachability-probed URLs enter `verifiedUrls`.
- **`goal-llm-verifier.ts:425` + `orchestrator-routes.ts:494` (`auto-validate`):**
  empty `acceptanceCriteria` → `passed:true` with **no model call**. The auto
  path parks a criteria-free task in `validating`, but the HTTP `auto-validate`
  route only gates on `status === "validating"`, not on empty criteria, so it
  marks such a task `done` with zero verification. Fix: the route must treat
  empty criteria as inconclusive (reject / no-pass), not forward `passed:true`.
- **`sub-agent-completion.ts:300-306,380`:** the user-facing "is it done" relay
  gate (`isSuccessfulSubAgentCompletion`) is `!completionHasVerificationFailure`,
  i.e. `.includes("[verification:")` / `"NOT reachable"` on rendered prose. If
  the router's annotation format drifts, real failures relay as success. Fix:
  key off a structured `metadata.verificationFailed` flag, not substring match.

### Provider / supervisor LARP
- **`active-workspace-context.ts:111`:** `const tasks = uniqueTasks([])` is
  hardcoded empty → `taskCount` is always 0, the tasks/pending render blocks are
  dead, and `reusableSessions` (filtered on the empty `tasks`) marks **every**
  session reusable — advertising busy, mid-turn agents to the planner as idle
  with `nextAction=SEND_TO_AGENT`. Fix: derive "reusable" from real session
  status; populate tasks from `OrchestratorTaskService` or delete the dead
  machinery + false `taskCount`.
- **`active-session-forward.ts:112` + `interruption-decider.ts`:** the
  interrupt/queue/deliver/ignore decision for a live user message to a running
  coding sub-agent never passes the core `shouldRespond` verdict, so the
  documented LLM path is dead and the decision is 100% regex — "let's **stop**
  using axios, switch to fetch" matches `\bstop\b` and **cancels the in-flight
  turn**. Fix: compute and thread `shouldRespond`; keep regex as a pre-filter.
- **`task-supervisor-service.ts:209`:** `setInterval(() => void this.runOnce())`
  has no reentrancy guard (a slow tick overlaps the next and races the `seen`
  dedup map + double-posts) and the digest change-key has no staleness term, so
  a genuinely *stuck* task is deduped into permanent silence after the first
  post. Fix: in-flight guard + fold a coarse `lastActivityAt` age bucket into the
  key.

### Actions intent-parsing (`actions/tasks.ts`) — text-eval / LARP
- **`:3251` `validate()`** keyword-gates the whole coding surface on
  `looksLikePersonalLifeOpsTask(text)` — a regex that contradicts the comment 6
  lines above ("decided structurally … not by keyword-matching") and suppresses
  legitimate "add a task to build me a landing page" requests.
- **Dead `_inferWindow` / `_inferSearch` / `_inferStatuses`** (~120 lines) plus a
  history schema advertising `window`/`statuses`/`search` filters that
  `runHistory` ignores — "tasks from yesterday" / "blocked tasks" silently
  return the same unfiltered recent list.
- **`inferControlAction`** maps life-critical pause/stop/resume from hardcoded
  English slang ("make it so", "yeah i'm down"); `inferIssueAction` /
  `inferMetric` similarly regex-guess mutating operations. All are fallbacks
  behind planner params that should be authoritative.
- Hardcoded terminal fallback agent type `"codex"` (`:525,837,1266`) contradicts
  the documented `elizaos` default and spawns a possibly-unauthed backend.

### Store concurrency (medium)
- **`orchestrator-task-store.ts`:** both the file and SQL backends do lock-free
  read-modify-write of a whole-document blob (file backend never re-reads after
  first load), so concurrent writers lose tasks/events. `deleteTask` on the SQL
  backend always returns `true`. Lock acquire-timeout equals the stale-lock
  threshold (crashed-holder recovery can race the deadline).

### Security follow-ups (medium)
- **`ssrf-guard.ts:267`:** `assertUrlAllowed` resolves DNS, then `fetch` resolves
  again — a low-TTL rebind between the two reaches internal IPs. Pin the vetted
  IP and connect to it. (The git outbound surface is now covered by S1's
  `GIT_ALLOW_PROTOCOL`.)
- **`acp-service.ts:2474`:** blanket `ELIZA_*` env forwarding into sub-agents that
  default to an approve-all preset — invert to an explicit credential allowlist.

## Already fixed by the swarm (verified on develop — no action needed)
- Independent execution verifier + completion-envelope structural gate **wired**
  into `autoVerifyCompletion` (were dead code on the stale branch).
- `runHealthCheck` respawn-cascade neutralized (grace window; status message is
  descriptive, not an imperative the planner obeyed).
- `#8875` per-origin spawn cap armed for dashboard/web (#10890).
- Multi-account rotation + in-chat add-account UX (#10776, #9960).
- Cerebras text default → Gemma 4 (#10733).

## Test-quality verdict
Real. ~86% of sampled tests genuinely exercise product code; 0% pure-LARP.
Improvements to make: (1) a keyless end-to-end grill scenario whose judge is
**not** a fixture (the current `pr-deterministic` grilling scenario's
`judgeRubric` is graded by a stubbed judge — circular); (2) a CI guard that fails
loudly when the env-gated live lanes silently no-op; (3) a concurrency test for
`OrchestratorTaskService` event-bridge races (same-session interleaved
`task_complete`/`error`/`blocked`).

## Next
Remaining fixes above + scenario/benchmark expansion (multi-task, concurrency,
noise/multi-user/multi-channel, real-judge grill) run against **Gemma-4 on
Cerebras** for end-to-end validation.
