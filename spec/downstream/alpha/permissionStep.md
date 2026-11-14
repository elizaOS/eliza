# Shared permission step consumed by Alpha setup

Alpha binds `PermissionStepBridge`, `PermissionStepState`,
`createPermissionStepFlow`, `walkthroughMemory`, `photoLibraryAccess`, and
`locationAccess` from Eliza's
`packages/ui/src/components/permissions/permission-walkthrough.ts`.
The renderer owns the ordered walkthrough and its UI progress. Each bridge
owns its live permission result. Permission values returned after an
unmount, owner change, cancel, or superseding read belong to their original
request and may not publish into the latest slot.

## Story: Request access only after the owner's explicit tap

### A tap rechecks access and dispatches at most one OS prompt per memory lifetime

An access observation is ready only with a valid response that is granted
and enabled. A previously attempted permission, a disabled grant, a
reported denial, or an explicitly nonrequestable result routes to Settings.
A malformed/read failure is unavailable. Refresh reads status without
prompting, and returns no answer while a tap owns the pending slot. A tap
first reads status, records the attempt before requesting, then checks
status again after the platform operation. A failed memory write retains the
in-memory attempt until remount; a persisted attempt survives remount.
Neither a stored attempt nor visiting Settings grants permission.

```quint
type AccessFacts = { valid: bool, granted: bool, enabled: bool, denied: bool, requestable: bool }
type AccessResult = Checking | Available | Ask | OpenSettings | Unavailable
pure def accessResult(access: AccessFacts, attempted: bool): AccessResult =
  if (not(access.valid)) Unavailable else if (access.granted and access.enabled) Available
  else if (attempted or access.granted or access.denied or not(access.requestable)) OpenSettings else Ask
pure val accessValues = Set(
  { valid: true, granted: false, enabled: false, denied: false, requestable: true },
  { valid: true, granted: true, enabled: true, denied: false, requestable: true },
  { valid: true, granted: true, enabled: false, denied: false, requestable: true },
  { valid: true, granted: false, enabled: false, denied: true, requestable: false },
  { valid: false, granted: false, enabled: false, denied: false, requestable: false }
)
pure def lawAvailableRequiresObservedAccess(access: AccessFacts, attempted: bool): bool =
  accessResult(access, attempted) == Available implies access.valid and access.granted and access.enabled
pure def lawAttemptForbidsAnotherPrompt(access: AccessFacts): bool = accessResult(access, true) != Ask

type StepPhase = Idle | RefreshRead | TapRead | RequestNext | SettingsNext | RequestRunning | SettingsRunning | FinalRead
type PermissionStep = { epoch: int, phase: StepPhase, access: AccessResult, attempted: bool, persisted: bool, requests: int, settings: int }
pure val initial: PermissionStep = { epoch: 0, phase: Idle, access: Checking, attempted: false, persisted: false, requests: 0, settings: 0 }
pure def pendingTap(s: PermissionStep): bool = s.phase != Idle and s.phase != RefreshRead
pure def canRefresh(s: PermissionStep): bool = not(pendingTap(s))
pure def refresh(s: PermissionStep): PermissionStep = { ...s, epoch: s.epoch + 1, phase: RefreshRead }
pure def canEnable(s: PermissionStep): bool = not(pendingTap(s))
pure def enable(s: PermissionStep): PermissionStep = { ...s, epoch: s.epoch + 1, phase: TapRead }
pure def tappingRead(s: PermissionStep): bool = s.phase == TapRead or s.phase == FinalRead or s.phase == RefreshRead
pure def canObserveStatus(s: PermissionStep, ticket: int): bool = tappingRead(s) and ticket == s.epoch
pure def observeStatus(s: PermissionStep, ticket: int, access: AccessFacts): PermissionStep = {
  val answer = accessResult(access, s.attempted)
  { ...s, access: answer, phase:
    if (s.phase != TapRead) Idle else if (answer == Ask) RequestNext
    else if (answer == OpenSettings) SettingsNext else FinalRead }
}
pure def canRequestAccess(s: PermissionStep): bool = s.phase == RequestNext and not(s.attempted)
pure def requestAccess(s: PermissionStep, writeOk: bool): PermissionStep =
  { ...s, phase: RequestRunning, attempted: true, persisted: s.persisted or writeOk, requests: s.requests + 1 }
pure def canVisitSettings(s: PermissionStep): bool = s.phase == SettingsNext
pure def visitSettings(s: PermissionStep): PermissionStep =
  { ...s, phase: SettingsRunning, settings: s.settings + 1 }
pure def canSettlePlatform(s: PermissionStep, ticket: int): bool =
  ticket == s.epoch and (s.phase == RequestRunning or s.phase == SettingsRunning)
pure def settlePlatform(s: PermissionStep, ticket: int, readAgain: bool): PermissionStep =
  if (readAgain) { ...s, phase: FinalRead } else { ...s, phase: Idle, access: Unavailable }
pure def cancel(s: PermissionStep): PermissionStep = { ...s, epoch: s.epoch + 1, phase: Idle }
pure def remount(s: PermissionStep): PermissionStep =
  { ...s, epoch: s.epoch + 1, phase: Idle, access: Checking, attempted: s.persisted, requests: 0, settings: 0 }
pure def alwaysStoredAttemptsAreRetained(s: PermissionStep): bool = s.persisted implies s.attempted
pure def alwaysOneSessionPrompt(s: PermissionStep): bool = s.requests >= 0 and s.requests <= 1 and (s.requests > 0 implies s.attempted)
pure def alwaysPendingPromptIsUnattempted(s: PermissionStep): bool = s.phase == RequestNext implies not(s.attempted) and s.access == Ask
pure def alwaysPendingSettingsHasSettingsResult(s: PermissionStep): bool = s.phase == SettingsNext implies s.access == OpenSettings
pure def alwaysEpochIsNonnegative(s: PermissionStep): bool = s.epoch >= 0
pure def stepRequestsRequireOwnedPreflight(before: PermissionStep, via: str, after: PermissionStep): bool =
  after.requests > before.requests implies via == "requestAccess" and before.phase == RequestNext and before.access == Ask and not(before.attempted)
pure def stepDurableAttemptCannotRegress(before: PermissionStep, after: PermissionStep): bool = before.persisted implies after.persisted
pure def sometimesRequests(s: PermissionStep): bool = s.phase == RequestRunning and s.requests == 1
pure def sometimesUsesSettings(s: PermissionStep): bool = s.phase == SettingsRunning
pure def sometimesReportsReady(s: PermissionStep): bool = s.phase == Idle and s.access == Available
pure def sometimesAttemptsWithoutPersistence(s: PermissionStep): bool = s.requests == 1 and not(s.persisted)
pure val ticketValues = Set(0, 1, 2, 3, 4, 5, 6)
```
