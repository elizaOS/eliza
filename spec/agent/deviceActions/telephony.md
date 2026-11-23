# Telephony proposals

The telephony family is the part of the
[device proposal path](./index.md) ("Propose what I asked for on my phone,
in my own words") that owns calls, dials, texts, the Messages and voicemail reads, the latest
SMS sender and address-book changes: `sms_send`, `mms_send`, `phone_dial`,
`phone_call`, `contact_create`, `contact_update`, `contact_delete`,
`sms_compose`, `sms_reply_selected`, `messages_read_selected`,
`voicemail_read_selected`, `voicemail_delete_selected` and
`sms_latest_sender`. Their wire shapes and capabilities are
[device operations](./operations.md)'s; how the phone reviews and runs them is
the [Android device](../../os/index.md)'s (`os/android/phone.md`,
`os/android/messages.md`, `os/android/contacts.md`). This spec decides, before
anything is kept, which recipient a proposal may name and which operation is
offered in its place. Reading numbers and names out of the owner's words stays
in the shell (`device-actions/proposal/telephony/`), which hands these rules
the facts it found: that reading is pattern and word matching over free text,
which neither Quint nor a `//@` contract can state, so it is VibeLang, as the
Browser's request grounding is.

The owner's words are the host-persisted text of the current message, without
the document wrapper. A number in them usually reaches the model only as a
contact reference (`__ELIZA_CONTACT_…__`), which the tool boundary restores to
the owner's own spelling; a number written with spaces, dashes, dots or
brackets is then read in its dial form, digits with an optional leading `+`.
A dial form drops the trunk `(0)` after `+44`, `+49` and `+41`, keeps it as a
`0` after `+39`, `+378` and `+225`, and accepts a one-digit first group after a
country code (`+33 1 23 45 67 89`). A run of digits is read as one number only
when its separators are those of one number; two numbers, a range, a date or
an address never are.

There is no keypad operation: a request to open the dialer with a number is a
reviewed `phone_dial` of that number, and an empty keypad is never offered.
Contacts never reach the agent, so no contact is shown or read for it.
`mms_send` belongs to this family only so that no other family claims it: no
form offers it, so chat never proposes an MMS. Whether an offered request may
run without its review card is decided by device operations' `directEligible`
and by [execution](./execution.md), never here: a latest-sender read and a
Messages draft are reviewed on the phone first, also when the owner asked for
exactly that sender or that draft.

## Story: Call or text the person I named, as I named them

> As the owner, I want a call, dial, text or contact change the agent
> proposes to go to exactly the number or the name I wrote or spoke in this
> message, so that a number the model invented, one a document carried, or
> one inside the text I asked to send never reaches my phone's review.

### A proposed number is the owner's own, written or spoken in this message and not only inside the text to send

A call, dial, text or SIM send names a number only when it is the same number
as one the owner wrote or spoke in this message, a country code aside. The
owner's own dial form is offered, never the model's spelling of it. Numbers
the owner wrote are matched first; a spoken reading ("four one five, five five
five, oh one double oh", or the digits an ASR split up) is matched only when no
written number is the same, so a written number is never made ambiguous by a
spoken reading of the words around it. Two of the owner's numbers that both
match are never chosen between. The text the owner asked to send is cut out
of the words first, where it occurs as whole words and preferably last, never
by a cut that would take away the proposed recipient; when the model reworded
the text, no number inside it can be the recipient. When the owner's number
reached the model only as a contact reference, digits the model wrote for it
are invented: the model is told which reference to copy. When the owner wrote
the proposed number's digits but not as one number ("415-555 0100 0199",
"415/555/0100"), the owner is asked to type it again with digits only.

```quint
type NumberMatch = NoOwnerNumber | WrittenOwnerNumber | SpokenOwnerNumber | SeveralOwnerNumbers
type TargetVerdict = TargetGrounded | TargetHandedThrough | NumberNotWritten | NumberCopyReference | ContactNotWritten
  | RecipientForm | NumberUnreadable | EmergencyDial
pure def ownedMatch(exactWritten: bool, writtenMatches: int, exactSpoken: bool, spokenMatches: int): NumberMatch =
  if (exactWritten or writtenMatches == 1) WrittenOwnerNumber
  else if (writtenMatches > 1) SeveralOwnerNumbers
  else if (exactSpoken or spokenMatches == 1) SpokenOwnerNumber
  else if (spokenMatches > 1) SeveralOwnerNumbers
  else NoOwnerNumber
pure def ownerNumberFound(owned: NumberMatch): bool = owned == WrittenOwnerNumber or owned == SpokenOwnerNumber
pure def targetGrounded(verdict: TargetVerdict): bool = verdict == TargetGrounded or verdict == TargetHandedThrough
pure def numberVerdict(owned: NumberMatch, swapped: bool, unreadable: bool): TargetVerdict =
  if (ownerNumberFound(owned)) TargetGrounded
  else if (swapped) NumberCopyReference
  else if (unreadable) NumberUnreadable
  else NumberNotWritten
pure def lawOnlyAnOwnerNumberIsGrounded(owned: NumberMatch, swapped: bool, unreadable: bool): bool =
  targetGrounded(numberVerdict(owned, swapped, unreadable)) iff ownerNumberFound(owned)
pure def lawAWrittenNumberIsMatchedBeforeASpokenReading(exactSpoken: bool, spokenMatches: int): bool =
  ownedMatch(false, 1, exactSpoken, spokenMatches) == WrittenOwnerNumber
pure def lawTwoOwnerNumbersAreNeverChosenBetween(writtenMatches: int, exactSpoken: bool, spokenMatches: int): bool =
  writtenMatches > 1 implies ownedMatch(false, writtenMatches, exactSpoken, spokenMatches) == SeveralOwnerNumbers
pure def lawInventedDigitsForASwappedNumberAreToldItsReference(owned: NumberMatch, unreadable: bool): bool =
  not(ownerNumberFound(owned)) implies numberVerdict(owned, true, unreadable) == NumberCopyReference
pure def lawAnUnreadableNumberIsAskedForAgain(owned: NumberMatch): bool =
  not(ownerNumberFound(owned)) implies numberVerdict(owned, false, true) == NumberUnreadable
```

### A proposed contact name is one the owner wrote as whole words, outside the text to send

A contact recipient is the name as the owner wrote it, case, punctuation and
a possessive aside ("Maya's cell" names Maya), as whole words of the message
once the text to send is cut out. The same holds for the contact a change
looks up (`contact_update`, `contact_delete`) and for the name it saves
(`contact_create`, or a renaming `contact_update`). A name made only of words
every request has ("the", "me", "you", "someone", "everyone", "no one", "call",
"her number") names nobody, and digits are never a name. The phone resolves
the name in the owner's own address book and asks which one when several
match; a name it does not know is refused there, never matched to a number
here.

```quint
pure def nameVerdict(written: bool): TargetVerdict = if (written) TargetGrounded else ContactNotWritten
pure def lawOnlyAWrittenNameIsGrounded(written: bool): bool = targetGrounded(nameVerdict(written)) iff written
```

### A whole-message call, text or dial command hands through the owner's own recipient

When the whole message is a call command ("call 415-555-0100", "ring mum back
please"), a text command ("text Sam saying I'm late", "send a text to Sam that
…") or a request to open the dialer with a number ("open the dialer and type
415 302 4399"), and the model proposed an operation of that kind, the
recipient the owner wrote is offered whatever the model proposed: their number
in its dial form, or their name without words that only say how or when
("back", "again", "please", "right now", "for me"), a leading "my" or "our",
or a line ("'s cell", "'s mobile"). The model's own name is kept when it is the
owner's name with only such words dropped; a shorter part of a full name
("Sam" for "Sam Lee") never is. A command that wrote something number-shaped
that is not one number asks the owner to type it again. A SIM send takes
numbers only, so a named recipient for it is refused for its form; a Messages
draft names a contact or a number alike in its `query`. A command that names
no one ("call me", "call everyone", "call it a day"), two people, another
service ("on WhatsApp"), a time, or the police or an ambulance is not a
command, and the model's recipient is grounded as above.

```quint
type CommandRecipient = CommandNumber | CommandName | CommandUnreadable
pure def commandVerdict(command: CommandRecipient, numbersOnly: bool): TargetVerdict =
  if (command == CommandUnreadable) NumberUnreadable
  else if (command == CommandName and numbersOnly) RecipientForm
  else TargetHandedThrough
pure def lawACommandHandsThroughTheOwnersRecipientOrRefuses(command: CommandRecipient, numbersOnly: bool): bool =
  commandVerdict(command, numbersOnly) != TargetGrounded
pure def lawASimSendNeverTakesAName(numbersOnly: bool): bool =
  numbersOnly implies commandVerdict(CommandName, numbersOnly) == RecipientForm
```

### An emergency request is never refused for its recipient, and the owner is told to dial it themselves

A message that asks for emergency services at the start of a clause ("call an
ambulance", "I need help, call emergency services now", "please get the
police", "call for help") or states a plain need ("I need an ambulance"),
never a report or a denial of one, makes a call or dial that would be refused
for its recipient, or that names the service as a contact, a refusal that
tells the owner to dial their local emergency number on the phone's own
dialer: there is no empty keypad to open for them. A number the owner wrote
("call 911") is still the reviewed recipient, and the phone hands an emergency
number to the system dialer.

```quint
pure def emergencyVerdict(emergency: bool, callOrDial: bool, namesService: bool, verdict: TargetVerdict): TargetVerdict =
  if (emergency and callOrDial and (namesService or not(targetGrounded(verdict)))) EmergencyDial else verdict
pure def lawAnEmergencyCallIsNeverRefusedForItsRecipient(namesService: bool, verdict: TargetVerdict): bool = {
  val decided = emergencyVerdict(true, true, namesService, verdict)
  decided == EmergencyDial or targetGrounded(decided)
}
pure def lawAWrittenEmergencyNumberIsReviewedAsWritten(verdict: TargetVerdict): bool =
  targetGrounded(verdict) implies emergencyVerdict(true, true, false, verdict) == verdict
pure def lawOnlyAnEmergencyRequestTurnsToTheDialer(callOrDial: bool, namesService: bool, verdict: TargetVerdict): bool =
  emergencyVerdict(false, callOrDial, namesService, verdict) == verdict
```

### A contact change saves only numbers the owner wrote

A number saved under a contact's name becomes the recipient of every later
"call" and "text" of that name, so a `contact_create` or `contact_update` that
writes numbers is grounded like a call: each number is one the owner wrote or
spoke in this message, in the owner's dial form, once. A message that writes
or speaks no number grounds none, so a change that writes a number from it is
refused and nothing is saved.

```quint
pure def lawAContactNumberTheOwnerNeverWroteIsNeverSaved(swapped: bool, unreadable: bool): bool =
  not(targetGrounded(numberVerdict(NoOwnerNumber, swapped, unreadable)))
```

### A refused recipient is explained truthfully, and the owner hears that nothing ran

A recipient refusal offers nothing. The owner hears a sentence that is true
whichever recipient was refused: that nothing was called or sent, or for a
contact change that nothing in the address book was saved or changed, and what
to tell the agent instead. A recipient this phone cannot take in its form, and
a contact it cannot save in its form, is refused in those same terms. A
refused number is called missing from the message only when the message
writes and speaks no number at all.

```quint
type OwnerReply = NoRefusalReply | ReplyDialEmergency | ReplyRetypeNumber | ReplyRetypeSavedNumber | ReplyNumberNotSaved
  | ReplyNoNumberWritten | ReplyRecipientForm | ReplyNameNotWritten | ReplyNumberNotWritten | ReplyContactForm | ReplyContactNameNotWritten
pure def numberRefused(verdict: TargetVerdict): bool = verdict == NumberNotWritten or verdict == NumberCopyReference
pure def refusalReply(verdict: TargetVerdict, contactChange: bool, messageHasNumber: bool): OwnerReply =
  if (targetGrounded(verdict)) NoRefusalReply
  else if (verdict == EmergencyDial) ReplyDialEmergency
  else if (verdict == NumberUnreadable) (if (contactChange) ReplyRetypeSavedNumber else ReplyRetypeNumber)
  else if (contactChange) (if (numberRefused(verdict)) ReplyNumberNotSaved else if (verdict == ContactNotWritten) ReplyContactNameNotWritten else ReplyContactForm)
  else if (numberRefused(verdict) and not(messageHasNumber)) ReplyNoNumberWritten
  else if (verdict == RecipientForm) ReplyRecipientForm
  else if (verdict == ContactNotWritten) ReplyNameNotWritten
  else ReplyNumberNotWritten
pure def savesNothing(reply: OwnerReply): bool =
  reply == ReplyRetypeSavedNumber or reply == ReplyNumberNotSaved or reply == ReplyContactForm or reply == ReplyContactNameNotWritten
pure def lawARefusalNeverSaysTheMessageHasNoNumberWhenItHasOne(verdict: TargetVerdict, contactChange: bool): bool =
  refusalReply(verdict, contactChange, true) != ReplyNoNumberWritten
pure def lawARefusedContactChangeSaysNothingWasSaved(verdict: TargetVerdict, messageHasNumber: bool): bool =
  (not(targetGrounded(verdict)) and verdict != EmergencyDial) implies savesNothing(refusalReply(verdict, true, messageHasNumber))
pure def lawARefusedCallOrTextNeverSpeaksOfSaving(verdict: TargetVerdict, messageHasNumber: bool): bool =
  not(savesNothing(refusalReply(verdict, false, messageHasNumber)))
pure def lawOnlyARefusalIsExplained(verdict: TargetVerdict, contactChange: bool, messageHasNumber: bool): bool =
  (refusalReply(verdict, contactChange, messageHasNumber) == NoRefusalReply) iff targetGrounded(verdict)
```

## Story: Draft my text to the person I addressed, and read the sender only as I asked

> As the owner, I want "draft a text to Sam saying …" to become a draft to
> Sam that I send myself, "draft a reply to them" to go to the sender the
> agent just read for me, and "who texted me last?" to name only as much of
> that sender as I asked for.

### An addressed draft request drafts to the addressed recipient unless the owner asked to send it there

When the message asks to draft, write, prepare or compose a text, message or
reply, the recipient is the one its addressing clause names ("to Sam", "for
+1 415 555 0124", "… and send it to Sam"), never a number in the body, and
the clause ends at the words that start the message ("saying", "to ask", "to
let him know", a colon or a quote). A proposed send or draft becomes a
Messages draft (`sms_compose`) to that recipient with the model's body, its
`query` the name or the number's dial form, read as above; the draft is the owner's to
edit and send, and Android's thread is not carried, so the phone picks the
conversation from the recipient. When the owner also asked for the draft to be
sent ("… and send it") and the model proposed exactly that recipient, the
model's proposal stays and its recipient is grounded as above. A reply in the
open thread stays a reply there when the message addresses no one or the last
sender. A recipient that is corrected, plural or unclear, one that names
nobody ("someone", "me", "everyone"), digits that are not one number ("415-555
0100 0199"), or a draft that addresses no one, is asked about: which one person
should receive it. A phone
that cannot draft in Messages is told so.

```quint
type DraftAddress = NotADraftRequest | DraftToName | DraftToNumber | DraftToPreviousSender | DraftAmbiguous | DraftUnaddressed
type DraftPlan = KeepProposal | ComposeAddressedDraft | ComposeSenderDraft | AskForOneRecipient | DraftUnavailable
pure def draftPlan(address: DraftAddress, openThreadReply: bool, alsoSendsThere: bool, composes: bool): DraftPlan =
  if (address == NotADraftRequest) KeepProposal
  else if ((address == DraftToName or address == DraftToNumber) and not(openThreadReply) and alsoSendsThere) KeepProposal
  else if (openThreadReply and (address == DraftToPreviousSender or address == DraftUnaddressed)) KeepProposal
  else if (address == DraftAmbiguous or address == DraftUnaddressed) AskForOneRecipient
  else if (not(composes)) DraftUnavailable
  else if (address == DraftToPreviousSender) ComposeSenderDraft
  else ComposeAddressedDraft
pure def lawASendToAnyoneElseBecomesTheAddressedDraft(openThreadReply: bool): bool =
  draftPlan(DraftToName, openThreadReply, false, true) == ComposeAddressedDraft and draftPlan(DraftToNumber, openThreadReply, false, true) == ComposeAddressedDraft
pure def lawAnUnclearRecipientIsAskedForNeverGuessed(openThreadReply: bool, alsoSendsThere: bool, composes: bool): bool =
  draftPlan(DraftAmbiguous, openThreadReply, alsoSendsThere, composes) == AskForOneRecipient
pure def lawAnOpenThreadReplyStaysInItsThread(alsoSendsThere: bool, composes: bool): bool =
  draftPlan(DraftUnaddressed, true, alsoSendsThere, composes) == KeepProposal and draftPlan(DraftToPreviousSender, true, alsoSendsThere, composes) == KeepProposal
```

### A draft to them goes only to the whole sender address the agent just delivered

"Draft a text to them" (or "to that sender", "to the last sender") goes to
the sender of the applied latest-sender read of this conversation whose
delivered answer is the agent's reply just before the owner's message: that
read's own completion, delivered for this owner, its reply unchanged and
bound to the read's proposal, attempt and request message, and not past its
completion deadline. That read must have returned the whole address, and the
phone negotiated `sms.latest-sender.v2`. A newer read whose answer was not
delivered, an older read, and a read past its deadline are earlier reads,
which never address the draft. The draft's `query` is that address; it is
never the model's number and is not grounded again. Otherwise the owner is
told there is no current sender, and asked who last texted them or for one
recipient.

```quint
type SenderSource = SenderReadJustDelivered | SenderReadEarlier | NoSenderRead
pure def senderDraftReady(source: SenderSource, wholeAddress: bool, addressNegotiated: bool): bool =
  source == SenderReadJustDelivered and wholeAddress and addressNegotiated
pure def lawOnlyAWholeAddressIsDraftedTo(source: SenderSource, addressNegotiated: bool): bool =
  not(senderDraftReady(source, false, addressNegotiated))
pure def lawAnOlderPhoneNeverAddressesADraft(source: SenderSource, wholeAddress: bool): bool =
  not(senderDraftReady(source, wholeAddress, false))
pure def lawAnOlderReadNeverAddressesADraft(wholeAddress: bool, addressNegotiated: bool): bool =
  not(senderDraftReady(SenderReadEarlier, wholeAddress, addressNegotiated))
```

### A latest-sender read names the whole address only when the owner asked who sent it, on a phone that names it

A proposed `sms_latest_sender` is offered in the form the owner's words ask
for. A question about who sent the newest incoming SMS, on a phone that
negotiated `sms.latest-sender.v2`, reads the whole address. An ask for the last
four digits, or any read on an older phone, reads only the last four digits. A
narrower or unclear ask (the first digits, three digits, "without the
number", a masked or partial number) is asked about first: whether the last
four digits will do, since no other part is available.

```quint
type SenderScope = WholeSenderAsked | LastFourAsked | SenderScopeUnclear
type SenderReadForm = ReadWholeSender | ReadSenderEnding | AskSenderScope
pure def senderReadForm(scope: SenderScope, addressNegotiated: bool): SenderReadForm =
  if (scope == SenderScopeUnclear) AskSenderScope
  else if (scope == WholeSenderAsked and addressNegotiated) ReadWholeSender
  else ReadSenderEnding
pure def lawTheWholeSenderIsReadOnlyWhenAskedOnAPhoneThatNamesIt(scope: SenderScope, addressNegotiated: bool): bool =
  (senderReadForm(scope, addressNegotiated) == ReadWholeSender) iff (scope == WholeSenderAsked and addressNegotiated)
pure def lawANarrowerAskIsClarifiedFirst(addressNegotiated: bool): bool =
  senderReadForm(SenderScopeUnclear, addressNegotiated) == AskSenderScope
```
