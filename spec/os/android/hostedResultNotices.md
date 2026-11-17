# Android hosted digest result notices

A consumer registers its hosted-results plugin, whose native producer
`HostedResultNotices.java` uses the `NoticeOwner` contract under
`plugins/plugin-native-notifications/android`. The
[hosted digest](../../workflow/hostedDigest.md) inbox owns retained
results and server acknowledgment. Posting, recovery and taps follow the shared
[notice ledger](./notificationProjection.md); this spec adds the owner
fence and digest identity that admit a hosted result to it. The model
follows one notice route and two owner tuples; route validation, digest
identity and the platform permission are port facts.

## Story: Receive a private hosted digest notification for a result already in my history

> As the person, I want a private notification for a hosted result that is
> already in my history, so that I learn it finished without its content
> showing on the lock screen.

### The route and retained result identify the only bytes eligible for posting

A route binds origin, owner, agent, scope, run, workflow and workflow
version. Scope is the lowercase SHA-256 of the JSON array of origin, owner
and agent, and the notice key hashes scope, a colon and run. A run ID
starts with an ASCII letter or digit followed by up to 127 ASCII letters,
digits, underscores or dashes. Every route field is nonblank, at most 2,048
UTF-16 units and free of NUL; owner and agent are at most 128. The owner fence holds one exact
signed-in tuple and a generation that every owner change advances. A route
is current only under the same tuple and generation it was armed under, so
an unset or signed-out fence never matches, and a tuple that signs out and
back in cannot see or settle a notice from before. Publication checks the
owner first, then run membership in the scope's retained history and the
exact run, workflow and version of the stored row. A different retained
digest arms a fresh notice under the same key after cancelling the old OS
tag, and no tap captured on the old digest can open it; the same digest
reads its receipt. The notice shows a short status
title and a redacted public version, never workflow output, source names or
digests, and lasts up to 24 hours. Only the scope currently on screen posts
silently.

```quint
import notificationProjection as N from "./notificationProjection"
type OwnerTuple = OwnerNone | OwnerFirst | OwnerSecond | OwnerSignedOut
type ResultNotice = { fenceOwner: OwnerTuple, fenceGeneration: int, owner: OwnerTuple, routeGeneration: int,
  digest: int, notice: N::NoticeLedger }
pure val initial: ResultNotice = { fenceOwner: OwnerNone, fenceGeneration: 0, owner: OwnerNone, routeGeneration: 0,
  digest: 0, notice: N::emptyNotice }
pure def signedIn(owner: OwnerTuple): bool = owner == OwnerFirst or owner == OwnerSecond
pure def currentRoute(s: ResultNotice): bool =
  s.digest > 0 and signedIn(s.owner) and s.owner == s.fenceOwner and s.routeGeneration == s.fenceGeneration
pure def resultCanPost(fenceOwner: OwnerTuple, routeOwner: OwnerTuple, validRoute: bool, retainedExact: bool): bool =
  signedIn(routeOwner) and routeOwner == fenceOwner and validRoute and retainedExact
pure def silencesResult(routeScope: int, showingScope: int): bool = routeScope > 0 and showingScope == routeScope
pure def lawUnsetOrSignedOutFenceCannotPost(routeOwner: OwnerTuple, validRoute: bool, retainedExact: bool): bool =
  not(resultCanPost(OwnerSignedOut, routeOwner, validRoute, retainedExact) or resultCanPost(OwnerNone, routeOwner, validRoute, retainedExact))
pure def canChangeResultOwner(s: ResultNotice, nextOwner: OwnerTuple): bool = nextOwner != OwnerNone and nextOwner != s.fenceOwner
pure def changeResultOwner(s: ResultNotice, nextOwner: OwnerTuple): ResultNotice =
  { ...s, fenceOwner: nextOwner, fenceGeneration: s.fenceGeneration + 1, notice: N::dropPermit(s.notice) }
pure def alwaysResultLedgerMatchesRoute(s: ResultNotice): bool =
  N::noticeLedgerValid(s.notice) and s.digest >= 0 and s.routeGeneration <= s.fenceGeneration and
  ((s.notice.phase == N::NoticeNone) == (s.digest == 0)) and (s.notice.permit implies currentRoute(s))
pure def stepReturningOwnerCannotRevive(before: ResultNotice, after: ResultNotice): bool =
  not(currentRoute(before)) and before.digest > 0 and before.digest == after.digest implies not(currentRoute(after))
```

### A hosted result arms its notice only under the current fence

Arming an allowed record reserves it in the notice ledger, dispatching or
declined by the platform permission; a failed ledger write arms nothing.
Settlement and recovery then follow the ledger's posting rule. A newly armed
row may retire the oldest uncaptured notice to stay within 200 rows, and may
supersede posted, uncaptured rows of the same scope and workflow; neither
touches the new row or a captured tap.

```quint
type ArmEvidence = { routeOwner: OwnerTuple, digestId: int, validRoute: bool, retainedExact: bool, permitted: bool, stored: bool }
pure val firstArm: ArmEvidence = { routeOwner: OwnerFirst, digestId: 1, validRoute: true, retainedExact: true, permitted: true, stored: true }
pure val armValues = Set(firstArm, { ...firstArm, digestId: 2 }, { ...firstArm, permitted: false },
  { ...firstArm, routeOwner: OwnerSecond }, { ...firstArm, validRoute: false },
  { ...firstArm, retainedExact: false }, { ...firstArm, stored: false })
pure def canArmResult(s: ResultNotice, arm: ArmEvidence): bool =
  resultCanPost(s.fenceOwner, arm.routeOwner, arm.validRoute, arm.retainedExact) and arm.digestId > 0 and
    (s.digest == 0 or (currentRoute(s) and s.owner == arm.routeOwner and s.digest != arm.digestId))
pure def armResult(s: ResultNotice, arm: ArmEvidence): ResultNotice =
  if (not(arm.stored)) s
  else { ...s, owner: arm.routeOwner, routeGeneration: s.fenceGeneration, digest: arm.digestId,
    notice: N::reserveNotice(N::rearmNotice(s.notice), arm.permitted) }
pure def canFinishResult(s: ResultNotice, settlement: N::PostSettlement): bool =
  currentRoute(s) and N::mayPostSettle(s.notice, settlement)
pure def finishResult(s: ResultNotice, settlement: N::PostSettlement, stored: bool): ResultNotice =
  { ...s, notice: N::settleNotice(s.notice, settlement, stored) }
pure def canInterruptResult(s: ResultNotice): bool = s.notice.permit
pure def interruptResult(s: ResultNotice): ResultNotice = { ...s, notice: N::dropPermit(s.notice) }
pure def mayEvictResult(ledgerRows: int, nominatedNew: bool, captured: bool): bool =
  ledgerRows > 200 and not(nominatedNew) and not(captured)
pure def lawEvictionKeepsPendingAndReplacement(ledgerRows: int, nominatedNew: bool): bool =
  not(mayEvictResult(ledgerRows, nominatedNew, true) or mayEvictResult(ledgerRows, true, nominatedNew))
pure def maySupersedeResult(sameScope: bool, sameWorkflow: bool, earlierPhase: N::NoticePhase, captured: bool): bool =
  sameScope and sameWorkflow and earlierPhase == N::NoticePosted and not(captured)
pure def lawSupersessionKeepsCapturedResult(sameScope: bool, sameWorkflow: bool, earlierPhase: N::NoticePhase): bool =
  not(maySupersedeResult(sameScope, sameWorkflow, earlierPhase, true))
pure def stepRearmClearsTap(before: ResultNotice, via: str, after: ResultNotice): bool =
  via == "armResult" and after.digest != before.digest implies after.notice.tapToken == 0
pure def sometimesUncertainDispatch(s: ResultNotice): bool = s.notice.phase == N::NoticeUnknown
```

## Story: Open or dismiss only the result and tap I still own

> As the person, I want a tap to open or dismiss only a result I still own,
> so that a notice from another account or session never acts for me.

### Readback distinguishes an authorized route from exact retained bytes

Capture admits a posted row under the current route; Ask is installed to
require device authentication. The bridge holds a warm intent until capture
writes, retries the last uncommitted intent on resume, and serializes its
work. Pending, consume and release run only for the current, focused,
unlocked activity. Readback under the current route returns the route,
token, Ask flag and whether the stored bytes still match the recorded
digest, and never the digest, dispatch ID, creation time or phase; any
other row is hidden from the renderer.

```quint
type TapReadback = TapHidden | TapRouteOnly | TapExactResult
pure def canCaptureResult(s: ResultNotice, ask: bool): bool = currentRoute(s) and s.notice.phase == N::NoticePosted
pure def captureResult(s: ResultNotice, ask: bool): ResultNotice = { ...s, notice: N::captureTap(s.notice, ask) }
pure def resultTapReadback(s: ResultNotice, foreground: bool, digestVerified: bool): TapReadback =
  if (not(foreground and currentRoute(s) and s.notice.tapToken > 0)) TapHidden
  else if (digestVerified) TapExactResult else TapRouteOnly
pure def lawForeignTapHidden(s: ResultNotice, foreground: bool, digestVerified: bool): bool =
  not(currentRoute(s)) implies resultTapReadback(s, foreground, digestVerified) == TapHidden
pure def sometimesCurrentAsk(s: ResultNotice): bool = currentRoute(s) and s.notice.tapAsk
```

### An owner change withdraws foreign rows, and taps settle only under the current route

After an owner change, cleanup marks each foreign row withdrawn, saves the
ledger, cancels its OS key and finally clears the row with its pending tap;
a failed step can leave a row or token behind, which the generation fence
already hides. A visible-scope acknowledgment marks at most 200 listed
posted, dispatching or uncertain rows opened and leaves captured taps
pending. Consume and Ask release follow the ledger's tap rule under the
current route and foreground activity.

```quint
type CleanupEvidence = CleanupBeforeLedger | CleanupBeforePending | CleanupComplete
pure def canCleanForeignResult(s: ResultNotice): bool = s.digest > 0 and not(currentRoute(s))
pure def cleanForeignResult(s: ResultNotice, cleanup: CleanupEvidence): ResultNotice =
  if (cleanup == CleanupBeforeLedger) s
  else if (cleanup == CleanupBeforePending) { ...s, notice: N::withdrawNotice(s.notice, false) }
  else { ...s, owner: OwnerNone, digest: 0, notice: { ...N::emptyNotice, tokenSerial: s.notice.tokenSerial } }
pure def canAcknowledgeVisibleResult(s: ResultNotice, exactListedRun: bool): bool =
  currentRoute(s) and exactListedRun and N::tapEligible(s.notice)
pure def acknowledgeVisibleResult(s: ResultNotice, exactListedRun: bool, stored: bool): ResultNotice =
  if (stored) { ...s, notice: N::markOpened(s.notice) } else s
pure def canReleaseResultAsk(s: ResultNotice, token: int, foreground: bool): bool =
  foreground and currentRoute(s) and N::tapMatches(s.notice, token) and s.notice.tapAsk
pure def releaseResultAsk(s: ResultNotice, token: int, foreground: bool, stored: bool): ResultNotice =
  if (stored) { ...s, notice: N::releaseTap(s.notice) } else s
pure def canConsumeResultTap(s: ResultNotice, token: int, foreground: bool): bool =
  foreground and currentRoute(s) and N::tapMatches(s.notice, token)
pure def consumeResultTap(s: ResultNotice, token: int, foreground: bool, write: N::TapWrite): ResultNotice =
  { ...s, notice: N::consumeTap(s.notice, write) }
pure def stepAskReleaseKeepsResult(before: ResultNotice, via: str, after: ResultNotice): bool =
  via == "releaseResultAsk" implies before.digest == after.digest and before.notice.phase == after.notice.phase
pure def stepVisibleAcknowledgmentKeepsTap(before: ResultNotice, via: str, after: ResultNotice): bool =
  via == "acknowledgeVisibleResult" implies before.notice.tapToken == after.notice.tapToken
pure def sometimesForeignTapSurvives(s: ResultNotice): bool = s.notice.tapToken > 0 and not(currentRoute(s))
pure def sometimesOpenedWithPendingTap(s: ResultNotice): bool = s.notice.phase == N::NoticeOpened and s.notice.tapToken > 0
pure val tokenValues = Set(0, 1, 2)
```
