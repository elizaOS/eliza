# Android password Autofill request, picker and save custody

AlphaPhone `8d44dfe5` registers `PasswordsPlugin` and declares the Android
`BIND_AUTOFILL_SERVICE` service. `android/app/src/main/res/values/eliza_passwords.xml`
sets the installed vault identity, its 60-second Keystore window, and its
own-browser mode. The active Eliza `c518127a` path is
`plugins/plugin-native-passwords/android/src/main/java/ai/eliza/plugins/passwords`.
Its service calls `AutofillStructures`, `PasswordFormPolicy` and
`PasswordRequests`, then `PasswordFillActivity` or `PasswordSaveActivity`.
`PasswordMatching`, `PasswordVaultAccess` and `PasswordUnlock` own matching
and native authentication. Grace's `7743504b` pins the same classes, with
`PASSWORDS_RELEASE_SWITCH=false` in `apps/app/scripts/passwords-profile.ts`
and a separate debug-only fixture build. Its owner and vault erasure rules
are separate. [Alpha's Settings contract](./alpha/passwords.md) owns the
renderer visit, metadata and manual editor. The older native-only
`PasswordAutofillRequest`, `PasswordAutofillSessions`, `PasswordAutofillOffer`
and `PasswordAutofillCompletion` classes have separate fixture callers.
The installed service uses its own request and dataset path. It shares the
`PasswordAutofillPolicy.FIELD_ORIGIN` metadata key with browser-surface.

## Story: Fill an exact website or app only after native unlock and selection

### Framework and browser evidence identify a fillable form and its credential facet

Use the latest framework `FillContext` and its activity package. The
framework conversion and form walk reject depth above 40 and more than
1,500 nodes including the synthetic root. The fill chooses exactly one
visible text password field with an Autofill ID. The password classifier
uses the accepted password hint, HTML type or Android input variation.
A username field is optional. Prefer the first explicitly classified
username in the same domain. Otherwise select the nearest eligible
preceding text field in that domain. Save considers fields even after
visibility changes, allows one or two password fields, and requires at
least one nonempty captured password with all nonempty values equal.
Missing username text in a save becomes the empty string.

A web request must have one reported domain and one HTTPS scheme and
web bindings for all selected login fields. Alpha's own process needs
its enabled browser identity, one committed top-level origin with an
exact host match to the reported domain, and engine-supplied per-field
origin matching the full top origin including port. A different browser
needs configured package and signer trust, and exact native per-field
origins matching the admitted HTTPS origin derived from Android's web
domain. Form and page text cannot supply field-origin authority. The
browser adapter `BrowserLoginFields` uses the engine message origin and
an isolated world where supported. `BrowserAutofillEligibility` requires
an active selected, presented, committed HTTPS document without load
failure and with the same document and engine address. These facts are
validated at the browser port; its document tracking stays with the
browser. Ordinary WebView structures without native field attestations
are refused. A native app request has no web domain or top origin, and
cannot be Alpha's own interface. A stored app facet matches by exact
package and Android-confirmed signing certificate. A web facet matches
exact canonical HTTPS origin including nondefault port. A display label
or similarity of hostnames conveys no credential authority.

```quint
type FillSite = NoTarget | WebTarget | NativeTarget
type FormMode = FillForm | SaveForm
type FormEvidence = { activityKnown: bool, hostAdmitted: bool, fillCancelled: bool, depth: int, nodes: int,
  passwordFields: int, hasCapturedPassword: bool, passwordsAgree: bool, webDomains: int, schemes: int, https: bool,
  loginFieldsWeb: bool, ownPackage: bool, ownBrowser: bool, signedBrowser: bool, topOrigins: int, topHostExact: bool,
  allFieldsAttested: bool, fieldOriginsExact: bool }
pure def passwordShape(form: FormEvidence, mode: FormMode): bool =
  if (mode == FillForm) form.passwordFields == 1
  else form.passwordFields >= 1 and form.passwordFields <= 2 and form.hasCapturedPassword and form.passwordsAgree
pure def formSite(form: FormEvidence, mode: FormMode): FillSite =
  if (not(form.activityKnown and form.hostAdmitted and passwordShape(form, mode)) or
    (mode == FillForm and form.fillCancelled) or form.depth < 0 or form.depth > 40 or form.nodes < 1 or form.nodes > 1500) NoTarget
  else if (form.webDomains == 0) {
    if (not(form.ownPackage) and form.topOrigins == 0) NativeTarget else NoTarget
  } else if (form.webDomains == 1 and form.schemes == 1 and form.https and form.loginFieldsWeb and
    form.allFieldsAttested and form.fieldOriginsExact and
    (if (form.ownPackage) form.ownBrowser and form.topOrigins == 1 and form.topHostExact else form.signedBrowser)) WebTarget
  else NoTarget
pure def matchesFacet(targetSite: FillSite, entrySite: FillSite, exactOrigin: bool, exactPackage: bool, signingCertificate: bool): bool =
  (targetSite == WebTarget and entrySite == WebTarget and exactOrigin) or
    (targetSite == NativeTarget and entrySite == NativeTarget and exactPackage and signingCertificate)
pure val ownWeb: FormEvidence = { activityKnown: true, hostAdmitted: true, fillCancelled: false, depth: 5, nodes: 15,
  passwordFields: 1, hasCapturedPassword: true, passwordsAgree: true, webDomains: 1, schemes: 1, https: true,
  loginFieldsWeb: true, ownPackage: true, ownBrowser: true, signedBrowser: false, topOrigins: 1, topHostExact: true,
  allFieldsAttested: true, fieldOriginsExact: true }
pure val formValues = Set(ownWeb, { ...ownWeb, allFieldsAttested: false }, { ...ownWeb, fieldOriginsExact: false },
  { ...ownWeb, webDomains: 0, topOrigins: 0, ownPackage: false }, { ...ownWeb, passwordFields: 2 })
pure def lawWebFormNeedsExactFieldEvidence(form: FormEvidence, mode: FormMode): bool =
  formSite(form, mode) == WebTarget implies form.allFieldsAttested and form.fieldOriginsExact and form.https and
    (if (form.ownPackage) form.topOrigins == 1 and form.topHostExact else form.signedBrowser)
pure def lawNativeFacetRequiresSigner(targetSite: FillSite, entrySite: FillSite, exactOrigin: bool, exactPackage: bool, signingCertificate: bool): bool =
  targetSite == NativeTarget and matchesFacet(targetSite, entrySite, exactOrigin, exactPackage, signingCertificate) implies exactPackage and signingCertificate
pure def lawSaveNeedsConsistentNonemptyPassword(form: FormEvidence): bool =
  formSite(form, SaveForm) != NoTarget implies form.hasCapturedPassword and form.passwordsAgree
```

### A fill offer contains no values and only its exact live picker may publish a dataset

The service responds with an authentication-gated framework dataset with
null field values. `PasswordRequests` keeps only the admitted target and
framework field IDs for filling. The once-only immutable Activity intent
carries the configured scheme and a 48-lowercase-hex opaque token. Fill
is current until strictly before 120,000 elapsed milliseconds after
its creation. A matching take marks it taken even if it has expired.
A replacement fill offer overwrites it. Cancellation of an older token
keeps the current offer. A malformed or cancelled request that fails
before producing a replacement leaves the prior request unchanged. A
new Activity accepts only its current token, validates its scheme and
host admission, and discards restored state. The picker starts a fresh
unlock. An unlock from Settings or an earlier picker conveys no access.
The prompt owns its single outstanding native challenge. A competing
prompt returns busy while another challenge is pending. Once accepted,
Alpha's process grant expires after 58,000 elapsed milliseconds and
the Keystore still controls its 60-second window. This model checks
both grants as port evidence. A new admitted challenge revokes the
prior grant. Cancelling the earlier picker cannot revoke a newer one.

The picker reads metadata under the exact grant, chooses an entry, and
checks the matching facet again on the entry actually read. The UI
callback still needs the exact token, its original deadline, valid
unlock and a successful atomic claim. The claim consumes the token
before publishing the result. The dataset goes directly to the Android
framework with the captured field IDs. No secret moves through the
renderer, an intent to open the picker, or the model. When the picker
stops for the credential prompt or a configuration change the old
instance handles that lifecycle callback specially. A reconstructed
Activity cannot restore the token. Other stop, destruction, host lock or
cancellation revoke the respective request or grant. External failures
such as Android declining the dataset do not produce another claim.

```quint
type FillPhase = NoFill | OfferedFill | UnlockingFill | ActiveFill
type SavePhase = NoSave | ReviewingSave | UnlockingSave | WritingSave
type NativeAutofill = { elapsed: int, fill: FillPhase, fillToken: int, fillCreated: int, fillFacet: str, fillFields: str,
  save: SavePhase, saveToken: int, saveFacet: str, pendingSaveToken: int, pendingSaveCreated: int, pendingSaveFacet: str,
  nextToken: int, auth: int, prompt: int, fillAuth: int, saveAuth: int, claimed: int, saved: int }
pure val initial: NativeAutofill = { elapsed: 0, fill: NoFill, fillToken: 0, fillCreated: 0, fillFacet: "", fillFields: "",
  save: NoSave, saveToken: 0, saveFacet: "", pendingSaveToken: 0, pendingSaveCreated: 0, pendingSaveFacet: "",
  nextToken: 0, auth: 0, prompt: 0, fillAuth: 0, saveAuth: 0,
  claimed: 0, saved: 0 }
pure def fresh(created: int, elapsed: int, ttl: int): bool = elapsed >= created and elapsed - created < ttl
pure def canOfferFill(s: NativeAutofill, validForm: bool, facet: str, fieldBinding: str): bool = validForm and facet != "" and fieldBinding != ""
pure def offerFill(s: NativeAutofill, validForm: bool, facet: str, fieldBinding: str): NativeAutofill =
  { ...s, fill: OfferedFill, fillToken: s.nextToken + 1, nextToken: s.nextToken + 1, fillCreated: s.elapsed, fillFacet: facet,
    fillFields: fieldBinding, fillAuth: 0 }
pure def canOpenFill(s: NativeAutofill, token: int, newActivity: bool): bool = s.fill == OfferedFill and token == s.fillToken and newActivity
pure def openFill(s: NativeAutofill, token: int, newActivity: bool): NativeAutofill =
  if (s.prompt == 0 and fresh(s.fillCreated, s.elapsed, 120000))
    { ...s, fill: UnlockingFill, auth: s.auth + 1, prompt: s.auth + 1, fillAuth: s.auth + 1 }
  else { ...s, fill: NoFill, fillToken: 0, fillFacet: "", fillFields: "", fillAuth: 0 }
pure def canUnlockFill(s: NativeAutofill, authTicket: int): bool =
  s.save != UnlockingSave and authTicket == s.prompt and s.prompt > 0
pure def unlockFill(s: NativeAutofill, authTicket: int, grantedFill: bool): NativeAutofill =
  if (s.fill != UnlockingFill or authTicket != s.fillAuth) { ...s, prompt: 0 }
  else if (grantedFill and fresh(s.fillCreated, s.elapsed, 120000)) { ...s, prompt: 0, fill: ActiveFill }
  else { ...s, prompt: 0, fill: NoFill, fillToken: 0, fillFacet: "", fillFields: "", fillAuth: 0 }
pure def canDeliverFill(s: NativeAutofill, token: int, liveGrant: bool, matchedTarget: str, fieldBinding: str): bool =
  s.fill == ActiveFill and token == s.fillToken and s.auth == s.fillAuth and liveGrant and fieldBinding == s.fillFields and
    s.fillFacet == matchedTarget and fresh(s.fillCreated, s.elapsed, 120000)
pure def deliverFill(s: NativeAutofill, token: int, liveGrant: bool, matchedTarget: str, fieldBinding: str): NativeAutofill =
  { ...s, fill: NoFill, fillToken: 0, fillFacet: "", fillFields: "", fillAuth: 0, claimed: s.claimed + 1 }
pure def canCancelFill(s: NativeAutofill, token: int): bool = s.fill != NoFill and s.fillToken == token
pure def cancelFill(s: NativeAutofill, token: int): NativeAutofill = { ...s, fill: NoFill, fillToken: 0, fillFacet: "", fillFields: "", fillAuth: 0 }
pure def canAdvanceClock(s: NativeAutofill, elapsed: int): bool = elapsed > s.elapsed
pure def advanceClock(s: NativeAutofill, elapsed: int): NativeAutofill = { ...s, elapsed: elapsed }
pure val tokenValues = Set(1, 2, 3)
pure val authTicketValues = Set(1, 2, 3)
pure val facetValues = Set("", "https://first.test", "https://first.test:8443")
pure val matchedTargetValues = Set("", "https://first.test", "https://first.test:8443")
pure val fieldBindingValues = Set("", "android-field-set", "replaced-field-set")
pure val elapsedValues = Set(0, 100, 120000, 120001, 300000, 300001)
pure val weight_offerFill = 4
pure val weight_openFill = 14
pure val weight_unlockFill = 22
pure val weight_deliverFill = 30
pure def alwaysActiveFillHasExactGrantIdentity(s: NativeAutofill): bool =
  (s.fill == UnlockingFill or s.fill == ActiveFill) implies s.fillAuth > 0 and s.fillToken > 0 and s.fillFacet != "" and s.fillFields != ""
pure def alwaysOfferedFillHasNoGrant(s: NativeAutofill): bool = s.fill == OfferedFill implies s.fillAuth == 0
pure def alwaysOfferedFillHasExactTarget(s: NativeAutofill): bool =
  s.fill == OfferedFill implies s.fillToken > 0 and s.fillFacet != "" and s.fillFields != ""
pure def alwaysRequestClockAndSerialAdvance(s: NativeAutofill): bool = s.auth >= 0 and s.nextToken >= 0 and s.elapsed >= 0
pure def stepClaimConsumesExactFill(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  after.claimed > before.claimed implies via == "deliverFill" and before.fill == ActiveFill and before.auth == before.fillAuth and
    fresh(before.fillCreated, before.elapsed, 120000) and after.fill == NoFill and after.fillToken == 0
pure def lawExactDeadlineExpiresFill(created: int): bool = not(fresh(created, created + 120000, 120000))
pure def sometimesClaimsFill(s: NativeAutofill): bool = s.claimed > 0
```

## Story: Save a captured password only by choosing Save and authenticating

### A save capture keeps the proved facet and cannot recover from a consumed intent

The service validates the captured form at the save request. For an app it
reads the current signer before recording its package and certificate
facet. Missing or ambiguous signer, missing capture or malformed form
returns no save activity. A save token is independent from the fill
token. It remains single-use until strictly before 300,000 elapsed
milliseconds. Taking a matching token removes it even on expiry. The
Activity holds the captured value in memory after a successful take.
The deadline gates that transfer to the Activity. It does not restart
and does not impose a second deadline on the opened save review. The
next saved-form offer replaces the pending capture independently of the
already-open review. The model follows one foreground review Activity
at a time, with the port retiring it before another Activity is tracked.
The identity retained in the Activity is separate from its consumed token.
The review accepts a separate affirmative tap and a fresh native unlock.
Cancellation, Activity retirement or a replaced runtime grant fence a
not-yet-admitted save. The model treats admission to the serialized vault
write and its result as one event. It does not assert that closing the
Activity rewinds a write that already entered the native store. A result
from a finished or destroyed Activity is not published to its UI.

Keep the captured credential facet through authorization. A matched
existing entry is the first one containing the exact facet and same
username. Change its password while retaining its label and bindings.
Otherwise create an entry for only that captured facet. Save retries after
an unsuccessful prompt require another explicit tap on the still-open
review. An actual write result closes the Activity. Exact encrypted bytes,
keystore and Android lifecycle behavior remain shell conformance.

```quint
type SaveChoice = UpdateEntry | CreateEntry
pure def saveChoice(entryHasFacet: bool, exactUsername: bool): SaveChoice =
  if (entryHasFacet and exactUsername) UpdateEntry else CreateEntry
pure def canOfferSave(s: NativeAutofill, saveFormValid: bool, facet: str, verifiedCaptureFacet: bool): bool =
  saveFormValid and facet != "" and verifiedCaptureFacet
pure def offerSave(s: NativeAutofill, saveFormValid: bool, facet: str, verifiedCaptureFacet: bool): NativeAutofill =
  { ...s, nextToken: s.nextToken + 1, pendingSaveToken: s.nextToken + 1, pendingSaveCreated: s.elapsed, pendingSaveFacet: facet }
pure def canOpenSave(s: NativeAutofill, token: int, newActivity: bool): bool =
  s.save == NoSave and token > 0 and token == s.pendingSaveToken and newActivity
pure def openSave(s: NativeAutofill, token: int, newActivity: bool): NativeAutofill =
  if (fresh(s.pendingSaveCreated, s.elapsed, 300000))
    { ...s, save: ReviewingSave, saveToken: s.pendingSaveToken, saveFacet: s.pendingSaveFacet, saveAuth: 0,
      pendingSaveToken: 0, pendingSaveFacet: "" }
  else { ...s, pendingSaveToken: 0, pendingSaveFacet: "" }
pure def canReviewSave(s: NativeAutofill, token: int, userChoseSave: bool): bool =
  s.save == ReviewingSave and token == s.saveToken and userChoseSave and s.prompt == 0
pure def reviewSave(s: NativeAutofill, token: int, userChoseSave: bool): NativeAutofill =
  { ...s, save: UnlockingSave, auth: s.auth + 1, prompt: s.auth + 1, saveAuth: s.auth + 1 }
pure def canFinishSavePrompt(s: NativeAutofill, authTicket: int): bool =
  s.save == UnlockingSave and authTicket == s.auth and authTicket == s.saveAuth and authTicket == s.prompt
pure def finishSavePrompt(s: NativeAutofill, authTicket: int, granted: bool): NativeAutofill =
  { ...s, prompt: 0, save: if (granted) WritingSave else ReviewingSave }
pure def canSettleSave(s: NativeAutofill, token: int, liveGrant: bool, capturedFacet: str): bool =
  s.save == WritingSave and s.saveToken == token and s.auth == s.saveAuth and liveGrant and capturedFacet == s.saveFacet
pure def settleSave(s: NativeAutofill, token: int, liveGrant: bool, capturedFacet: str, persisted: bool): NativeAutofill =
  { ...s, save: NoSave, saveToken: 0, saveFacet: "", saveAuth: 0, saved: if (persisted) s.saved + 1 else s.saved }
pure def canRetireSave(s: NativeAutofill): bool = s.save != NoSave
pure def retireSave(s: NativeAutofill): NativeAutofill =
  { ...s, save: NoSave, saveToken: 0, saveFacet: "", saveAuth: 0, prompt: if (s.save == UnlockingSave and s.prompt == s.saveAuth) 0 else s.prompt }
pure def canLockAutofill(s: NativeAutofill): bool = s.fill != NoFill or s.save != NoSave or s.pendingSaveToken > 0
pure def lockAutofill(s: NativeAutofill): NativeAutofill =
  { ...s, auth: s.auth + 1, prompt: 0, fill: NoFill, fillToken: 0, fillFacet: "", fillFields: "", fillAuth: 0,
    save: if (s.save == UnlockingSave) ReviewingSave else s.save, pendingSaveToken: 0, pendingSaveFacet: "" }
pure def canLoseProcess(s: NativeAutofill): bool = canLockAutofill(s) or s.prompt > 0
pure def loseProcess(s: NativeAutofill): NativeAutofill =
  { ...s, auth: s.auth + 1, prompt: 0, fill: NoFill, fillToken: 0, fillFacet: "", fillFields: "", fillAuth: 0,
    save: NoSave, saveToken: 0, saveFacet: "", saveAuth: 0, pendingSaveToken: 0, pendingSaveFacet: "" }
pure val capturedFacetValues = Set("https://first.test", "https://first.test:8443")
pure val weight_offerSave = 5
pure val weight_openSave = 16
pure val weight_reviewSave = 24
pure val weight_finishSavePrompt = 28
pure val weight_settleSave = 38
pure def alwaysSaveWriteHasFreshGrantIdentity(s: NativeAutofill): bool =
  (s.save == UnlockingSave or s.save == WritingSave) implies s.saveAuth > 0 and s.saveToken > 0 and s.saveFacet != ""
pure def alwaysSaveReviewHasCapturedFacet(s: NativeAutofill): bool = s.save != NoSave implies s.saveToken > 0 and s.saveFacet != ""
pure def alwaysPendingSaveHasCapturedFacet(s: NativeAutofill): bool = s.pendingSaveToken > 0 implies s.pendingSaveFacet != ""
```

### The pending save challenge remains the current native prompt

Discovered by the proof: a save-review phase with an unrelated current
prompt would permit a stale native callback to stand in for the original
confirmation. The installed grant service reserves only one prompt and
matches its generation until completion, cancellation or lock.

```quint
pure def alwaysSaveChallengeOwnsPrompt(s: NativeAutofill): bool = s.save == UnlockingSave implies s.prompt == s.saveAuth and s.prompt == s.auth
pure def stepSavedNeedsConfirmedWrite(before: NativeAutofill, via: str, after: NativeAutofill): bool =
  after.saved > before.saved implies via == "settleSave" and before.save == WritingSave and before.auth == before.saveAuth and after.save == NoSave
pure def lawExactDeadlineExpiresSave(created: int): bool = not(fresh(created, created + 300000, 300000))
pure def lawSaveUpdateRequiresFacetAndUsername(entryHasFacet: bool, exactUsername: bool): bool =
  saveChoice(entryHasFacet, exactUsername) == UpdateEntry implies entryHasFacet and exactUsername
pure def sometimesPersistsSave(s: NativeAutofill): bool = s.saved > 0
```
