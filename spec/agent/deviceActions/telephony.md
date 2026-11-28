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
anything is kept, whether the recipient a proposal names may be offered. What
the owner asked for is the model's to read: it proposes the operation and its
recipient, and fills the form's `recipientKind`, `disclosure` and
`reviewRequested` with how the owner named the recipient, how much of a
sender the owner asked to hear, and whether the owner asked to review first.
Nothing reads those out of the owner's words. The shell
(`device-actions/proposal/telephony/`) only checks the model's values against
them: that a number is one the owner wrote or spoke, and a name one the owner
wrote, and it hands these rules the facts it found. That check matches
numbers and whole words in free text, which neither Quint nor a `//@`
contract can state, so it is VibeLang, as the Browser's request grounding is.

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
removes them, a dial to a number only or also to a contact, a latest-sender
read that can only keep its card or one that can name the whole sender) a
phone is offered exactly the one its capabilities take. Whether a keypad, a Messages
draft or a latest-sender read runs without its review card is decided below
("A keypad, a Messages draft or a who-texted-me read runs without its card
only as the owner asked"); device operations' `directEligible` and
[execution](./execution.md) decide the rest, never here. A reply draft in
the open conversation, and a read or deletion of the thread, voicemail or
contact the owner has open, are grounded as steps on that open selection, so
they carry the owner's message while the turn is live whatever its action
mode; every other telephony proposal is grounded as asked.

A reply to a pending text card, typed or spoken ("yep, send it", "actually
no"), reaches the agent as a new turn, and no word of it approves, declines
or edits that card here: proposing the same text again only returns the same
pending request and its card, and a text is sent only after the phone's own
decision on that card's exact binding ([device requests](./index.md), "Only
the exact binding decides an open offer before its deadline"). Reading such a
reply as approve, decline, edit or unrelated is the phone's, which re-checks
that the card is in view, current, unchanged and unexpired before it approves
it as a tap would; Alpha's spoken "Send this text" is that path, and it never
reaches the agent.

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
type TargetVerdict = TargetGrounded | NumberNotWritten | NumberCopyReference | ContactNotWritten
  | RecipientForm | NumberUnreadable | EmergencyDial | EmergencyKeypad | EmailNotWritten
pure def ownedMatch(exactWritten: bool, writtenMatches: int, exactSpoken: bool, spokenMatches: int): NumberMatch =
  if (exactWritten or writtenMatches == 1) WrittenOwnerNumber
  else if (writtenMatches > 1) SeveralOwnerNumbers
  else if (exactSpoken or spokenMatches == 1) SpokenOwnerNumber
  else if (spokenMatches > 1) SeveralOwnerNumbers
  else NoOwnerNumber
pure def ownerNumberFound(owned: NumberMatch): bool = owned == WrittenOwnerNumber or owned == SpokenOwnerNumber
pure def targetGrounded(verdict: TargetVerdict): bool = verdict == TargetGrounded or verdict == EmergencyKeypad
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

### The model asks which of alternative SMS recipients is meant, in its own words, before any lookup

On an enrolled phone that can compose or send SMS, the device tool's
target guidance says that a proposal has one recipient and that, when the
owner gives alternatives ("text Carson or Maya that dinner is covered"),
the model asks which one in its own words before looking either up or
proposing an operation. Whether the words give alternatives is the model's
to judge: no fixed question answers the turn before the model sees it.
Alternatives within the text body remain part of the body, and a message
that also asks for emergency services keeps the emergency rule.

```quint
type AlternativeRecipientAction = AskWhichRecipient | ProceedToProposal | KeepEmergencyRule
pure def alternativeSmsGuidanceShown(smsOffered: bool): bool = smsOffered
pure def alternativeRecipientAction(alternativeRecipient: bool, emergency: bool): AlternativeRecipientAction =
  if (emergency) KeepEmergencyRule
  else if (alternativeRecipient) AskWhichRecipient
  else ProceedToProposal
pure def lawAlternativeSmsGuidanceRequiresSmsCapability(smsOffered: bool): bool =
  alternativeSmsGuidanceShown(smsOffered) iff smsOffered
pure def lawAlternativeRecipientsAskBeforeLookupOrProposal(alternativeRecipient: bool): bool =
  (alternativeRecipientAction(alternativeRecipient, false) == AskWhichRecipient) iff alternativeRecipient
pure def lawEmergencyOverridesAlternativeRecipients(alternativeRecipient: bool): bool =
  alternativeRecipientAction(alternativeRecipient, true) == KeepEmergencyRule
```

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

### The model's own recipient is grounded as it proposed it, and an invented one is handed back once

The model reads whom the owner asked to call or text, also after a thanks or
a courtesy and with the words to send told to the person ("Thank you. Can you
text Carson and tell him to bring the ice", "ring mum back please"), and
proposes that recipient as its target. On a text it may say how the owner
named them, in `recipientKind`: `named` for a contact name, `number` for a
number, or `previous-sender` for the sender the agent just read (below).
`named` and `number` only describe the target and never change it or refuse
it. Nothing re-reads the owner's words for a recipient or puts another in the
model's place: the target is offered only when it is grounded as above. A SIM
send to several numbers the owner wrote ("text 415-555-0100 and 415-555-0111
that I'm late") is one reviewed send to each of them, once; every one is
grounded, so one the owner never wrote refuses the whole send.

A number, contact reference, name or email address the model invented is
handed back to the model the first time in a turn, as coaching that nothing
was called, sent or saved and why, so it can propose the owner's own instead
("Cole" for "Carson") or answer the owner in its own words. A second one in
the same turn is refused, and the owner hears why (below). A number the owner
wrote that cannot be read as one, a recipient this phone cannot take in its
form, and the emergency verdicts are the owner's to settle, so they are never
handed back.

```quint
type RecipientKind = NamedRecipient | NumberRecipient | PreviousSender | KindUnstated
type TargetHandling = OfferTarget | HandBackTarget | RefuseTarget
pure def modelInvented(verdict: TargetVerdict): bool =
  verdict == NumberNotWritten or verdict == NumberCopyReference or verdict == ContactNotWritten or verdict == EmailNotWritten
pure def targetHandling(verdict: TargetVerdict, handedBackThisTurn: bool): TargetHandling =
  if (targetGrounded(verdict)) OfferTarget
  else if (modelInvented(verdict) and not(handedBackThisTurn)) HandBackTarget
  else RefuseTarget
pure def lawAGroundedTargetIsOffered(verdict: TargetVerdict, handedBackThisTurn: bool): bool =
  (targetHandling(verdict, handedBackThisTurn) == OfferTarget) iff targetGrounded(verdict)
pure def lawAnInventedRecipientIsHandedBackOnlyOnceATurn(verdict: TargetVerdict): bool =
  modelInvented(verdict) implies (targetHandling(verdict, false) == HandBackTarget and targetHandling(verdict, true) == RefuseTarget)
pure def lawOnlyAnInventedRecipientIsHandedBack(verdict: TargetVerdict, handedBackThisTurn: bool): bool =
  targetHandling(verdict, handedBackThisTurn) == HandBackTarget implies modelInvented(verdict)
pure def lawWhatTheOwnerMustSettleIsNeverHandedBack(handedBackThisTurn: bool): bool =
  targetHandling(EmergencyDial, handedBackThisTurn) == RefuseTarget and targetHandling(NumberUnreadable, handedBackThisTurn) == RefuseTarget
    and targetHandling(RecipientForm, handedBackThisTurn) == RefuseTarget
```

### A request to open the dialer is the model's keypad, filled only with a number the owner wrote

On a phone that opens its keypad for chat, the model proposes the keypad for
"open the dialer", "open the keypad and type 415 302 4399" or "show me the
dial pad with 415-555-0100": empty, or with the number filled in. Nothing
turns another proposal into a keypad or rewrites its number: a keypad's
number is grounded like a call's, so a number the owner never wrote or spoke
is refused, and an empty keypad names nobody and is never refused. A phone
that cannot open its keypad for chat but can dial is told instead that such a
request with a number is a reviewed dial of that number, and that an empty
one is no phone step.

```quint
type DialerGuidance = KeypadForm | ReviewedDialGuidance | NoDialerGuidance
pure def dialerGuidance(keypadOffered: bool, dialOffered: bool): DialerGuidance =
  if (keypadOffered) KeypadForm else if (dialOffered) ReviewedDialGuidance else NoDialerGuidance
pure def lawAPhoneWithAKeypadIsOfferedTheKeypad(dialOffered: bool): bool = dialerGuidance(true, dialOffered) == KeypadForm
pure def lawOnlyAPhoneThatDialsIsToldToDial(keypadOffered: bool): bool = dialerGuidance(keypadOffered, false) != ReviewedDialGuidance
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
system dialer. What the owner hears of the empty keypad, and of that
refusal, is safety copy: it reaches the owner in these fixed words, alone
for the keypad, and the model never rewrites it
([planning](../conversation/planning.md)).

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

### A refused recipient is explained in a sentence that says truthfully that nothing ran

A recipient refusal offers nothing. Once it is refused rather than handed
back to the model (above), its sentence for the owner is true whichever
recipient was refused: it says that nothing was called or sent, or for a
contact change that nothing in the address book was saved or changed, and what
to tell the agent instead. The model can revise its reply after a host note
that quotes the refusal. When the failure remains open under the
[planning rules](../conversation/planning.md), its own words reach the owner.
The emergency refusal always reaches the owner as written. A recipient this
phone cannot take in its form, and
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
> last?" to name only as much of that sender as I asked for (the last four
> digits, unless I ask for the whole number), each without an extra approval
> when I asked for exactly that.

### A draft is the model's to ask for, to the recipient it proposed or to the sender the agent just read

The model sets `draft: true` when the owner asks only to draft, write or
prepare a text, and leaves it out when the owner asks to send one. A draft
the owner asks to see here, in the chat ("show me the draft here"), is the
model's own reply and proposes nothing: the tool tells the model so, and the
model decides from the owner's words. A text the owner then asks to send is
proposed as any text is, so it waits for its card. The model
proposes the recipient the owner addressed ("to Sam", "for +1 415 555
0124"), grounded as any recipient is (above), so a number inside the words to
send never becomes the recipient; nothing re-reads the owner's words to turn
a send into a draft or to pick another recipient. When the model says the
recipient is the sender the agent just read (`recipientKind:
previous-sender`, for "draft a reply to them" or "text that sender back"),
the text goes to that sender (below), never to the model's target. A reply in
the open thread (`sms_reply_selected`) stays there. When the owner names no
one, several people or someone unclear, the model asks which one person in
its own words.

```quint
type TextTarget = ModelTarget | DeliveredSenderAddress
pure def textTarget(kind: RecipientKind): TextTarget = if (kind == PreviousSender) DeliveredSenderAddress else ModelTarget
pure def lawOnlyATextToThePreviousSenderLeavesTheModelsTarget(kind: RecipientKind): bool =
  (textTarget(kind) == DeliveredSenderAddress) iff kind == PreviousSender
```

### A text to them goes only to the whole sender address the agent just delivered

A text the model addresses to the previous sender ("draft a text to them",
"to that sender", "to the last sender") goes to the sender of the applied latest-sender read of this conversation whose
delivered answer is the agent's reply just before the owner's message: that
read's own completion, delivered for this owner, its reply unchanged and
bound to the read's proposal, attempt and request message, and not past its
completion deadline. That read must have returned the whole address, and the
phone negotiated `sms.latest-sender.v2`. A newer read whose answer was not
delivered, an older read, and a read past its deadline are earlier reads,
which never address the text. Its `target` is that address as a number,
never the model's number, and is not grounded again; a draft also carries
the read's thread as its `replyThreadId` when the read returned one, so it
goes into that sender's conversation, and a text to send waits for its card
as every send does. Otherwise the owner is told there is no current sender,
and asked who last texted them or for one recipient.

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

### A latest-sender read names the whole address only when the owner asked for the whole number, on a phone that names it

A proposed `sms_latest_sender` is offered in the form the model read from
the owner's words, its `disclosure`, which the tool defines for the model:
`last-four` for a question about who sent the newest incoming SMS and for an
ask for the last four digits, `address` for an ask for the sender's whole
number or to text that sender, and
`unclear` for a narrower or unclear ask (the first digits, three digits,
"without the number", a masked or partial number). So "look up the sender
of my newest text" reads and answers only the last four digits, and the
whole number is read only when the owner asks for it, or asks to text that
sender when no whole number was read yet. `address`, on a phone
that negotiated `sms.latest-sender.v2`, reads the whole address. `last-four`,
a disclosure left out, and any read on an older phone read only the last four
digits. `unclear` offers nothing and is handed back to the model, which asks
the owner in its own words whether the last four digits will do, since no
other part is available.

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
draft to a number the owner wrote, not only spoke, outside the words to
send, or to the sender of the read just delivered, carrying that sender's
thread; a read of the whole sender address because the owner asked for the
whole number or to text that sender. Review is the default: a draft or a read keeps its card unless the model
set `reviewRequested: false`, which the tool tells it to set unless the owner
asked to see or approve it first. So one the owner asked to review first
("ask me first", "show me the approval", "wait for my approval"), and one
whose `reviewRequested` the model left out, waits on its card. The keypad never
dials, so it is not held, and the emergency keypad is never held or refused.
Every other keypad, draft or sender read is grounded for review, so the phone
shows its card. A pending keypad the owner asked for is
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
