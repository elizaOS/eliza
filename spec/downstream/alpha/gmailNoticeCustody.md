# AlphaPhone Gmail background notice custody

Alpha `8d44dfe52` installs `apps/app/src/runtime/gmail-background.ts`
under the `AlphaGmail` bridge. It imports Eliza `c518127a`'s
`plugins/plugin-inbox/src/mailbox/background-notices.ts`. The active
consumer is `apps/app/src/prototype/inbox-cloud-adapter.ts`, which
opens ordinary taps and lends explicit Ask reviews to
`own-notice-question.ts`. This model covers the renderer's watch
selection, scoped pending tap and reviewed excerpt. Android's stored
history, scheduler, delivery and tap verification are port boundaries.

## Story: Open the Inbox or ask about the exact notification I tapped

### Watch configuration changes only for a named binding or a deliberately empty selection

The watch is independent of inference. A Cloud client with no selected
grant withdraws the watch. A selected grant configures native with the
matching Cloud credential, user and organization. Absence of the
client, an unknown owner, no organization or a credential mismatch
while a grant is selected leaves native's saved selection for its own
verification. On web these operations are no-ops.

The bridge announces configure settlement even when native configure
or its implicit withdrawal rejects. Direct withdrawal announces only
after success. Starting a grant retirement tries its scoped withdrawal
immediately. Awaiting its settlement retries a failed first withdrawal
once and swallows a failed retry. Listener failure does not change the
previous native result. Native status failure reports unavailable,
whereas web reports web-unavailable.

```quint
type WatchInput = { nativeReady: bool, cloudBound: bool, hasSelection: bool, ownerOrganization: bool, sameCredential: bool }
type WatchAction = KeepWatch | WithdrawWatch | ConfigureWatch
pure val watchValues = Set(
  { nativeReady: true, cloudBound: true, hasSelection: true, ownerOrganization: true, sameCredential: true },
  { nativeReady: true, cloudBound: true, hasSelection: false, ownerOrganization: false, sameCredential: false },
  { nativeReady: true, cloudBound: true, hasSelection: true, ownerOrganization: false, sameCredential: true },
  { nativeReady: true, cloudBound: true, hasSelection: true, ownerOrganization: true, sameCredential: false },
  { nativeReady: false, cloudBound: true, hasSelection: true, ownerOrganization: true, sameCredential: true }
)
pure def decideWatch(watch: WatchInput): WatchAction =
  if (not(watch.nativeReady and watch.cloudBound)) KeepWatch
  else if (not(watch.hasSelection)) WithdrawWatch
  else if (watch.ownerOrganization and watch.sameCredential) ConfigureWatch else KeepWatch
pure def announcesWatchChange(nativeReady: bool, configureCall: bool, succeeded: bool): bool =
  nativeReady and (configureCall or succeeded)
pure def retryScopedRetirement(firstSucceeded: bool, awaited: bool): bool = awaited and not(firstSucceeded)
pure def lawSelectionWithUnknownOwnerIsPreserved(watch: WatchInput): bool =
  watch.hasSelection and not(watch.ownerOrganization and watch.sameCredential) implies decideWatch(watch) == KeepWatch
pure def lawWebNeverChangesWatch(watch: WatchInput): bool = not(watch.nativeReady) implies decideWatch(watch) == KeepWatch
```

### A pending tap opens only the current grant and ordinary opening spends it first

Native returns a pending tap only through the foreground, unlocked
bridge. The shared renderer decoder requires token, grant, credential,
user and generation to be nonempty strings. Optional Ask fields are
checked by the Ask path. The renderer captures its shell and attempt,
checks visibility, credential and user when the pending read answers,
then reads the Cloud accounts. After that await it checks the same
shell, attempt, session and credential and finds the exact readable
grant. A newer pending attempt can supersede an earlier one before
review. This model follows one such attempt; a scope-current fact at the
port carries shell, attempt and connection fences for that stage.

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
type GmailTap = { phase: AskPhase, asks: bool, spent: bool, canceled: bool, releaseRequested: bool }
pure val initial: GmailTap =
  { phase: IdleTap, asks: false, spent: false, canceled: false, releaseRequested: false }
pure def canReadPending(s: GmailTap): bool = s.phase == IdleTap
pure def readPending(s: GmailTap): GmailTap = { ...s, phase: ReadingTap }
type TapEvidence = { validIdentity: bool, sameOwner: bool, scopeCurrent: bool, asks: bool }
pure val exactTap: TapEvidence = { validIdentity: true, sameOwner: true, scopeCurrent: true, asks: true }
pure val tapEvidenceValues = Set(exactTap, { ...exactTap, asks: false }, { ...exactTap, validIdentity: false },
  { ...exactTap, sameOwner: false }, { ...exactTap, scopeCurrent: false })
pure def canAcceptPending(s: GmailTap): bool = s.phase == ReadingTap
pure def acceptPending(s: GmailTap, tapEvidence: TapEvidence): GmailTap =
  if (tapEvidence.validIdentity and tapEvidence.sameOwner and tapEvidence.scopeCurrent)
    { ...s, phase: ReadingGrants, asks: tapEvidence.asks }
  else { ...s, phase: ClosedAsk }
type GrantEvidence = { scopeCurrent: bool, readableGrant: bool, askReady: bool }
pure val exactGrant: GrantEvidence = { scopeCurrent: true, readableGrant: true, askReady: true }
pure val grantEvidenceValues = Set(exactGrant, { ...exactGrant, scopeCurrent: false },
  { ...exactGrant, readableGrant: false }, { ...exactGrant, askReady: false })
pure def canCheckGrants(s: GmailTap): bool = s.phase == ReadingGrants
pure def checkGrants(s: GmailTap, grantEvidence: GrantEvidence): GmailTap =
  if (not(grantEvidence.scopeCurrent and grantEvidence.readableGrant) or (s.asks and not(grantEvidence.askReady))) { ...s, phase: ClosedAsk }
  else { ...s, phase: if (s.asks) ReadingMail else ConsumingTap }
type InitialReply = UnavailableMail | WrongMail | ExactMail
type MailEvidence = { scopeCurrent: bool, initialReply: InitialReply, reviewable: bool }
pure val exactMail: MailEvidence = { scopeCurrent: true, initialReply: ExactMail, reviewable: true }
pure val mailEvidenceValues = Set(exactMail, { ...exactMail, scopeCurrent: false }, { ...exactMail, reviewable: false },
  { ...exactMail, initialReply: UnavailableMail }, { ...exactMail, initialReply: WrongMail })
pure def canOpenAsk(s: GmailTap): bool = s.phase == ReadingMail
pure def openAsk(s: GmailTap, mailEvidence: MailEvidence): GmailTap =
  if (not(mailEvidence.scopeCurrent)) { ...s, phase: ClosedAsk }
  else if (mailEvidence.initialReply == UnavailableMail) { ...s, phase: OpenedList }
  else if (mailEvidence.initialReply == ExactMail and mailEvidence.reviewable) { ...s, phase: ReviewingAsk }
  else { ...s, phase: ClosedAsk }
pure def alwaysAskPhasesHaveAsk(s: GmailTap): bool =
  (s.phase == ReadingMail or s.phase == ReviewingAsk or s.phase == RecheckingAsk or s.phase == ComposedAsk) implies s.asks
pure def sometimesListOpens(s: GmailTap): bool = s.phase == OpenedList
pure val weight_acceptPending = 4
pure val weight_checkGrants = 4
pure val weight_openAsk = 4
```

### Ask rechecks the exact reviewed subject and snippet before consumption

The excerpt carries the message's subject and snippet, each trimmed
and joined by a newline when nonempty, with no body or attachment.
The own-notice review validates its identity and content. The shared
dialog allows explicit editing of the excerpt and refuses a blank or
sensitive excerpt. It displays at most 12,000 UTF-16 units and marks
a longer input as truncated. This is a presentation limit for the
selected excerpt, not an attempt to summarize or truncate a message
body. The confirmation rechecks the underlying unedited selection.

The recheck first requires the same pending Ask token and notice
generation, then the same provider history, message, thread, subject
and snippet from a fresh read. A user cancellation or scope loss
before consumption prevents it. Explicit dialog dismissal requests
release of the question. Passive hide, page retirement, launcher Home
or blur does not request release. A recheck or consume failure reports
the changed notification. Once native acknowledges consumption the
tap is spent. That final step checks the current scope. A Home or
blur during the consume await alone does not stop composition if
the scope is still current. A scope loss or compose failure after
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
pure def canConfirmAsk(s: GmailTap): bool = s.phase == ReviewingAsk
pure def confirmAsk(s: GmailTap, scopeCurrent: bool, safeDraft: bool): GmailTap =
  if (scopeCurrent and safeDraft) { ...s, phase: RecheckingAsk } else s
pure def canFinishRecheck(s: GmailTap): bool = s.phase == RecheckingAsk
pure def finishRecheck(s: GmailTap, question: ExactQuestion, scopeCurrent: bool): GmailTap =
  if (not(s.canceled) and scopeCurrent and exactQuestion(question)) { ...s, phase: ConsumingTap }
  else { ...s, phase: ClosedAsk }
pure def canCancelAsk(s: GmailTap): bool =
  (s.phase == ReviewingAsk or s.phase == RecheckingAsk or (s.phase == ConsumingTap and s.asks)) and not(s.canceled)
pure def cancelAsk(s: GmailTap, explicitDismissal: bool): GmailTap =
  if (s.phase == ReviewingAsk) { ...s, phase: ClosedAsk, canceled: true, releaseRequested: explicitDismissal }
  else { ...s, canceled: true }
type ConsumeEvidence = { acknowledged: bool, scopeCurrent: bool, composerSucceeded: bool }
pure val exactConsume: ConsumeEvidence = { acknowledged: true, scopeCurrent: true, composerSucceeded: true }
pure val consumeEvidenceValues = Set(exactConsume, { ...exactConsume, acknowledged: false },
  { ...exactConsume, scopeCurrent: false }, { ...exactConsume, composerSucceeded: false })
pure def canFinishConsume(s: GmailTap): bool = s.phase == ConsumingTap
pure def finishConsume(s: GmailTap, consumeEvidence: ConsumeEvidence): GmailTap =
  { ...s, spent: consumeEvidence.acknowledged,
    phase: if (not(consumeEvidence.acknowledged and consumeEvidence.scopeCurrent)) ClosedAsk
      else if (not(s.asks)) OpenedList
      else if (consumeEvidence.composerSucceeded) ComposedAsk else ClosedAsk }
type AskFailure = NoAskFailure | ChangedNotice | CouldNotKeep
pure def askFailure(confirmationInProgress: bool, s: GmailTap): AskFailure =
  if (not(confirmationInProgress and s.asks) or s.phase != ClosedAsk) NoAskFailure
  else if (s.spent) CouldNotKeep else ChangedNotice
pure def alwaysSpentTapIsTerminal(s: GmailTap): bool =
  s.spent implies s.phase == ClosedAsk or s.phase == OpenedList or s.phase == ComposedAsk
pure def alwaysCompositionAfterConsume(s: GmailTap): bool = s.phase == ComposedAsk implies s.spent and s.asks
pure def alwaysReleaseRetainsTap(s: GmailTap): bool = s.releaseRequested implies s.phase == ClosedAsk and s.canceled and not(s.spent)
pure def stepOnlyConsumptionSpends(before: GmailTap, via: str, after: GmailTap): bool =
  not(before.spent) and after.spent implies via == "finishConsume"
pure def stepNoCompositionFromRecheck(before: GmailTap, via: str, after: GmailTap): bool =
  via == "finishRecheck" implies after.phase != ComposedAsk and not(after.spent)
pure def sometimesAskDrafts(s: GmailTap): bool = s.phase == ComposedAsk
pure def sometimesConsumedWithoutDraft(s: GmailTap): bool = s.phase == ClosedAsk and s.spent
pure val weight_confirmAsk = 6
pure val weight_finishRecheck = 9
pure val weight_finishConsume = 6
```

Exact producer fixtures are `plugins/plugin-inbox/test/mailbox/background-notices.test.ts`
at the Eliza pin and `test/browser/gmail-notice-question.spec.ts` at the
Alpha pin. The browser fixture supplies a synthetic native tap and Cloud
answer to actual renderer code. It checks subject/snippet custody,
explicit dismissal, changed history and owner change. Android delivery
and credentials are outside that fixture.
