# Android hosted Brief result notices

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` registers
`AlphaHostedResultsPlugin` from `MainActivity.java`. Its native producer
`HostedResultNotices.java` uses the `NoticeOwner` contract under
`plugins/plugin-native-notifications/android` at Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`.
The [hosted inbox](./hostedDigest.md) owns retained result and server
acknowledgment. The [renderer notice](./alpha/notices.md) owns navigation
and exact displayed history. This model follows one native notice route,
two distinct owner tuples and symbolic identities for retained bytes.
The port establishes exact provider and storage facts before each
transition.

## Story: Receive a private Brief notification for a result already in my history

### The route and retained result identify the only bytes eligible for posting

A route binds origin, owner, agent, scope, run, workflow and workflow
version. Scope is the lowercase SHA-256 digest of the JSON array of
origin, owner and agent. The notice key hashes scope, colon and run.
The run ID starts with an ASCII alphanumeric and continues with up
to 127 ASCII alphanumerics, underscores or dashes. The route fields
are nonblank and at most 2,048 UTF-16 units. The owner fence admits only
an exact three-field tuple. Origin has a 2,048-unit bound, owner and agent
128, and none permits NUL. An absent fence is the legacy unrestricted
case. A persistently signed-out fence never matches a route.

Publication checks the owner first. Next it requires run membership in
the scope's retained history index and the exact run, workflow and
version of the stored row. A digest covers the full retained result.
The source inbox accepts a newer reconciled terminal result in place of
a matching provisional cancellation. A different retained digest arms a
fresh notice under the same key and cancels the old OS tag first.
The same digest reads its receipt. Retained workflow output, source
names and notification digests do not appear in the notification.
A short title comes from the stored result status. The redacted public
version says “Alpha Phone” and “Tap to open.” The private notice survives
up to 24 hours. Only the currently displayed scope posts silently, without
changing channel settings. The model takes exact route validation, digest
identity and the current platform permission as port facts.

```quint
type OwnerFence = OwnerUninitialized | OwnerFirst | OwnerSecond | OwnerSignedOut
type ResultPhase = ResultAbsent | ResultDispatching | ResultPosted | ResultUncertain | ResultDenied | ResultOpened | ResultWithdrawn
type TapKind = NoResultTap | OpenResultTap | AskResultTap
type ResultNotice = { fence: OwnerFence, owner: OwnerFence, digest: int, phase: ResultPhase, dispatchPermit: bool,
  tokenSerial: int, tapToken: int, tapKind: TapKind }
pure val initial: ResultNotice = { fence: OwnerUninitialized, owner: OwnerFirst, digest: 0, phase: ResultAbsent,
  dispatchPermit: false, tokenSerial: 0, tapToken: 0, tapKind: NoResultTap }
pure def matchesFence(fence: OwnerFence, routeOwner: OwnerFence): bool =
  (routeOwner == OwnerFirst or routeOwner == OwnerSecond) and
    (fence == OwnerUninitialized or fence == routeOwner)
pure def currentRoute(s: ResultNotice): bool = s.digest > 0 and matchesFence(s.fence, s.owner)
pure def resultCanPost(fence: OwnerFence, routeOwner: OwnerFence, validRoute: bool, retainedExact: bool): bool =
  matchesFence(fence, routeOwner) and validRoute and retainedExact
pure def silencesResult(routeScope: int, showingScope: int): bool = routeScope > 0 and showingScope == routeScope
pure def lawSignedOutCannotPost(routeOwner: OwnerFence, validRoute: bool, retainedExact: bool): bool =
  not(resultCanPost(OwnerSignedOut, routeOwner, validRoute, retainedExact))
pure def lawSilenceIsScopeLocal(routeScope: int, showingScope: int): bool =
  silencesResult(routeScope, showingScope) implies routeScope == showingScope
```

### A committed dispatch can be recovered by its own platform ID only

Publishing an allowed record first commits dispatching with a fresh
dispatch ID. Only that live attempt can post it. A crash or interrupted
post leaves an uncertain reservation. A repeated request reads Android
for the exact key and dispatch ID, records posted only if both match,
otherwise records uncertain, and does not post. A stale tag from an
earlier dispatch cannot prove the new outcome. Permission denied before
reservation persists denied without posting. A thrown OS permission
exception settles denied from a live reservation. A write fault can
leave the row dispatching even though Android already posted.
Successful live post settles posted without an extra active readback.
The model distinguishes interruption, successful return and exact
recovery evidence. Platform effects remain outside the durable reducer.

A newly armed row can retire the oldest uncaptured notice before saving
within the 200-row bound, preserving the new row and the currently
captured tap. It can also supersede posted, uncaptured rows for the same
scope and workflow. Those cancel calls precede the new ledger commit as
written in the pinned source. A storage fault can leave the metadata
with a canceled OS notice. Retained inbox rows are independent. The
count guard expresses the new row and pending exemption separately
from the representative route.

```quint
type ArmEvidence = { routeOwner: OwnerFence, digestId: int, validRoute: bool, retainedExact: bool, permitted: bool, stored: bool }
pure val firstArm: ArmEvidence = { routeOwner: OwnerFirst, digestId: 1, validRoute: true, retainedExact: true, permitted: true, stored: true }
pure val armValues = Set(firstArm, { ...firstArm, digestId: 2 }, { ...firstArm, permitted: false },
  { ...firstArm, routeOwner: OwnerSecond }, { ...firstArm, validRoute: false },
  { ...firstArm, retainedExact: false }, { ...firstArm, stored: false })
pure def canArmResult(s: ResultNotice, arm: ArmEvidence): bool =
  resultCanPost(s.fence, arm.routeOwner, arm.validRoute, arm.retainedExact) and arm.digestId > 0 and
    (s.digest == 0 or (s.owner == arm.routeOwner and s.digest != arm.digestId))
pure def armResult(s: ResultNotice, arm: ArmEvidence): ResultNotice =
  if (arm.stored) { ...s, owner: arm.routeOwner, digest: arm.digestId,
    phase: if (arm.permitted) ResultDispatching else ResultDenied, dispatchPermit: arm.permitted }
  else s
type DispatchOutcome = PostedReturn | PermissionRefusal | InexactActiveRecovery | ExactActiveRecovery | DispatchInterrupted
pure def canFinishResult(s: ResultNotice, dispatchOutcome: DispatchOutcome): bool =
  currentRoute(s) and s.phase == ResultDispatching and
    (if (s.dispatchPermit) dispatchOutcome == PostedReturn or dispatchOutcome == PermissionRefusal or dispatchOutcome == DispatchInterrupted
     else dispatchOutcome == ExactActiveRecovery or dispatchOutcome == InexactActiveRecovery)
pure def finishResult(s: ResultNotice, dispatchOutcome: DispatchOutcome, stored: bool): ResultNotice =
  if (not(stored) or dispatchOutcome == DispatchInterrupted) { ...s, dispatchPermit: false }
  else { ...s, dispatchPermit: false,
    phase: if (dispatchOutcome == PostedReturn or dispatchOutcome == ExactActiveRecovery) ResultPosted
      else if (dispatchOutcome == PermissionRefusal) ResultDenied else ResultUncertain }
pure def mayEvictResult(ledgerRows: int, nominatedNew: bool, captured: bool): bool =
  ledgerRows > 200 and not(nominatedNew) and not(captured)
pure def lawEvictionKeepsPendingAndReplacement(ledgerRows: int, nominatedNew: bool): bool =
  not(mayEvictResult(ledgerRows, nominatedNew, true) or mayEvictResult(ledgerRows, true, nominatedNew))
pure def maySupersedeResult(sameScope: bool, sameWorkflow: bool, earlierPhase: ResultPhase, captured: bool): bool =
  sameScope and sameWorkflow and earlierPhase == ResultPosted and not(captured)
pure def lawSupersessionKeepsCapturedResult(sameScope: bool, sameWorkflow: bool, earlierPhase: ResultPhase): bool =
  not(maySupersedeResult(sameScope, sameWorkflow, earlierPhase, true))
pure def alwaysDispatchPermitIsCurrent(s: ResultNotice): bool =
  s.dispatchPermit implies s.phase == ResultDispatching and currentRoute(s)
pure def alwaysResultPhaseHasDigest(s: ResultNotice): bool =
  s.digest >= 0 and (s.phase == ResultAbsent) == (s.digest == 0)
pure def sometimesUncertainDispatch(s: ResultNotice): bool = s.phase == ResultUncertain
pure val weight_armResult = 8
pure val weight_finishResult = 9
```

## Story: Open or dismiss only the result and tap I still own

### Readback distinguishes an authorized route from exact retained bytes

Native capture accepts a valid key for a posted row under the current
owner. It preserves the token for the same key and action again, and
generates a fresh token for a different capture. Warm intents are held
in the bridge until capture writes. It retries the last uncommitted
intent on resume and pending read. Bridge work is serialized. Posted
phase, rather than an Android active-list query, admits a native Ask
capture. The installed Ask action requires authentication on Android 31
and newer. The bridge checks the current activity, focus and unlocked
state on the main thread before pending, consume or release. Locked and
destroyed activity paths reject; the renderer still owns exact current
binding and fresh result verification.

Readback removes digest, dispatch ID, creation time and phase. With
an exact current owner it returns the route, token, Ask flag and
`retained`, even when the row was opened by a separate acknowledgment.
The retained bit checks the current stored bytes against the recorded
digest. An inexact or absent row is unavailable to the renderer.
The token can be stored even when the next read of retained bytes fails.

```quint
pure def canCaptureResult(s: ResultNotice, nextTap: TapKind): bool =
  currentRoute(s) and s.phase == ResultPosted and nextTap != NoResultTap
pure def captureResult(s: ResultNotice, nextTap: TapKind): ResultNotice =
  if (s.tapKind == nextTap) s
  else { ...s, tapKind: nextTap, tokenSerial: s.tokenSerial + 1, tapToken: s.tokenSerial + 1 }
type TapReadback = TapHidden | TapRouteOnly | TapExactResult
pure def resultTapReadback(s: ResultNotice, foreground: bool, digestVerified: bool): TapReadback =
  if (not(foreground and currentRoute(s) and s.tapToken > 0)) TapHidden
  else if (digestVerified) TapExactResult else TapRouteOnly
pure def alwaysTapHasLedgerIdentity(s: ResultNotice): bool =
  s.tapToken >= 0 and s.tapToken <= s.tokenSerial and
    ((s.tapToken == 0) == (s.tapKind == NoResultTap)) and (s.tapToken > 0 implies s.digest > 0)
pure def sometimesCurrentAsk(s: ResultNotice): bool = currentRoute(s) and s.tapKind == AskResultTap
pure val weight_captureResult = 6
```

### Owner fencing is durable before cleanup and token settlement has two writes

An owner change writes the fence first, then marks each foreign row
withdrawn, saves the ledger, cancels the exact OS key and clears its
pending tap. A row or token can survive a failed cleanup. Readback and
settlement reject it under the changed owner immediately. The pinned
fence compares tuples. If an identical tuple later returns before
cleanup, that tuple can again see or settle a surviving token. The
native source has no generation field for distinguishing that case.

A visible-scope acknowledgment only marks matching posted, dispatching
or uncertain rows opened, commits first and then cancels the OS keys.
It accepts at most 200 run IDs and leaves captured taps pending.
Ask Release clears the exact pending Ask token and keeps the row.
Consume requires the exact current token and owner, saves the opened row
first, clears the pending slot second and then cancels Android. A fault
can leave an opened row and the old pending token, or can leave Android
showing a notice whose token was durably removed. The foreground and
token checks precede both settlement paths.

```quint
pure def canChangeResultOwner(s: ResultNotice, nextOwner: OwnerFence): bool =
  nextOwner != OwnerUninitialized and nextOwner != s.fence
pure def changeResultOwner(s: ResultNotice, nextOwner: OwnerFence): ResultNotice =
  { ...s, fence: nextOwner, dispatchPermit: s.dispatchPermit and matchesFence(nextOwner, s.owner) }
pure def canCleanForeignResult(s: ResultNotice): bool = s.digest > 0 and not(currentRoute(s))
type CleanupEvidence = CleanupBeforeLedger | CleanupBeforePending | CleanupComplete
pure def cleanForeignResult(s: ResultNotice, cleanup: CleanupEvidence): ResultNotice =
  if (cleanup == CleanupBeforeLedger) s
  else { ...s, phase: ResultWithdrawn, dispatchPermit: false,
    tapToken: if (cleanup == CleanupComplete) 0 else s.tapToken,
    tapKind: if (cleanup == CleanupComplete) NoResultTap else s.tapKind }
pure def canAcknowledgeVisibleResult(s: ResultNotice, exactListedRun: bool): bool =
  currentRoute(s) and exactListedRun and (s.phase == ResultPosted or s.phase == ResultDispatching or s.phase == ResultUncertain)
pure def acknowledgeVisibleResult(s: ResultNotice, exactListedRun: bool, stored: bool): ResultNotice =
  if (stored) { ...s, phase: ResultOpened, dispatchPermit: false } else s
pure def authorizesTapSettlement(s: ResultNotice, token: int, foreground: bool): bool =
  foreground and currentRoute(s) and s.tapToken > 0 and s.tapToken == token
pure def canReleaseResultAsk(s: ResultNotice, token: int, foreground: bool): bool =
  authorizesTapSettlement(s, token, foreground) and s.tapKind == AskResultTap
pure def releaseResultAsk(s: ResultNotice, token: int, foreground: bool, stored: bool): ResultNotice =
  if (stored) { ...s, tapToken: 0, tapKind: NoResultTap } else s
pure def canConsumeResultTap(s: ResultNotice, token: int, foreground: bool): bool =
  authorizesTapSettlement(s, token, foreground)
type ConsumeEvidence = ConsumeBeforeLedger | ConsumeBeforePending | ConsumePendingCleared
pure def consumeResultTap(s: ResultNotice, token: int, foreground: bool, consumeEvidence: ConsumeEvidence): ResultNotice =
  if (consumeEvidence == ConsumeBeforeLedger) s
  else { ...s, phase: ResultOpened, dispatchPermit: false,
    tapToken: if (consumeEvidence == ConsumePendingCleared) 0 else s.tapToken,
    tapKind: if (consumeEvidence == ConsumePendingCleared) NoResultTap else s.tapKind }
pure def stepVisibleAcknowledgmentKeepsTap(before: ResultNotice, via: str, after: ResultNotice): bool =
  via == "acknowledgeVisibleResult" implies before.tapToken == after.tapToken and before.tapKind == after.tapKind
pure def stepAskReleaseKeepsLedger(before: ResultNotice, via: str, after: ResultNotice): bool =
  via == "releaseResultAsk" implies before.digest == after.digest and before.phase == after.phase
pure def lawForeignTapHidden(s: ResultNotice, foreground: bool, digestVerified: bool): bool =
  not(currentRoute(s)) implies resultTapReadback(s, foreground, digestVerified) == TapHidden
pure def sometimesForeignTapSurvives(s: ResultNotice): bool = s.tapToken > 0 and not(currentRoute(s))
pure def sometimesOpenedWithPendingTap(s: ResultNotice): bool = s.phase == ResultOpened and s.tapToken > 0
pure val tokenValues = Set(0, 1, 2)
pure val weight_changeResultOwner = 2
pure val weight_consumeResultTap = 4
pure val weight_releaseResultAsk = 4
```

The pinned `test/quint-native-hosted-result-notices.test.mjs` runs the
real Java ledger and Eliza owner contract with synthetic platform and
Capacitor ports. It exercises interrupted dispatch, exact active
readback, same-tag replacement, partial withdrawal, durable pending
settlement and the 200-row limit. `test/hosted-notice-withdraw.test.mjs`
observes visible-run acknowledgment and silent post. Android installed
notification and lock-screen delivery require device evidence.
