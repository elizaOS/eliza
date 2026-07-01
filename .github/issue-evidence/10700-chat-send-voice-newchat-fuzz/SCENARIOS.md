# #10700 — Interleaved send-text / send-voice / new-chat lifecycle fuzz

Deterministic + seeded scenario matrix for the two harnesses that guard the
chat send/voice/new-chat race:

1. **Component fuzz** (vitest + jsdom): drives the REAL send queue
   (`useChatSend` via `renderHook(useChatSend, deps)`) plus a thin real-shape
   `send()` wrapper, network mocked at the `ElizaClient` layer.
2. **Playwright e2e** (`packages/app/test/ui-smoke/`): modeled on
   `chat-clear-swipe.spec.ts`, desktop chromium + Pixel-7 mobile lanes, stateful
   in-spec conversation store at the network layer.

The user checklist (loud/quiet voice, multi-speaker, room noise, speakers
entering/leaving, long-form transcription, button smashing, all button states,
voice toggle storms, interleaved text+voice, transcribe-on/off while sending,
swiping mid-voice, view switching mid-chat/mid-transcription, TTS echo
rejection) maps onto the action alphabet + condition modifiers below. Every
checklist item is tagged `[C#]` and cross-referenced in §6.

---

## 0. Root-cause recap (the code the matrix defends)

Ground truth, read this session:

- `packages/ui/src/state/useChatSend.ts`
  - `sendChatText(rawInput, options)` (~1347) pushes a queued turn with
    `conversationId: options?.conversationId` (~1366) — **undefined when the
    caller omits it** — then `void flushQueuedChatSends()`.
  - `runQueuedChatSend` (~787) resolves the target late at drain time:
    `convId = turn.conversationId ?? activeConversationIdRef.current ?? ""`
    (~824). If still empty it calls `client.createConversation(...)` (~828) and
    pins the new id into `activeConversationIdRef.current` (~841).
  - `flushQueuedChatSends` (~1266) is single-flight via `chatSendBusyRef`.
  - `handleChatSend` (~1379) snapshots `conversationId:
    activeConversationIdRef.current` **at enqueue** (~1407) — the typed composer
    path is NOT exposed to the race.
- `packages/ui/src/components/shell/useShellController.ts`
  - `send(text, options)` (~600): sets `lastTurnVoice = (channelType ===
    "VOICE_DM")`, calls `sendChatText(trimmed, options?)` — **the `options` it
    forwards never contains a `conversationId`** (voice `onCommit` at ~704 and
    suggestion sends pass only `channelType`/`metadata`). This is the
    unprotected asymmetric surface.
  - `clearConversation` (~327): `setLastTurnVoice(false)` then
    `runWithConversationLoading(handleNewConversation)`, which activates a new
    conversation (mutating `activeConversationId`).
  - `runWithConversationLoading` (~290): seq-guarded, 12s watchdog
    (`CONVERSATION_LOADING_MAX_MS`).
  - Voice: `startCapture` (~656) bails if `captureRef` set;
    `stopCaptureAndDrain` (~629) sets `explicitStopRef`, clears
    `turnCarryoverRef`, resets aggregator; `toggleRecording` (~876);
    `toggleTranscriptionMode` (~1049); `stopTranscriptionAndMic` (~1094).

**THE RACE.** A `clearConversation()` (new-chat) issued between a
shell-`send()` enqueue and its drain reroutes that turn to the NEW conversation,
because `runQueuedChatSend` resolves `activeConversationIdRef.current` *late*.
The typed path is safe (enqueue-time pin); the voice/suggestion path is not.

**The fix trap (regression risk #ii).** The obvious fix — pin
`conversationId = activeConversationIdRef.current` at enqueue inside the shell
`send()` path too — must NOT break the legitimate cold-open case where
`activeConversationIdRef.current` is `null`/`""` and a double-send should create
**exactly one** conversation and land both turns in it. If the fix pins `""` at
enqueue and the drain treats `""` as "no target, create a new one" per turn,
a cold-open double-send creates TWO conversations. So the enqueue-time pin must
only capture a *non-empty* id; an empty id must stay late-bound so both queued
turns share the single conversation the first drain creates.

---

## 1. Action alphabet (the random walk)

Each action is a pure closure over the harness controls. The component fuzz and
the e2e share this alphabet; the e2e maps each to a real gesture (§5).

| Action | Symbol | Component-level effect | Target-conversation semantics |
|---|---|---|---|
| **send-text** | `T` | `send(text, { conversationId: activeIdRef.current })` via the typed `handleChatSend` shape (enqueue-time pin) | pinned active id at enqueue |
| **send-voice** | `V` | `send(turn, { channelType: "VOICE_DM", metadata })` via the shell voice `onCommit` shape (NO conversationId) | late-bound at drain |
| **send-suggestion** | `S` | `send(text, { channelType: "DM", metadata })` (NO conversationId) — same asymmetric surface as voice, text payload | late-bound at drain |
| **rec-on** | `R+` | `toggleRecording()` / `toggleHandsFree()` from idle → capture opens | n/a (mic state) |
| **rec-off** | `R-` | `toggleRecording()` from listening → `stopCaptureAndDrain` (discards half-utterance) | n/a |
| **transcribe-on** | `X+` | `toggleTranscriptionMode()` off→on (record-only; pauses reply loop) | n/a |
| **transcribe-off** | `X-` | `toggleTranscriptionMode()` on→off (leaves mic on, resumes hands-free loop) | n/a |
| **mic-master-off** | `M-` | `stopTranscriptionAndMic()` (mic parent off — kills transcript too) | n/a |
| **new-chat** | `N` | `clearConversation()` → activates a fresh conversation; `setLastTurnVoice(false)` | mutates active id |
| **swipe-conv** | `W±` | `conversationNav.goNext()` / `goPrev()` | mutates active id (adjacency) |
| **switch-view** | `Y` | `setTab(nextView)` (chat ↔ another surface) then back | n/a (view only) |
| **drain-tick** | `·` | advance fake timers / flush microtasks — lets an in-flight queue settle | resolves late-bound turns |

**Zero-gap / rapid modifier.** Any two actions may fire inside a single `act()`
with NO intervening `drain-tick` and NO rerender. The high-value pairs — the
ones a rendered overlay cannot reproduce deterministically — are:
`V·then·N` (send-voice then new-chat before drain),
`S·then·N`, `T·then·N`, `N·then·V`, `R+·then·V-commit`, `X+·then·W`,
`N·then·N` (double new-chat), `V·then·V` at cold open (double send, no active id).

**Condition modifiers** (applied to `V` and `R+` to satisfy the acoustic
checklist — realized as `onTranscript` payload shapes fed to the fake capture,
per the existing `fireFinalTranscript` helper in
`useShellController.test.tsx`):

| Modifier | Checklist | Realization at the capture boundary |
|---|---|---|
| `loud→quiet` | [C1] | two finals with descending `amplitude`/`gain` fields on the transcript payload; assert single committed turn, no split |
| `multi-speaker` | [C2] | finals carry distinct `speakerLabel`/diarization; overlapping timestamps |
| `room-noise` | [C3] | interleave a disfluency/echo final (`"um uh"`) with a real request final |
| `speaker-enter-exit` | [C4] | a transient `speakerLabel` appears for one final then never returns; assert it doesn't corrupt the aggregator turn |
| `long-form` | [C5] | `X+` session with N accumulated finals, then `X-`; assert ONE session, all segments |
| `tts-echo` | [C14] | a final whose text equals the latest assistant reply (seed `conversationMessages`); assert `shouldRespondToVoiceTurn` suppresses → no send |

These modifiers ride on top of the alphabet; they change *what* a `V`/`R+`
produces, not the walk structure.

---

## 2. Invariant set (assert after EVERY step)

Let `delivered[c]` = the ordered list of `(convId, text)` the mocked client
actually received (component: `client.sendConversationMessageStream` calls,
keyed by its `convId` arg; e2e: the stateful store's appended user messages per
room). Let `intended` = the ordered list of `(action, text, expectedTarget)`
the walk issued, where `expectedTarget` is computed by the **reference model**
(§2.1). After each step, and again after a terminal `drain-tick`:

**(a) No message lost.** Every non-empty `T`/`S` and every committed `V`
(one that passed `shouldRespondToVoiceTurn` + the EOT aggregator) appears
**exactly once** in `delivered`, in its `expectedTarget` conversation.
Suppressed voice turns (echo/disfluency/held-mid-clause) appear **zero** times.

**(b) No duplicates.** `delivered` has no `(convId, text, nonce)` appearing
twice. Each queued turn resolves-or-rejects exactly once (the queue's
`resolve()`/`reject()` fire once per turn — assert via a per-turn settle
counter).

**(c) Ordering within a conversation.** For any conversation `c`, the
subsequence of `delivered[c]` matches the subsequence of `intended` items whose
`expectedTarget === c`, in issue order. (The single-flight `chatSendBusyRef`
drain guarantees FIFO; a regression that parallelizes drains would reorder.)

**(d) new-chat clean reset.** After `N` (and its `drain-tick`):
- the prior conversation's `delivered[prev]` is **unmutated** (no turn leaks
  backward or forward across the boundary);
- the new conversation is empty of user turns except those the walk issued
  *after* `N` resolved (greeting-only is allowed);
- `lastTurnVoice === false` immediately after `clearConversation` (assert on the
  controller — the fresh greeting must not be spoken);
- exactly ONE `createConversation` fired for that `N` (no orphan/double create).

**(e) No stuck latches after the walk.** At end of walk + a full drain:
- `recording === false` unless the last mic action left it intentionally on;
  a `V`/`R+`/`R-` sequence that ends in `R-`/`M-` must land `recording=false`,
  `handsFree=false`, `transcriptionMode=false`;
- `captureRef.current === null` after any `R-`/`M-`/close (no orphaned capture
  handle — assert the fake capture's `stop()` was called and `dispose()` ran);
- `chatSendBusyRef.current === false` and `chatSendQueueRef.current.length === 0`
  (queue fully drained, single-flight released);
- `conversationLoading === false` (the seq-guarded flag cleared; watchdog not
  left armed — assert with fake timers that no pending `setConversationLoading`
  remains);
- `serverTurnStatus`/`chatSending` settled to idle.

**(f) Active-id integrity** (inherited from the #9954 nav block): the active
conversation is always a member of the list; `nav.index` tracks it;
`hasPrev`/`hasNext` are exact index boundaries; no swipe resolved against a
stale index.

### 2.1 Reference model (`expectedTarget`)

A pure, deterministic oracle the harness runs in lockstep with the real hook.
It owns a shadow of `(activeId, conversations[], pendingQueue[])` and applies:

```
on T(text):        pin = activeId (may be "" / null); enqueue(text, pin)
on V(text)/S(text): enqueue(text, LATE)              // late marker
on N:              // clearConversation
                   newId = freshId(); conversations.unshift(newId); activeId = newId
on W±:             activeId = adjacent(activeId, dir)   // guarded, no-op at edge
on drain-tick / whenever the queue can advance (single-flight, FIFO):
   for each queued turn in order:
     target = turn.pin (if non-empty) ?? activeId (if non-empty) ?? createOne()
     // createOne() creates exactly one conversation, pins activeId to it,
     // and SUBSEQUENT late/empty turns in the same drain reuse that activeId
     record delivered(target, text)
```

`expectedTarget` is whatever this model records. Both harnesses assert the real
`delivered` equals the model's `delivered` after every step. The model encodes
the correct fix semantics (empty pin stays late; non-empty pin is honored;
cold-open batch shares one created conversation) so it doubles as the spec for
regression #ii.

---

## 3. Named deterministic regression cases

These are hand-authored, non-random `it(...)` cases pinning the exact race
windows. They run FIRST (before the seeded walks) so a reintroduced bug fails
with a legible name, not a seed number.

### (i) `new-chat while a shell-send() turn is queued must NOT deliver to the new conversation`
Setup: `activeConversationIdRef.current = "conv-A"`, conversations `[A]`.
Freeze the drain by making `sendConversationMessageStream` return a pending
promise (deferred) so `chatSendBusyRef` stays busy through step 2.
1. `V("hello A")` — shell voice send, no conversationId. It enqueues; the drain
   picks it up and is now awaiting the deferred stream against `convId = "A"`
   (late-bound at drain START, already resolved to A).
   *Sub-variant (i-b):* enqueue `V` but DO NOT let the drain start (hold
   `flushQueuedChatSends` before the first `shift`, e.g. keep an earlier turn
   in-flight) so `convId` is resolved AFTER the `N`.
2. `N()` — `clearConversation`; new conversation `fresh-1` becomes active
   (`activeConversationIdRef.current = "fresh-1"`).
3. Resolve the deferred stream; `drain-tick`.
Assert: `delivered["conv-A"] === ["hello A"]`, `delivered["fresh-1"]` contains
NO `"hello A"`. In sub-variant (i-b) — the true regression — the turn was
resolved after `N`, so a reverted fix (late-bind with no enqueue pin) delivers
to `fresh-1` and FAILS; the fixed hook (enqueue-time capture of the non-empty
`"conv-A"`) delivers to `conv-A`.

### (ii) `cold-open double shell-send must create exactly ONE conversation`
Setup: `activeConversationIdRef.current = null`, conversations `[]`. Make
`createConversation` resolve to `fresh-1` and record call count. Make
`sendConversationMessageStream` resolve normally.
1. In a SINGLE `act()`, with no drain between: `V("first")` then `V("second")`
   (both empty-pinned, late-bound).
2. `drain-tick`.
Assert: `createConversation` called **exactly once**;
`delivered["fresh-1"] === ["first", "second"]` in order; no second conversation.
This is the guardrail against an over-eager enqueue-pin fix that would pin `""`
per turn and create two conversations. Also run the mixed variant `T("a")` then
`V("b")` at cold open → still one conversation, both turns (the typed path pins
`null`→ stays late; identical outcome).

### (iii) `toggle-recording while a converse turn commits must not orphan captureRef`
Setup: hands-free engaged (`R+`), fake capture #1 open.
1. Fire a final that commits a turn (`V` via `onCommit` → `send(...VOICE_DM)`).
2. In the SAME `act()`, before the re-listen loop re-arms, `R-`
   (`toggleRecording` → `stopCaptureAndDrain`).
Assert: `captureHandles[0].stop` called, `dispose` ran, `captureRef.current ===
null`, `recording === false`, `explicitStopRef` caused the half-utterance
carryover to be discarded (no phantom second `send`). The committed turn is
delivered exactly once; no capture #2 is opened after `R-`.
*Variant (iii-b):* `R-` fires DURING the commit's microtask (interleave with a
`drain-tick` of length 0) — assert the same, no double-stop, no orphan.

### (iv) `new-chat while runWithConversationLoading pending stays seq-consistent`
Setup: make `handleNewConversation` return a controllable deferred (as in the
existing watchdog test).
1. `N()` — `clearConversation`; `conversationLoading === true`, seq = 1.
2. Before it resolves, `N()` again — seq = 2, `conversationLoading` still true.
3. Resolve the FIRST create (seq 1); assert it does NOT clear the flag
   (seq guard: `conversationLoadingSeqRef.current === 2`), spinner stays.
4. Resolve the SECOND create (seq 2); `conversationLoading === false`.
5. `drain-tick` past `CONVERSATION_LOADING_MAX_MS`; assert no late watchdog
   re-sticks the flag and no stray `setConversationLoading(true)` fires.
Assert additionally: exactly the final `N`'s conversation is active; the first
create's conversation is not left active/orphaned in a way that violates (f);
`lastTurnVoice === false` throughout.
*Variant (iv-b):* interleave a `V(...)` between the two `N`s and assert the
voice turn lands in whichever conversation the reference model says (the one
active at its drain), never split.

---

## 4. Component fuzz — level recommendation & exact wiring

### Recommendation: drive the REAL `useChatSend` via `renderHook(useChatSend, deps)` (its injected-deps seam), NOT the full AppContext-mounted `useShellController`.

**Why.** The #10700 race lives entirely in the enqueue-vs-drain timing of
`useChatSend` — the late `activeConversationIdRef.current` read in
`runQueuedChatSend` (~824) versus the enqueue-time pin in `handleChatSend`
(~1407). `useChatSend` already accepts a `UseChatSendDeps` object with the exact
refs the race turns on (`activeConversationIdRef`, `conversationsRef`,
`chatSendBusyRef`, `chatSendQueueRef` internal, `setActiveConversationId`) and a
mockable `client` — this is the seam that lets us drive the interleaving
deterministically (freeze a drain on a deferred stream, mutate
`activeConversationIdRef.current` to model `clearConversation`, resolve, and
assert the target). Mounting the full `useShellController` through a real
`AppContext` provider would (1) drag in the entire chat/voice/nav graph and its
transitive barrel imports (the existing shell test mocks `../../state`,
`../../state/app-store`, `useHomeModelStatus`, `useShellVoiceOutput`, and the
voice-capture factory precisely to avoid that), (2) make the race
non-deterministic — the overlay rerenders after every op so the closure is
always fresh and the two-op-single-closure window (the actual bug) never fires,
which is *exactly* the limitation the #9954 nav block calls out and works around
with its "rapid burst, no rerender between" cases, and (3) couple the fuzz to
unrelated UI churn. The narrow hook is more faithful to the race AND less
fragile.

**But keep the shell `send()` shape honest.** The race is asymmetric because the
shell `send()` forwards options WITHOUT a `conversationId`. So the component
fuzz wraps `useChatSend` in a tiny in-test `send()` that mirrors
`useShellController.send` exactly:
```ts
// mirrors packages/ui/src/components/shell/useShellController.ts send() (~600)
const sendVoice = (text: string, meta = {}) =>
  result.current.sendChatText(text, { channelType: "VOICE_DM", metadata: meta });   // NO conversationId
const sendSuggestion = (text: string) =>
  result.current.sendChatText(text, { channelType: "DM" });                          // NO conversationId
const sendTyped = (text: string) =>
  result.current.sendChatText(text, { conversationId: deps.activeConversationIdRef.current }); // enqueue-time pin (handleChatSend shape)
const newChat = () => {                       // mirrors clearConversation's id mutation
  const id = freshId();
  deps.setConversations((p) => [conversation(id, `room-${id}`), ...p]);
  deps.setActiveConversationId(id);
  deps.activeConversationIdRef.current = id;  // the exact late-read source of the race
};
```
`new-chat`'s voice-flag reset (`setLastTurnVoice(false)`) and the recording
latches (invariant e) are covered by the SEPARATE existing
`useShellController.test.tsx` voice suite; this fuzz owns the queue-routing
invariants (a–d, f). Do not duplicate the voice state machine here — assert the
routing, and let the shell test own the mic/transcription lifecycle. (A thin
bridge test in `useShellController.test.tsx` still asserts that the real `send()`
forwards NO `conversationId` for `VOICE_DM`, so the two harnesses agree on the
asymmetric surface — see the existing `channelType: "VOICE_DM"` assertions at
lines ~729/821/958.)

### Exact `deps` + client mock (extends the existing `makeDeps` in `useChatSend.test.tsx`)

Reuse the file's `makeDeps(overrides)` verbatim (it already builds live
`conversationsRef` + `activeConversationIdRef` + real `setConversations` /
`setActiveConversationId` that mutate the refs). Mock on `mocks.client`:

- `createConversation` → returns `{ conversation: conversation(freshId(),
  roomId) }`; **increment a call counter** (invariant ii). Default: resolve
  synchronously; a variant returns a deferred to model a slow cold-open create.
- `sendConversationMessageStream(convId, text, onToken, channelType, signal,
  images, metadata, onStatus)` → the ONLY delivery sink. Push
  `{ convId, text, channelType, nonce }` into a `delivered` array, optionally
  call `onToken("ok", "ok")` then resolve `{ text: "ok", agentName: "a",
  completed: true }`. A "freeze" variant returns a deferred keyed by a barrier so
  the harness can hold a drain open across an `N` (regression i/i-b).
- `sendWsMessage`, `abortConversationTurn` → `vi.fn()` (as today).
- Keep `elizaCloudEnabled/Connected: false` so the handoff-freeze path stays
  inert (no `CLOUD_HANDOFF_PHASE_EVENT`), isolating the new-chat race.

Fake timers (`vi.useFakeTimers`) drive `drain-tick`
(`await vi.advanceTimersByTimeAsync(0)` for microtask flush; larger advances for
the throttled streaming commit + the `runWithConversationLoading` watchdog when
the shell reset semantics are in scope). Seeded RNG via the existing
`mulberry32` (copy from `useShellController.test.tsx`) for the walks; 12 seeds ×
40 steps like the nav block, plus a dedicated ≥25-step "rapid burst, no
drain-tick between two ops" block that fires the `V·N` / `S·N` / `V·V`-cold-open
pairs — the only shape that exercises the late-bind window.

**File:** `packages/ui/src/state/__tests__/chat-send-newchat-fuzz.test.tsx`
(new; co-located with the state hook, jsdom, imports the real `useChatSend` and
the file's own `makeDeps` pattern).

---

## 5. E2E action script → real Playwright gestures

Modeled on `chat-clear-swipe.spec.ts`: stateful in-spec `makeStore()` +
`installConversationStore(page, store)` mocking `/api/conversations`,
`/api/conversations/*/messages`, DELETE/PATCH, greeting, cleanup-empty — extended
to also record **user** sends per room so the e2e can assert invariants (a)–(d)
against the store, not just greetings.

**Store extension.** Add a `POST /api/conversations/*/messages` (or the actual
send endpoint — mirror `sendConversationMessageStream`'s transport; capture the
SSE/stream POST) handler that appends `{ role:"user", text }` to
`store.messages[id]` keyed by the URL's conversation id, and records
`store.sent.push({ id, text })`. The active conversation for a send is whatever
the client targets in the request path/body — so the store observes the SAME
`convId` the race would misroute, giving a real end-to-end assertion of target
routing (not a client-side proxy).

**Lanes.** Desktop chromium + `mobile-chromium` (Pixel 7), exactly as the model
spec's projects. Voice-real-audio lanes (`chromium-voice-mic`,
`--use-file-for-fake-audio-capture`) run the acoustic-modifier subset (§6 C1–C5,
C14) using the `known-phrase` WAV fixture; the deterministic routing walk runs
on the standard lanes with the STT boundary shimmed (as in `tts-stt-e2e.spec.ts`
— shimmed `webkitSpeechRecognition` feeding scripted finals) so the walk is
byte-stable.

| Action | Real gesture / keystroke |
|---|---|
| open sheet | `pointerDrag('[data-testid="chat-sheet-grabber"]', 0, -220, 8)` → expect overlay `data-open="true"` (then `-400` to FULL for the header clear control) |
| **send-text** `T` | `page.getByTestId("chat-composer-textarea").fill(text)` → `page.keyboard.press("Enter")` (Enter submits; Shift+Enter is newline per composer keydown ~3721) |
| **send-voice** `V` | voice-mic lane: play the fixture WAV via `--use-file-for-fake-audio-capture` after `chat-composer-mic` is active; shimmed lane: `page.evaluate` dispatch a scripted final transcript into the STT shim → the converse `onCommit` fires `send(...VOICE_DM)` |
| **send-suggestion** `S` | `page.getByTestId("chat-suggestion-0").click()` (the suggestion chip → `send(text, {channelType})`, no conversationId — the same asymmetric surface) |
| **rec-on** `R+` | `page.getByTestId("chat-composer-mic").click()` (idle→listening/handsfree); assert `active` state on the mic SoftButton |
| **rec-off** `R-` | `page.getByTestId("chat-composer-mic").click()` while listening (→ stop); or `chat-composer-stop` if a reply is streaming |
| **transcribe-on** `X+` | `page.getByTestId("chat-composer-transcribe").click()` (voice-mode only; #10699 additive button); assert `chat-transcribing-badge` visible |
| **transcribe-off** `X-` | `page.getByTestId("chat-composer-transcribe").click()` again → mic stays on (badge clears, mic still `active`) |
| **mic-master-off** `M-` | `page.getByTestId("chat-composer-mic").click()` while transcribing (mic parent → both off); badge + active clear |
| **new-chat** `N` | expand to FULL, `page.getByTestId("chat-full-clear").click()`; assert fresh greeting text, NO `conversation-undo-toast`, exactly one create in `store.created` |
| **swipe-conv** `W-` (older) | `pointerDrag("#continuous-thread", -160, 0, 12)` (desktop) / `touchDrag(...)` (Pixel-7, real CDP touch); assert thread text flips to the next conversation |
| **swipe-conv** `W+` (newer) | `pointerDrag("#continuous-thread", 160, 0, 12)` / `touchDrag` |
| **switch-view** `Y` | swipe the collapsed grabber horizontally to the launcher rail (`pointerDrag('[data-testid="chat-sheet-grabber"]', -180, -6, 12)` → `home-launcher-surface` `data-page="launcher"`), open a view, return to `/chat` — assert the pending queue drained to the right conversation across the view switch |
| **drain-tick** `·` | `page.waitForResponse` on the send endpoint / `expect.poll(() => store.sent.length)` — settle before the next assertion |

**Named e2e specs** (each ends with `expectNoPageDiagnostics`):

1. `voice-send-then-newchat-routes-to-prior.spec.ts` — [regression i] open sheet,
   `V("route me")`, immediately `N`, assert `store.sent` has `"route me"` under
   the PRIOR room and the fresh room has only its greeting.
2. `cold-open-double-send-one-conversation.spec.ts` — [regression ii] from a
   cleared/empty state, `V("first")` + `V("second")` back-to-back, assert
   `store.created.length === 1` and both under that one room, in order.
3. `interleaved-text-voice-transcribe-walk.spec.ts` — the seeded walk on desktop
   + Pixel-7: a scripted 20-step sequence
   `T,V,X+,T,X-,V,W-,S,N,V,Y,T,W+,R+,V,R-,N,S,V,·` with an invariant assertion
   after each mutation (store routing + no-duplicate + ordering + no undo toast +
   no stuck badge/mic).
4. `transcription-mid-session-swipe-and-view.spec.ts` — [C5,C11,C12,C13]
   `X+`, feed long-form finals, `W-` swipe mid-transcription, `Y` switch view and
   back, `X-`; assert ONE transcript session finalized with all segments, no
   send leaked, mic/badge state consistent.
5. `button-smash.spec.ts` — [C6,C7,C8,C9] a tight loop of rapid clicks across
   `chat-composer-mic` / `chat-composer-transcribe` / `chat-composer-action` /
   `chat-composer-stop` (all reachable states) with random 0–30ms gaps; assert at
   the end: no stuck `recording`/badge, queue drained, exactly the intended sends
   delivered, no `conversation-undo-toast`, `expectNoPageDiagnostics`.
6. Voice-mic real-audio lane variant of (1)+(3) subset — [C1–C4,C14] the
   acoustic modifiers via the WAV fixture + a seeded-echo assistant message to
   drive TTS-echo rejection (assert the echoed final produces NO send).

**Files:** `packages/app/test/ui-smoke/chat-send-voice-newchat-*.spec.ts`,
reusing `helpers.ts` (`seedAppStorage`, `installDefaultAppRoutes`,
`installPageDiagnosticsGuard`, `expectNoPageDiagnostics`, `openAppPath`,
`pointerDrag`/`touchDrag` copied from `chat-clear-swipe.spec.ts`).

---

## 6. Checklist coverage matrix

| # | Condition | Component fuzz | E2E |
|---|---|---|---|
| C1 | Voice loud→quiet | `loud→quiet` modifier on `V` (amplitude fields); assert one committed turn | voice-mic real-audio lane (spec 6) |
| C2 | Multiple/overlapping speakers | `multi-speaker` modifier; assert aggregator/diarization doesn't split or drop | spec 6 |
| C3 | Background room conversation | `room-noise` modifier (disfluency interleave, `shouldRespond` gate) | spec 6 |
| C4 | Speakers enter/leave | `speaker-enter-exit` modifier; transient label doesn't corrupt turn | spec 6 |
| C5 | Long-form transcription | `X+ …finals… X-` → ONE session, all segments (invariant a for transcription) | spec 4 |
| C6 | Button smashing | rapid-modifier pairs across all actions, no drain-tick between | spec 5 |
| C7 | All button states | alphabet covers mic idle/listening/handsfree/transcribing, send, stop, transcribe on/off, disabled | specs 3,5 (assert each SoftButton `active`/`disabled`/badge) |
| C8 | Voice on/off toggle storms | `R+ R- R+ R-…` and `X+ X- …` bursts; invariant (e) latches clear | spec 5 |
| C9 | Text while doing voice | interleave `T`/`S` with `R+`/`V` in the walk; routing invariants (a–d) | spec 3 |
| C10 | Transcribe on/off while sending | `X+ T X- T` sequences; assert sends route + session integrity | spec 3,4 |
| C11 | Swipe mid-voice/mid-transcription | `V`/`X+` then `W±`; invariant (f) + no lost turn | spec 3,4 |
| C12 | Iterate back-and-forth | seeded 40-step walks (component) / 20-step (e2e) | specs (all) |
| C13 | Open/switch views mid-chat/mid-transcription | `Y` in the walk; assert queue drains to right conv across switch | spec 3,4 |
| C14 | TTS echo rejection | `tts-echo` modifier (final == latest assistant reply) → NO send | spec 6 |

---

## 7. Determinism controls

- Component: `vi.useFakeTimers()` (already the pattern in both existing test
  files); seeded `mulberry32`; `TZ=UTC` from the UI test setup; no
  `Date.now()`-derived assertions (the `audit:ui-determinism` gate forbids new
  render-time nondeterminism). Every seed is logged so a failing walk is
  reproducible by seed.
- E2E: stateful in-spec store (no live backend); STT shim for scripted finals on
  the standard lanes; `--use-file-for-fake-audio-capture` + `known-phrase` WAV on
  the voice-mic lane; `SMOKE_GENERATED_AT` frozen timestamps; `E2E_RECORD=1` for
  the video walkthrough evidence.
- Both: the reference model (§2.1) is the single oracle both harnesses assert
  against, so a divergence between "what the queue did" and "what should have
  happened" fails loudly with the exact `(action, expectedTarget, actual)` diff.

---

## 8. Evidence to attach (PR_EVIDENCE.md)

- Component fuzz: seed list + pass output; a deliberately-reverted-fix run
  showing regressions (i) and (ii) FAIL (proof the tests have teeth).
- E2E: before/after full-page screenshots desktop + Pixel-7, a video walkthrough
  of the interleaved walk (spec 3), console + network logs showing the send
  endpoint hitting the CORRECT conversation id after a new-chat, and the store's
  `sent`/`created`/`deleted` arrays dumped per test.
- Voice-mic lane: the real WAV-driven trajectory + the TTS-echo-suppressed case.
- N/A: live-LLM trajectory — this matrix mocks the model at the client layer by
  design (it tests client-side send routing, not model behavior); mark N/A with
  this reason, and cross-link the separate live voice-turn scenario if the reply
  gate (`core.voice_turn_signal`) is touched.
