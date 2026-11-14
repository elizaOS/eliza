# Grace bill email evidence

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` reads a generic bill through `apps/app/host/bill-email-extract.ts` and `evidence-quotes.ts`. The pinned Eliza managed mail port at `7743504b7c936a764b3938a44cad918808b621df` provides the host-only `authenticationResults` values in header order. This contract covers the generic extractor when the host invokes it. Configured bill profiles, PDF discovery, product any-sender enablement, payment, and native browsing have separate owners.

## Story: Ask the model about a consented bill email only after checking its sender and contents

### The topmost receiving-server result and the complete body govern admission

The host needs explicit consent, a nonblank string body of at most 200,000 JavaScript UTF-16 units, a syntactically usable From domain, the receiving server's topmost result and at least one aligned passing DKIM signing domain. The default allowed `authserv-id` is `mx.google.com`. A `header.i` signing identity uses the part after its final `@`. DKIM clauses with mismatched registrable domains or untrusted server names do not count. The parsed host classifications supply these observations. Lower header results never substitute for the first. An aligned header proves a comparison against the supplied header, which the mail port must obtain in authoritative order. The extractor cannot establish the provenance of a sender-written topmost value that presents itself as the receiving server. Grace's any-sender screen records this limitation and the enabled path still needs user confirmation of the sender and pay link.

A message with a recognized code, sensitive text outside the permitted probe exclusions, or no positive labelled amount is kept from the model. The probe checks subject, body and button words together, then excludes URLs and account lines for its general secret test. The request separately redacts subject, body, and button words with the session redactor. A button contributes its normalized words and HTTPS origin, with no username, password or URL path in the button projection. Discovery of the word spans, registrable domains, credential matches and matching Google-supplied header text remains at the parsing boundary.

```quint
type EmailGate = { consented: bool, bodyString: bool, bodyNonblank: bool, bodyUnits: int, fromDomain: str, firstResultPresent: bool, trustedFirstAuthserv: bool, firstPassedDomains: List[str], holdsCode: bool, positiveLabelledAmount: bool }
pure def emailSenderChecked(mail: EmailGate): bool =
  mail.fromDomain != "" and mail.firstResultPresent and mail.trustedFirstAuthserv and mail.firstPassedDomains.includes(mail.fromDomain)
pure def mayReadBillEmail(mail: EmailGate): bool =
  mail.consented and mail.bodyString and mail.bodyNonblank and mail.bodyUnits > 0 and mail.bodyUnits <= 200000 and emailSenderChecked(mail) and not(mail.holdsCode) and mail.positiveLabelledAmount
pure def lawNoConsentNeverCallsModel(mail: EmailGate): bool = not(mail.consented) implies not(mayReadBillEmail(mail))
pure def lawCodeNeverCallsModel(mail: EmailGate): bool = mail.holdsCode implies not(mayReadBillEmail(mail))
pure def lawFirstHeaderCannotBeReplaced(mail: EmailGate): bool =
  (not(mail.firstResultPresent and mail.trustedFirstAuthserv) or not(mail.firstPassedDomains.includes(mail.fromDomain))) implies not(mayReadBillEmail(mail))
pure def lawOversizedEmailNeverCallsModel(mail: EmailGate): bool = mail.bodyUnits > 200000 implies not(mayReadBillEmail(mail))
pure val eligibleMail: EmailGate = { consented: true, bodyString: true, bodyNonblank: true, bodyUnits: 180, fromDomain: "biller.example", firstResultPresent: true, trustedFirstAuthserv: true, firstPassedDomains: List("biller.example"), holdsCode: false, positiveLabelledAmount: true }
pure val mailValues = Set(eligibleMail, { ...eligibleMail, bodyUnits: 200000 }, { ...eligibleMail, bodyUnits: 200001 }, { ...eligibleMail, consented: false }, { ...eligibleMail, bodyString: false }, { ...eligibleMail, bodyNonblank: false }, { ...eligibleMail, trustedFirstAuthserv: false }, { ...eligibleMail, firstResultPresent: false }, { ...eligibleMail, firstPassedDomains: List("mail.example") }, { ...eligibleMail, holdsCode: true }, { ...eligibleMail, positiveLabelledAmount: false })
```

### A failure or malformed model reply is distinct from a nonbill and from cancellation

The decoder accepts a JSON object or its JSON text. It needs exactly `bill`, `company`, `amount`, `dueDate`, `accountLast4`, and `payLink`. The first is `yes` or `no`. Each fact has exactly the string fields `value` and `quote`. They have at most 300 and 400 UTF-16 units respectively. After trimming, either both are empty or both are nonempty. Invalid JSON or shape belongs to the failure path. An admitted model rejection or malformed reply calls the optional failure callback and returns no bill. If the signal was aborted when the failure was caught, the extractor propagates the signal reason or the failure and skips the callback. A successful `no` returns no bill without a failure callback. A successful `yes` goes to evidence checking; this catch path does not invalidate a successful reply merely because the signal is now aborted.

```quint
type ReplyField = { fieldObject: bool, keyCount: int, valueString: bool, quoteString: bool, valueUnits: int, quoteUnits: int, valueNonblank: bool, quoteNonblank: bool }
type BillReply = { replyObject: bool, keyCount: int, bill: str, company: ReplyField, amount: ReplyField, dueDate: ReplyField, account: ReplyField, payLink: ReplyField }
type MailModelResult = MailModelSkipped | MailModelNotBill | MailModelFailed | MailModelAborted | MailModelEvidence
pure def replyFieldValid(candidateFact: ReplyField): bool = candidateFact.fieldObject and candidateFact.keyCount == 2 and candidateFact.valueString and candidateFact.quoteString and candidateFact.valueUnits >= 0 and candidateFact.valueUnits <= 300 and candidateFact.quoteUnits >= 0 and candidateFact.quoteUnits <= 400 and candidateFact.valueNonblank == candidateFact.quoteNonblank
pure def replyValid(reply: BillReply): bool = reply.replyObject and reply.keyCount == 6 and (reply.bill == "yes" or reply.bill == "no") and replyFieldValid(reply.company) and replyFieldValid(reply.amount) and replyFieldValid(reply.dueDate) and replyFieldValid(reply.account) and replyFieldValid(reply.payLink)
pure def modelReplyGate(mail: EmailGate, reply: BillReply, callSucceeded: bool, signalAborted: bool): MailModelResult =
  if (not(mayReadBillEmail(mail))) MailModelSkipped
  else if (not(callSucceeded and replyValid(reply))) (if (signalAborted) MailModelAborted else MailModelFailed)
  else if (reply.bill == "no") MailModelNotBill
  else MailModelEvidence
pure def lawInvalidReplyNeverAddsEvidence(mail: EmailGate, reply: BillReply, callSucceeded: bool, signalAborted: bool): bool =
  not(replyValid(reply)) implies modelReplyGate(mail, reply, callSucceeded, signalAborted) != MailModelEvidence
pure def lawAbortedRejectionSkipsFailureCallback(mail: EmailGate, reply: BillReply, callSucceeded: bool): bool =
  mayReadBillEmail(mail) and not(callSucceeded and replyValid(reply)) implies modelReplyGate(mail, reply, callSucceeded, true) == MailModelAborted
pure val emptyFact: ReplyField = { fieldObject: true, keyCount: 2, valueString: true, quoteString: true, valueUnits: 0, quoteUnits: 0, valueNonblank: false, quoteNonblank: false }
pure val validYes: BillReply = { replyObject: true, keyCount: 6, bill: "yes", company: emptyFact, amount: emptyFact, dueDate: emptyFact, account: emptyFact, payLink: emptyFact }
pure val replyValues = Set(validYes, { ...validYes, bill: "no" }, { ...validYes, bill: "maybe" }, { ...validYes, keyCount: 7 }, { ...validYes, company: { ...emptyFact, valueUnits: 301 } }, { ...validYes, amount: { ...emptyFact, quoteUnits: 401 } }, { ...validYes, dueDate: { ...emptyFact, valueNonblank: true } })
```

## Story: Build a checked bill from evidence in the words the host sent

### Only unique anchored facts may determine the company and amount

Each nonempty quote is whitespace-normalized. It must occur once, including overlapping occurrences, in the normalized redacted request source assembled from subject, body and visible button lines. The normalized quote must contain the normalized value, after removing its one leading `$` on the inclusion check. A missing quote is absent. A present rejected quote is marked uncertain. Company is required, nonempty, at most 120 units and free of ASCII control characters. The parsed amount must be positive and listed under a recognized amount label in its quote. The extractor compares it against the set of all explicit due amounts in the raw body when at least one exists. When none exists, it compares against all recognized labelled amounts instead. No amount in the chosen set is allowed to disagree. The configured profile's integer rules are separate. This extractor uses the pinned JavaScript amount parser before checking positive and equal amounts; the model covers exact integer cents and leaves out-of-range JavaScript numeric parsing as an explicit refinement case. Publish a checked bill only after the model was admitted and its successful bill reply has passed these evidence checks.

```quint
type Quote = { quotePresent: bool, occurrences: int, carriesValue: bool }
type EvidenceDraft = { company: Quote, companyNonempty: bool, companyUnits: int, companyControls: bool, amount: Quote, amountParsed: bool, amountMinor: int, amountInQuote: bool, dueAmounts: List[int], labelledAmounts: List[int] }
pure def verifiedQuote(quote: Quote): bool = quote.quotePresent and quote.occurrences == 1 and quote.carriesValue
pure def quoteUncertain(quote: Quote): bool = quote.quotePresent and not(verifiedQuote(quote))
pure def amountsAgree(amountMinor: int, dueAmounts: List[int], labelledAmounts: List[int]): bool =
  if (dueAmounts.length() > 0) dueAmounts.every(value => value == amountMinor) else labelledAmounts.every(value => value == amountMinor)
pure def verifiedBill(evidence: EvidenceDraft): bool =
  verifiedQuote(evidence.company) and evidence.companyNonempty and evidence.companyUnits > 0 and evidence.companyUnits <= 120 and not(evidence.companyControls) and
  verifiedQuote(evidence.amount) and evidence.amountParsed and evidence.amountMinor > 0 and evidence.amountInQuote and amountsAgree(evidence.amountMinor, evidence.dueAmounts, evidence.labelledAmounts)
pure def mayPublishBill(mail: EmailGate, reply: BillReply, callSucceeded: bool, signalAborted: bool, evidence: EvidenceDraft): bool =
  modelReplyGate(mail, reply, callSucceeded, signalAborted) == MailModelEvidence and verifiedBill(evidence)
pure def lawNoCheckedBillWithoutAdmittedCall(mail: EmailGate, reply: BillReply, callSucceeded: bool, signalAborted: bool, evidence: EvidenceDraft): bool =
  mayPublishBill(mail, reply, callSucceeded, signalAborted, evidence) implies mayReadBillEmail(mail) and replyValid(reply) and verifiedBill(evidence) and callSucceeded and reply.bill == "yes"
pure def lawDuplicateQuoteCannotSupplyCompany(evidence: EvidenceDraft): bool = evidence.company.occurrences > 1 implies not(verifiedBill(evidence))
pure def lawExplicitDueAmountHasPriority(evidence: EvidenceDraft): bool =
  verifiedBill(evidence) and evidence.dueAmounts.length() > 0 implies evidence.dueAmounts.every(value => value == evidence.amountMinor)
pure def lawFallbackUsesAllLabelledAmounts(evidence: EvidenceDraft): bool =
  verifiedBill(evidence) and evidence.dueAmounts.length() == 0 implies evidence.labelledAmounts.every(value => value == evidence.amountMinor)
pure val oneQuote: Quote = { quotePresent: true, occurrences: 1, carriesValue: true }
pure val absentQuote: Quote = { quotePresent: false, occurrences: 0, carriesValue: false }
pure val exampleEvidence: EvidenceDraft = { company: oneQuote, companyNonempty: true, companyUnits: 12, companyControls: false, amount: oneQuote, amountParsed: true, amountMinor: 8420, amountInQuote: true, dueAmounts: List(8420), labelledAmounts: List(8420, 7420) }
pure val evidenceValues = Set(exampleEvidence, { ...exampleEvidence, company: { ...oneQuote, occurrences: 2 } }, { ...exampleEvidence, companyUnits: 121 }, { ...exampleEvidence, amountInQuote: false }, { ...exampleEvidence, dueAmounts: List(8420, 9900) }, { ...exampleEvidence, dueAmounts: List() }, { ...exampleEvidence, dueAmounts: List(), labelledAmounts: List(8420, 8420) })
```

### An optional field keeps uncertainty instead of inventing evidence

A quoted due date is used only if the shared calendar parser supplies a valid day. A quoted account ending needs four digits and a confirming quote. The host recovers a full account number only when exactly one distinct number on a non-funding account or customer line of the raw body matches the ending. With zero or multiple distinct matches, the result contains only the ending. The model-facing request does not receive that full account number. An accepted link quote needs an HTTPS URL without credentials that was written in the message or coincides with the origin emitted for a visible button. The output retains only its origin. Anchor flags show which quotes actually passed the evidence match, even when their value is later refused. A nonempty rejected optional value is marked uncertain. A valid ending with no unique raw match is still a valid ending. Company/sender alignment is advisory after extraction. It adds company uncertainty without changing a bill's quoted company. The checked result uses USD and two fractional digits. The host's `bill-email:` source reference is derived from the message external ID, normalized From address and full raw body. Calendar, exact URL acceptance, source hashing and raw-body extraction supply evidence to this model.

```quint
type OptionalEvidence = { dueDate: Quote, calendarDay: bool, account: Quote, fourDigitEnding: bool, quoteShowsEnding: bool, distinctMatchingNumbers: int, payLink: Quote, httpsUncredentialed: bool, writtenOrButton: bool, companySenderAligned: bool }
type AccountDetail = AccountAbsent | EndingOnly | FullNumberFromEmail
type OptionalProjection = { dueDate: bool, account: AccountDetail, linkOrigin: bool, anchorNames: List[str], unsure: List[str] }
pure def accountEvidenceIsValid(optional: OptionalEvidence): bool = verifiedQuote(optional.account) and optional.fourDigitEnding and optional.quoteShowsEnding
pure def accountProjection(optional: OptionalEvidence): AccountDetail =
  if (not(accountEvidenceIsValid(optional))) AccountAbsent
  else if (optional.distinctMatchingNumbers == 1) FullNumberFromEmail
  else EndingOnly
pure def optionalProjection(optional: OptionalEvidence): OptionalProjection = {
  val validDate = verifiedQuote(optional.dueDate) and optional.calendarDay
  val validLink = verifiedQuote(optional.payLink) and optional.httpsUncredentialed and optional.writtenOrButton
  val whenUncertain = if (optional.dueDate.quotePresent and not(validDate)) List("dueDate") else List()
  val whenAccountUncertain = if (optional.account.quotePresent and not(accountEvidenceIsValid(optional))) whenUncertain.append("accountLast4") else whenUncertain
  val whenLinkUncertain = if (optional.payLink.quotePresent and not(validLink)) whenAccountUncertain.append("payLink") else whenAccountUncertain
  val anchored = (if (verifiedQuote(optional.dueDate)) List("dueDate") else List())
  val withAccount = if (verifiedQuote(optional.account)) anchored.append("accountLast4") else anchored
  val withLink = if (verifiedQuote(optional.payLink)) withAccount.append("payLink") else withAccount
  { dueDate: validDate, account: accountProjection(optional), linkOrigin: validLink, anchorNames: withLink, unsure: if (optional.companySenderAligned) whenLinkUncertain else whenLinkUncertain.append("company") }
}
pure def lawFullAccountRequiresUniqueRawMatch(optional: OptionalEvidence): bool =
  accountProjection(optional) == FullNumberFromEmail implies accountEvidenceIsValid(optional) and optional.distinctMatchingNumbers == 1
pure def lawInvalidUrlCannotBecomeOrigin(optional: OptionalEvidence): bool =
  (not(optional.httpsUncredentialed) or not(optional.writtenOrButton)) implies not(optionalProjection(optional).linkOrigin)
pure def lawNoOptionalQuoteDoesNotInventValues(optional: OptionalEvidence): bool =
  (not(optional.dueDate.quotePresent) implies not(optionalProjection(optional).dueDate)) and
  (not(optional.account.quotePresent) implies optionalProjection(optional).account == AccountAbsent) and
  (not(optional.payLink.quotePresent) implies not(optionalProjection(optional).linkOrigin))
pure val optionalFields: OptionalEvidence = { dueDate: oneQuote, calendarDay: true, account: oneQuote, fourDigitEnding: true, quoteShowsEnding: true, distinctMatchingNumbers: 1, payLink: oneQuote, httpsUncredentialed: true, writtenOrButton: true, companySenderAligned: true }
pure val optionalValues = Set(optionalFields, { ...optionalFields, distinctMatchingNumbers: 0 }, { ...optionalFields, distinctMatchingNumbers: 2 }, { ...optionalFields, fourDigitEnding: false }, { ...optionalFields, calendarDay: false }, { ...optionalFields, httpsUncredentialed: false }, { ...optionalFields, writtenOrButton: false }, { ...optionalFields, companySenderAligned: false }, { ...optionalFields, dueDate: absentQuote, account: absentQuote, payLink: absentQuote })
```
