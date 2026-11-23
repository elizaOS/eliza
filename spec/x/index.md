# X

The X plugin handles mentions, timeline actions, posting and direct messages through environment credentials, account OAuth or a managed broker. The rules follow `plugins/plugin-x/src/{environment,direct-messages,dm-policy,post,timeline}.ts` and `utils/provider-receipt.ts` on `develop` at `51aad7ee8a82e1b8e6fa1908ed76d0c344c75d55`.

## Story: Read recent X direct messages without replaying old messages on first connection

> As an X account owner, I want the first poll to start at the newest event and later polls to follow that account's cursor.

### X cursors compare complete decimal provider IDs and stay with the selected session

The shell parses decimal provider IDs as digits so ordering does not lose precision. First connection seeds the cursor at the newest visible event without creating a turn. A later event advances the cursor after its handler settles. A malformed, self-sent or non-message event can be consumed without sending. Account and credential rotation withdraw the previous poller's authority.

```quint
type XAuthorization = XEnvironment | XOauth | XBroker
type XCaller = XAdapter | XExternal
type XSession = { accountId: str, epoch: int, auth: XAuthorization }
type XDigitScan = { digitIndex: int, ordering: int }
type XCursor = { binding: XSession, cursor: List[int], initialized: bool }
pure val sampleXSession: XSession = { accountId: "x-one", epoch: 1, auth: XBroker }
pure val initial: XCursor = { binding: { ...sampleXSession, accountId: "", epoch: 0 }, cursor: List(), initialized: false }
pure val bindingValues = Set(sampleXSession, { ...sampleXSession, epoch: 2 }, { ...sampleXSession, accountId: "x-other" })
pure val eventIdValues = Set(List(1), List(2), List(1, 0), List(1, 0, 0), List(0, 1))
pure def validXId(digits: List[int]): bool = digits.length() > 0 and digits.nthOr(0, 0) > 0 and digits.every(digit => digit >= 0 and digit <= 9)
pure def laterXId(left: List[int], right: List[int]): bool = if (left.length() != right.length()) left.length() > right.length() else left.foldl({ digitIndex: 0, ordering: 0 }, (scan, digit) => { digitIndex: scan.digitIndex + 1, ordering: if (scan.ordering != 0) scan.ordering else digit - right.nthOr(scan.digitIndex, 0) }).ordering > 0
pure def canBindX(s: XCursor, by: XCaller, binding: XSession): bool = by == XAdapter and binding.accountId != "" and binding.epoch > s.binding.epoch
pure def bindX(s: XCursor, by: XCaller, binding: XSession): XCursor = { binding: binding, cursor: if (binding.accountId == s.binding.accountId) s.cursor else List(), initialized: binding.accountId == s.binding.accountId and s.initialized }
pure def canSeedXCursor(s: XCursor, by: XCaller, binding: XSession, eventId: List[int]): bool = by == XAdapter and s.binding == binding and binding.epoch > 0 and not(s.initialized) and validXId(eventId)
pure def seedXCursor(s: XCursor, by: XCaller, binding: XSession, eventId: List[int]): XCursor = { ...s, cursor: eventId, initialized: true }
pure def canAdvanceXCursor(s: XCursor, by: XCaller, binding: XSession, eventId: List[int], eventFinalized: bool): bool = by == XAdapter and s.binding == binding and s.initialized and eventFinalized and validXId(eventId) and laterXId(eventId, s.cursor)
pure def advanceXCursor(s: XCursor, by: XCaller, binding: XSession, eventId: List[int], eventFinalized: bool): XCursor = { ...s, cursor: eventId }
pure def alwaysXInitializedHasCursor(s: XCursor): bool = s.initialized implies validXId(s.cursor)
pure def stepXCursorMovesOnlyWithinItsAccount(before: XCursor, after: XCursor): bool = (before.initialized and before.binding.accountId == after.binding.accountId) implies (after.cursor == before.cursor or laterXId(after.cursor, before.cursor))
pure def sometimesXCursorAdvances(s: XCursor): bool = s.cursor == List(2)
pure val eval_witness_sometimesXCursorAdvances = (("bindX", XAdapter, sampleXSession), ("seedXCursor", XAdapter, sampleXSession, List(1)), ("advanceXCursor", XAdapter, sampleXSession, List(2), true))
```

## Story: Respect the X account's direct-message and autonomous publishing policy

> As an X account owner, I want unknown senders, automation and dry runs treated according to the policy I selected.

### Direct requests, discovered items and autonomous actions use their own policy gates

A one-on-one DM defaults to pairing, and a group DM does not start one-on-one pairing. Group DMs still require a valid group conversation. Autonomous posts and timeline actions require their respective opt-ins. Disabled replies and disabled direct messaging refuse those operations. Dry run can preview a permitted action but cannot dispatch it.

```quint
type XDmMode = XDmOpen | XDmAllowlist | XDmPairing | XDmDisabled
type XDmScope = XOneToOne | XGroupDm
type XDmDecision = XAcceptDm | XPairDm | XRejectDm
type XWriteKind = XPublishPost | XReplyToPost | XSendDm | XLikePost | XRepost | XQuotePost
type XWritePolicy = { dryRun: bool, postsEnabled: bool, repliesEnabled: bool, directEnabled: bool, timelineActionsEnabled: bool }
type XWriteDecision = XDoWrite | XPreviewWrite | XRejectWrite
pure def xDmDecision(scope: XDmScope, mode: XDmMode, allowlisted: bool, paired: bool, groupId: str): XDmDecision = if (scope == XGroupDm) (if (groupId != "") XAcceptDm else XRejectDm) else if (mode == XDmDisabled) XRejectDm else if (mode == XDmOpen or allowlisted or (mode == XDmPairing and paired)) XAcceptDm else if (mode == XDmPairing) XPairDm else XRejectDm
pure def xWriteEnabled(writeKind: XWriteKind, policy: XWritePolicy): bool = match writeKind {
  | XPublishPost => policy.postsEnabled
  | XReplyToPost => policy.repliesEnabled
  | XSendDm => policy.directEnabled
  | XLikePost => policy.timelineActionsEnabled
  | XRepost => policy.timelineActionsEnabled
  | XQuotePost => policy.timelineActionsEnabled
}
pure def xWriteDecision(writeKind: XWriteKind, policy: XWritePolicy): XWriteDecision = if (not(xWriteEnabled(writeKind, policy))) XRejectWrite else if (policy.dryRun) XPreviewWrite else XDoWrite
pure val policyValues = Set({ dryRun: true, postsEnabled: true, repliesEnabled: true, directEnabled: true, timelineActionsEnabled: true }, { dryRun: false, postsEnabled: false, repliesEnabled: true, directEnabled: true, timelineActionsEnabled: false })
pure def lawXDryRunCannotDispatch(writeKind: XWriteKind, policy: XWritePolicy): bool = policy.dryRun implies xWriteDecision(writeKind, policy) != XDoWrite
```

## Story: Do not repeat an X direct message that may already have reached the recipient

> As an X account owner, I want a missing receipt or failed later part to prevent a second delivery of text the provider may have accepted.

### The X direct-message journal retries only a confirmed transient refusal before any part was accepted

The adapter stores the no-replay barrier before the create request and checks that the account session stays current before every part. A transient explicit refusal with no accepted part may reopen the reply. A permanent refusal with no accepted part settles as rejected. A timeout, missing provider ID or any failure after an accepted part retains an indeterminate barrier. Successful reply memory uses the first verified item identifier in provider order.

```quint
type XDmJournalPhase = XNoAttempt | XBarrierRecorded | XAwaitingPart | XPartAccepted | XAllPartsAccepted | XPermanentRefusal | XIndeterminateWrite
type XDmPartObservation = XDmAccepted({ receiptId: str }) | XDmExplicitTransientRefusal | XDmExplicitPermanentRefusal | XDmOutcomeUnknown
type XDmWrite = { phase: XDmJournalPhase, plannedParts: int, acceptedIds: List[str] }
pure val emptyXDmWrite: XDmWrite = { phase: XNoAttempt, plannedParts: 0, acceptedIds: List() }
pure def xReserveDmWrite(plannedParts: int, journal: XDmWrite): XDmWrite = if (journal.phase == XNoAttempt and plannedParts > 0) { ...journal, plannedParts: plannedParts, phase: XBarrierRecorded } else journal
pure def xDispatchDmPart(sessionCurrent: bool, journal: XDmWrite): XDmWrite = if (sessionCurrent and (journal.phase == XBarrierRecorded or journal.phase == XPartAccepted)) { ...journal, phase: XAwaitingPart } else if (not(sessionCurrent) and journal.phase == XBarrierRecorded and journal.acceptedIds.length() == 0) emptyXDmWrite else if (not(sessionCurrent) and journal.phase == XPartAccepted) { ...journal, phase: XIndeterminateWrite } else journal
pure def xObserveDmPart(observation: XDmPartObservation, journal: XDmWrite): XDmWrite = if (journal.phase != XAwaitingPart) journal else match observation {
  | XDmAccepted(r) => if (r.receiptId == "") { ...journal, phase: XIndeterminateWrite } else { ...journal, acceptedIds: journal.acceptedIds.append(r.receiptId), phase: if (journal.acceptedIds.length() + 1 == journal.plannedParts) XAllPartsAccepted else XPartAccepted }
  | XDmExplicitTransientRefusal => if (journal.acceptedIds.length() == 0) emptyXDmWrite else { ...journal, phase: XIndeterminateWrite }
  | XDmExplicitPermanentRefusal => { ...journal, phase: if (journal.acceptedIds.length() == 0) XPermanentRefusal else XIndeterminateWrite }
  | XDmOutcomeUnknown => { ...journal, phase: XIndeterminateWrite }
}
pure def xDmFirstReceipt(journal: XDmWrite): str = journal.acceptedIds.nthOr(0, "")
pure val journalValues = Set(emptyXDmWrite, { phase: XAwaitingPart, plannedParts: 1, acceptedIds: List() }, { phase: XAwaitingPart, plannedParts: 2, acceptedIds: List("part-one") })
pure val observationValues = Set(XDmAccepted({ receiptId: "part-two" }), XDmExplicitTransientRefusal, XDmExplicitPermanentRefusal, XDmOutcomeUnknown)
pure def lawXAmbiguousDmDoesNotReopen(journal: XDmWrite): bool = journal.phase == XAwaitingPart implies xObserveDmPart(XDmOutcomeUnknown, journal).phase == XIndeterminateWrite
pure def lawXPartNeverReopensAfterAcceptance(journal: XDmWrite, observation: XDmPartObservation): bool = journal.phase == XAwaitingPart and journal.acceptedIds.length() > 0 implies xObserveDmPart(observation, journal).phase != XNoAttempt
```
