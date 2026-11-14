# Grace website mail challenges

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` ships general website guidance with an account-bound Gmail read port. The release entry point is `apps/app/host/local-agent-gateway.ts:539–561`. This contract covers `website-guide-helper.ts`, `guide-code.ts`, `shared/emailed-code.ts`, and `src/website-guide.ts`. Eliza `7743504b7c936a764b3938a44cad918808b621df` owns the managed read port and browser actuator. The [Cloud host](../cloudHost.md) owns the connection grant, [manual activity](websiteManualActivity.md) owns validation of the browser's evidence, and [website guidance](websiteGuide.md) owns the generic task and browser action boundary. [Invoice evidence](billEmailEvidence.md) and [configured bill verification](billVerification.md) are separate flows.

## Story: Help with a challenge that the person asked this website to send

### The observed page establishes the kind of challenge and the start of the attempt

A readable page can ask for a code only when its controls yield exactly one empty and enabled one-time field among at most 1000 candidates, and that field has both selectors. The current guidance must pick that field. A protected field requires a one-time-code human verification decision. An ordinary field requires a human review with the same control reference. With no unique field, recognized emailed-link wording and a human review, needs-help, wait or human-verification decision select the link path. All other decisions pass through.

The host notes a request after a look on a page that had no challenge. A newly observed event with a string ID absent from that look and an origin matching the current page qualifies. A different page key after pointing out an eligible request control also qualifies. An already noted request keeps its original timestamp. On a no-challenge page, the host clears its offer and mail-wait record. If a code was used, it also resets the request and the pointer and starts a fresh watch. A new task goal resets the attempt. A phone-coaching refusal survives a no-challenge look.

```quint
type ChallengePage = { readable: bool, candidates: int, eligibleFields: int, namedField: bool, protectedField: bool, decision: str, oneTimeCategory: bool, exactRef: bool, linkWords: bool }
pure def uniqueCodeField(page: ChallengePage): bool = page.candidates >= 1 and page.candidates <= 1000 and page.eligibleFields == 1 and page.namedField
pure def mailChallenge(page: ChallengePage): str =
  if (not(page.readable)) "unchanged"
  else if (uniqueCodeField(page) and (if (page.protectedField) page.decision == "human-verification" and page.oneTimeCategory else page.decision == "human-review" and page.exactRef)) "code"
  else if (not(uniqueCodeField(page)) and page.linkWords and Set("human-review", "needs-help", "wait", "human-verification").contains(page.decision)) "link"
  else "unchanged"
type RequestWatch = { watching: bool, since: int, ids: List[str], requested: bool, pointed: bool, pointedPage: str, requestWords: bool, used: bool, coached: bool }
type RequestEvent = { idIsString: bool, id: str, origin: str }
pure def mailRequestNoted(watch: RequestWatch, events: List[RequestEvent], origin: str, pageKey: str): bool =
  watch.requested or (watch.watching and (events.some(submit => submit.idIsString and submit.origin == origin and not(watch.ids.includes(submit.id))) or (watch.pointed and watch.pointedPage != pageKey and watch.requestWords)))
pure def watchWithoutChallenge(watch: RequestWatch, events: List[RequestEvent], at: int): RequestWatch =
  if (watch.requested and not(watch.used)) watch
  else { ...watch, watching: true, since: at, ids: events.foldl(List(), (seenIds, submit) => if (submit.idIsString and not(seenIds.includes(submit.id))) seenIds.append(submit.id) else seenIds), requested: false, used: false, pointed: watch.pointed and not(watch.used) }
pure def lawCodeUsesTheMatchingDecision(page: ChallengePage): bool =
  mailChallenge(page) == "code" implies page.readable and uniqueCodeField(page) and (if (page.protectedField) page.oneTimeCategory and page.decision == "human-verification" else page.exactRef and page.decision == "human-review")
pure def lawRequestRequiresPriorWatch(watch: RequestWatch, events: List[RequestEvent], origin: str, pageKey: str): bool =
  not(watch.watching or watch.requested) implies not(mailRequestNoted(watch, events, origin, pageKey))
pure def lawNotedRequestKeepsTimeUntilUsed(watch: RequestWatch, events: List[RequestEvent], at: int): bool =
  watch.requested and not(watch.used) implies watchWithoutChallenge(watch, events, at).since == watch.since
pure def lawLookingWithoutChallengeKeepsCoaching(watch: RequestWatch, events: List[RequestEvent], at: int): bool =
  watchWithoutChallenge(watch, events, at).coached == watch.coached
pure val codePage: ChallengePage = { readable: true, candidates: 2, eligibleFields: 1, namedField: true, protectedField: true, decision: "human-verification", oneTimeCategory: true, exactRef: false, linkWords: false }
pure val pageValues = Set(codePage, { ...codePage, readable: false }, { ...codePage, candidates: 1001 }, { ...codePage, oneTimeCategory: false }, { ...codePage, protectedField: false, decision: "human-review", exactRef: true }, { ...codePage, eligibleFields: 0, decision: "wait", linkWords: true }, { ...codePage, eligibleFields: 2, decision: "wait", linkWords: true }, { ...codePage, namedField: false })
pure val openWatch: RequestWatch = { watching: true, since: 100, ids: List("prior"), requested: false, pointed: false, pointedPage: "earlier", requestWords: false, used: false, coached: false }
pure val watchValues = Set(openWatch, { ...openWatch, watching: false }, { ...openWatch, requested: true }, { ...openWatch, requested: true, used: true, coached: true }, { ...openWatch, pointed: true, requestWords: true })
pure val eventsValues = Set(List(), List({ idIsString: true, id: "prior", origin: "site" }), List({ idIsString: true, id: "new", origin: "site" }), List({ idIsString: false, id: "new", origin: "site" }), List({ idIsString: true, id: "new", origin: "other" }))
pure val originValues = Set("site", "other")
pure val pageKeyValues = Set("earlier", "later")
pure val atValues = Set(0, 50, 100, 150)
```

### The host checks the present origin and account before mail lookup

The first applicable condition determines the response. A coached or used attempt stays manual. Without a mail port the original decision is returned. A missing mailbox first prompts for email once. An email without an approved connection then stays manual. The site check uses the present page origin, or the binding if the origin cannot be read. A blocked or look-alike site stops and an absent or failed safety decision stays manual. A fresh request and a recipient verdict other than a definite mismatch are required. The masked-address parser considers visible pieces in order and returns unstated when no masked local part was displayed. Unstated permits lookup. Owner denial raises the typed task authorization error. An ordinary owner-check or mail-port construction failure stays manual. The lookup calls the managed read port using the current task actor and the confirmed account ID.

```quint
type MailScope = { coached: bool, used: bool, mailPort: bool, heldEmail: bool, askedMail: bool, confirmedConnection: bool, safety: str, requested: bool, recipient: str, owner: str }
pure def mailScope(scope: MailScope): str =
  if (scope.coached) "on-call"
  else if (scope.used) "used"
  else if (not(scope.mailPort)) "unchanged"
  else if (not(scope.heldEmail) and not(scope.askedMail)) "ask-email"
  else if (not(scope.confirmedConnection)) "no-mail"
  else if (scope.safety == "blocked" or scope.safety == "lookalike") "site-threat"
  else if (scope.safety != "no-known-threat") "site-unchecked"
  else if (not(scope.requested)) "no-request"
  else if (scope.recipient == "mismatch") "wrong-address"
  else if (scope.owner == "denied") "TASK_UNAUTHORIZED"
  else if (scope.owner != "current") "mail-failed"
  else "read-account"
pure def lawReadNeedsSiteAndOwner(scope: MailScope): bool =
  mailScope(scope) == "read-account" implies scope.mailPort and scope.confirmedConnection and scope.safety == "no-known-threat" and scope.requested and scope.recipient != "mismatch" and scope.owner == "current"
pure def lawPhoneCoachingTakesPrecedence(scope: MailScope): bool =
  scope.coached implies mailScope(scope) == "on-call"
pure val confirmedScope: MailScope = { coached: false, used: false, mailPort: true, heldEmail: true, askedMail: true, confirmedConnection: true, safety: "no-known-threat", requested: true, recipient: "unstated", owner: "current" }
pure val scopeValues = Set(confirmedScope, { ...confirmedScope, coached: true, used: true }, { ...confirmedScope, used: true }, { ...confirmedScope, mailPort: false }, { ...confirmedScope, heldEmail: false, askedMail: false, confirmedConnection: false }, { ...confirmedScope, confirmedConnection: false }, { ...confirmedScope, safety: "blocked" }, { ...confirmedScope, safety: "lookalike" }, { ...confirmedScope, safety: "unavailable" }, { ...confirmedScope, requested: false }, { ...confirmedScope, recipient: "mismatch" }, { ...confirmedScope, owner: "denied" }, { ...confirmedScope, owner: "unavailable" })
```

## Story: Choose fresh message evidence and show exactly what the person can act on

### Code and link candidates follow distinct sender and freshness policies

The search asks for up to five messages on the first page only. The lower search bound is the later of the attempt start and fifteen minutes before now, less thirty seconds, rounded down to whole seconds. A message needs a readable time no earlier than thirty seconds before the attempt, no later than thirty seconds in the future, and at most fifteen minutes old. Code checks both the listed time and the detail time. Links check the listed time.

The managed port verifies the returned detail identity. A code candidate has matching detail identity and a string body, yields a high-confidence single code from the parser, and has a passing topmost Google sender authentication result aligned to the sender. An authenticated site-domain sender qualifies. A reviewed, authenticated vendor also qualifies when the message names the site. The newest qualifying code wins, with candidate order breaking an equal-time tie. A different qualifying code strictly less than a minute older makes the answer ambiguous. The selected code must be four through twelve ASCII alphanumeric characters to offer fill. An unqualified sender reporting a high-confidence code can cause an unchecked-sender notice when no qualifying selection exists. The code poll checks cancellation before listing and after details. A list failure rejects the poll; a detail read failure is ignored by that code poll. The model receives already parsed confidence, shape and authenticated-domain evidence and compares opaque fixture identities for equality.

An emailed link needs the authenticated site-domain sender, with no vendor exception. The link is credential-free HTTPS and survives look-alike, displayed-label and sender-domain checks. Plain-text URLs and eligible HTML anchors feed the same assessment. The host offers the first candidate only if all qualifying links collapse to one exact href, even if several messages carried it. With no unique selection, a relevant unauthenticated candidate yields an unchecked result. The link lookup propagates search and detail failures to guidance and does not itself receive the code poll's abort signal.

```quint
type ChallengeCode = { listedTimeValid: bool, listedAt: int, detailTimeValid: bool, detailAt: int, sameId: bool, bodyRead: bool, highConfidence: bool, sender: str, codeIdentity: int, fillable: bool }
type CodeChoice = { found: bool, chosen: ChallengeCode }
pure def freshTime(valid: bool, at: int, since: int, now: int): bool =
  valid and since - 30000 <= at and at <= now + 30000 and now - at <= 900000
pure def searchBoundMs(since: int, now: int): int = (if (since >= now - 900000) since else now - 900000) - 30000
pure def searchAfterSeconds(since: int, now: int): int = {
  val millis = searchBoundMs(since, now)
  if (millis < 0 and millis % 1000 != 0) millis / 1000 - 1 else millis / 1000
}
pure def codeCandidate(codeEntry: ChallengeCode, since: int, now: int): bool =
  codeEntry.sameId and codeEntry.bodyRead and codeEntry.highConfidence and (codeEntry.sender == "site" or codeEntry.sender == "reviewed-vendor") and freshTime(codeEntry.listedTimeValid, codeEntry.listedAt, since, now) and freshTime(codeEntry.detailTimeValid, codeEntry.detailAt, since, now)
pure def uncheckedCode(codeEntry: ChallengeCode, since: int, now: int): bool =
  codeEntry.highConfidence and codeEntry.sender == "unknown" and freshTime(codeEntry.listedTimeValid, codeEntry.listedAt, since, now)
pure def newestCode(items: List[ChallengeCode], since: int, now: int): CodeChoice =
  items.foldl({ found: false, chosen: codeSample }, (best, codeEntry) =>
    if (codeCandidate(codeEntry, since, now) and (not(best.found) or codeEntry.detailAt > best.chosen.detailAt)) { found: true, chosen: codeEntry } else best)
pure def clashingCode(items: List[ChallengeCode], best: ChallengeCode, since: int, now: int): bool =
  items.some(codeEntry => codeCandidate(codeEntry, since, now) and best.detailAt - codeEntry.detailAt < 60000 and best.codeIdentity != codeEntry.codeIdentity)
pure def projectCodeResult(found: bool, clashing: bool, fillable: bool, unchecked: bool, cancelled: bool, searchFailed: bool): str =
  if (cancelled) "cancelled"
  else if (searchFailed) "mail-failed"
  else if (not(found)) (if (unchecked) "unchecked" else "none")
  else if (clashing) "ambiguous"
  else if (not(fillable)) "type-it"
  else "ready"
pure def selectMailCode(items: List[ChallengeCode], since: int, now: int): str = {
  val best = newestCode(items, since, now)
  projectCodeResult(best.found, clashingCode(items, best.chosen, since, now), best.chosen.fillable, items.some(codeEntry => uncheckedCode(codeEntry, since, now)), false, false)
}
type ChallengeLink = { listedTimeValid: bool, listedAt: int, siteSender: bool, passedAuthentication: bool, approvedHref: bool, hrefIdentity: int }
type LinkChoice = { found: bool, firstIdentity: int, multiple: bool, unchecked: bool }
pure def considerLink(choice: LinkChoice, entry: ChallengeLink, since: int, now: int): LinkChoice =
  if (not(entry.siteSender and entry.approvedHref and freshTime(entry.listedTimeValid, entry.listedAt, since, now))) choice
  else if (not(entry.passedAuthentication)) { ...choice, unchecked: true }
  else if (not(choice.found)) { ...choice, found: true, firstIdentity: entry.hrefIdentity }
  else { ...choice, multiple: choice.multiple or choice.firstIdentity != entry.hrefIdentity }
pure def selectMailLink(links: List[ChallengeLink], since: int, now: int): str = {
  val choice = links.foldl({ found: false, firstIdentity: 0, multiple: false, unchecked: false }, (seen, entry) => considerLink(seen, entry, since, now))
  if (choice.found and not(choice.multiple)) "ready" else if (choice.unchecked) "unchecked" else "none"
}
pure def lawSearchWindowCoversFreshTime(valid: bool, at: int, since: int, now: int): bool =
  freshTime(valid, at, since, now) implies searchBoundMs(since, now) <= at
pure def lawReadyCodeIsFillableAndUncontested(found: bool, clashing: bool, fillable: bool, unchecked: bool, cancelled: bool, searchFailed: bool): bool =
  projectCodeResult(found, clashing, fillable, unchecked, cancelled, searchFailed) == "ready" implies found and not(clashing) and fillable and not(cancelled or searchFailed)
pure def lawUnauthenticatedLinkCannotBecomeFirst(choice: LinkChoice, entry: ChallengeLink, since: int, now: int): bool =
  not(entry.passedAuthentication or choice.found) implies not(considerLink(choice, entry, since, now).found)
pure val codeSample: ChallengeCode = { listedTimeValid: true, listedAt: 100000, detailTimeValid: true, detailAt: 100000, sameId: true, bodyRead: true, highConfidence: true, sender: "site", codeIdentity: 1, fillable: true }
pure val linkSample: ChallengeLink = { listedTimeValid: true, listedAt: 100000, siteSender: true, passedAuthentication: true, approvedHref: true, hrefIdentity: 1 }
pure val itemsValues = Set(List(), List(codeSample), List({ ...codeSample, sender: "unknown" }), List(codeSample, { ...codeSample, codeIdentity: 2, detailAt: 99999 }), List(codeSample, { ...codeSample, codeIdentity: 2, detailAt: 40000 }), List({ ...codeSample, fillable: false }))
pure val linksValues = Set(List(), List(linkSample), List(linkSample, linkSample), List(linkSample, { ...linkSample, hrefIdentity: 2 }), List({ ...linkSample, passedAuthentication: false }), List({ ...linkSample, siteSender: false }))
pure val choiceValues = Set({ found: false, firstIdentity: 0, multiple: false, unchecked: false }, { found: true, firstIdentity: 1, multiple: false, unchecked: true })
pure val codeEntryValues = Set(codeSample, { ...codeSample, sender: "unknown" }, { ...codeSample, sender: "reviewed-vendor" }, { ...codeSample, listedTimeValid: false }, { ...codeSample, sameId: false }, { ...codeSample, detailTimeValid: false })
pure val bestValues = Set(codeSample, { ...codeSample, codeIdentity: 2, detailAt: 40000 })
pure val entryValues = Set(linkSample, { ...linkSample, passedAuthentication: false }, { ...linkSample, approvedHref: false }, { ...linkSample, siteSender: false }, { ...linkSample, hrefIdentity: 2 })
pure val sinceValues = Set(70000, 100000, 130001)
pure val nowValues = Set(70000, 100000, 1000000, 1000001)
```

### Waiting and outward decisions expose different data for codes and links

An unchanged page waiting for mail rereads mail and reuses the last guidance decision without replanning. A changed or unreadable page leaves that path. The host projects a wait every ten seconds while the attempt is under two minutes old. At or after the deadline, absent code becomes manual and absent link becomes open-it-yourself. An unchecked or ambiguous code, an unfillable code or an unchecked link goes straight to manual guidance. The code helper returns a cancelled poll through the same time-based fallback as an empty result.

A code offer carries site and sender and two opaque keys; the code stays host-private and the helper remembers it in the existing request redactor. A repeated selection of the same message and code keeps both outstanding keys. The code is absent from the panel decision and the operation evidence, which records identifiers, status, time and capability. The panel link intentionally receives the checked address with its query and fragment, plus sender and site, for opening only after Yes. The public decoder requires HTTPS without credentials and limits site and sender labels to 120 and 254 units after trimming. The two code keys require lowercase 64-digit hex, with a `code-call:` prefix for the phone key. The model represents formats and fields, using no raw code or link contents.

```quint
type MailPanel = { kind: str, site: bool, sender: bool, codeKeys: bool, href: bool }
pure def mailPanel(kind: str, labelsValid: bool, offerKeyValid: bool, callKeyValid: bool, httpsHref: bool, noCredentials: bool): MailPanel =
  if (kind == "code-offer" and labelsValid and offerKeyValid and callKeyValid) { kind: kind, site: true, sender: true, codeKeys: true, href: false }
  else if (kind == "link-offer" and labelsValid and httpsHref and noCredentials) { kind: kind, site: true, sender: true, codeKeys: false, href: true }
  else { kind: "unavailable", site: false, sender: false, codeKeys: false, href: false }
pure def mailWait(link: bool, result: str, since: int, now: int): str =
  if (result == "ready") (if (link) "link-offer" else "code-offer")
  else if (result == "mail-failed") "mail-failed"
  else if (link and (result == "unchecked" or now - since >= 120000)) "link-yourself"
  else if (link) "link-waiting"
  else if (result == "unchecked") "unchecked-sender"
  else if (result == "ambiguous" or result == "type-it") result
  else if (now - since < 120000) "waiting"
  else "no-code"
pure val mailWaitHintMs = 10000
pure def reuseWaitingLook(waiting: bool, readable: bool, samePage: bool): bool = waiting and readable and samePage
pure def lawCodePanelHasOnlyMetadata(kind: str, labelsValid: bool, offerKeyValid: bool, callKeyValid: bool, httpsHref: bool, noCredentials: bool): bool =
  kind == "code-offer" implies not(mailPanel(kind, labelsValid, offerKeyValid, callKeyValid, httpsHref, noCredentials).href)
pure def lawLinkPanelRequiresSafeAddress(kind: str, labelsValid: bool, offerKeyValid: bool, callKeyValid: bool, httpsHref: bool, noCredentials: bool): bool =
  mailPanel(kind, labelsValid, offerKeyValid, callKeyValid, httpsHref, noCredentials).href implies labelsValid and httpsHref and noCredentials and kind == "link-offer"
pure def lawWaitingEndsAtDeadline(link: bool, result: str, since: int, now: int): bool =
  now - since >= 120000 implies mailWait(link, result, since, now) != "waiting" and mailWait(link, result, since, now) != "link-waiting"
pure val kindValues = Set("code-offer", "link-offer", "unknown")
pure val resultValues = Set("ready", "unchecked", "ambiguous", "none", "type-it", "cancelled", "mail-failed")
```

## Story: Give the person a separate choice before a code fill or link open

### The panel responds to present call status and keeps opening a link separate from filling a code

A code offer arriving while a call is active or unknown first asks about phone coaching. A Yes to filling rechecks the call unless the person already answered that nobody told them what to do. A changed panel step makes the asynchronous answer obsolete. A matching phone-coaching key closes the host offer and prevents another fill for the attempt and subsequent looks under that goal. A negative answer to the coaching question restores the offer for a separate Yes. Declining a code makes the person responsible for typing.

For a link, Yes clears the current panel proposal before the panel calls the owned browser's open path with the same address. Declining keeps the work with the person. A failed open offers manual advice. The pinned link branch uses the panel's current step, normal browser checks and no host code-offer key, code grant or fill operation. A new look can return another link offer. The model does not attach the code branch's one-use semantics or a late-open cancellation fence to that separate path.

```quint
pure def codePanelOnArrival(currentStep: bool, callStatus: str): str =
  if (not(currentStep)) "ignore" else if (callStatus == "idle") "ask-fill" else "ask-coaching"
pure def codeYes(currentStep: bool, answeredNobody: bool, callStatus: str): str =
  if (not(currentStep)) "ignore" else if (answeredNobody or callStatus == "idle") "request-fill" else "ask-coaching"
pure def linkAnswer(currentStep: bool, hasLink: bool, answer: str): str =
  if (not(currentStep and hasLink)) "ignore" else if (answer == "yes") "open-browser" else if (answer == "decline") "person-opens" else "ignore"
pure def lawChangedStepDoesNotRequestFill(answeredNobody: bool, callStatus: str): bool =
  codeYes(false, answeredNobody, callStatus) == "ignore"
pure def lawLinkOpenRequiresYes(currentStep: bool, hasLink: bool, answer: str): bool =
  linkAnswer(currentStep, hasLink, answer) == "open-browser" implies currentStep and hasLink and answer == "yes"
pure val callStatusValues = Set("idle", "active", "unknown")
pure val answerValues = Set("yes", "decline", "other")
```

### The matching code offer is consumed and the value resolves only for its fill

The host runs its movement guard before matching the offer key. A match consumes the offer before checking task state and authority. The authorized path clears guidance, checks current authority, reads the unique target, pauses and settles to establish a new scoped epoch, and records an epoch-specific target and fill kind. It observes again and verifies the same target selector and protection class and absence of an effect violation. This models passage through the host movement and actuator checks as boundary facts. Grace configures Eliza's compatibility option to omit the native expected-target argument when that browser lacks the feature. The host still requires its own reviewed target.

The sole proposal is `browser.fill`, with a ten-second expiry. The private reference is resolvable once. The protected target receives the tagged verification-code value and an ordinary target receives text. A missing reference is refused. The host removes the reference on resolution and also in the execute cleanup. A returned runtime result marks the code used before branching on success, failure or unknown. A throw still clears the value reference and does not take the returned-result branch. The resulting success check requires the same document, no effect violation, and exactly one matching selector whose observed input marker is true. It records fill evidence and leaves submission to the person. A definite failed fill asks the person to type. Any unsettled returned result becomes unknown.

```quint
type FillAdmission = { movementAllows: bool, keyMatches: bool, active: bool, authorized: bool, hasShownTarget: bool, targetMatches: bool, protectionMatches: bool, effectViolation: bool, protectedField: bool }
pure def offerConsumed(fill: FillAdmission): bool = fill.movementAllows and fill.keyMatches
pure def fillAdmission(fill: FillAdmission): str =
  if (not(fill.movementAllows)) "page-guard"
  else if (not(fill.keyMatches)) "other-offer"
  else if (not(fill.active)) "look"
  else if (not(fill.authorized)) "TASK_UNAUTHORIZED"
  else if (not(fill.hasShownTarget and fill.targetMatches and fill.protectionMatches) or fill.effectViolation) "look"
  else if (fill.protectedField) "fill-code"
  else "fill"
pure def codeFillEvidence(sameDocument: bool, effectViolation: bool, markers: List[bool]): str =
  if (not(sameDocument) or effectViolation or markers.length() != 1) "unknown"
  else if (markers == List(true)) "succeeded"
  else "failed"
pure val codeFillLifetimeMs = 10000
pure def resultAfterFill(executeResult: str): str =
  if (executeResult == "succeeded") "look"
  else if (executeResult == "failed") "fill-failed"
  else if (executeResult == "threw") "propagate"
  else "fill-unverified"
pure def lawFillingRequiresTheCurrentTarget(fill: FillAdmission): bool =
  Set("fill", "fill-code").contains(fillAdmission(fill)) implies offerConsumed(fill) and fill.active and fill.authorized and fill.hasShownTarget and fill.targetMatches and fill.protectionMatches and not(fill.effectViolation)
pure def lawOneObservedInputIsRequired(sameDocument: bool, effectViolation: bool, markers: List[bool]): bool =
  (codeFillEvidence(sameDocument, effectViolation, markers) == "succeeded") iff (sameDocument and not(effectViolation) and markers == List(true))
pure val readyFill: FillAdmission = { movementAllows: true, keyMatches: true, active: true, authorized: true, hasShownTarget: true, targetMatches: true, protectionMatches: true, effectViolation: false, protectedField: true }
pure val fillValues = Set(readyFill, { ...readyFill, protectedField: false }, { ...readyFill, movementAllows: false }, { ...readyFill, keyMatches: false }, { ...readyFill, active: false }, { ...readyFill, authorized: false }, { ...readyFill, hasShownTarget: false }, { ...readyFill, targetMatches: false }, { ...readyFill, protectionMatches: false }, { ...readyFill, effectViolation: true })
pure val markersValues = Set(List(), List(true), List(false), List(true, false), List(true, true))
pure val executeResultValues = Set("succeeded", "failed", "threw", "unknown")
```

### Once the offer is consumed it cannot resolve another fill value

The machine records only the offer and call keys, the equality identity of the selected message and code, and whether a private value reference is currently held. It models one task goal at a time. Finishing removes any remaining reference. A used code stays suppressed until a look sees no challenge. That look leaves phone coaching in place. A new goal creates a fresh attempt. The machine represents one synchronous fill operation as a sequence of reference custody events. It does not infer how the surrounding task routes serialize concurrent requests.

```quint
type CodeOffer = { pending: bool, messageIdentity: int, codeIdentity: int, offerKey: str, phoneKey: str }
type CodeCustody = { offer: CodeOffer, coached: bool, used: bool, operation: bool, referenceHeld: bool, resolved: bool, result: str }
pure val noOffer: CodeOffer = { pending: false, messageIdentity: 0, codeIdentity: 0, offerKey: "", phoneKey: "" }
pure val initial: CodeCustody = { offer: noOffer, coached: false, used: false, operation: false, referenceHeld: false, resolved: false, result: "" }
pure def canOfferCode(custody: CodeCustody, candidate: CodeOffer): bool = not(custody.coached or custody.used or custody.operation) and candidate.pending
pure def offerCode(custody: CodeCustody, candidate: CodeOffer): CodeCustody =
  if (custody.offer.pending and custody.offer.messageIdentity == candidate.messageIdentity and custody.offer.codeIdentity == candidate.codeIdentity) custody
  else { ...custody, offer: candidate, resolved: false, result: "" }
pure def canReportCoaching(custody: CodeCustody, key: str): bool =
  custody.offer.pending and custody.offer.phoneKey == key and not(custody.operation)
pure def reportCoaching(custody: CodeCustody, key: str): CodeCustody =
  { ...custody, offer: noOffer, coached: true }
pure def canAcceptCode(custody: CodeCustody, key: str, fill: FillAdmission): bool =
  custody.offer.pending and custody.offer.offerKey == key and not(custody.coached or custody.used or custody.operation) and offerConsumed(fill)
pure def acceptCode(custody: CodeCustody, key: str, fill: FillAdmission): CodeCustody = {
  val admitted = Set("fill", "fill-code").contains(fillAdmission(fill))
  { ...custody, offer: noOffer, operation: admitted, referenceHeld: admitted, resolved: false, result: fillAdmission(fill) }
}
pure def canResolveCode(custody: CodeCustody, ownerCurrent: bool): bool = ownerCurrent and custody.operation and custody.referenceHeld and not(custody.resolved)
pure def resolveCode(custody: CodeCustody, ownerCurrent: bool): CodeCustody =
  { ...custody, referenceHeld: false, resolved: true }
pure def canFinishCode(custody: CodeCustody): bool = custody.operation
pure def finishCode(custody: CodeCustody, executeResult: str): CodeCustody =
  { ...custody, used: executeResult != "threw", operation: false, referenceHeld: false, result: resultAfterFill(executeResult) }
pure def canLeaveChallenge(custody: CodeCustody): bool = not(custody.operation)
pure def leaveChallenge(custody: CodeCustody): CodeCustody = { ...custody, offer: noOffer, used: false, resolved: false, result: "" }
pure def canStartNextGoal(custody: CodeCustody): bool = not(custody.operation)
pure def startNextGoal(custody: CodeCustody): CodeCustody = initial
pure def alwaysPrivateValueNeedsActiveFill(custody: CodeCustody): bool =
  custody.referenceHeld implies custody.operation and not(custody.offer.pending or custody.used or custody.coached or custody.resolved)
pure def alwaysOfferRequiresUnusedUncoachedAttempt(custody: CodeCustody): bool =
  custody.offer.pending implies not(custody.coached or custody.used or custody.operation)
pure def stepPhoneCoachingStaysUntilNewGoal(before: CodeCustody, via: str, after: CodeCustody): bool =
  before.coached and via != "startNextGoal" implies after.coached
pure def stepOnlyAcceptanceCreatesReference(before: CodeCustody, via: str, after: CodeCustody): bool =
  not(before.referenceHeld) and after.referenceHeld implies via == "acceptCode" and before.offer.pending
pure def sometimesOffered(custody: CodeCustody): bool = custody.offer.pending
pure def sometimesHolding(custody: CodeCustody): bool = custody.referenceHeld
pure def sometimesResolved(custody: CodeCustody): bool = custody.operation and custody.resolved and not(custody.referenceHeld)
pure def sometimesCoached(custody: CodeCustody): bool = custody.coached
pure def sometimesFillUnverified(custody: CodeCustody): bool = custody.used and custody.result == "fill-unverified"
pure val candidateValues = Set({ pending: true, messageIdentity: 1, codeIdentity: 1, offerKey: "offer1", phoneKey: "phone1" }, { pending: true, messageIdentity: 2, codeIdentity: 2, offerKey: "offer2", phoneKey: "phone2" }, { pending: true, messageIdentity: 1, codeIdentity: 1, offerKey: "offer3", phoneKey: "phone3" }, noOffer)
pure val keyValues = Set("offer1", "offer2", "offer3", "phone1", "phone2", "phone3", "stale")
```

The model has no physical-browser or live-mail claim. Site labels, address masking, parser confidence, authentication provenance, the bounded session redactor and browser-target compatibility need pinned boundary replay. Cloud sender authentication availability still depends on the deployed Cloud read path. The conditional one-use code proof concerns the host fill, with no claim about mailbox delivery, successful sign-in or a link's remote effect.
