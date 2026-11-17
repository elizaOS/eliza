# Android Autofill fill and save custody

The passwords bridge ships an Android `AutofillService` that a consumer
declares with `BIND_AUTOFILL_SERVICE`. A fill request never touches the
vault: it answers with one authentication-gated dataset whose values are
empty, and only a picker Activity opened from that dataset, after a fresh
unlock and the owner's choice of one entry, hands values to Android for the
request's own fields. A save request keeps the typed values in memory and
opens a review the owner must accept and unlock. Activity intents carry only
an unguessable one-shot token; targets and values never enter an intent, a
log, disk or the page. The host's admission rule (for example its account
owner) is asked first at every entry, and a refused entry does nothing.
Matching, unlock and the vault page itself are in the passwords bridge;
this spec follows one fill offer, one save capture and one open save review.

## Story: Fill a form only for its site, from my choice

> As the owner, I want a saved password filled only into the exact website
> or app it belongs to, after I unlock and pick it, so that no look-alike
> page, frame or app can collect it.

### A form is fillable only for one exact HTTPS origin or one other app

The shell reduces the framework's latest structure to evidence. The
requesting package comes from Android, never from the form. At most 40
levels and 1,500 nodes are read. A fill needs exactly one visible,
explicitly classified password field; a save allows one or two password
fields and needs at least one entered password, all entered passwords
equal. Web fields must come from one HTTPS domain and carry a native
per-field origin equal to the target origin; page text, labels and a
form-level domain grant nothing. The consumer's own browser must also
report one committed top-level origin on the same host, which supplies the
port; another browser must be trusted by package and signer. The
consumer's own native interface is never filled, and an app capture needs
the app's single current signer.

```quint
type FillSite = NoTarget | WebTarget | AppTarget
type FormMode = FillForm | SaveForm
type Requester = OwnInterface | OwnBrowser | TrustedBrowser | OtherApp
type FormEvidence = { admitted: bool, withinBounds: bool, passwordFields: int, enteredPasswords: int, enteredAgree: bool,
  webDomains: int, httpsOnly: bool, loginFieldsWeb: bool, fieldOriginsExact: bool, topOrigins: int, topHostMatches: bool,
  requester: Requester, appSignerKnown: bool }
pure def passwordShape(form: FormEvidence, mode: FormMode): bool =
  if (mode == FillForm) form.passwordFields == 1
  else form.passwordFields >= 1 and form.passwordFields <= 2 and form.enteredPasswords >= 1 and form.enteredAgree
pure def webRequesterAdmitted(form: FormEvidence): bool =
  if (form.requester == OwnBrowser) form.topOrigins == 1 and form.topHostMatches else form.requester == TrustedBrowser
pure def formSite(form: FormEvidence, mode: FormMode): FillSite =
  if (not(form.admitted and form.withinBounds and passwordShape(form, mode))) NoTarget
  else if (form.webDomains == 0) {
    if (form.topOrigins == 0 and form.requester != OwnInterface and form.requester != OwnBrowser) AppTarget else NoTarget
  } else if (form.webDomains == 1 and form.httpsOnly and form.loginFieldsWeb and form.fieldOriginsExact and webRequesterAdmitted(form)) WebTarget
  else NoTarget
pure def captureSite(form: FormEvidence): FillSite = {
  val site = formSite(form, SaveForm)
  if (site == AppTarget and not(form.appSignerKnown)) NoTarget else site
}
pure val ownBrowserForm: FormEvidence = { admitted: true, withinBounds: true, passwordFields: 1, enteredPasswords: 1, enteredAgree: true,
  webDomains: 1, httpsOnly: true, loginFieldsWeb: true, fieldOriginsExact: true, topOrigins: 1, topHostMatches: true,
  requester: OwnBrowser, appSignerKnown: false }
pure val appForm: FormEvidence = { ...ownBrowserForm, webDomains: 0, loginFieldsWeb: false, fieldOriginsExact: false, topOrigins: 0,
  topHostMatches: false, requester: OtherApp, appSignerKnown: true }
pure val formValues = Set(ownBrowserForm, appForm, { ...ownBrowserForm, requester: TrustedBrowser, topOrigins: 0 },
  { ...ownBrowserForm, fieldOriginsExact: false }, { ...appForm, requester: OwnInterface }, { ...appForm, appSignerKnown: false })
pure def lawWebTargetNeedsExactFieldOrigins(form: FormEvidence, mode: FormMode): bool =
  formSite(form, mode) == WebTarget implies
    (form.webDomains == 1 and form.httpsOnly and form.fieldOriginsExact and form.requester != OwnInterface and form.requester != OtherApp and
      (form.requester == OwnBrowser implies form.topOrigins == 1 and form.topHostMatches))
pure def lawOwnInterfaceIsNeverFilled(form: FormEvidence, mode: FormMode): bool =
  form.requester == OwnInterface implies formSite(form, mode) == NoTarget
pure def lawSaveNeedsOneAgreedPassword(form: FormEvidence): bool =
  captureSite(form) != NoTarget implies (form.enteredPasswords >= 1 and form.enteredAgree and form.passwordFields <= 2)
pure def lawAppCaptureNeedsItsSigner(form: FormEvidence): bool =
  captureSite(form) == AppTarget implies form.appSignerKnown
```

### Only the current offer's live picker publishes a dataset, for an entry of the exact facet

A new fill offer replaces the previous one, and a picker left on the old
offer ends. The picker's intent token is taken once, even when it has
expired; the offer is current for 120,000 elapsed milliseconds after it was
made, and the deadline still holds when the dataset is published. The
picker starts its own unlock: an unlock from the vault page, Settings or an
earlier picker conveys nothing, and while another prompt is pending the
picker is refused and ends. It then rechecks the entry actually read: a web
entry matches by exact origin, port included; an app entry by exact package
and an Android-confirmed signing certificate. Publishing consumes the offer
and the grant. Cancelling the offer, or stopping the picker other than for
its own prompt or a configuration change, ends both.

```quint
type FillPhase = NoFill | FillOffered | FillPicking
type GrantPhase = GrantIdle | GrantChallenging | GrantLive
type ReviewPhase = NoReview | Reviewing | ReviewUnlocking | ReviewWriting
type FillOffer = { phase: FillPhase, token: int, created: int, site: FillSite, facet: str, ticket: int }
type SaveCapture = { token: int, created: int, site: FillSite, facet: str }
type SaveReview = { phase: ReviewPhase, site: FillSite, facet: str, ticket: int }
type Grant = { phase: GrantPhase, generation: int }
type EntryBinding = { kind: FillSite, facet: str, signerConfirmed: bool }
type NativeAutofill = { elapsed: int, nextToken: int, fill: FillOffer, capture: SaveCapture, review: SaveReview, grant: Grant, filled: int, saved: int }
pure val fillWindow = 120000
pure val saveWindow = 300000
pure val noFill: FillOffer = { phase: NoFill, token: 0, created: 0, site: NoTarget, facet: "", ticket: 0 }
pure val noCapture: SaveCapture = { token: 0, created: 0, site: NoTarget, facet: "" }
pure val noReview: SaveReview = { phase: NoReview, site: NoTarget, facet: "", ticket: 0 }
pure val initial: NativeAutofill = { elapsed: 0, nextToken: 0, fill: noFill, capture: noCapture, review: noReview,
  grant: { phase: GrantIdle, generation: 0 }, filled: 0, saved: 0 }
pure def fresh(created: int, now: int, window: int): bool = now >= created and now - created < window
pure def grantOwnedBy(g: Grant, ticket: int): bool = ticket > 0 and ticket == g.generation
pure def lockTicket(g: Grant, ticket: int): Grant = if (grantOwnedBy(g, ticket)) { ...g, phase: GrantIdle } else g
pure def entryMatches(site: FillSite, facet: str, binding: EntryBinding): bool =
  binding.kind == site and binding.facet == facet and (site == WebTarget or (site == AppTarget and binding.signerConfirmed))
pure def canOfferFill(s: NativeAutofill, form: FormEvidence, facet: str): bool = formSite(form, FillForm) != NoTarget and facet != ""
pure def offerFill(s: NativeAutofill, form: FormEvidence, facet: str): NativeAutofill =
  { ...s, nextToken: s.nextToken + 1,
    fill: { phase: FillOffered, token: s.nextToken + 1, created: s.elapsed, site: formSite(form, FillForm), facet: facet, ticket: 0 },
    grant: lockTicket(s.grant, s.fill.ticket) }
pure def canOpenFill(s: NativeAutofill, token: int): bool = s.fill.phase == FillOffered and token == s.fill.token
pure def openFill(s: NativeAutofill, token: int): NativeAutofill =
  if (fresh(s.fill.created, s.elapsed, fillWindow) and s.grant.phase != GrantChallenging)
    { ...s, fill: { ...s.fill, phase: FillPicking, ticket: s.grant.generation + 1 },
      grant: { phase: GrantChallenging, generation: s.grant.generation + 1 } }
  else { ...s, fill: noFill }
pure def canDeliverFill(s: NativeAutofill, token: int, binding: EntryBinding): bool =
  s.fill.phase == FillPicking and token == s.fill.token and s.grant.phase == GrantLive and grantOwnedBy(s.grant, s.fill.ticket) and
    fresh(s.fill.created, s.elapsed, fillWindow) and entryMatches(s.fill.site, s.fill.facet, binding)
pure def deliverFill(s: NativeAutofill, token: int, binding: EntryBinding): NativeAutofill =
  { ...s, fill: noFill, grant: lockTicket(s.grant, s.fill.ticket), filled: s.filled + 1 }
pure def canCancelFill(s: NativeAutofill, token: int): bool = s.fill.phase != NoFill and token == s.fill.token
pure def cancelFill(s: NativeAutofill, token: int): NativeAutofill = { ...s, fill: noFill, grant: lockTicket(s.grant, s.fill.ticket) }
pure def canAdvanceClock(s: NativeAutofill, now: int): bool = now > s.elapsed
pure def advanceClock(s: NativeAutofill, now: int): NativeAutofill = { ...s, elapsed: now }
pure val facetValues = Set("https://first.test", "first.app")
pure val bindingValues = Set({ kind: WebTarget, facet: "https://first.test", signerConfirmed: false },
  { kind: WebTarget, facet: "https://first.test:8443", signerConfirmed: false },
  { kind: AppTarget, facet: "first.app", signerConfirmed: true }, { kind: AppTarget, facet: "first.app", signerConfirmed: false })
pure val tokenValues = Set(1, 2, 3)
pure val nowValues = Set(60000, 119999, 120000, 300000, 420000)
pure def alwaysOfferHoldsItsTarget(s: NativeAutofill): bool =
  s.fill.phase != NoFill implies (s.fill.token > 0 and s.fill.site != NoTarget and s.fill.facet != "")
pure def alwaysTicketsAreIssuedAndDistinct(s: NativeAutofill): bool =
  s.fill.ticket <= s.grant.generation and s.review.ticket <= s.grant.generation and s.fill.ticket >= 0 and s.review.ticket >= 0 and
    ((s.fill.ticket > 0) iff (s.fill.phase == FillPicking)) and
    ((s.review.ticket > 0) iff (s.review.phase == ReviewUnlocking or s.review.phase == ReviewWriting)) and
    ((s.fill.ticket > 0 and s.review.ticket > 0) implies s.fill.ticket != s.review.ticket)
pure def stepFillOnlyByExactLivePicker(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  after.filled != before.filled implies
    (via == "deliverFill" and after.filled == before.filled + 1 and before.fill.phase == FillPicking and before.grant.phase == GrantLive and
      grantOwnedBy(before.grant, before.fill.ticket) and fresh(before.fill.created, before.elapsed, fillWindow) and
      after.fill == noFill and after.grant.phase == GrantIdle)
pure def stepPickerOpensOnlyFreshOffer(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  (via == "openFill" and after.fill.phase == FillPicking) implies
    (fresh(before.fill.created, before.elapsed, fillWindow) and before.grant.phase != GrantChallenging)
pure def sometimesFillsAForm(s: NativeAutofill): bool = s.filled > 0
```

### One native prompt is pending at a time, and a new one revokes the previous grant

Every unlock, from a picker, a save review or elsewhere (the vault page,
Settings), begins a new challenge generation; while one is pending another
is refused as busy. Only the pending generation's own answer can grant, and
the grant then ends on expiry, on its owner's lock, or on the next
challenge. A failed prompt ends its picker and returns its save review to
the owner's choice.

```quint
pure def canBeginOtherUnlock(s: NativeAutofill): bool = s.grant.phase != GrantChallenging
pure def beginOtherUnlock(s: NativeAutofill): NativeAutofill = { ...s, grant: { phase: GrantChallenging, generation: s.grant.generation + 1 } }
pure def canAnswerPrompt(s: NativeAutofill, ticket: int, accepted: bool): bool = s.grant.phase == GrantChallenging and grantOwnedBy(s.grant, ticket)
pure def answerPrompt(s: NativeAutofill, ticket: int, accepted: bool): NativeAutofill =
  { ...s, grant: { ...s.grant, phase: if (accepted) GrantLive else GrantIdle },
    fill: if (not(accepted) and s.fill.ticket == ticket) noFill else s.fill,
    review: if (s.review.phase == ReviewUnlocking and s.review.ticket == ticket)
      (if (accepted) { ...s.review, phase: ReviewWriting } else { ...s.review, phase: Reviewing, ticket: 0 }) else s.review }
pure def canExpireGrant(s: NativeAutofill): bool = s.grant.phase == GrantLive
pure def expireGrant(s: NativeAutofill): NativeAutofill = { ...s, grant: { ...s.grant, phase: GrantIdle } }
pure val ticketValues = Set(1, 2, 3)
pure def stepNewChallengeOnlyWhenNonePending(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  after.grant.generation != before.grant.generation implies
    (after.grant.generation == before.grant.generation + 1 and before.grant.phase != GrantChallenging and after.grant.phase == GrantChallenging)
pure def stepOnlyThePendingChallengeGrants(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  (after.grant.phase == GrantLive and before.grant.phase != GrantLive) implies
    (via == "answerPrompt" and before.grant.phase == GrantChallenging and after.grant.generation == before.grant.generation)
```

## Story: Save a password only when I choose Save and unlock

> As the owner, I want a password I typed saved only when I choose Save and
> unlock, under the exact site it was typed into, so that nothing is stored
> behind my back or for the wrong site.

### A save capture keeps its proved facet and cannot be recovered from a consumed intent

A save capture holds the facet proved at capture time: the exact origin, or
the app's package with its current signer. A new capture replaces the
pending one, not an open review. Opening the review takes the token once,
even when the capture is older than 300,000 elapsed milliseconds, and then
opens nothing. One review is open at a time, and its facet does not change
until it closes. A write updates the first entry with that facet and the
same username, keeping its label and bindings, or creates an entry bound
only to that facet; its admission and result are one event. Closing the
review (Not now, stop, destroy) locks its grant; a host lock clears the
offer and the capture, and turns an unlocking review back to the choice.

```quint
pure def canOfferSave(s: NativeAutofill, form: FormEvidence, facet: str): bool = captureSite(form) != NoTarget and facet != ""
pure def offerSave(s: NativeAutofill, form: FormEvidence, facet: str): NativeAutofill =
  { ...s, nextToken: s.nextToken + 1, capture: { token: s.nextToken + 1, created: s.elapsed, site: captureSite(form), facet: facet } }
pure def canOpenSave(s: NativeAutofill, token: int): bool = s.review.phase == NoReview and s.capture.token > 0 and token == s.capture.token
pure def openSave(s: NativeAutofill, token: int): NativeAutofill =
  { ...s, capture: noCapture,
    review: if (fresh(s.capture.created, s.elapsed, saveWindow)) { phase: Reviewing, site: s.capture.site, facet: s.capture.facet, ticket: 0 } else s.review }
pure def canChooseSave(s: NativeAutofill): bool = s.review.phase == Reviewing and s.grant.phase != GrantChallenging
pure def chooseSave(s: NativeAutofill): NativeAutofill =
  { ...s, review: { ...s.review, phase: ReviewUnlocking, ticket: s.grant.generation + 1 },
    grant: { phase: GrantChallenging, generation: s.grant.generation + 1 } }
pure def canSettleSave(s: NativeAutofill, persisted: bool): bool = s.review.phase == ReviewWriting
pure def settleSave(s: NativeAutofill, persisted: bool): NativeAutofill =
  { ...s, review: noReview, grant: lockTicket(s.grant, s.review.ticket),
    saved: if (persisted and s.grant.phase == GrantLive and grantOwnedBy(s.grant, s.review.ticket)) s.saved + 1 else s.saved }
pure def canCloseSave(s: NativeAutofill): bool = s.review.phase != NoReview
pure def closeSave(s: NativeAutofill): NativeAutofill = { ...s, review: noReview, grant: lockTicket(s.grant, s.review.ticket) }
pure def lockAutofill(s: NativeAutofill): NativeAutofill =
  { ...s, fill: noFill, capture: noCapture, grant: { ...s.grant, phase: GrantIdle },
    review: if (s.review.phase == ReviewUnlocking) { ...s.review, phase: Reviewing, ticket: 0 } else s.review }
pure def alwaysCaptureAndReviewHoldTheirFacet(s: NativeAutofill): bool =
  (s.capture.token > 0 implies (s.capture.site != NoTarget and s.capture.facet != "")) and
    (s.review.phase != NoReview implies (s.review.site != NoTarget and s.review.facet != ""))
pure def stepConsumedCaptureIsGone(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  via == "openSave" implies
    (after.capture == noCapture and ((after.review.phase == Reviewing) iff fresh(before.capture.created, before.elapsed, saveWindow)) and
      (after.review.phase == Reviewing implies (after.review.facet == before.capture.facet and after.review.site == before.capture.site)))
pure def stepOpenReviewKeepsItsFacet(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  (before.review.phase != NoReview and after.review.phase != NoReview) implies
    (after.review.facet == before.review.facet and after.review.site == before.review.site)
pure def stepSavedOnlyUnderItsLiveGrant(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  after.saved != before.saved implies
    (via == "settleSave" and after.saved == before.saved + 1 and before.review.phase == ReviewWriting and
      before.grant.phase == GrantLive and grantOwnedBy(before.grant, before.review.ticket) and after.review == noReview)
pure def sometimesSavesACapture(s: NativeAutofill): bool = s.saved > 0
```

### The pending save challenge stays the current native prompt

While a review is unlocking, the one pending challenge is its own, so no
other surface's answer or a stale callback can stand in for the owner's
confirmation of this save.

```quint
pure def alwaysSaveChallengeOwnsPrompt(s: NativeAutofill): bool =
  s.review.phase == ReviewUnlocking implies (s.grant.phase == GrantChallenging and grantOwnedBy(s.grant, s.review.ticket))
pure def sometimesSaveAwaitsItsPrompt(s: NativeAutofill): bool = s.review.phase == ReviewUnlocking
```
