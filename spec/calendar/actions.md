# Calendar agent actions

The agent reads and changes the owner's calendars through one Calendar
action. A read answers from the active account's own listed calendars.
A change to the resident calendar runs at once for the owner who asked;
a change to a provider calendar waits for the owner's approval. Both run
through the [mutation ledger](./mutationLedger.md) with exactly the
fields that were reviewed.

## Story: Ask the agent about my calendar and get my active account's events

> As the owner, I want the agent to answer from the account I am using
> now, so that another account's events never appear in its answer.

### An event is shown only from a listed calendar of the active account

An event is part of an answer only when its account is the active
account and its calendar is one the active account lists. An event of
another account, or of a calendar no longer listed, is left out, however
well its title matches.

```quint
pure def eventVisible(eventAccount: str, activeAccount: str, sourceListed: bool): bool =
  eventAccount == activeAccount and sourceListed
pure def lawOtherAccountNeverShown(eventAccount: str, activeAccount: str, sourceListed: bool): bool =
  eventAccount != activeAccount implies not(eventVisible(eventAccount, activeAccount, sourceListed))
pure val eventAccountValues = Set("owner", "other")
pure val activeAccountValues = Set("owner", "other")
```

### The calendar reaches the agent only in a turn whose audience is the owner alone

The upcoming-events context and the Calendar action are disclosed only
when the owner asks and the turn's attested audience is the owner alone.
In a room anyone else can read, or with no attested audience, the owner's
events stay out of the prompt and the action does not run.

```quint
pure def calendarDisclosed(isOwner: bool, ownerAlone: bool): bool = isOwner and ownerAlone
pure def lawSharedAudienceSeesNoCalendar(isOwner: bool): bool = not(calendarDisclosed(isOwner, false))
pure def lawOthersSeeNoCalendar(ownerAlone: bool): bool = not(calendarDisclosed(false, ownerAlone))
```

### A calendar the active account does not list never narrows a read

A read or a lookup narrows to the calendar it names only when the active
account lists that calendar. A name no listed calendar has, such as a
masked or invented id, is dropped, and the read covers every listed
calendar of the account, so it never answers "nothing" from a calendar
that does not exist.

```quint
type ReadScope = AllListed | OneListed
pure def readScope(named: bool, namedListed: bool): ReadScope =
  if (named and namedListed) OneListed else AllListed
pure def lawUnlistedNameNeverNarrows(named: bool): bool = readScope(named, false) == AllListed
```

## Story: Change my calendar only as I asked and know it happened

> As the owner, I want a change the agent makes to my calendar to carry
> exactly the fields I reviewed, to land in the calendar it named, and to
> be reported done only when the calendar shows it.

### A write goes to the active account's writable calendar, at once only for the resident calendar

A write needs the active account and a calendar that account can write.
The resident calendar applies it at once for the owner who asked, unless
the owner asked to review it first. Any provider calendar queues the
exact fields for the owner's approval, and so does a resident write the
owner asked to review. A write for another account, or to a calendar it
cannot write, is refused.

A new event the agent proposes in chat is reviewed first unless the
owner plainly chose to save it now: a create that does not say is
reviewed. A save from the owner's own calendar editor is that choice.

```quint
type WriteProvider = ResidentProvider | AccountProvider
type WriteRoute = RefuseWrite | ApplyNow | QueueApproval
pure def writeRoute(provider: WriteProvider, sameAccount: bool, writable: bool, reviewAsked: bool): WriteRoute =
  if (not(sameAccount and writable)) RefuseWrite
  else if (provider == ResidentProvider and not(reviewAsked)) ApplyNow
  else QueueApproval
pure def chatCreateReviewed(saveNowChosen: bool): bool = not(saveNowChosen)
pure def lawProviderWriteWaitsForApproval(sameAccount: bool, writable: bool, reviewAsked: bool): bool =
  writeRoute(AccountProvider, sameAccount, writable, reviewAsked) != ApplyNow
pure def lawForeignAccountRefused(provider: WriteProvider, writable: bool, reviewAsked: bool): bool =
  writeRoute(provider, false, writable, reviewAsked) == RefuseWrite
pure def lawAskedReviewWaitsForApproval(provider: WriteProvider): bool =
  writeRoute(provider, true, true, true) == QueueApproval
pure def lawUnsaidChatCreateIsReviewed(provider: WriteProvider): bool =
  writeRoute(provider, true, true, chatCreateReviewed(false)) == QueueApproval
```

### Declining an invitation never deletes the event

A removal names how it ends the owner's part in the event: the organizer
cancels it, or the owner removes a private copy. Either deletes the
event. Declining an invitation is a reply to the organizer, not a
removal; until the calendar can send that reply it is refused, and the
event stays as it was.

```quint
type CancellationMode = OrganizerCancel | DeclineInvitation | RemovePrivateCopy
type CancellationRoute = DeleteEvent | RefuseUnsupported
pure def cancellationRoute(mode: CancellationMode): CancellationRoute =
  if (mode == DeclineInvitation) RefuseUnsupported else DeleteEvent
pure def lawDeclineNeverDeletes(mode: CancellationMode): bool =
  mode == DeclineInvitation implies cancellationRoute(mode) != DeleteEvent
```

### An approved change runs only with its reviewed fields for the account that approved it

The executed change is the reviewed one: the same operation, target,
recurrence scope and fields, compared by their digest. When the active account changed since
the review, or the stored change no longer has its digest, the change is
invalidated before any provider call.

```quint
pure def reviewStillBinds(approvedAccount: str, activeAccount: str, reviewedDigest: str, payloadDigest: str): bool =
  approvedAccount == activeAccount and reviewedDigest == payloadDigest and reviewedDigest != ""
pure def lawSwitchedAccountInvalidates(approvedAccount: str, activeAccount: str, reviewedDigest: str, payloadDigest: str): bool =
  approvedAccount != activeAccount implies not(reviewStillBinds(approvedAccount, activeAccount, reviewedDigest, payloadDigest))
pure def lawChangedFieldsInvalidate(approvedAccount: str, activeAccount: str, reviewedDigest: str, payloadDigest: str): bool =
  reviewedDigest != payloadDigest implies not(reviewStillBinds(approvedAccount, activeAccount, reviewedDigest, payloadDigest))
pure val approvedAccountValues = Set("owner", "other")
pure val reviewedDigestValues = Set("", "a", "b")
pure val payloadDigestValues = Set("a", "b")
```

### A create is reported only after it reads back from the same calendar

After the provider accepts a create, the event is read again through the
same account and calendar. Only a readback that holds the reviewed fields
reports the event created. A readback that is missing, comes from another
calendar or differs leaves the outcome unconfirmed.

```quint
type CreateOutcome = NotCreated | CreatedAndRead | CreatedUnconfirmed
pure def createOutcome(written: bool, readBack: bool, sameSource: bool, fieldsMatch: bool): CreateOutcome =
  if (not(written)) NotCreated
  else if (readBack and sameSource and fieldsMatch) CreatedAndRead
  else CreatedUnconfirmed
pure def lawCreatedNeedsSameCalendarReadback(written: bool, readBack: bool, sameSource: bool, fieldsMatch: bool): bool =
  createOutcome(written, readBack, sameSource, fieldsMatch) == CreatedAndRead implies readBack and sameSource and fieldsMatch
```

### A repeating create carries its reviewed recurrence and reads back with it

A new event may repeat daily, on weekdays or weekly, with an optional
last start and starts it skips, in the zone of its reviewed fields. The
recurrence is part of the reviewed change and its digest. The resident
calendar saves it as one series row. A provider calendar receives it as
RFC 5545 recurrence lines when its provider writes them, and refuses a
repeating create with that reason otherwise. A timed series needs a known
zone, and its last start is never before its first. The create is
reported only when its readback also holds exactly the reviewed
recurrence lines.

```quint
type RecurrenceCarrier = ResidentRows | ProviderRuleLines | ProviderWithoutRules
pure def repeatingCreateAllowed(repeating: bool, carrier: RecurrenceCarrier): bool =
  not(repeating) or carrier != ProviderWithoutRules
pure def lawProviderWithoutRulesRefusesRepeats(repeating: bool): bool =
  repeating implies not(repeatingCreateAllowed(repeating, ProviderWithoutRules))
pure def lawOneOffCreateNeedsNoRules(carrier: RecurrenceCarrier): bool = repeatingCreateAllowed(false, carrier)
pure def lawRecurrenceMismatchIsUnconfirmed(written: bool, readBack: bool, sameSource: bool): bool =
  createOutcome(written, readBack, sameSource, false) != CreatedAndRead
```

### A change's result names its target as read before the change and the version it produced

An update or a delete reports the event it changed as it was read before
the change, with that event's provider version. An update's receipt names
the changed event's version; a delete's names the deleted target's
version, marked deleted. A result without its target's version names no
receipt.

```quint
type ChangeOp = UpdateChange | DeleteChange
type VersionSource = FromChangedEvent | FromDeletedTarget | NoVersion
pure def receiptVersion(op: ChangeOp, targetVersioned: bool, changedVersioned: bool): VersionSource =
  if (not(targetVersioned)) NoVersion
  else if (op == DeleteChange) FromDeletedTarget
  else if (changedVersioned) FromChangedEvent
  else NoVersion
pure def lawDeleteNamesItsTarget(targetVersioned: bool, changedVersioned: bool): bool =
  targetVersioned implies receiptVersion(DeleteChange, targetVersioned, changedVersioned) == FromDeletedTarget
pure def lawUnversionedTargetHasNoReceipt(op: ChangeOp, changedVersioned: bool): bool =
  receiptVersion(op, false, changedVersioned) == NoVersion
```
