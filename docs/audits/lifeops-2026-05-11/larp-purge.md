# LARP Purge — 2026-05-11

Sub-agents W1-2 / W1-2b purged hall-of-shame LARP tests identified by the 2026-05-09 audit (`docs/audits/lifeops-2026-05-09/02-scenario-larp-audit.md`), plus deeper-scan finds.

## Files deleted

### Hall of shame (audit-identified)

| File | Why it was LARP |
|---|---|
| `plugins/app-lifeops/test/helpers/lifeops-deterministic-llm.ts` | Hard-coded planner answers by substring match on the prompt; the embedded judge always returned `{ passed: true, score: 1 }`. Zero in-tree consumers besides the sibling chat-runtime helper (dead code). |
| `plugins/app-lifeops/test/helpers/lifeops-chat-runtime.ts` | Sole consumer of the deterministic-LLM helper above; removed alongside it. |
| `plugins/app-lifeops/test/cancellation-fee.e2e.test.ts` | Only live assertion was `expect(reply).not.toMatch(/something (?:went wrong\|flaked)|try again/i)`; the actual journey ("agent warns about the $150 cancellation fee") was `it.todo`. Test passed without ever inspecting the warning or the fee. |
| `plugins/app-lifeops/test/stuck-agent-call.e2e.test.ts` | Final assertion was `expect(reply.length > 0 || browserCalls.length > 0 || escalations.length > 0).toBe(true)` — the disjunction makes any non-error reply satisfy the test. The CAPTCHA-blocked-→-voice-call journey was `it.todo`. |
| `plugins/app-lifeops/test/group-chat-handoff.e2e.test.ts` | Sole assertion was `expect(reply).not.toMatch(/something (?:went wrong\|flaked)|try again/i)`. Test claims to cover handoff but never inspects `HandoffStore`, room policy, or message routing. |
| `plugins/app-lifeops/test/eow-escalation.e2e.test.ts` | Only conditional assertion: `if (smsCalls.length > 0) { expect(smsCalls[0]?.path ?? "").toMatch(/messages/i); }`. When SMS doesn't fire the test silently passes. The journey body lived in two `it.todo` placeholders. |
| `plugins/app-lifeops/test/daily-brief.drafts.e2e.test.ts` | Pre-seeded two `send_email` approvals into the approval queue in `beforeAll`, then asserted the queue still contained those drafts. The agent's actual brief reply was checked only against `not.toMatch(/something went wrong/i)`. The journey claims "the brief mentions the drafts" but the brief was never inspected. |
| `plugins/app-lifeops/test/assistant-user-journeys.identity-merge.live.e2e.test.ts` | `seedCanonicalIdentityFixture` followed by `acceptCanonicalIdentityMerge` ran in `beforeAll` — the merge happens **before** the agent receives a message. The final `assertCanonicalIdentityMerged` then holds because the helper already merged everything. The agent never had to decide whether to merge. |

## Files rewritten

| File | Before | After |
|---|---|---|
| `plugins/app-lifeops/test/booking-preferences.e2e.test.ts` | After Turn 1, the test inspected the owner profile and if the agent failed to capture preferences the test wrote them itself via `updateLifeOpsOwnerProfile`, then asserted the profile contained them. The capture-failure path was indistinguishable from success. | The test no longer writes preferences. After Turn 1 it reads the owner profile and asserts the captured value matches `/aisle|checked bag|300|venue/i` with a diagnostic on failure. If the agent fails to capture, the test fails. Turn 2 still asserts the agent does not re-ask for preferences. |

## Files updated

| File | Change |
|---|---|
| `plugins/app-lifeops/coverage-matrix.md` | Rows 14 (group-chat handoff), 18 (identity merge), 22 (push notifications), 23 (remote sessions) flipped from `covered` to `uncovered (LARP purged 2026-05-11 — see docs/audits/lifeops-2026-05-11/larp-purge.md)`. Their `testFile` cells set to `—`. |
| `plugins/app-lifeops/test/prd-coverage.contract.test.ts` | The `every row points to a real test file on disk` contract now allows rows whose status contains `uncovered` to omit a `testFile` path. The exemption is narrow: a typo in the status column will not bypass the check. Coverage backlog is tracked in this audit doc, not in the contract. |

## Coverage delta

- **4 domain rows lost coverage**: group-chat handoff (row 14), identity merge (row 18), push notifications (row 22), remote sessions (row 23).
- These need real tests in Wave-2. Tracked below.

## Wave-2 followups (real tests needed)

1. **Group chat handoff** — covers `WORK_THREAD.create` + `MESSAGE_HANDOFF.enter` + room policy, asserting actual handoff store mutations and channel routing. Mockoon: slack, discord.
2. **Identity merge** — covers `ENTITY.merge` across 4 platforms with the agent deciding to merge from raw signals, NOT a pre-merged fixture. Mockoon: gmail + signal + telegram + whatsapp.
3. **Push notification ladder (cancellation fee)** — covers `T-1h` / `T-10m` / `T-0` escalation with cost framing in the user-facing message. Mockoon: ntfy + twilio + calendar.
4. **Remote session lifecycle (stuck-agent voice call)** — covers `VOICE_CALL.call` when browser automation hits CAPTCHA, including the confirmation token before placing the call. Mockoon: twilio + browser-workspace.
5. **Cancellation fee warning (T-24h, proactive)** — currently `it.todo` in the deleted file: requires a background-scheduler tick to fire the warning without a user prompt. Mockoon: calendar + duffel.
6. **EOW escalation** — covers Friday EOW deadline → SMS escalation → 30-min unanswered → phone call → unanswered → Discord. Mockoon: gmail + twilio + discord.
7. **Daily brief drafts** — asserts the brief reply mentions `DRAFT_SUBJECT_1` or `DRAFT_RECIPIENT_1` from the seeded approval queue, i.e. the agent surfaces what is in the queue. Mockoon: gmail.
8. **Stuck-agent voice call (full journey)** — covers `VOICE_CALL.call` placement when agent can't proceed (CAPTCHA, etc.), with seeded blocked-state. Mockoon: twilio + browser-workspace.

Followups 5–8 cover the same domains as 3–4 with different journey angles; tracked separately so each can be implemented and verified independently.

## Additional LARP found (beyond audit hall of shame)

None in the live `plugins/app-lifeops/test/` tree.

Deeper scan confirmed:

- `grep -rn "createLifeOpsDeterministicLlm|lifeops-deterministic-llm|lifeops-chat-runtime"` returns zero hits outside `.claude/worktrees/` snapshots of other agents (which are not part of the build).
- `grep -nE "toBeGreaterThanOrEqual"` in the test tree returns zero hits.
- `expect(...).toBe(true)` patterns in `signature-deadline.e2e.test.ts`, `flight-rebook.e2e.test.ts`, and `portal-upload.e2e.test.ts` were inspected. All are backed by real assertions (approval-queue enqueue checks, judge rubrics with `minimumScore`, or structured reply matches against domain-specific terms). Not LARP.
- `expect(...).toBeDefined()` patterns in `journey-domain-coverage.test.ts`, `journey-extended-coverage.test.ts`, `scheduled-task-end-to-end.e2e.test.ts`, etc., are all followed by further structural assertions on the same object. Not LARP.

W1-2's purge of the hall-of-shame list was complete.

## Verification

- `grep -rn "createLifeOpsDeterministicLlm" --include="*.ts" --exclude-dir=".claude" --exclude-dir="node_modules" --exclude-dir="dist"` → zero hits in the live tree.
- `bun x vitest run plugins/app-lifeops/test/prd-coverage.contract.test.ts --reporter=verbose` → 9/9 pass; the `uncovered` exemption is honored and no orphan test files are flagged.
- Test files deleted in commit `7ba0a2df3b` are no longer referenced by any in-tree import (verified via `grep -rn` for each filename root).
