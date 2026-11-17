# @elizaos/plugin-assistant

Explicitly registered conversational behavior for the Node runtime.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-assistant build  # build
bun run --cwd plugins/plugin-assistant test   # tests
```

The public OAuth provider catalog remains here; connection flows belong to
hosts, connectors, and cloud services. The unused OAuth callback bus and
plugin-configuration action plugin have been removed.

## Evaluator model selection

`ELIZA_EVALUATOR_MODEL` optionally requests a provider model only for completion
evaluation. The per-agent runtime setting takes precedence over the environment
fallback, which is used only when the runtime value is absent. Blank or
nonstring runtime values keep the existing slot and suppress that fallback.
An explicit nonblank `runEvaluator({ model })` takes precedence; blank is unspecified, not
an instruction to suppress the setting. Selection, including no override, stays
fixed through restoration and is resolved afresh on the next invocation.
Response handling, planning and extraction keep their own selections.
Provider adapters may ignore per-call selection or use their configured fallback;
recorded served-model metadata is
authoritative. Limits from a different slot model are not reused: unknown
capacity stays diagnostic and complete input reaches the provider unchanged.

## Resuming paused work

Resumption reloads the original selected domains through the current authorized
catalog, together with any newly selected domains. Saved tool schemas and prior
permissions are never reused. Missing or revoked domains stay unavailable;
`DISCOVER_ACTIONS` can retrieve other currently authorized operations. Original
outcome intents guide retrieval when the new routing decision supplies none,
while the complete checkpoint preserves receipts and prevents effect replay.

## Planner action discovery

`DISCOVER_ACTIONS` is a real per-turn `Action`, exposed to the planner as a native
function tool with typed arguments. It searches the registered action catalog;
it is not a prompt-only instruction or a second model call. Stage 1 chooses
contexts without receiving the action catalog. The planner can request more
operations throughout the turn.

Exact action hints stay selected. For other selected domains with pending
intents, the existing authorized retriever loads matching operations before
planning, avoiding a discovery round caused solely by an incomplete hint list.
Negated mutation clauses do not supply positive action hints.

Historical receipt wrappers may use compact row tables or position-preserving
shared legends when their shapes are uniform and the representation is smaller. Every value and source binding stays
available; original context events and restoration are unchanged. Shared source
review descriptions appear once in the planner instructions without weakening
the native tool schemas.

Use `query` and optional `contexts` when an action name is unknown. When contexts
are omitted, exact registered domain phrases or declared aliases in the query scope the search; the
result reports those inferred domains. Identifier fragments and path components do not
supply domain hints. Unresolved initial routing starts with discovery; explicit queries
without a domain retain global search, and explicit contexts or catalog reads remain available.
Explicit contexts accept registered aliases within the authorized catalog. Unknown
contexts stay restrictive; misses return authorized context names for correction. Search ranks
complete authorized operations and prefers matching operation names over
incidental words in long descriptions. Multiple requested operations remain
eligible. An unresolved family uses its authorized parent instead of loading all
siblings; exact child operations remain discoverable. Ambiguous wording falls
back to the existing lexical matches; a miss
means the query found nothing, not that the capability is unavailable.

Automatic initial selection and query/context search select at most ten complete
operation definitions, retaining domain coverage before filling remaining slots
by rank. Explicit Stage-1 hints remain selected even when they exceed that automatic
budget. Search reports total `matchCount`, `selectedCount`, and `deferredCount`;
`completeMatches` is false when any matching operations were deferred. Neither
the underlying catalog nor the ranker is capped. This bounds lexical/contextual
selection; it does not add vector retrieval or a semantic reranker.

Context-only loads rank against the current request and its selected outcomes;
context-only descriptions retain domain membership. Retrieval includes prior
dialogue for explicit continuations and source references, not merely a later
pronoun in a self-contained request. This ranking does not alter original dialogue
or its restoration.

The default `mode=load` enables the selected complete schemas in the next planner
round. `mode=describe` reads descriptions and schemas without enabling them.
Exact `names` load known operations or whole named families. `mode=describe`
with `names=[]` reads the complete authorized catalog with full definitions while
they fit core's action-result prompt-size threshold. A larger catalog returns an
explicit complete index instead (`catalogDetail: "index"`,
`completeDefinitions: false`): every family and child name, with its authored
`descriptionCompressed` when it has one. Full definitions then come from exact
names. An empty load searches for operations relevant to the current task.
Exact-name and full-catalog requests are not limited to ten; no name or selected
definition is truncated. Search and exact loads refresh permissions, and
execution checks them again. Discovery does not execute domain work. There is
one canonical planner discovery action. `SEARCH_ACTIONS` remains a cloud MCP
simile for connector discovery, not a separate planner registry;
`GET_ACTION_FROM_ALL` is not implemented. `DISCOVER_TOOLS` is its declared compatibility
simile: persisted or older model calls resolve to the same admitted action,
while new native schemas advertise only `DISCOVER_ACTIONS`.

Planner work continues across distinct operations and tool discovery by default.
Explicit `maxToolCalls` and `maxMemorySearchRounds` ceilings remain available;
discovery does not consume the domain-call ceiling. The default cumulative
prompt-token budget remains 1.5 million. Repeated failures, redundant mutations,
and repeated unchanged observations stop stalled work. A resource limit or
planner timeout returns an incomplete result with the full settled trajectory
and pending calls intact; it never reports earlier committed effects as undone
or automatically retries the turn.

The evaluator keeps one schema and instruction prefix across queue, receipt,
reply and host-effect changes. Current eligibility and exact source IDs follow
complete execution evidence. Runtime checks reject invalid queue/receipt IDs and
unsupported success; semantic outcome coverage can release an earlier pending
scope only when every declared intent has successful evidence and the full request
has been checked. Coverage is a model judgment, not independent execution proof.

## Reviewed history

A committed background retention review can provide a source-bound view of exact
original messages to the response handler and planner. It is not a foreground
completion certificate. Missing, stale or wrong-scope reviews retain full history;
constraints, uncertain/linked sources and unreviewed messages remain available.
The same validated view reaches action field extraction through the existing
request-bound dialogue handoff. Explicit full or invalid foreground selections
retain full-context fallback. Canonical events and historical effect outcomes
are unchanged. Explicit history
reads and restoration recover complete originals before dependent work. Initial
replies do not acquire a source-classification field or an extra review call.
After a successful native full-history read, the existing foreground selector
and exact source labels are offered together. A complete valid selection can
guide later stages; missing, stale or incomplete selections keep all originals.

Historical observations qualify only through exact operation declarations on the
registered action and canonical successful, non-replayed noop receipts. They
follow their original request through source-bound history selection and full
restoration. Mutation outcomes, undeclared operations and ambiguous bindings
remain inline; stored receipts are unchanged.

## Reviewed Clock handoffs

`@elizaos/plugin-assistant/device-clock-review` exposes the renderer-safe review coordinator. The host supplies durable approved-journal checks, one-use native consent, dispatch and receipts. Await `retire()` before changing the session owner; failed cancellation remains retryable. An opened receipt confirms dispatch, not final alarm state. Set, dismiss and snooze may mutate alarms immediately after approval.

`clock.handoff.v1` retains its one-off set payload without `days`. Explicit `days` requires `clock.handoff.v2`, including `[]` for one-off; daily is `[1,2,3,4,5,6,7]` and weekdays is `[2,3,4,5,6]`. Values follow [Android AlarmClock.EXTRA_DAYS](https://developer.android.com/reference/android/provider/AlarmClock#EXTRA_DAYS), Sunday=1 through Saturday=7. The exact unique integer array stays bound to the approved proposal; unsupported capabilities or repeat patterns are rejected instead of discarding recurrence.

Run `bun run --cwd plugins/plugin-assistant test:clock-review-export` for source and packed-consumer checks. This uses a controlled host adapter and does not qualify Android Clock behavior.

`clock.alarms.v1` adds Eliza-owned native alarms through `clock_alarm`: set,
update, delete, enable, dismiss, snooze and show. It never opens an external Clock
app. Set and update require exact time, label, phone timezone and repeat days;
targeted changes require the current alarm UUID. The full authenticated phone
snapshot supplies current alarms and explicit schedule/permission states. A
stale or unavailable snapshot cannot prove the list is empty. Approval binds
the durable store's `alarmsRevision` as `clockContextRevision`; native dispatch
must recheck it. Applied typed receipts report actual saved or scheduled changes,
not proof that a future alarm will ring. Historical receipt retrieval performs
no new effect. Older `clock.handoff.v1/v2` clients retain their external handoff;
owned-alarm clients receive only the owned operation schemas.

## Authenticated device scope

Device enrollment retains the authenticated subject for approval review, claims and receipts. The host may separately bind a verified local OWNER enrollment to the canonical workflow owner; external identities and USER/ADMIN subjects keep their own scope. Request JSON cannot choose that owner. Nullable `workflow_owner_id` preserves legacy enrollment fallback.

An authenticated installation can read or revise its enabled-view subset at `/api/client-devices/view-profile`. Updates use an expected revision; empty subsets disable all view proposals, while a null legacy profile preserves existing behavior. Open-view proposals bind the current profile revision and revalidate at approval and claim. Per-turn tool schemas are cloned, so one installation cannot narrow another installation’s registered catalog. These restrictions do not authorize execution. Nullable `view_profile` migrates without replacing device keys or enrollment identities.

Run `vitest run --config vitest.device-actions.config.ts` from this package for real HTTP/SQL device lifecycle, workflow-owner dispatch/receipt and additive-migration scenarios.

Device executors may throw `DeviceActionNotStarted` only before an effect. The
coordinator owns failed journal records' `result.dispatch` marker; hosts must
preserve it through journal finish, get and list. Display copy grants no new
no-effect authority. Exact unmarked fixed no-call records from prior coordinator
versions retain their existing recovery contract.

The package root exports the memory, knowledge-delivery and notification actions.
Hosts explicitly compose them; importing the package does not install those
actions or change an existing host's selected behavior.

Foreground device review supports Calendar free/busy, Notes content or title search,
and name-targeted record edits. Each requires its negotiated capability. The phone
owner selects records locally; receipts bind the exact approved fields and selected
record revision. Reminder v2 timing is never sent to a v1 peer. No-match results are
observations, not evidence of a completed edit.

## Reviewed phone SMS

The `sms.send.v1` device capability adds `sms_send` for the owner-approved
[AlphaPhone communication scope](https://github.com/AlphaCompute/alphaphone/issues/421)
and [MVP plan](https://github.com/AlphaCompute/alphaphone/blob/ef9825a6/docs/owner-approved-mvp-plan-2026-10-12.md).
The host admits this capability only on its trusted AOSP image. The phone must
review the exact recipients, text and active SIM on an unlocked screen before
it sends. Use the execution claim's `providerIdempotencyKey` as the native
operation ID. A repeated ID reads the journal; it must not send again.

The receipt binds that ID, SIM and SHA-256 of `smsBindingText(operation)`.
`submitted` proves only that the send API returned. `sent` requires all matching
sent callbacks. `delivered` requires all matching delivery reports. The shared
effect receipt proves submission only. Unknown and partial failures require
reconciliation; they do not permit automatic retry. This contract does not
implement MMS, native transport, SIM qualification or device delivery evidence.

A phone that also negotiates `sms.compose.v2` receives `sms_compose` with a
`target`: a contact name or an exact number. The phone chooses the SIM, so a
number can be texted from any view. `draft: true` puts the text into that
conversation's text field and sends nothing. A phone without telephony
capabilities is told to say that calls and texts are not available.

## Contacts from chat

`contacts.write.v1` adds `contact_create`, `contact_update` and
`contact_delete`. The phone finds the contact, shows the owner the change, and
writes only after approval. The agent receives the outcome only.

A phone that also negotiates `contacts.write.v2` receives `contact_update` with
`add` and `remove`. Each holds numbers or email addresses. The phone removes
and adds only those values and keeps the others. Without it, `set` replaces a
field whole, and the model is told to ask before it replaces.

`contacts.show.v1` adds `contact_show {query}`. The phone opens Contacts with
the matches. The agent learns only `shown` or `not-found`.

`contacts.read.v1` adds `contact_read_selected`. The owner approves sharing
the one contact open in Contacts: its name, numbers and email addresses. The
agent never searches or lists the address book.

## Browser from chat

`browser_navigate {url}` opens only an address the owner typed in the current
message. A typed `http://` address opens over HTTPS. The phone opens it without
a review only when the whole message is a direct request, such as "open
example.com". Any other typed address gets a review card. The host's assistant
name may come before the request ("Alpha, open example.com"): the server reads
the character name, and the phone passes `assistantName` in its client profile.

Each control below needs its own negotiated capability. The agent learns only
whether it ran. It never receives the tab list, a title, an address or page
content.

- `browser.search.v1`: `browser_search {query}`. The query is words the owner
  typed in the current message. The phone builds the search address with its
  own search engine.
- `browser.tabs.v1`: `browser_tab_new {private}`, `browser_tab_switch {target}`
  and `browser_tab_close {target}`. `target` is a word of the tab's title or
  site. The phone finds the tab, and the owner picks when more than one
  matches. Without `target`, close acts on the tab that is showing. The owner
  always reviews a close.
- `browser.find.v1`: `browser_find {text}` shows the matches on the open page.
- `browser.history.v1`: `browser_history {action}` with `back`, `forward`,
  `reload` or `stop`.

## Requested Camera capture

The `camera.capture-photo.v1` device capability adds `camera_capture_photo`.
The renderer uses the existing Camera adapter to save one still image in Photos.
It returns a bound receipt with the media ID and image dimensions; it does not
send image bytes or a local file path to the agent. Browser media IDs remain
strings and can contain 25 decimal digits.

A request from Home uses the existing verified view handoff before capture.
The current user message, device, foreground view and action preference must
still match. A prior or uncertain request is not replayed. Camera permissions
remain controlled by the device. Clients without this capability do not receive
the operation in their tool schema. A device that also negotiates
`camera.capture-lens.v1` can receive `lens: "front"` or `lens: "back"`; without
it the phone uses the camera that is showing.

## Current-request Gmail policy

A device that negotiates `gmail.request-policy.v1` may send the top-level
`requestedActionPolicy: "initial-gmail-send-v1"` command with a new conversation
request, or `"review-gmail-send-v1"` to require confirmation even for a known
recipient. The authenticated request scope binds this choice to the canonical
user message and conversation. Message metadata and model parameters cannot
make this grant. Background, cancelled, revoked, copied, or older requests do
not qualify.

The generic policy selects a preference, not authority to send. Both modes
currently retain exact later-turn send confirmation. A model-produced allow,
message metadata, or a foreground request alone cannot bypass it. Cancellation,
revocation, exact draft digest checks, and one-use approval remain enforced.
Automatic text-only requested sends remain unimplemented until a host can bind
a trusted user effect origin to the original request and exact message payload.
This does not change Google scopes or permit replay of an uncertain send.
