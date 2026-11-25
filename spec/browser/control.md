# Browser controls from chat

The controls the agent proposes for the browser on the owner's phone: a web
search, a new, switched or closed tab, the phone's own list of open tabs
shown, find in page, page history and opening a typed address.
[Request grounding](./requestGrounding.md) decides which address or search
words a message grounds, and
[remote control](./remoteControl.md) binds a history command to the tab the
turn observed. The phone keeps the tab list, titles, addresses and page
content; the agent learns only whether a control was sent.

## Story: Offer only the Browser controls my phone negotiated

> As the owner, I want the agent to propose a Browser control only when my
> phone said it can run it, and to review it only on my unlocked phone.

### Each control needs its group's capability, and a new-tab open needs its own

A search needs `browser.search.v1`; opening, switching and closing a tab
need `browser.tabs.v1`, and closing every tab needs its own capability too
(below); showing the phone's own list of open tabs needs
`browser.tabs.show.v1`, on its own and without `browser.tabs.v1`; find needs `browser.find.v1`; back, forward, reload and stop need
`browser.history.v1`. A phone that did not advertise a group is
never offered or sent its controls. Opening a typed address in a tab of its
own needs `browser.open-new-tab.v1`: without it the phone is never sent a
new-tab open, and an address asked for in a new tab opens as it always has,
in the phone's own earlier tab, replacing that page. A private tab is asked
for explicitly, opens empty, and is never where an address is placed.

```quint
type BrowserControl = SearchControl | TabNewControl | TabSwitchControl | TabCloseControl | TabListControl | FindControl | HistoryControl
type ControlFamily = SearchFamily | TabsFamily | TabListFamily | FindFamily | HistoryFamily
type Negotiated = { searchCapability: bool, tabsCapability: bool, tabListCapability: bool, findCapability: bool, historyCapability: bool, newTabCapability: bool, closeAllCapability: bool }
pure def controlFamily(control: BrowserControl): ControlFamily =
  match control {
    | SearchControl => SearchFamily
    | TabNewControl => TabsFamily
    | TabSwitchControl => TabsFamily
    | TabCloseControl => TabsFamily
    | TabListControl => TabListFamily
    | FindControl => FindFamily
    | HistoryControl => HistoryFamily
  }
pure def familyNegotiated(family: ControlFamily, negotiated: Negotiated): bool =
  match family {
    | SearchFamily => negotiated.searchCapability
    | TabsFamily => negotiated.tabsCapability
    | TabListFamily => negotiated.tabListCapability
    | FindFamily => negotiated.findCapability
    | HistoryFamily => negotiated.historyCapability
  }
pure def controlOffered(control: BrowserControl, negotiated: Negotiated): bool = familyNegotiated(controlFamily(control), negotiated)
pure def navigationOffered(newTab: bool, negotiated: Negotiated): bool = not(newTab) or negotiated.newTabCapability
pure def lawOfferedControlWasNegotiated(control: BrowserControl, negotiated: Negotiated): bool =
  controlOffered(control, negotiated) implies (negotiated.searchCapability or negotiated.tabsCapability or negotiated.tabListCapability or negotiated.findCapability or negotiated.historyCapability)
pure def lawTabControlsShareTheTabsCapability(negotiated: Negotiated): bool =
  not(negotiated.tabsCapability) implies not(controlOffered(TabNewControl, negotiated) or controlOffered(TabSwitchControl, negotiated) or controlOffered(TabCloseControl, negotiated))
pure def lawNewTabNeedsItsCapability(negotiated: Negotiated): bool =
  not(negotiated.newTabCapability) implies (not(navigationOffered(true, negotiated)) and navigationOffered(false, negotiated))
pure def lawTheTabListNeedsItsOwnCapability(negotiated: Negotiated): bool = controlOffered(TabListControl, negotiated) iff negotiated.tabListCapability
pure val nothingNegotiated: Negotiated = { searchCapability: false, tabsCapability: false, tabListCapability: false, findCapability: false, historyCapability: false, newTabCapability: false, closeAllCapability: false }
pure val negotiatedValues = Set(nothingNegotiated, { ...nothingNegotiated, searchCapability: true }, { ...nothingNegotiated, tabsCapability: true, newTabCapability: true },
  { ...nothingNegotiated, tabListCapability: true },
  { searchCapability: true, tabsCapability: true, tabListCapability: false, findCapability: true, historyCapability: true, newTabCapability: false, closeAllCapability: false },
  { ...nothingNegotiated, tabsCapability: true, closeAllCapability: true }, { ...nothingNegotiated, closeAllCapability: true })
```

### Closing every tab is its own negotiated form, refused rather than narrowed, and reviewed only on a card that lists those tabs

Closing every open tab is a tab close that names `all`. It needs
`browser.tabs.close-all.v1` beside `browser.tabs.v1`; a phone without it is
never sent it, so a request to close several tabs is refused rather than
narrowed to the tab that is showing. A close that names one tab and every
tab is refused. The phone lists the tabs it will close on that one review
card, counting private tabs without naming them, and closes exactly those
tabs or nothing; the agent never sees the list. Where the phone cannot list
them for the proposal, or no tab is open, the owner gets a notice instead of
a card, and only a close-all card that listed its tabs in the latest review
may be approved.

```quint
type TabCloseForm = CloseShowing | CloseNamed | CloseEvery
type CloseAllReview = CloseAllCard | CloseAllNotice
pure def closeFormOffered(form: TabCloseForm, negotiated: Negotiated, closeAllNegotiated: bool): bool =
  controlOffered(TabCloseControl, negotiated) and (form != CloseEvery or closeAllNegotiated)
pure def closeAllReview(listed: bool, tabs: int): CloseAllReview = if (listed and tabs > 0) CloseAllCard else CloseAllNotice
pure def closeAllApprovable(listedInLatestReview: bool, tabs: int): bool = closeAllReview(listedInLatestReview, tabs) == CloseAllCard
pure val formValues = Set(CloseShowing, CloseNamed, CloseEvery)
pure val tabsValues = Set(0, 1, 8)
pure def lawClosingEveryTabNeedsItsOwnForm(negotiated: Negotiated): bool = not(closeFormOffered(CloseEvery, negotiated, false))
pure def lawClosingEveryTabNeedsTheTabsCapability(closeAllNegotiated: bool): bool = not(closeFormOffered(CloseEvery, nothingNegotiated, closeAllNegotiated))
pure def lawOneTabFormsNeedOnlyTheTabsCapability(form: TabCloseForm, negotiated: Negotiated): bool =
  form != CloseEvery implies closeFormOffered(form, negotiated, false) == controlOffered(TabCloseControl, negotiated)
pure def lawAnUnlistedCloseAllIsNeverACard(listed: bool, tabs: int): bool = (not(listed) or tabs <= 0) implies closeAllReview(listed, tabs) == CloseAllNotice
pure def lawOnlyAListedCardIsApproved(listed: bool, tabs: int): bool = closeAllApprovable(listed, tabs) implies (listed and tabs > 0)
```

### A control is reviewed only on the unlocked phone, and closing a tab always waits for that review

A control is reviewed only where the owner sees the phone unlocked and on a
screen that is not sensitive; on a locked or sensitive screen the review is
refused with the notice to unlock the phone, and nothing runs. Closing a tab
always waits for the review. Any other control may run without one only when
it is bound to the owner's own current message, and a search, a tab switch
or a find only when the owner typed its words in that message.

```quint
type ControlRequest = { control: BrowserControl, boundToMessage: bool, wordsTyped: bool }
pure def needsTypedWords(control: BrowserControl): bool = control == SearchControl or control == TabSwitchControl or control == FindControl
pure def runsUnreviewed(request: ControlRequest): bool =
  request.control != TabCloseControl and request.boundToMessage and (not(needsTypedWords(request.control)) or request.wordsTyped)
pure def reviewAdmitted(sensitiveScreen: bool): bool = not(sensitiveScreen)
pure def lawClosingATabIsAlwaysReviewed(request: ControlRequest): bool = request.control == TabCloseControl implies not(runsUnreviewed(request))
pure def lawUnboundControlIsReviewed(request: ControlRequest): bool = not(request.boundToMessage) implies not(runsUnreviewed(request))
pure def lawUntypedWordsAreReviewed(request: ControlRequest): bool = needsTypedWords(request.control) and not(request.wordsTyped) implies not(runsUnreviewed(request))
pure def lawLockedPhoneRefusesReview(sensitiveScreen: bool): bool = sensitiveScreen implies not(reviewAdmitted(sensitiveScreen))
pure val directHistory: ControlRequest = { control: HistoryControl, boundToMessage: true, wordsTyped: false }
pure val requestValues = Set(directHistory, { ...directHistory, boundToMessage: false }, { ...directHistory, control: TabCloseControl }, { ...directHistory, control: SearchControl },
  { ...directHistory, control: SearchControl, wordsTyped: true }, { ...directHistory, control: FindControl, wordsTyped: true }, { ...directHistory, control: TabNewControl },
  { ...directHistory, control: TabListControl })
```

### A history move has one home: the Browser control where my phone negotiated it, or else the BROWSER command

Where the owner's enrolled phone negotiated `browser.history.v1`, back,
forward, reload and stop are offered only as the Browser history control,
and the BROWSER command is not offered on that turn. The BROWSER command,
bound to the tab the turn observed, answers a history move only on a turn
whose device negotiated no history control and whose mounted browser takes
agent commands. Otherwise no history move is offered. Core's catalog gives the BROWSER
command the general context every owner turn is planned in, beside its
browser context, so it runs from any owner chat, as on the phone before
VibeStack; its owner role gate and these offer rules are unchanged.

```quint
type HistoryHome = HistoryAsControl | HistoryAsCommand | NoHistoryMove
pure def historyHome(negotiated: Negotiated, commandReachable: bool): HistoryHome =
  if (controlOffered(HistoryControl, negotiated)) HistoryAsControl else if (commandReachable) HistoryAsCommand else NoHistoryMove
pure def lawANegotiatedHistoryMoveIsNeverACommand(negotiated: Negotiated, commandReachable: bool): bool =
  controlOffered(HistoryControl, negotiated) implies historyHome(negotiated, commandReachable) == HistoryAsControl
pure def lawACommandAnswersOnlyWithoutTheControl(negotiated: Negotiated, commandReachable: bool): bool =
  historyHome(negotiated, commandReachable) == HistoryAsCommand implies (commandReachable and not(controlOffered(HistoryControl, negotiated)))
```

## Story: Tell me a Browser command was sent, never that the page finished

> As the owner, I want to hear that my browser was asked to go back, forward
> or reload, and never that the page got there, because the agent cannot see
> whether it did.

A Browser request my phone opens without review is told as sent, in the
model's words, from the Browser's own sentence ("wikipedia.org is ready to
open." for an open, which never says it opened) given to the model as what
the phone shows. One proposed
again after it applied is reported from its stored receipt with no sentence of the Browser's own, so
the model words the reply from that historical result and never says how
the page looks.

### A history receipt proves dispatch only, and any other answer is a typed refusal or uncertain

The mounted browser answers a history command it took with a receipt. Only
an explicit receipt that says dispatched, not completed, and asks for a
readback counts, and it is reported as dispatched: the action tells the
model that the browser was asked and that the page may still be loading,
the model words the reply from that, it ends the turn, and it marks the
execution dispatched, never completed. Where the
device has no read command the report asks for no readback. A refusal the
browser gave with a typed code before it acted is reported with that code,
nothing done. A command never handed to the browser is reported not sent.
Every other answer, a failed, malformed, lost or late one, may have acted:
it is reported uncertain and is never sent again.

```quint
type HistoryAnswer = AnswerMissing | AnswerFailed | AnswerRefusal | AnswerReceipt
type HistoryReceipt = { delivered: bool, answer: HistoryAnswer, typedCode: bool, dispatched: bool, completed: bool, readbackAsked: bool }
type HistoryReport = HistoryNotSent | HistoryRefused | HistoryUncertain | HistoryDispatched
pure def historyReport(receipt: HistoryReceipt): HistoryReport =
  if (not(receipt.delivered)) HistoryNotSent
  else if (receipt.answer == AnswerRefusal and receipt.typedCode) HistoryRefused
  else if (receipt.answer == AnswerReceipt and receipt.dispatched and not(receipt.completed) and receipt.readbackAsked) HistoryDispatched
  else HistoryUncertain
pure def lawDispatchedReceiptNeverClaimsCompletion(receipt: HistoryReceipt): bool =
  historyReport(receipt) == HistoryDispatched implies receipt.delivered and receipt.answer == AnswerReceipt and receipt.dispatched and not(receipt.completed)
pure def lawUndeliveredCommandIsNotSent(receipt: HistoryReceipt): bool = not(receipt.delivered) implies historyReport(receipt) == HistoryNotSent
pure def lawDeliveredAnswerWithoutReceiptOrTypedRefusalIsUncertain(receipt: HistoryReceipt): bool =
  receipt.delivered and receipt.answer != AnswerReceipt and not(receipt.answer == AnswerRefusal and receipt.typedCode) implies historyReport(receipt) == HistoryUncertain
pure val dispatchReceipt: HistoryReceipt = { delivered: true, answer: AnswerReceipt, typedCode: false, dispatched: true, completed: false, readbackAsked: true }
pure val receiptValues = Set(dispatchReceipt, { ...dispatchReceipt, delivered: false }, { ...dispatchReceipt, completed: true }, { ...dispatchReceipt, readbackAsked: false },
  { ...dispatchReceipt, answer: AnswerRefusal, typedCode: true }, { ...dispatchReceipt, answer: AnswerRefusal }, { ...dispatchReceipt, answer: AnswerMissing }, { ...dispatchReceipt, answer: AnswerFailed })
```

## Story: Propose a Browser control in my own words

> As the owner, I want a Browser request I type in chat to reach my phone as
> one control in my own words, so that the agent never searches for words I
> did not type, never closes fewer tabs than I asked, and tells me how to ask
> when it cannot.

### A search runs on my words as I typed them, and a search the model words differently runs only after my review

A proposed search whose query appears in the owner's current message as
whole words, letter case and spacing aside, carries the owner's own spelling
of it. A query the model added to, reordered or reworded ("look up whether
it'll rain in Austin tomorrow" searched as "Austin weather tomorrow") is
still offered, with the model's words, and is never bound to the message,
so the owner reviews it on the phone (below). An empty query, one longer
than the search limit, and a message that cannot be read ground no search,
and nothing is proposed.

```quint
type SearchWords = { readable: bool, fits: bool, typedAsWholeWords: bool, typedSpelling: str, proposed: str }
pure def groundedSearch(words: SearchWords): str =
  if (not(words.readable) or not(words.fits)) "" else if (words.typedAsWholeWords) words.typedSpelling else words.proposed
pure def lawATypedSearchKeepsMySpelling(words: SearchWords): bool =
  (words.readable and words.fits and words.typedAsWholeWords) implies groundedSearch(words) == words.typedSpelling
pure def lawAnUnreadableMessageGroundsNoSearch(words: SearchWords): bool = not(words.readable) implies groundedSearch(words) == ""
pure def lawAQueryPastTheLimitGroundsNoSearch(words: SearchWords): bool = not(words.fits) implies groundedSearch(words) == ""
pure val typedWords: SearchWords = { readable: true, fits: true, typedAsWholeWords: true, typedSpelling: "cheap flights", proposed: "Cheap  flights" }
pure val wordsValues = Set(typedWords, { ...typedWords, typedAsWholeWords: false, proposed: "flights that are cheap" }, { ...typedWords, readable: false }, { ...typedWords, fits: false })
```

### A search, tab switch or find runs without my review only on words I typed for it, and a search only as my whole message

A grounded search is bound to the owner's current message only when that
whole message is the search and its words are the query; a tab switch or a
find only when the owner typed its words in that message; showing the tab
list always, since it only shows the phone's own list and changes nothing; a
new tab, a tab close and a history move whenever they are grounded, except a
reload of a page the phone withheld, which is always reviewed (below). The phone shows a review card
before it runs an unbound proposal. A tab close always waits for review.

```quint
type ProposedControl = { control: BrowserControl, wholeMessage: bool, wordsTyped: bool }
pure def controlBound(proposed: ProposedControl): bool =
  if (proposed.control == SearchControl) proposed.wholeMessage and proposed.wordsTyped
  else if (proposed.control == TabListControl) true
  else not(needsTypedWords(proposed.control)) or proposed.wordsTyped
pure def lawUntypedWordsAreNeverBound(proposed: ProposedControl): bool =
  (needsTypedWords(proposed.control) and not(proposed.wordsTyped)) implies not(controlBound(proposed))
pure def lawOnlyMyWholeMessageSearchIsBound(proposed: ProposedControl): bool =
  (proposed.control == SearchControl and controlBound(proposed)) implies proposed.wholeMessage
pure def lawTheTabListIsBound(proposed: ProposedControl): bool = proposed.control == TabListControl implies controlBound(proposed)
pure val typedSearch: ProposedControl = { control: SearchControl, wholeMessage: true, wordsTyped: true }
pure val proposedValues = Set(typedSearch, { ...typedSearch, wholeMessage: false }, { ...typedSearch, wordsTyped: false }, { ...typedSearch, control: FindControl, wholeMessage: false },
  { ...typedSearch, control: TabSwitchControl, wordsTyped: false }, { ...typedSearch, control: HistoryControl, wordsTyped: false }, { ...typedSearch, control: TabCloseControl, wordsTyped: false },
  { ...typedSearch, control: TabListControl, wordsTyped: false }, { ...typedSearch, control: TabListControl, wholeMessage: false, wordsTyped: false })
```

### Closing every tab on a phone that closes one tab at a time is refused with its reason, never narrowed

The model may ask to close every tab wherever the phone negotiated tab
controls, so that a request for all of them is never narrowed for want of a
way to say it. A proposal to close every tab, on a phone that negotiated tab
controls but not `browser.tabs.close-all.v1`, is refused before anything is
kept, with the reason that this phone closes one tab at a time, so the agent
can tell the owner and offer the tab that is showing or a tab they name. It
is never proposed as a close of the tab that is showing. Each other close
the phone negotiated is proposed as it was asked.

```quint
type CloseAnswer = CloseProposed | CloseEveryRefused | CloseUnavailable
pure def closeAnswer(form: TabCloseForm, negotiated: Negotiated, closeAllNegotiated: bool): CloseAnswer =
  if (closeFormOffered(form, negotiated, closeAllNegotiated)) CloseProposed
  else if (form == CloseEvery and controlOffered(TabCloseControl, negotiated)) CloseEveryRefused
  else CloseUnavailable
pure def lawCloseEveryIsRefusedOnAOneTabPhone(negotiated: Negotiated): bool =
  controlOffered(TabCloseControl, negotiated) implies closeAnswer(CloseEvery, negotiated, false) == CloseEveryRefused
pure def lawCloseEveryIsProposedOnlyAsCloseEvery(negotiated: Negotiated, closeAllNegotiated: bool): bool =
  closeAnswer(CloseEvery, negotiated, closeAllNegotiated) == CloseProposed implies closeFormOffered(CloseEvery, negotiated, closeAllNegotiated)
pure def lawOneTabClosesAreProposedAsAsked(form: TabCloseForm, negotiated: Negotiated, closeAllNegotiated: bool): bool =
  (form != CloseEvery and controlOffered(TabCloseControl, negotiated)) implies closeAnswer(form, negotiated, closeAllNegotiated) == CloseProposed
```

### A refused Browser proposal tells me how to ask, and never says anything opened

A refused open answers the owner with how to ask for an address, with a
plain example address such as example.com that reads aloud as an ordinary
sentence, with no quotes and no command phrase, when the message has
none, and only that the address was not opened when it has one; a refused search asks for the words to search for; a refused close of
every tab says the phone closes one tab at a time and nothing closed; a
refused reload of a page the phone withheld says the page was not reloaded
because reloading would not let the agent read it. The
model learns that no proposal was created and nothing ran.

```quint
type BrowserRefusal = DestinationNotRequested | SearchWordsMissing | CloseEveryUnavailable | ReloadNotRequested
type RefusalReply = AskForAddress | SayAddressNotOpened | AskForSearchWords | SayOneTabAtATime | SayPageNotReloaded
pure def refusalReply(refusal: BrowserRefusal, addressInWords: bool): RefusalReply =
  match refusal {
    | DestinationNotRequested => if (addressInWords) SayAddressNotOpened else AskForAddress
    | SearchWordsMissing => AskForSearchWords
    | CloseEveryUnavailable => SayOneTabAtATime
    | ReloadNotRequested => SayPageNotReloaded
  }
pure def lawARefusedOpenAsksOnlyWithoutAnAddress(addressInWords: bool): bool =
  (refusalReply(DestinationNotRequested, addressInWords) == AskForAddress) iff not(addressInWords)
pure def lawOnlyARefusedOpenSpeaksOfAnAddress(refusal: BrowserRefusal, addressInWords: bool): bool =
  (refusalReply(refusal, addressInWords) == AskForAddress or refusalReply(refusal, addressInWords) == SayAddressNotOpened) implies refusal == DestinationNotRequested
```

## Story: Open an address on the screen I asked from

> As the owner, I want to ask for a web address from a screen that has no
> enrolled phone behind it, such as Alpha in a web browser, and see it open
> in that screen's Browser, under the same rules as on my phone.

### An open has one home: the Browser proposal where my enrolled phone takes it, else the screen I asked from

Where the owner's enrolled phone admits a Browser open, an address is
opened only as the `browser_navigate` proposal. On a turn with no such phone,
whose screen takes the agent's views as completed actions, the BROWSER_OPEN
action is offered instead, for that screen alone. Otherwise no open is
offered, and the BROWSER command's history moves are unchanged.

```quint
type OpenHome = OpenAsProposal | OpenOnScreen | NoOpen
pure def openHome(phoneAdmitsOpen: bool, screenTakesViews: bool): OpenHome =
  if (phoneAdmitsOpen) OpenAsProposal else if (screenTakesViews) OpenOnScreen else NoOpen
pure def lawAnOpenMyPhoneTakesIsAProposal(phoneAdmitsOpen: bool, screenTakesViews: bool): bool =
  phoneAdmitsOpen implies openHome(phoneAdmitsOpen, screenTakesViews) == OpenAsProposal
pure def lawAScreenOpenNeedsTheScreenAndNoPhone(phoneAdmitsOpen: bool, screenTakesViews: bool): bool =
  openHome(phoneAdmitsOpen, screenTakesViews) == OpenOnScreen implies (screenTakesViews and not(phoneAdmitsOpen))
```

### The screen shows the address for me to open, and nothing opens until I choose Open there

BROWSER_OPEN grounds the address exactly as the `browser_navigate` proposal
does ([request grounding](./requestGrounding.md)): the same https address,
the same page links, the same refusals, answered as a refused proposal is,
with nothing handed back. A grounded open is handed back in the action's
completed result as the typed `browser_navigate` operation, bound to the
screen that asked, which shows the address for the owner to open; even an
address the owner's whole message asked for waits for their Open there. The
model learns that the screen shows the address for the owner to open, and
never that it opened, that the page loaded or what it shows.

## Story: Tell me you cannot read my page, and never reload it unasked

> As the owner, I want the agent to tell me when it cannot read the page I
> am on, and never to reload it unless I ask, because a reload can send a
> form again and still leaves the page unreadable.

### A reload of a page my phone withheld runs only after my review on the phone, or as the BROWSER command only when the model says I asked for it

Where the owner's current message carried a Browser page whose text the
phone withheld, because it could not read it or because it may hold
sign-in details, a reload of that tab proposed as the Browser history
control is always offered unbound to the message, so the phone shows its
review card and nothing reloads until the owner approves there. No reading
of the owner's words decides it: the card is the check, since a reload can
send a form again and still leaves the page unreadable. The BROWSER command
has no review card, so there the model says whether the owner asked: its
reload carries `ownerAskedReload`, true only when the owner's current
message itself asks to reload, refresh or reopen the page now, and never
for a mention, a question about reloading, a reload the owner says they
will do, a retracted request or a bare yes. Whether the words ask is the
model's to judge; no word list decides it. A reload the model marks as
asked runs only on the tab the turn observed, and never on a page withheld
because it may hold sign-in details, where reloading can send a form again. Any other reload on such a turn is refused
before anything is sent: the model learns that the phone shares no text of
that page, only its title and address, that reloading does not change that
and nothing was reloaded, and that it should answer the owner instead.
Back, forward and stop, a page the phone read and a message that carried
no page are unchanged. Opening the same withheld page by its address
requires a direct request to open the exact normalized address; a fragment
change still reaches the same page and its exact address must be
authorized.

```quint
type CarriedPage = NoPageCarried | PageTextRead | PageTextUnreadable | PageTextSensitive
type HistoryMove = MoveBack | MoveForward | MoveReload | MoveStop
pure def pageWithheld(page: CarriedPage): bool = page == PageTextUnreadable or page == PageTextSensitive
pure def pageReopenRefused(page: CarriedPage, samePage: bool, exactOpen: bool): bool =
  pageWithheld(page) and samePage and not(exactOpen)
pure def withheldReload(move: HistoryMove, page: CarriedPage): bool = move == MoveReload and pageWithheld(page)
pure def lawAReloadOfAWithheldPageIsAlwaysChecked(page: CarriedPage): bool = pageWithheld(page) implies withheldReload(MoveReload, page)
pure def lawOnlyAReloadOfAWithheldPageIsChecked(move: HistoryMove, page: CarriedPage): bool =
  withheldReload(move, page) implies (move == MoveReload and pageWithheld(page))
pure def lawAReadablePageIsNeverCheckedForAReload(move: HistoryMove): bool =
  not(withheldReload(move, PageTextRead)) and not(withheldReload(move, NoPageCarried))
type CommandReload = { move: HistoryMove, page: CarriedPage, ownerAskedReload: bool, tabObserved: bool }
pure def commandReloadRuns(r: CommandReload): bool =
  not(withheldReload(r.move, r.page)) or (r.page != PageTextSensitive and r.ownerAskedReload and r.tabObserved)
pure val askedReload: CommandReload = { move: MoveReload, page: PageTextUnreadable, ownerAskedReload: true, tabObserved: true }
pure val rValues = Set(askedReload, { ...askedReload, ownerAskedReload: false }, { ...askedReload, page: PageTextSensitive },
  { ...askedReload, tabObserved: false }, { ...askedReload, page: PageTextRead, ownerAskedReload: false }, { ...askedReload, move: MoveBack, ownerAskedReload: false })
pure def lawAnUnaskedWithheldReloadNeverRuns(r: CommandReload): bool =
  (withheldReload(r.move, r.page) and not(r.ownerAskedReload)) implies not(commandReloadRuns(r))
pure def lawASignInPageNeverReloads(r: CommandReload): bool =
  (r.move == MoveReload and r.page == PageTextSensitive) implies not(commandReloadRuns(r))
pure def lawAnAskedReloadRunsOnlyOnTheObservedTab(r: CommandReload): bool =
  (withheldReload(r.move, r.page) and commandReloadRuns(r)) implies r.tabObserved
pure def lawAnAskedReloadOfTheObservedTabRuns(r: CommandReload): bool =
  (r == askedReload) implies commandReloadRuns(r)
pure def lawOtherMovesAndReadablePagesAreUnchecked(r: CommandReload): bool =
  not(withheldReload(r.move, r.page)) implies commandReloadRuns(r)
```
