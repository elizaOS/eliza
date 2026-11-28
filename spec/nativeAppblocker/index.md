# Native app blocking

Android uses Usage Access and overlay permission. iOS uses Family Controls and the person's picker. The browser fallback exposes an unavailable engine. See also [Session](./session.md).

## Story: Block only the apps I selected for a chosen interval

> As the owner, I want a platform-accepted app selection and a clear expiry for a timed block.

### A block needs the selected app identities and its engine's current grants

The source bridge discovers installed Android apps or receives opaque iOS picker tokens. The adapter identifies tokens without exposing their contents and reports a permission prompt, a settings handoff or an acceptance independently.

```quint
type AppBlockEngine = UsageOverlay | FamilyControls | NoAppBlock
type BlockGrant = { usageAllowed: bool, overlayAllowed: bool, familyAllowed: bool }
type AppSelection = { installedIds: Set[str], pickedTokens: Set[str] }
type AppBlockInterval = IndefiniteAppBlock | TimedAppBlock({ deadline: int })
pure def hasAppBlockGrant(engine: AppBlockEngine, grant: BlockGrant): bool =
  (engine == UsageOverlay and grant.usageAllowed and grant.overlayAllowed) or
  (engine == FamilyControls and grant.familyAllowed)
pure def validAppSelection(engine: AppBlockEngine, selection: AppSelection): bool =
  (engine == UsageOverlay and selection.installedIds.size() > 0 and selection.pickedTokens.size() == 0) or
  (engine == FamilyControls and selection.pickedTokens.size() > 0 and selection.installedIds.size() == 0)
pure def appBlockInForce(interval: AppBlockInterval, nowMs: int): bool = match interval {
  | IndefiniteAppBlock => true
  | TimedAppBlock(window) => nowMs >= 0 and nowMs < window.deadline
}
pure def mayStartAppBlock(engine: AppBlockEngine, grant: BlockGrant, selection: AppSelection, interval: AppBlockInterval, nowMs: int): bool =
  hasAppBlockGrant(engine, grant) and validAppSelection(engine, selection) and appBlockInForce(interval, nowMs)
pure def lawExpiredAppBlockIsInactive(deadline: int, nowMs: int): bool =
  nowMs >= deadline implies not(appBlockInForce(TimedAppBlock({ deadline: deadline }), nowMs))
pure def lawUnavailableAppBlockCannotStart(grant: BlockGrant, selection: AppSelection, interval: AppBlockInterval, nowMs: int): bool =
  not(mayStartAppBlock(NoAppBlock, grant, selection, interval, nowMs))
pure val grantValues = Set(
  { usageAllowed: true, overlayAllowed: true, familyAllowed: false },
  { usageAllowed: true, overlayAllowed: false, familyAllowed: false },
  { usageAllowed: false, overlayAllowed: false, familyAllowed: true })
pure val selectionValues = Set(
  { installedIds: Set("com.example.app"), pickedTokens: Set() },
  { installedIds: Set(), pickedTokens: Set("family-selection-token") },
  { installedIds: Set(), pickedTokens: Set() })
pure val intervalValues = Set(IndefiniteAppBlock, TimedAppBlock({ deadline: 5000 }), TimedAppBlock({ deadline: 0 }))
pure val nowMsValues = Set(0, 4999, 5000, 10000)
```
