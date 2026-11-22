# Browser controls from chat

The controls the agent proposes for the browser on the owner's phone: a web
search, a new, switched or closed tab, find in page, page history and
opening a typed address. [Request grounding](./requestGrounding.md) decides
which address or search words a message grounds, and
[remote control](./remoteControl.md) binds a history command to the tab the
turn observed. The phone keeps the tab list, titles, addresses and page
content; the agent learns only whether a control was sent.

## Story: Offer only the Browser controls my phone negotiated

> As the owner, I want the agent to propose a Browser control only when my
> phone said it can run it, and to review it only on my unlocked phone.

### Each control needs its group's capability, and a new-tab open needs its own

A search needs `browser.search.v1`; opening, switching and closing a tab
need `browser.tabs.v1`; find needs `browser.find.v1`; back, forward, reload
and stop need `browser.history.v1`. A phone that did not advertise a group is
never offered or sent its controls. Opening a typed address in a tab of its
own needs `browser.open-new-tab.v1`: without it the phone opens the address
in its own earlier tab, replacing that page, and a request for a new tab is
refused rather than placed in the reused tab. A private tab is asked for
explicitly, opens empty, and is never where an address is placed.

```quint
type BrowserControl = SearchControl | TabNewControl | TabSwitchControl | TabCloseControl | FindControl | HistoryControl
type ControlFamily = SearchFamily | TabsFamily | FindFamily | HistoryFamily
type Negotiated = { searchCapability: bool, tabsCapability: bool, findCapability: bool, historyCapability: bool, newTabCapability: bool }
pure def controlFamily(control: BrowserControl): ControlFamily =
  match control {
    | SearchControl => SearchFamily
    | TabNewControl => TabsFamily
    | TabSwitchControl => TabsFamily
    | TabCloseControl => TabsFamily
    | FindControl => FindFamily
    | HistoryControl => HistoryFamily
  }
pure def familyNegotiated(family: ControlFamily, negotiated: Negotiated): bool =
  match family {
    | SearchFamily => negotiated.searchCapability
    | TabsFamily => negotiated.tabsCapability
    | FindFamily => negotiated.findCapability
    | HistoryFamily => negotiated.historyCapability
  }
pure def controlOffered(control: BrowserControl, negotiated: Negotiated): bool = familyNegotiated(controlFamily(control), negotiated)
pure def navigationOffered(newTab: bool, negotiated: Negotiated): bool = not(newTab) or negotiated.newTabCapability
pure def lawOfferedControlWasNegotiated(control: BrowserControl, negotiated: Negotiated): bool =
  controlOffered(control, negotiated) implies (negotiated.searchCapability or negotiated.tabsCapability or negotiated.findCapability or negotiated.historyCapability)
pure def lawTabControlsShareTheTabsCapability(negotiated: Negotiated): bool =
  not(negotiated.tabsCapability) implies not(controlOffered(TabNewControl, negotiated) or controlOffered(TabSwitchControl, negotiated) or controlOffered(TabCloseControl, negotiated))
pure def lawNewTabNeedsItsCapability(negotiated: Negotiated): bool =
  not(negotiated.newTabCapability) implies (not(navigationOffered(true, negotiated)) and navigationOffered(false, negotiated))
pure val nothingNegotiated: Negotiated = { searchCapability: false, tabsCapability: false, findCapability: false, historyCapability: false, newTabCapability: false }
pure val negotiatedValues = Set(nothingNegotiated, { ...nothingNegotiated, searchCapability: true }, { ...nothingNegotiated, tabsCapability: true, newTabCapability: true },
  { searchCapability: true, tabsCapability: true, findCapability: true, historyCapability: true, newTabCapability: false })
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
  { ...directHistory, control: SearchControl, wordsTyped: true }, { ...directHistory, control: FindControl, wordsTyped: true }, { ...directHistory, control: TabNewControl })
```

## Story: Tell me a Browser command was sent, never that the page finished

> As the owner, I want to hear that my browser was asked to go back, forward
> or reload, and never that the page got there, because the agent cannot see
> whether it did.

### A history receipt proves dispatch only, and any other answer is a typed refusal or uncertain

The mounted browser answers a history command it took with a receipt. Only
an explicit receipt that says dispatched, not completed, and asks for a
readback counts, and it is reported as dispatched: the action's own sentence
says the browser was asked and that the page may still be loading, it ends
the turn, and it marks the execution dispatched, never completed. Where the
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
