# Telephony proposals

The telephony family is the part of the
[device proposal path](./index.md) ("Propose what I asked for on my phone,
in my own words") that owns calls, dials, the keypad, texts, the Messages,
voicemail and contact reads, the latest SMS sender and the address book:
`sms_send`, `mms_send`, `phone_dial`, `phone_call`, `phone_keypad`,
`contact_create`, `contact_update`, `contact_delete`, `contact_show`,
`contact_read_selected`, `sms_compose`, `sms_reply_selected`,
`messages_read_selected`, `voicemail_read_selected`,
`voicemail_delete_selected` and `sms_latest_sender`. Their wire shapes and capabilities are
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

`phone_keypad` opens the Phone keypad, empty or with a number filled in; it
never dials, and only the owner's Call tap there places a call.
`contact_show` opens Contacts filtered by a name the owner said: the
matches are shown to the owner only, and the agent learns only that they
were shown or that none matched. `contact_read_selected` shares the one
contact the owner has open in Contacts, after the owner approves sharing it.
The address book itself never reaches the agent. `mms_send` belongs to this
family only so that no other family claims it: no form offers it, so chat
never proposes an MMS. Each form is offered only when the phone negotiated
what it needs, and of two forms of one operation (a Messages text named by
`query` or by `target`, a contact change that replaces values or adds and
removes them, a dial to a number only or also to a contact) a phone is
offered exactly the one its capabilities take. Whether a keypad, a Messages
draft or a latest-sender read runs without its review card is decided below
("A keypad, a Messages draft or a who-texted-me read runs without its card
only as the owner asked"); device operations' `directEligible` and
[execution](./execution.md) decide the rest, never here. A reply draft in
the open conversation, and a read or deletion of the thread, voicemail or
contact the owner has open, are grounded as steps on that open selection, so
they carry the owner's message while the turn is live whatever its action
mode; every other telephony proposal is grounded as asked.

## Story: Call or text the person I named, as I named them

> As the owner, I want a call, dial, text or contact change the agent
> proposes to go to exactly the number or the name I wrote or spoke in this
> message, so that a number the model invented, one a document carried, or
> one inside the text I asked to send never reaches my phone's review.

### A proposed number is the owner's own, written or spoken in this message and not only inside the text to send

A call, dial, keypad, text or SIM send names a number only when it is the
same number as one the owner wrote or spoke in this message, a country code
aside. The
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
  | RecipientForm | NumberUnreadable | EmergencyDial | EmergencyKeypad | EmailNotWritten
pure def ownedMatch(exactWritten: bool, writtenMatches: int, exactSpoken: bool, spokenMatches: int): NumberMatch =
  if (exactWritten or writtenMatches == 1) WrittenOwnerNumber
  else if (writtenMatches > 1) SeveralOwnerNumbers
  else if (exactSpoken or spokenMatches == 1) SpokenOwnerNumber
  else if (spokenMatches > 1) SeveralOwnerNumbers
  else NoOwnerNumber
pure def ownerNumberFound(owned: NumberMatch): bool = owned == WrittenOwnerNumber or owned == SpokenOwnerNumber
pure def targetGrounded(verdict: TargetVerdict): bool = verdict == TargetGrounded or verdict == TargetHandedThrough or verdict == EmergencyKeypad
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
once the text to send is cut out. A contact change is never refused for its
name: the phone looks the contact up in the owner's own address book and
shows the owner the before and after, so a change may name a contact from an
earlier turn ("delete that contact") or spell out the name the owner said.
A contact a search shows (`contact_show`) is the phone's to match too. A
name made only of words
every request has ("the", "me", "you", "someone", "everyone", "no one", "call",
"her number") names nobody, and digits are never a name. The phone resolves
the name in the owner's own address book and asks which one when several
match; a name it does not know is refused there, never matched to a number
here.

```quint
pure def nameVerdict(written: bool): TargetVerdict = if (written) TargetGrounded else ContactNotWritten
pure def lawOnlyAWrittenNameIsGrounded(written: bool): bool = targetGrounded(nameVerdict(written)) iff written
```

### Alternative SMS recipients are clarified before any lookup

On an enrolled phone that can compose or send SMS, when the owner gives
alternative recipients in a whole text command ("text Carson or Maya that
dinner is covered"), the agent asks which person should get the text before
looking either up or proposing an operation. Alternatives within the text
body remain part of the body. A message that also asks for emergency services
("text Carson or Maya that I crashed, call an ambulance now") is not
clarified, so the emergency rule still applies.

### A call or text to someone the owner names by a role is proposed at once, with that word as the contact query

Where the phone is offered a call or a text that takes a contact target,
`{kind: contact, query}`, the device tool says once that a person is
called or texted at once with a contact target, also when the owner names
them by a role or relation ("ping my brother", "ring the dentist"): the
query is that word alone, brother for my brother and dentist for the
dentist, and the phone finds the contact and lets the owner pick when
several match. It names the call, the text or both, as the phone is
offered them with a contact target, and where a contact search
(`contact_show`) is offered too, it says to skip that search first for
the operations that admit a contact target, since they resolve it themselves. A phone
offered neither is told none of it. The role word is a name the owner
wrote, so it is grounded as any contact name is (above).

```quint
type RoleRule = CallOrTextByRole | CallByRole | TextByRole | NoRoleRule
pure def roleRule(callsContact: bool, textsContact: bool): RoleRule =
  if (callsContact and textsContact) CallOrTextByRole else if (callsContact) CallByRole else if (textsContact) TextByRole else NoRoleRule
pure def searchFirstRefused(rule: RoleRule, searchOffered: bool): bool = searchOffered and rule != NoRoleRule
pure def lawTheRoleRuleIsSaidOnlyWhereAContactTargetIsOffered(callsContact: bool, textsContact: bool): bool =
  (roleRule(callsContact, textsContact) == NoRoleRule) iff not(callsContact or textsContact)
pure def lawTheRoleRuleNamesBothOnlyWhereBothAreOffered(callsContact: bool, textsContact: bool): bool =
  (roleRule(callsContact, textsContact) == CallOrTextByRole) iff (callsContact and textsContact)
pure def lawASearchIsRefusedFirstOnlyBesideTheRoleRule(callsContact: bool, textsContact: bool, searchOffered: bool): bool =
  searchFirstRefused(roleRule(callsContact, textsContact), searchOffered) iff (searchOffered and (callsContact or textsContact))
```

### A whole-message call, text or dial command hands through the owner's own recipient

When the whole message is a call command ("call 415-555-0100", "ring mum back
please"), a text command ("text Sam saying I'm late", "send a text to Sam that
…") or, on a phone that cannot open its keypad for chat, a request to open
the dialer with a number ("open the dialer and type 415 302 4399"), and the
model proposed an operation of that kind, the recipient the owner wrote is
offered whatever the model proposed: their number in its dial form, or their
name without words that only say how or when ("back", "again", "please",
"right now", "for me"), a leading "my" or "our", or a line ("'s cell",
"'s mobile"). The model's own name is kept when it is the owner's name with
only such words dropped; a shorter part of a full name ("Sam" for "Sam Lee")
never is. A command that wrote something number-shaped that is not one
number asks the owner to type it again. A SIM send takes numbers only, and a
Messages text named by its `query` takes contact names only, so the other
kind of recipient is refused for its form; a Messages text named by its
`target`, a call and a dial take either, and a dial to a name needs a phone
that looks contacts up. A command that names no one ("call me", "call
everyone", "call it a day"), two people, another service ("on WhatsApp"), a
time, or the police or an ambulance is not a command, and the model's
recipient is grounded as above.

```quint
type CommandRecipient = CommandNumber | CommandName | CommandUnreadable
pure def commandVerdict(command: CommandRecipient, takesNames: bool, takesNumbers: bool): TargetVerdict =
  if (command == CommandUnreadable) NumberUnreadable
  else if ((command == CommandName and not(takesNames)) or (command == CommandNumber and not(takesNumbers))) RecipientForm
  else TargetHandedThrough
pure def lawACommandHandsThroughTheOwnersRecipientOrRefuses(command: CommandRecipient, takesNames: bool, takesNumbers: bool): bool =
  commandVerdict(command, takesNames, takesNumbers) != TargetGrounded
pure def lawASimSendNeverTakesAName(takesNumbers: bool): bool = commandVerdict(CommandName, false, takesNumbers) == RecipientForm
pure def lawAContactQueryNeverTakesANumber(takesNames: bool): bool = commandVerdict(CommandNumber, takesNames, false) == RecipientForm
```

### A request to open the dialer opens the keypad as the owner wrote it

When the whole message asks to open the dialer, dial pad or keypad ("open
the dialer", "open the keypad and type 415 302 4399", "show me the dial pad
with 415-555-0100"), on a phone that opens its keypad for chat, and the
model proposed a keypad or a dial, the keypad is offered as the owner wrote
it: empty, or with their number in its dial form, never the model's number.
A number in the request that is not one dial number makes it no such
request. On a phone without the keypad, a request with a number is a dial of
that number, handed through as a command, and an empty one offers no phone
step. A keypad the model proposed with a number outside such a request is
grounded like a call's number; an empty keypad names nobody and is never
refused.

```quint
type DialerPlan = OpenKeypad | DialWrittenNumber | NoDialerStep
pure def dialerPlan(keypadOffered: bool, writesNumber: bool): DialerPlan =
  if (keypadOffered) OpenKeypad else if (writesNumber) DialWrittenNumber else NoDialerStep
pure def lawAPhoneWithAKeypadOpensItForEveryDialerRequest(writesNumber: bool): bool = dialerPlan(true, writesNumber) == OpenKeypad
pure def lawAnEmptyDialerRequestNeverDials(keypadOffered: bool): bool = dialerPlan(keypadOffered, false) != DialWrittenNumber
```

### An emergency request is never refused for its recipient, and the owner dials it themselves on the keypad

A message that asks for emergency services at the start of a clause ("call an
ambulance", "I need help, call emergency services now", "please get the
police", "call for help") or states a plain need ("I need an ambulance"),
never a report or a denial of one, turns a call, dial or keypad that would be
refused for its recipient, or that names the service as a contact, into the
empty keypad, where the owner dials their local emergency number and taps
Call; the owner hears so. Only a phone that cannot open its keypad for chat
refuses it instead, telling the owner to dial their local emergency number
on the phone's own dialer. A number the owner wrote ("call 911") is still
the reviewed recipient, and the phone hands an emergency number to the
system dialer.

```quint
pure def emergencyVerdict(emergency: bool, callOrKeypad: bool, namesService: bool, keypadOffered: bool, verdict: TargetVerdict): TargetVerdict =
  if (emergency and callOrKeypad and (namesService or not(targetGrounded(verdict)))) (if (keypadOffered) EmergencyKeypad else EmergencyDial)
  else verdict
pure def lawAnEmergencyCallIsNeverRefusedForItsRecipient(namesService: bool, keypadOffered: bool, verdict: TargetVerdict): bool = {
  val decided = emergencyVerdict(true, true, namesService, keypadOffered, verdict)
  decided == EmergencyDial or targetGrounded(decided)
}
pure def lawAWrittenEmergencyNumberIsReviewedAsWritten(keypadOffered: bool, verdict: TargetVerdict): bool =
  targetGrounded(verdict) implies emergencyVerdict(true, true, false, keypadOffered, verdict) == verdict
pure def lawAnEmergencyOpensTheKeypadOnAPhoneThatHasOne(namesService: bool, verdict: TargetVerdict): bool =
  (namesService or not(targetGrounded(verdict))) implies emergencyVerdict(true, true, namesService, true, verdict) == EmergencyKeypad
pure def lawOnlyAPhoneWithoutTheKeypadSendsTheOwnerElsewhere(emergency: bool, callOrKeypad: bool, namesService: bool, verdict: TargetVerdict): bool =
  verdict != EmergencyDial implies emergencyVerdict(emergency, callOrKeypad, namesService, true, verdict) != EmergencyDial
pure def lawOnlyAnEmergencyRequestTurnsToTheDialer(callOrKeypad: bool, namesService: bool, keypadOffered: bool, verdict: TargetVerdict): bool =
  emergencyVerdict(false, callOrKeypad, namesService, keypadOffered, verdict) == verdict
```

### A contact change saves only numbers and email addresses the owner wrote, when the message writes any

A number saved under a contact's name becomes the recipient of every later
"call" and "text" of that name, so the numbers a `contact_create` writes, and
those a `contact_update` sets, adds or removes, are grounded like a call's
when the message writes or speaks any number: each is one the owner wrote or
spoke in this message, in the owner's dial form, once. Likewise, when the
message writes any email address, each address a change writes, adds or
removes is one the owner wrote, case aside. A message that writes or speaks
no number, or writes no email address, has nothing to ground that value in:
the change is offered as proposed, and the owner reviews its exact digits
and address on the phone before anything is saved ("save the number that
just texted me as Sam").

```quint
pure def contactValueVerdict(messageWritesAny: bool, verdict: TargetVerdict): TargetVerdict = if (messageWritesAny) verdict else TargetGrounded
pure def emailVerdict(written: bool): TargetVerdict = if (written) TargetGrounded else EmailNotWritten
pure def lawAContactNumberTheOwnerNeverWroteIsNeverSaved(swapped: bool, unreadable: bool): bool =
  not(targetGrounded(contactValueVerdict(true, numberVerdict(NoOwnerNumber, swapped, unreadable))))
pure def lawAnEmailTheOwnerNeverWroteIsNeverSaved(written: bool): bool =
  targetGrounded(contactValueVerdict(true, emailVerdict(written))) iff written
pure def lawAMessageWithoutTheValueLeavesItToTheReview(verdict: TargetVerdict): bool = targetGrounded(contactValueVerdict(false, verdict))
```

### A refused recipient is explained truthfully, and the owner hears that nothing ran

A recipient refusal offers nothing. The owner hears a sentence that is true
whichever recipient was refused: that nothing was called or sent, or for a
contact change that nothing in the address book was saved or changed, and what
to tell the agent instead. A recipient this phone cannot take in its form, and
a contact it cannot save in its form, is refused in those same terms; a
contact change's number or email address the owner never wrote is named as
the one refused. A refused number is called missing from the message only
when the message writes and speaks no number at all. An emergency keypad is
no refusal.

```quint
type OwnerReply = NoRefusalReply | ReplyDialEmergency | ReplyRetypeNumber | ReplyRetypeSavedNumber | ReplyNumberNotSaved | ReplyEmailNotSaved
  | ReplyNoNumberWritten | ReplyRecipientForm | ReplyNameNotWritten | ReplyNumberNotWritten | ReplyContactForm
pure def numberRefused(verdict: TargetVerdict): bool = verdict == NumberNotWritten or verdict == NumberCopyReference
pure def refusalReply(verdict: TargetVerdict, contactChange: bool, messageHasNumber: bool): OwnerReply =
  if (targetGrounded(verdict)) NoRefusalReply
  else if (verdict == EmergencyDial) ReplyDialEmergency
  else if (verdict == NumberUnreadable) (if (contactChange) ReplyRetypeSavedNumber else ReplyRetypeNumber)
  else if (contactChange) (if (numberRefused(verdict)) ReplyNumberNotSaved else if (verdict == EmailNotWritten) ReplyEmailNotSaved else ReplyContactForm)
  else if (numberRefused(verdict) and not(messageHasNumber)) ReplyNoNumberWritten
  else if (verdict == RecipientForm) ReplyRecipientForm
  else if (verdict == ContactNotWritten) ReplyNameNotWritten
  else ReplyNumberNotWritten
pure def savesNothing(reply: OwnerReply): bool =
  reply == ReplyRetypeSavedNumber or reply == ReplyNumberNotSaved or reply == ReplyEmailNotSaved or reply == ReplyContactForm
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
> agent just read for me, in that sender's conversation, and "who texted me
> last?" to name only as much of that sender as I asked for, each without an
> extra approval when I asked for exactly that.

### An addressed draft request drafts to the addressed recipient unless the owner asked to send it there

When the message asks to draft, write, prepare or compose a text, message or
reply, the recipient is the one its addressing clause names ("to Sam", "for
+1 415 555 0124", "… and send it to Sam"), never a number in the body, and
the clause ends at the words that start the message ("saying", "to ask", "to
let him know", a colon or a quote). A proposed send or draft becomes a
Messages draft (`sms_compose` with `draft: true`) to that recipient with the
model's body, its `target` the contact name or the number's dial form, read
as above, and is not grounded again; the draft is only put into that
recipient's conversation for the owner to edit and send, and can never
report a send. When the owner also asked for the draft to be
sent ("… and send it") and the model proposed exactly that recipient, the
model's proposal stays and its recipient is grounded as above. A reply in the
open thread stays a reply there when the message addresses no one or the last
sender. A recipient that is corrected, plural or unclear, one that names
nobody ("someone", "me", "everyone"), digits that are not one number ("415-555
0100 0199"), or a draft that addresses no one, is asked about: which one person
should receive it. A phone
that cannot address a Messages draft (`sms.compose.v1` and `sms.compose.v2`)
is told so.

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
which never address the draft. The draft's `target` is that address as a
number, with the read's thread as its `replyThreadId` when the read returned
one, so the draft goes into that sender's conversation; it is never the
model's number and is not grounded again. Otherwise the owner is told there
is no current sender, and asked who last texted them or for one recipient.

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

### A keypad, a Messages draft or a who-texted-me read runs without its card only as the owner asked

A keypad, a Messages draft and a latest-sender read may skip their review
card ([device operations](./operations.md)' `directEligible`); this family
grounds one as asked, so that it carries a direct request's message, only
when the current message asked for exactly that: a keypad that is empty or
filled with a number the owner wrote, not only spoke, in this message; a
draft to the number the owner wrote in its addressing clause, or to the
sender of the read just delivered, carrying that sender's thread; a read of
the whole sender address because the owner asked who sent it. A message that
asks to review first ("ask me first", "show me the approval", "wait for my
approval") keeps a draft and a read on their card; the keypad never dials,
so it is not held. Every other keypad, draft or sender read is grounded for
review, so the phone shows its card. A pending keypad the owner asked for is
answered as the handoff it is: "Opening the keypad.", "Opening the keypad
with 4153024399.", or, for an emergency, the keypad and how to dial from it.

```quint
type DirectTelephony = KeypadOpen | MessagesDraft | SenderAddressRead
pure def telephonyAsAsked(request: DirectTelephony, ownersOwn: bool, reviewAsked: bool): bool = ownersOwn and (request == KeypadOpen or not(reviewAsked))
pure def lawWhatTheOwnerDidNotAskForKeepsItsCard(request: DirectTelephony, reviewAsked: bool): bool = not(telephonyAsAsked(request, false, reviewAsked))
pure def lawAskingForReviewKeepsADraftOrAReadOnItsCard(request: DirectTelephony, ownersOwn: bool): bool =
  request != KeypadOpen implies not(telephonyAsAsked(request, ownersOwn, true))
pure def lawTheOwnersOwnKeypadOpensAsAsked(reviewAsked: bool): bool = telephonyAsAsked(KeypadOpen, true, reviewAsked)
```

## Story: Hear what my phone did with a call, text or contact change, as far as it shows

> As the owner, I want a request my phone already ran to be answered from
> what the phone reported, so that the agent never runs it again and never
> says it did more than the phone showed.

### A settled telephony request is answered by the model from its stored result

When the model proposes again a call, dial, keypad, text, draft, contact
change or search, open-item read or voicemail deletion that already settled
applied, it is told that nothing ran again and what the stored result shows,
and it answers the owner from that result in the context of the message, so
the owner hears no fixed sentence. A started call was not answered as far as
anyone knows, and an emergency number went to the phone's own dialer for the
owner to place; a dial opened the dial screen, and no call is known to be
placed; a keypad opened and nothing was dialed; a draft is in the text field
and nothing was sent; a submitted message is not yet sent, a sent one is not
delivered, and only a delivered one was reported delivered; a contact was
saved or deleted; contacts were shown to the owner and no detail was shared;
a voicemail was deleted. A SIM send is reported in its exact status and never
retried automatically. A read is historical, never a current read, and what
it shared is untrusted data; a latest-sender read is told in the fixed words
of [device operations](./operations.md), which only its first delivery gives
the owner verbatim.

```quint
type SettledTelephony = SettledCall | SettledDial | SettledKeypad | SettledSimSend | SettledDraft | SettledContactChange
  | SettledContactShow | SettledOpenRead | SettledSenderRead | SettledVoicemailDelete
type SettledLead = RetrievedReceipt | RetrievedDial | RetrievedSimSend | RetrievedRead
pure def settledLead(request: SettledTelephony): SettledLead =
  if (request == SettledOpenRead or request == SettledSenderRead) RetrievedRead
  else if (request == SettledDial) RetrievedDial
  else if (request == SettledSimSend) RetrievedSimSend
  else RetrievedReceipt
pure def lawEveryReadIsToldAsHistorical(request: SettledTelephony): bool =
  (settledLead(request) == RetrievedRead) iff (request == SettledOpenRead or request == SettledSenderRead)
pure def lawOnlyASimSendIsToldItsExactStatus(request: SettledTelephony): bool =
  (settledLead(request) == RetrievedSimSend) iff (request == SettledSimSend)
```
