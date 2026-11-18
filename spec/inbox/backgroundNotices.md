# Mail background notices

A background notice tells the owner that mail arrived. Tapping it opens
the inbox, or asks the agent about that exact message after the owner
reviews its excerpt. The device's stored history, scheduler, delivery and
tap verification are mail background delivery.
A notice carries counts only; the subject and snippet stay in the
reviewed excerpt.

## Story: Open the Inbox or ask about the exact notification I tapped

> As the owner, I want a notice I tap to open my inbox, or to let me ask
> about the exact message it was about, and never anyone else's mail.

### A pending tap opens only the current grant and ordinary opening spends it first

A pending tap is read only in the foreground on an unlocked device, and
carries a token, grant, credential, user and generation. The tap is
admitted only while its owner and scope are current, and then only for
the exact readable grant. A newer pending tap can supersede an earlier
one before review.

An ordinary tap consumes the token first. Only a successful consume
under the still-current scope opens the Inbox list for the selected
grant. That path performs no message read or mark-read. A failed or
stale request has no visible navigation. For an Ask tap, the current
agent, enrollment and non-sensitive foreground must also hold.
It reads the exact message and thread. A definite initial read failure
under live Ask scope may open the Inbox list without consuming or
composing. A stale answer or wrong message/thread does neither.

```quint
type NoticeFields = { tokenText: str, grantText: str, credentialText: str, userText: str, generationText: str }
pure val validNotice: NoticeFields = { tokenText: "token", grantText: "grant", credentialText: "credential", userText: "user", generationText: "generation" }
pure val noticeValues = Set(validNotice, { ...validNotice, tokenText: "" }, { ...validNotice, generationText: "" })
pure def noticeHasIdentity(notice: NoticeFields): bool =
  notice.tokenText != "" and notice.grantText != "" and notice.credentialText != "" and notice.userText != "" and notice.generationText != ""
pure def lawGenerationRequired(notice: NoticeFields): bool =
  notice.generationText == "" implies not(noticeHasIdentity(notice))
type AskPhase = IdleTap | ReadingTap | ReadingGrants | ReadingMail | ReviewingAsk | RecheckingAsk | ConsumingTap | OpenedList | ComposedAsk | ClosedAsk
type NoticeTap = { phase: AskPhase, asks: bool, spent: bool, canceled: bool, releaseRequested: bool }
pure val initial: NoticeTap =
  { phase: IdleTap, asks: false, spent: false, canceled: false, releaseRequested: false }
pure def canReadPending(s: NoticeTap): bool = s.phase == IdleTap
pure def readPending(s: NoticeTap): NoticeTap = { ...s, phase: ReadingTap }
type TapEvidence = { validIdentity: bool, sameOwner: bool, scopeCurrent: bool, asks: bool }
pure val exactTap: TapEvidence = { validIdentity: true, sameOwner: true, scopeCurrent: true, asks: true }
pure val tapEvidenceValues = Set(exactTap, { ...exactTap, asks: false }, { ...exactTap, validIdentity: false },
  { ...exactTap, sameOwner: false }, { ...exactTap, scopeCurrent: false })
pure def canAcceptPending(s: NoticeTap): bool = s.phase == ReadingTap
pure def acceptPending(s: NoticeTap, tapEvidence: TapEvidence): NoticeTap =
  if (tapEvidence.validIdentity and tapEvidence.sameOwner and tapEvidence.scopeCurrent)
    { ...s, phase: ReadingGrants, asks: tapEvidence.asks }
  else { ...s, phase: ClosedAsk }
type GrantEvidence = { scopeCurrent: bool, readableGrant: bool, askReady: bool }
pure val exactGrant: GrantEvidence = { scopeCurrent: true, readableGrant: true, askReady: true }
pure val grantEvidenceValues = Set(exactGrant, { ...exactGrant, scopeCurrent: false },
  { ...exactGrant, readableGrant: false }, { ...exactGrant, askReady: false })
pure def canCheckGrants(s: NoticeTap): bool = s.phase == ReadingGrants
pure def checkGrants(s: NoticeTap, grantEvidence: GrantEvidence): NoticeTap =
  if (not(grantEvidence.scopeCurrent and grantEvidence.readableGrant) or (s.asks and not(grantEvidence.askReady))) { ...s, phase: ClosedAsk }
  else { ...s, phase: if (s.asks) ReadingMail else ConsumingTap }
type InitialReply = UnavailableMail | WrongMail | ExactMail
type MailEvidence = { scopeCurrent: bool, initialReply: InitialReply, reviewable: bool }
pure val exactMail: MailEvidence = { scopeCurrent: true, initialReply: ExactMail, reviewable: true }
pure val mailEvidenceValues = Set(exactMail, { ...exactMail, scopeCurrent: false }, { ...exactMail, reviewable: false },
  { ...exactMail, initialReply: UnavailableMail }, { ...exactMail, initialReply: WrongMail })
pure def canOpenAsk(s: NoticeTap): bool = s.phase == ReadingMail
pure def openAsk(s: NoticeTap, mailEvidence: MailEvidence): NoticeTap =
  if (not(mailEvidence.scopeCurrent)) { ...s, phase: ClosedAsk }
  else if (mailEvidence.initialReply == UnavailableMail) { ...s, phase: OpenedList }
  else if (mailEvidence.initialReply == ExactMail and mailEvidence.reviewable) { ...s, phase: ReviewingAsk }
  else { ...s, phase: ClosedAsk }
pure def alwaysAskPhasesHaveAsk(s: NoticeTap): bool =
  (s.phase == ReadingMail or s.phase == ReviewingAsk or s.phase == RecheckingAsk or s.phase == ComposedAsk) implies s.asks
pure def sometimesListOpens(s: NoticeTap): bool = s.phase == OpenedList
pure val weight_acceptPending = 4
pure val weight_checkGrants = 4
pure val weight_openAsk = 4
```

### Ask rechecks the exact reviewed subject and snippet before consumption

The excerpt carries the message's subject and snippet, with no body or
attachment. The owner may edit it; a blank or sensitive excerpt is
refused. The confirmation rechecks the underlying unedited selection.

The recheck first requires the same pending Ask token and notice
generation, then the same provider history, message, thread, subject
and snippet from a fresh read. A user cancellation or scope loss
before consumption prevents it. Only an explicit dismissal releases the
question; the view merely being hidden does not. A recheck or consume
failure reports the changed notification. Once the device acknowledges
consumption the tap is spent, and that final step checks the current
scope. A scope loss or compose failure after
consumption reports that the question could not be kept. The Ask
flow places a draft in the composer and performs no send.

```quint
type MailExcerpt = { message: int, thread: int, providerHistory: int, subject: str, snippet: str }
type ExactQuestion = { sameToken: bool, questionTap: bool, sameGeneration: bool, reviewed: MailExcerpt, fresh: MailExcerpt }
pure val exampleExcerpt: MailExcerpt = { message: 1, thread: 1, providerHistory: 1, subject: "Subject", snippet: "Snippet" }
pure val questionValues = Set(
  { sameToken: true, questionTap: true, sameGeneration: true, reviewed: exampleExcerpt, fresh: exampleExcerpt },
  { sameToken: false, questionTap: true, sameGeneration: true, reviewed: exampleExcerpt, fresh: exampleExcerpt },
  { sameToken: true, questionTap: true, sameGeneration: false, reviewed: exampleExcerpt, fresh: exampleExcerpt },
  { sameToken: true, questionTap: true, sameGeneration: true, reviewed: exampleExcerpt, fresh: { ...exampleExcerpt, providerHistory: 2 } },
  { sameToken: true, questionTap: true, sameGeneration: true, reviewed: exampleExcerpt, fresh: { ...exampleExcerpt, snippet: "Changed" } }
)
pure def exactQuestion(question: ExactQuestion): bool =
  question.sameToken and question.questionTap and question.sameGeneration and question.reviewed == question.fresh
pure def lawChangedExcerptBlocksQuestion(question: ExactQuestion): bool =
  question.reviewed != question.fresh implies not(exactQuestion(question))
pure def canConfirmAsk(s: NoticeTap): bool = s.phase == ReviewingAsk
pure def confirmAsk(s: NoticeTap, scopeCurrent: bool, safeDraft: bool): NoticeTap =
  if (scopeCurrent and safeDraft) { ...s, phase: RecheckingAsk } else s
pure def canFinishRecheck(s: NoticeTap): bool = s.phase == RecheckingAsk
pure def finishRecheck(s: NoticeTap, question: ExactQuestion, scopeCurrent: bool): NoticeTap =
  if (not(s.canceled) and scopeCurrent and exactQuestion(question)) { ...s, phase: ConsumingTap }
  else { ...s, phase: ClosedAsk }
pure def canCancelAsk(s: NoticeTap): bool =
  (s.phase == ReviewingAsk or s.phase == RecheckingAsk or (s.phase == ConsumingTap and s.asks)) and not(s.canceled)
pure def cancelAsk(s: NoticeTap, explicitDismissal: bool): NoticeTap =
  if (s.phase == ReviewingAsk) { ...s, phase: ClosedAsk, canceled: true, releaseRequested: explicitDismissal }
  else { ...s, canceled: true }
type ConsumeEvidence = { acknowledged: bool, scopeCurrent: bool, composerSucceeded: bool }
pure val exactConsume: ConsumeEvidence = { acknowledged: true, scopeCurrent: true, composerSucceeded: true }
pure val consumeEvidenceValues = Set(exactConsume, { ...exactConsume, acknowledged: false },
  { ...exactConsume, scopeCurrent: false }, { ...exactConsume, composerSucceeded: false })
pure def canFinishConsume(s: NoticeTap): bool = s.phase == ConsumingTap
pure def finishConsume(s: NoticeTap, consumeEvidence: ConsumeEvidence): NoticeTap =
  { ...s, spent: consumeEvidence.acknowledged,
    phase: if (not(consumeEvidence.acknowledged and consumeEvidence.scopeCurrent)) ClosedAsk
      else if (not(s.asks)) OpenedList
      else if (consumeEvidence.composerSucceeded) ComposedAsk else ClosedAsk }
type AskFailure = NoAskFailure | ChangedNotice | CouldNotKeep
pure def askFailure(confirmationInProgress: bool, s: NoticeTap): AskFailure =
  if (not(confirmationInProgress and s.asks) or s.phase != ClosedAsk) NoAskFailure
  else if (s.spent) CouldNotKeep else ChangedNotice
pure def alwaysSpentTapIsTerminal(s: NoticeTap): bool =
  s.spent implies s.phase == ClosedAsk or s.phase == OpenedList or s.phase == ComposedAsk
pure def alwaysCompositionAfterConsume(s: NoticeTap): bool = s.phase == ComposedAsk implies s.spent and s.asks
pure def alwaysReleaseRetainsTap(s: NoticeTap): bool = s.releaseRequested implies s.phase == ClosedAsk and s.canceled and not(s.spent)
pure def stepOnlyConsumptionSpends(before: NoticeTap, via: str, after: NoticeTap): bool =
  not(before.spent) and after.spent implies via == "finishConsume"
pure def stepNoCompositionFromRecheck(before: NoticeTap, via: str, after: NoticeTap): bool =
  via == "finishRecheck" implies after.phase != ComposedAsk and not(after.spent)
pure def sometimesAskDrafts(s: NoticeTap): bool = s.phase == ComposedAsk
pure def sometimesConsumedWithoutDraft(s: NoticeTap): bool = s.phase == ClosedAsk and s.spent
pure val weight_confirmAsk = 6
pure val weight_finishRecheck = 9
pure val weight_finishConsume = 6
```
