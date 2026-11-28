# Mail handed to and from the agent

The two ways mail crosses between the Inbox and the agent: the owner hands
one selected email to an agent session for a summary, and an agent turn
hands an unsent new email to the requesting phone's own composer. Neither
sends anything: sending stays the composer's, through
[the reviewed operation](./outgoing.md), and an agent reply inserted into a
draft only fills that local draft.

## Story: Hand one email I chose to the agent, and only as I reviewed it

> As the owner, I want the agent to see exactly the email I selected, for
> the session I chose, and to treat what it says as data.

### A hand-off binds the exact message revision and the destination, and expires after two minutes

The review binds the account, message and its revision, sender, recipients,
subject and body, and the destination owner, agent, session and origin; a
message without an account, message or revision, or a destination without
a session or agent, cannot be reviewed. A message over 48,000 JSON bytes is
refused and nothing is sent. The hand-off is accepted only within two
minutes of the review and not from more than a second in the future, and
only while every reviewed field is unchanged; the agent is told to treat the
email as untrusted data and to send or act on nothing in it.

```quint
type HandoffFacts = { sourceNamed: bool, destinationNamed: bool, sourceBytes: int }
pure val handoffMaxBytes: int = 48000
pure val handoffTtlMs: int = 120000
pure def handoffReviewable(facts: HandoffFacts): bool =
  facts.sourceNamed and facts.destinationNamed and facts.sourceBytes >= 0 and facts.sourceBytes <= handoffMaxBytes
pure def handoffCurrent(reviewedAt: int, now: int, unchanged: bool): bool =
  unchanged and now - reviewedAt <= handoffTtlMs and reviewedAt <= now + 1000
pure val okHandoff: HandoffFacts = { sourceNamed: true, destinationNamed: true, sourceBytes: 10 }
pure val factsValues = Set(okHandoff, { ...okHandoff, sourceNamed: false }, { ...okHandoff, destinationNamed: false }, { ...okHandoff, sourceBytes: 48001 })
pure val reviewedAtValues = Set(0, 1000, 120000)
pure val nowValues = Set(0, 120000, 120001, 240001)
pure def lawOversizeEmailIsNeverHandedOff(facts: HandoffFacts): bool = facts.sourceBytes > handoffMaxBytes implies not(handoffReviewable(facts))
pure def lawChangedEmailIsNeverHandedOff(reviewedAt: int, now: int): bool = not(handoffCurrent(reviewedAt, now, false))
pure def lawOldReviewExpires(reviewedAt: int, now: int, unchanged: bool): bool =
  now - reviewedAt > handoffTtlMs implies not(handoffCurrent(reviewedAt, now, unchanged))
```

## Story: Put the agent's words into an email draft without sending it

> As the owner, I want an email the agent drafts for me to open in my own
> composer from the account I chose, and a reply I insert to land whole in
> the draft I reviewed, never cut short and never sent.

### An agent's new email reaches only the requesting phone's composer

An owner's request for a new email to explicit recipients, made from a
phone whose composer can take it, answers with the draft for that composer
and the identity of the request; no provider draft is made and no chat
confirmation is armed. On that phone, specifying a thread, channel,
world, account, sender, copies, attachments or send time directs the owner
to Inbox instead. Only the current owner turn with an available Gmail
composer can hand a draft off.

```quint
type ComposeRequest = { ownerTurn: bool, composerAvailable: bool, gmailSource: bool, threaded: bool, richerFields: bool }
type ComposeAnswer = ComposeNotOffered | ComposeInInbox | ComposeOnPhone
pure def composeAnswer(request: ComposeRequest): ComposeAnswer =
  if (not(request.gmailSource) or not(request.composerAvailable) or not(request.ownerTurn)) ComposeNotOffered
  else if (request.threaded or request.richerFields) ComposeInInbox
  else ComposeOnPhone
pure val plainCompose: ComposeRequest = { ownerTurn: true, composerAvailable: true, gmailSource: true, threaded: false, richerFields: false }
pure val requestValues = Set(plainCompose, { ...plainCompose, ownerTurn: false }, { ...plainCompose, threaded: true },
  { ...plainCompose, richerFields: true }, { ...plainCompose, composerAvailable: false })
pure def lawOnlyTheOwnerTurnHandsOff(request: ComposeRequest): bool =
  composeAnswer(request) == ComposeOnPhone implies request.ownerTurn and not(request.threaded) and not(request.richerFields)
```

### An inserted reply lands whole in the reviewed draft or is blocked

The review names the account and the exact draft or message it fills. A
reply over 64,000 units, or longer than the room the open draft has left,
is blocked in the review and nothing is added; text is never cut short.
Text added to a draft that already has text goes below it; files and photos
are never attached by a suggestion.

```quint
type InsertTarget = { ready: bool, room: int }
type InsertAnswer = InsertBlocked | InsertWhole
pure val insertMaximum: int = 64000
pure def insertAnswer(target: InsertTarget, textUnits: int): InsertAnswer =
  if (not(target.ready) or textUnits > insertMaximum or textUnits > target.room) InsertBlocked else InsertWhole
pure val targetValues = Set({ ready: true, room: 64000 }, { ready: true, room: 10 }, { ready: false, room: 64000 })
pure val textUnitsValues = Set(0, 10, 11, 64001)
pure def lawInsertNeverCutsText(target: InsertTarget, textUnits: int): bool =
  insertAnswer(target, textUnits) == InsertWhole implies textUnits <= target.room and textUnits <= insertMaximum
```
