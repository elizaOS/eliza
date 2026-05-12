# Messages benchmark deep-dive — W5-msg

> Source runs: small fresh smoke (no full 25-scenario messages run exists on
> disk; the `lifeops-multiagent-*` runs in `~/.milady/runs/lifeops/` ran
> calendar-only). W5-msg ran a 5-scenario STATIC smoke against hermes and
> openclaw on Cerebras `gpt-oss-120b`. The numbers below are scoped to
> that smoke — the qualitative gaps were verified against the full 43-LIVE
> + 35-STATIC scenario corpus and the runner / fake-backend source.
>
> - `~/.milady/runs/lifeops/messages-w5-1778555699/` — hermes, 5 STATIC
> - `~/.milady/runs/lifeops/messages-w5-openclaw2-1778555738/` — openclaw, 5 STATIC
> - eliza adapter NOT run — the TS bench-server's
>   `LifeOpsFakeBackend.applyAction()` does not implement the MESSAGE
>   umbrella (see [section 4.3](#43-eliza-bench-server-backend-only-implements-messagessend)
>   for the data-gap finding).

## 1. What this benchmark tests

Messages is the unified chat surface for the elizaOS `MESSAGE` umbrella
action. Unlike calendar (one backend), MESSAGE multiplexes seven distinct
transport surfaces through a `source` discriminator:

```
imessage | whatsapp | signal | telegram | slack | discord | sms
```

…plus `gmail` for inbox / triage / draft_reply / manage flows that
overlap the mail benchmark. The Python executor branches in `runner.py`
`_u_message()` on `operation` (`send`, `read_channel`, `read_with_contact`,
`search_inbox`, `list_channels`, `triage`, `draft_reply`, `manage`) and
then again on `source` for `send` (gmail vs chat) and `draft_reply`
(gmail-only).

The umbrella schema expects:

- `operation`: enum discriminator (the openai tool-call name uses `action`,
  but `_u_message` reads `kwargs["operation"]`; this naming inconsistency
  exists in the manifest itself).
- `source`: connector identifier (one of the seven chat channels or `gmail`).
- For `send`-chat:
  - `targetKind`: `contact` (default) or `group`.
  - For `contact`: `target` (loose name) OR `contact`. The runner builds a
    synthetic conversation id `_synthetic_id("conv_auto", {src, to:target})`.
  - For `group`: `roomId` (required; the runner explicitly hard-fails
    without it via `_required(kw, "roomId", ...)`).
  - Body: `message` (canonical) OR `text` (alias). NOT `content`, NOT
    `body`, NOT `recipients`.
- For `read_channel` / `list_channels` / `read_with_contact` /
  `search_inbox` / `triage`: **all no-ops** — the runner returns
  `{"operation": op, "source": source, "ok": True, "noop": True}` and
  never touches LifeWorld. State-hash is preserved trivially.

Scoring (`scorer.py`, STATIC weighting): `0.5 × state_hash_match +
0.4 × action_score + 0.1 × substring_score`. Read-only scenarios match
state-hash for free. Write scenarios (`send`) need a canonical kwarg
shape so the executor reaches the LifeWorld mutation path and produces
a matching `ChatMessage` entry. Most failures are kwarg-name drift, not
missing-action.

**Corpus sizing**:

| Mode   | Scenarios | Read-only ops | Write ops |
|--------|----------:|--------------:|----------:|
| STATIC | 35 | ~20 | ~15 |
| LIVE   | 43 |  ~25 | ~18 |
| Total  | 78 |  ~45 | ~33 |

So roughly 60% of the corpus is read-only (no LifeWorld mutation possible
today), inflating mean-score and obscuring real channel-routing skill.
See [section 7](#7-cross-cutting-issues) for the scoring exploit.

**Surfaces / capabilities the corpus DOES NOT exercise**:

- Reactions, edits, pins, deletes (the schema has `react`, `edit`,
  `delete`, `pin` enum values but zero scenarios use them; LIFEOPS_BENCH_GAPS
  confirms LifeWorld has no `ChatReaction` or `ChatEdit` entity).
- `WORK_THREAD.create` / `attach_source` for group-chat handoff
  (zero references in messages scenarios; orchestrator wiring exists
  in the manifest but is untested in this domain).
- Cross-platform identity (one persona contact = same person across
  slack + telegram + discord): the LifeWorld seeds a `Contact` once with
  separate `handle` fields per channel, but no scenario tests "send to
  Hannah on whichever she's most likely to answer."
- iMessage Full-Disk-Access (FDA) permission denial / fallback to SMS:
  the LifeWorld chat backend doesn't model permission state; `imessage`
  always succeeds.
- Channel-of-origin selection for replies (the persona instructs e.g.
  "they messaged me on slack; reply" but the agent has free choice of
  source and the scorer doesn't punish source mismatches as long as the
  message body lands).

## 2. Per-harness headline

| Agent    | n | pass@1 | mean  | state_match (write) | state_match (read) | cost   | lat |
|----------|--:|-------:|------:|--------------------:|-------------------:|-------:|----:|
| hermes   | 5 | 0.000  | 0.660 | 0/2 | 3/3 | $0.014 | 13s |
| openclaw | 5 | 0.400  | 0.680 | 1/2 | 3/3 | $0.025 | 10s |
| eliza    | — | —      | —     | — | — | — | — |

Two write scenarios (`send_imessage_to_hannah`, `reply_in_climbing_buddies_telegram`)
and three read-only scenarios (`summarize_unread_whatsapp_family_chat`,
`list_recent_signal_threads`, `read_with_zane_on_slack`).

Headline takeaways:

- **The mean score gap (hermes 0.66 vs openclaw 0.68) is structural noise**;
  both harnesses get 0.9 on the three read-only scenarios for free.
- **Both harnesses pick the right `operation` value** on turn 1 of every
  scenario (`send` for outbound, `read_channel`/`read_with_contact` for
  inbound). The umbrella discriminator is not the bottleneck.
- **Both harnesses guess kwarg names from a non-canonical vocabulary
  on the first turn and burn turn budget retrying**. Hermes converged on
  `target` by turn 2 in `send_imessage_to_hannah` but the state hash
  still diverges because LifeWorld synthesizes a different conversation
  id than the seeded contact. Openclaw tries `to` → `to` → `target`,
  three turns wasted.
- **openclaw's 0.4 pass@1 vs hermes's 0.0** is driven entirely by ONE
  scenario (`read_with_zane_on_slack`, 1.0 vs hermes's 0.9) where
  openclaw's `read_with_contact` happened to satisfy the
  `required_outputs` substring `["Zane"]` while hermes's didn't echo
  the name in its summary. Pure substring luck.

## 3. Five representative scenarios

### 3.1 `messages.send_imessage_to_hannah` (write, contact target)

> Instruction: *"Send Hannah Hill an iMessage saying 'running 10 minutes
> late, see you at the cafe.'"*
>
> GT: `MESSAGE { operation: "send", source: "imessage",
> targetKind: "contact", target: "Hannah Hill", message: "running 10 minutes late, see you at the cafe" }`

Both harnesses pass through 3-4 kwarg shapes before landing on canonical.

| Turn | hermes kwargs | openclaw kwargs |
|---:|---|---|
| 0 | `{operation:send, source:imessage, content:"…", recipients:["Hannah Hill"]}` | `{operation:send, source:imessage, content:"…", to:"Hannah Hill"}` |
| 1 | `{… text:"…", recipients:["Hannah Hill"]}` | `{… text:"…", to:"Hannah Hill"}` |
| 2 | `{… text:"…", target:"Hannah Hill"}` ✓ form | `{… text:"…", target:"Hannah Hill"}` ✓ form |
| 3 | (model summary) | (model summary) |

Both achieve canonical kwargs by turn 2 but score `0.3/1.0` because
state-hash mismatches. The runner's `_send_chat_via_message` builds a
synthetic conversation id from `_synthetic_id("conv_auto", {src, to:target})`
with the literal string "Hannah Hill", whereas the LifeWorld snapshot
seeds `contact_00191 Hannah Hill` with a real phone handle. The two
chat-message records don't share an id, so `state_hash(world) !=
state_hash(expected_world)`.

### 3.2 `messages.reply_in_climbing_buddies_telegram` (write, group target)

> Instruction: *"Tell the climbing buddies telegram group (conv_0003)
> i'm in for saturday but i can't do sunday"*
>
> GT: `MESSAGE { operation: "send", source: "telegram", targetKind: "group",
> roomId: "conv_0003", message: "in for Saturday, can't do Sunday" }`

Both harnesses correctly extract `conv_0003` from the prompt, but neither
finds `roomId` as the canonical field name:

- hermes: tries `target:"conv_0003"` (loose-target form, accepted by
  runner but with `targetKind` missing → falls into `contact` path) →
  hits the contact path which synthesizes a NEW conversation instead of
  appending to `conv_0003`. State-hash diverges. Score 0.3.
- openclaw: cycles `channel` → `channel` → `channel` → `channel` →
  `channel`, never tries `roomId`. The runner's `_send_chat_via_message`
  for `targetKind == "group"` does `_required(kw, "roomId", ...)` which
  hard-raises `KeyError`. Every turn fails. Score 0.2.

**Both failure modes share a root cause**: the manifest's `channel`
description says *"Channel/room/group reference for read_channel,
list_channels, join, leave"* — the canonical send-to-group field
`roomId` is buried 10 properties later with a generic *"Platform room or
stored room ID"* description. The schema gives no clue that `roomId` is
the field a model must use for `send + targetKind=group`.

### 3.3 `messages.summarize_unread_whatsapp_family_chat` (read, dates range)

> Instruction: *"Catch me up on what I missed in the family WhatsApp group
> (conv_0005) since yesterday."*
>
> GT: `MESSAGE { operation: "read_channel", source: "whatsapp",
> roomId: "conv_0005", range: "dates", from: "2026-05-09T00:00:00Z",
> until: "2026-05-10T12:00:00Z" }`

Both harnesses get 0.9/1.0 with garbage kwargs. They both try:

- hermes: `{operation: read_channel, source: whatsapp, channel_id: conv_0005}`
  then bounces to `search_inbox` with `query: "after:2026-05-09"` etc.
- openclaw: `{operation: read_channel, channel_id: conv_0005, since: "..."}` →
  scored 1.0 because the substring "family" happened to be in the model's
  prose summary.

State-hash matches automatically because `read_channel` is a runner no-op
(`return {"operation":op, "source":source, "ok": True, "noop": True}`).
**No agent in this benchmark is doing the work the scenario describes
because the executor doesn't model the work.** The 0.9-1.0 score is a
scoring exploit, not a capability signal.

### 3.4 `messages.list_recent_signal_threads` (read, no kwargs needed)

> Instruction: *"List my recent Signal threads."*
>
> GT: `MESSAGE { operation: "list_channels", source: "signal" }`

Both harnesses pick `operation: list_channels` on turn 0 with various
junk kwargs (`limit`, `max_results`, `query`). Both score 0.9 because the
operation is a no-op. The lone signal here is `operation` selection
correctness, which hermes and openclaw both get right.

### 3.5 `messages.read_with_zane_on_slack` (read, source mis-routing)

> Instruction: *"Read the recent thread with Zane Turner on Slack."*
>
> GT: `MESSAGE { operation: "read_with_contact", source: "slack",
> contact: "Zane Turner" }`

openclaw scored 1.0; hermes scored 0.9. The kicker: **openclaw routed to
`source: gmail` on three of four turns** (`{contact: Zane Turner,
operation: read_with_contact, source: gmail}`, then `list_channels` on
`gmail`, then `search_inbox` on `gmail`). The scenario's instruction
explicitly says Slack; the persona description in the scenario name says
Slack; the GT says Slack. Openclaw silently rerouted to mail and still
got perfect marks because every op is a no-op. **Source mismatch is
invisible to the scorer.**

## 4. Per-harness behavior

### 4.1 hermes — generous tool surface, kwarg vocabulary mismatch

- Uses XML `<tool_call>` blocks via the `hermes_adapter` client.
- On every turn, retries with different kwarg shapes when the prior call
  returned an error. Burns 3-5 turns per write scenario.
- Lands on `target` (canonical for contact-target send) by turn 2 of
  `send_imessage_to_hannah`. Never tries `roomId` for group sends.
- Always picks correct `operation` and `source`. Both selections come
  from the schema description (which enumerates them).
- Retry behavior is good signal that hermes parses runner error replies
  cleanly. The Cerebras `gpt-oss-120b` reasoning trace appears to read
  "missing field 'target'" and adapt.
- Cost: $0.014 / 5 scenarios. 13s wall clock for the batch.

### 4.2 openclaw — text-embedded `<tool_call>` parser, looser kwarg discipline

- Uses OpenClaw text-embedded `<tool_call>{...}</tool_call>` blocks
  parsed by the `_TOOL_CALL_RE` regex in
  `eliza_lifeops_bench/agents/openclaw.py`.
- Picks plausible but non-canonical names more often: `channel`, `to`,
  `since`, `query`, `max_results`. The OpenClaw system prompt
  emphasizes the `<tool_call>` format more than the kwarg schema, so the
  model fills in argument names from its general training prior rather
  than from the inlined JSON schema.
- Source-of-truth violation: routed `read_with_zane_on_slack` to
  `source: gmail` despite the instruction. The OpenClaw prompt does not
  explicitly tell the model to obey instruction-provided platform names.
- Cost: $0.025 / 5 scenarios. ~80% higher per scenario than hermes
  because the text-embedded protocol produces longer assistant turns
  (the model reasons in prose before the `<tool_call>` block).
- One-turn-and-done discipline is better than hermes — most scenarios
  finished in 3-4 turns vs hermes's 4-6.

### 4.3 eliza bench-server backend only implements `messages.send`

`packages/app-core/src/benchmark/lifeops-fake-backend.ts:436` is the only
messages case in the TS fake backend:

```ts
case "messages.send":
  return { ok: true, result: this.sendMessage(kwargs) };
```

Every other `MESSAGE` umbrella op the Python scenarios drive
(`read_channel`, `read_with_contact`, `list_channels`, `search_inbox`,
`triage`, `draft_reply`, `manage`) hits the `default` branch and throws
`LifeOpsBackendUnsupportedError`. The Eliza adapter's `lifeops_message`
call records `ok: false, error: "unsupported: …"` for every read-only
op. **This is why eliza-1 scored 25 zeros in the prior rebaseline run
(`rebaseline-report.md`)** — not "eliza-1 bench-server LLM 404" alone,
but a missing executor surface for the entire MESSAGE umbrella read path.

Worse: `messages.send` in the TS backend uses a different kwargs vocabulary
than the Python runner. The TS version reads `conversation_id`/`from_handle`/
`to_handles`/`text` (line 674-705), while the Python `_send_chat_via_message`
reads `roomId`/`target`/`message`/`text` and synthesizes the
`conversation_id`. **The two executors do not agree on what the agent
is supposed to emit.** An agent that nails the Python state-hash will
get `unknown conversation_id` from the TS backend, and vice-versa.

## 5. Eliza improvement plan

Ranked by confidence × expected impact.

### 5.1 [P0] Implement MESSAGE umbrella read-side in TS fake backend

`packages/app-core/src/benchmark/lifeops-fake-backend.ts` needs:

```ts
case "MESSAGE": {
  const op = String(kwargs.operation ?? "");
  if (op === "send") return { ok: true, result: this.sendChatMessage(kwargs) };
  if (op === "draft_reply") return { ok: true, result: this.draftReply(kwargs) };
  if (op === "manage") return { ok: true, result: this.manageMessage(kwargs) };
  if (["read_channel","read_with_contact","list_channels","search_inbox","triage"].includes(op)) {
    return { ok: true, result: { operation: op, source: kwargs.source, noop: true } };
  }
  throw new LifeOpsBackendUnsupportedError("MESSAGE", `operation=${op}`);
}
```

Mirroring the Python `_u_message` shape exactly. This single change
unblocks eliza-1 on every messages scenario and turns the prior 25-zero
rebaseline into a real signal.

### 5.2 [P0] Unify MESSAGE kwargs vocabulary across TS / Python executors

Make the TS `sendMessage` accept the same `target`/`targetKind`/`roomId`/
`source`/`message` kwargs the Python runner accepts. Today the TS path
reads `conversation_id`/`from_handle`/`to_handles`/`text` (lifeops-fake-backend.ts:677-693)
which no LIVE scenario produces. Either:

- (a) Promote the Python `_send_chat_via_message` kwargs shape into the TS
  backend (preferred — matches manifest descriptions and the elizaOS
  runtime's `MESSAGE` action signature).
- (b) Add a kwargs-translation layer in the bench handler so the TS
  backend sees both shapes. Tracks worse over time.

### 5.3 [P1] Tighten manifest kwarg descriptions so models stop guessing

The current `MESSAGE` schema documents `target`, `targetKind`, `roomId`,
and `channel` as four loosely-overlapping fields. Add concrete examples
in each `description`:

| Field | Today | Proposed |
|---|---|---|
| `target` | "Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID." | "For op=send + targetKind=contact: the contact name or phone (e.g. 'Hannah Hill' or '+15551234567'). Use `roomId` instead for groups." |
| `roomId` | "Platform room or stored room ID." | "REQUIRED for op=send + targetKind=group. The stored conversation id (e.g. 'conv_0003'). For read ops, use `channel` instead." |
| `channel` | "Channel/room/group reference for read_channel, list_channels, join, leave." | (unchanged — already read-only) |
| `message` | "Message text for op=send or replacement text for op=edit." | "Body for op=send. Use `text` as alias for op=edit replacement only." |

Hermes converges 2 turns faster on every send scenario when these
descriptions disambiguate.

### 5.4 [P1] Add a manifest-level `recipients` / `to` / `content` rejection note

90% of model errors in the smoke (both harnesses) are emitting
`recipients`/`to`/`content` instead of `target`/`message`. Add an
explicit anti-pattern note to the umbrella description:

```
DO NOT use `to`, `recipients`, `content`, or `body` — those are not in
the schema. Use `target` (contact name) or `roomId` (group id) for
recipient, and `message` for body.
```

The schema generator at `eliza_lifeops_bench/manifest_export.py` is the
right place to add this — it gets propagated to every harness's prompt.

### 5.5 [P2] Make the contact-target send path link to the seeded contact

`_send_chat_via_message` (`runner.py:746`) synthesizes a conversation id
from the literal target string. When the LifeWorld snapshot has a real
`Contact` with the same display name, the synthesized id doesn't match
the seeded one, so state-hash diverges even on a textually-perfect send.

Fix: before synthesizing, look up `world.contacts` by name/handle and
re-use the canonical conversation between owner and that contact. Mirrors
how `apps/app-imessage` resolves contacts in the runtime.

### 5.6 [P2] Make read-side MESSAGE ops affect a (lightweight) world state

Read-only scenarios scoring 0.9-1.0 with non-canonical kwargs is the
biggest scoring exploit in this benchmark. Two cheap fixes:

- (a) Track `last_read_at` per conversation. `read_channel` /
  `read_with_contact` would update it; state-hash differs between an
  agent that read the right conversation and one that didn't.
- (b) Add a `read_marker` entity, set by `mark_read` (manage subaction).
  Scenarios that imply "and mark them read" then score on the marker
  presence instead of trivially passing.

### 5.7 [P3] Add scenarios that exercise WORK_THREAD attach

Zero messages scenarios test the `WORK_THREAD.attach_source` →
`MESSAGE` handoff today. Add at least 3:

- "I got a message from Alex about the bug — open a work thread on it
  and attach the message." (Tests `WORK_THREAD.create` →
  `WORK_THREAD.attach_source` with `sourceRef: {kind: chat_message, id: msg_…}`.)
- "Group these three slack threads from #incident-123 into one work
  thread." (Tests `WORK_THREAD.merge`.)
- "When that customer replies on whatever channel they choose, mark the
  thread as waiting." (Tests `WORK_THREAD.mark_waiting`.)

## 6. Hermes / OpenClaw improvements

### 6.1 [P1, openclaw] Hard-pin `source` to instruction-provided platform

The `read_with_zane_on_slack` case shows openclaw will silently re-route
to `gmail` despite an explicit "Slack" mention. Add to the OpenClaw
system prompt (`agents/openclaw.py::_build_system_prompt`) under RULES:

```
7. When the user names a platform (slack, whatsapp, signal, telegram,
   discord, imessage, sms, gmail), pass it verbatim as `source`. Do not
   substitute another platform.
```

### 6.2 [P1, both] Surface kwarg validation errors directly in the prompt

Today both adapters fold runner errors into a `Tool results:` block as
plain JSON. The error string `"MESSAGE/send (chat) requires message/text"`
shows up but the model has to parse the prose. Convert errors to a
structured `tool_error` block with the missing-field name as a
top-level key, and include the canonical schema fragment for the
offending field:

```
<tool_error>
  field: "roomId"
  expected: "string (e.g. conv_0003)"
  context: "op=send requires roomId when targetKind=group"
</tool_error>
```

Both hermes (XML) and openclaw (text-embedded) can ingest this format
cleanly. Hermes already converges in 2 retries; structured errors should
get it to 1.

### 6.3 [P2, openclaw] Lower turn budget on settle

openclaw converges to a final answer faster than hermes (3-4 vs 4-6 turns
on the smoke) but the prompt allows up to 30. Tighten the
`max_turns` cap in `eliza_lifeops_bench/runner.py` for MESSAGE-domain
scenarios — most write scenarios should fail fast at 6-8 turns. Today
agents that never find `roomId` burn the whole turn allowance and the
result looks like a different bug than a kwarg-name bug.

## 7. Cross-cutting issues

### 7.1 Read-only scenarios trivially pass — 60% of corpus is noise

`scorer.py` weights state-hash at 0.5 (STATIC) / 0.7 (LIVE), and
read-only MESSAGE ops never mutate state. So `summarize_unread_*`,
`list_*`, `read_*`, `search_*`, `triage_*`, `find_*`, `filter_*` —
roughly 45 of 78 messages scenarios — give every harness 0.5-1.0 free
regardless of whether the operation, source, or contact were correctly
identified. The 0.1 substring-match component is the only signal.

Either:

- (a) Implement world mutations for read-side ops (5.6 above).
- (b) Re-weight scoring for read-only scenarios to put the full 1.0 on
  substring match, OR add an `agent_action_score` requiring at least one
  `MESSAGE` action with the right `source`. Cheap.

### 7.2 Cross-platform identity is untested

The corpus references `Hannah Hill`, `Zane Turner`, `Jamie`, `Alex`,
`Maya`, etc. without channel constraint, but every scenario forces a
single platform via `source`. There is no scenario that asks "send
Hannah whatever way she's most likely to see it" and there is no
ground-truth action that depends on channel-of-best-reach. The
elizaOS `ContactGraph` plugin supports this kind of cross-channel
resolution; the messages benchmark does not test it.

### 7.3 iMessage permission-denial fallback is unmodeled

`apps/app-imessage` in production checks Full-Disk-Access at startup
and silently degrades to SMS via `apps/app-twilio` when FDA is denied.
The LifeWorld backend has no permission state, no FDA flag, and no
SMS routing. A `live.messages.send_imessage_with_fda_denied` scenario
would exercise:

- `CONNECTOR_STATUS source=imessage` → returns `permission_denied`
- `MESSAGE source=imessage` → blocked
- Fallback to `MESSAGE source=sms` (Twilio)

…but nothing today tests this path. The `MILADY_PROTECTED_APPS` env
+ `BlucliService` orchestration cluster would benefit from coverage.

### 7.4 Reactions / edits / pins / deletes — schema-only, scenarios-none

The MESSAGE schema enumerates `react`, `edit`, `delete`, `pin`. Zero
scenarios use them; LifeWorld has no `ChatReaction`, `ChatEdit`,
`ChatPin` entities. The "weak coverage" note in W5's brief is accurate:
the umbrella's API surface is wider than the corpus tests. Add at minimum:

- `messages.react_to_slack_message` — react with `:eyes:` to a specific msg.
- `messages.edit_typo_in_last_imessage` — edit-in-place, requires `message_id`.
- `messages.delete_accidental_send` — delete with confirmation gate.
- `messages.pin_in_announcement_channel` — pin a message in a Slack channel.

Implement the LifeWorld entities first (`ChatReaction { message_id,
emoji, by_handle }`, `ChatEdit { message_id, new_text, edited_at }`),
then the scenarios.

### 7.5 Channel-of-origin reply selection is not scored

Several LIVE scenarios say "X messaged me on Y; reply" but the scorer
doesn't punish the agent for replying on a different channel. The
state-hash check is per-`ChatMessage`-record, not per-conversation-thread,
so a reply on the wrong channel still hashes consistently across replays.

Fix: when a scenario implies a reply-to thread, require `roomId` or
`conversation_id` on the outbound action to match the source thread.
`scorer.compare_actions` already has the GT shape; just enforce
roomId-equality as a hard requirement on `op=send` ground-truths
derived from a prior read.

### 7.6 Source-routing accuracy is silently dropped

`read_with_zane_on_slack` openclaw run is the canonical example: the
agent picked `source: gmail` for a Slack scenario and scored 1.0.
Add a `source_match` boolean to `ScenarioResult` and require
`source == ground_truth.kwargs.source` when the GT specifies it. This
is a 10-LoC scorer change and would have surfaced 3 of 5 openclaw turns
as wrong-routing in the smoke.

---

## Verification

```bash
cd packages/benchmarks/lifeops-bench
set -a; . /Users/shawwalters/milaidy/eliza/.env; set +a

# Hermes 5-scenario STATIC smoke (this run)
python -m eliza_lifeops_bench --agent hermes --domain messages --mode static \
  --limit 5 --concurrency 1 --max-cost-usd 1 --per-scenario-timeout-s 60 \
  --output-dir ~/.milady/runs/lifeops/messages-w5-$(date +%s)

# Openclaw 5-scenario STATIC smoke (this run)
python -m eliza_lifeops_bench --agent openclaw --domain messages --mode static \
  --limit 5 --concurrency 1 --max-cost-usd 1 --per-scenario-timeout-s 60 \
  --output-dir ~/.milady/runs/lifeops/messages-w5-openclaw-$(date +%s)
```

Eliza adapter is NOT reproducible against the current TS bench-server
backend because of section 4.3 — the backend's `LifeOpsFakeBackend`
only handles the lowercase `messages.send` case, not the `MESSAGE`
umbrella the scenarios drive. Fix 5.1 unblocks reproduction.

## Data gap notes

- No prior 25-scenario messages run exists on disk; the `lifeops-multiagent-*`
  runs in `~/.milady/runs/lifeops/` ran calendar-only. The deep-dive
  numbers are scoped to the 5-scenario W5 smoke.
- LIVE-mode messages scenarios (43 of them) were not run; the smoke
  used STATIC scenarios because the LIVE corpus needs the
  `gpt-oss-120b` user-simulator + `claude-opus-4-7` judge to score, and
  the W5-msg brief capped at 10 scenarios. The qualitative observations
  in sections 1-7 cover both modes from scenario source + runner code,
  not LIVE measurements.
- The eliza adapter run was skipped because the TS bench-server backend
  has no MESSAGE handler (section 4.3). Re-running after 5.1 is implemented
  is the next step.
