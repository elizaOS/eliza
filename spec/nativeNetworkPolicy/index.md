# Native network cost hints

Android's native active-network policy stays with [the OS bridge](../os/android/networkPolicy.md). This package's boundary also translates the iOS path monitor and browser data-saver hints for the local inference updater.

## Story: Check the cost of the active connection before a passive download

> As the device owner, I want the updater to respect both metering and reduced-data preferences, so an unavailable hint cannot authorize a large download.

### Only an authoritative answer proves an unrestricted path

The adapter normalizes explicitly reported false and true separately from a missing result. Android's transport name is immaterial. On iOS an expensive or constrained path limits use, and both facts must be explicitly false to establish an unrestricted path. The web data-saver hint can restrict an otherwise unknown path.

```quint
type Hint = HintUnknown | HintNo | HintYes
type NetworkCost = CostUnknown | Unrestricted | Restricted
pure def androidCost(isMetered: Hint): NetworkCost =
  if (isMetered == HintYes) Restricted else
  if (isMetered == HintNo) Unrestricted else CostUnknown
pure def appleCost(isExpensive: Hint, isConstrained: Hint): NetworkCost =
  if (isExpensive == HintYes or isConstrained == HintYes) Restricted else
  if (isExpensive == HintNo and isConstrained == HintNo) Unrestricted else CostUnknown
pure def webCost(isDataSaver: Hint): NetworkCost =
  if (isDataSaver == HintYes) Restricted else CostUnknown
pure def mayDownload(cost: NetworkCost, internetValidated: bool): bool =
  cost == Unrestricted and internetValidated
pure def lawDataSaverNeverAuthorizes(isDataSaver: Hint, internetValidated: bool): bool =
  not(mayDownload(webCost(isDataSaver), internetValidated))
pure def lawAppleRestrictionWins(isExpensive: Hint, isConstrained: Hint): bool =
  (isExpensive == HintYes or isConstrained == HintYes) implies appleCost(isExpensive, isConstrained) == Restricted
pure def lawUnconfirmedPathNeverAuthorizes(internetValidated: bool): bool =
  not(mayDownload(CostUnknown, internetValidated))
```
