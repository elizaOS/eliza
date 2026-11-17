# Maps guidance recovery

While guiding along an unchanged route, the next maneuver is passed only
on evidence: a position near it, or two usable fixes that have cleared
it. One clearing fix is not enough, a position that is off the route or
behind it resets the evidence, and a passed maneuver stays passed. The
distance and accuracy facts come from the route projection.
[Maps navigation](./navigation.md) owns the route; [guidance
speech](./guidanceVoice.md) speaks the step this selects.

## Story: Move on to the next step only when I have really passed the turn

> As a driver, I want guidance to move to the next step when I have
> passed the turn, and not because of one stray location fix.

### A maneuver is passed only on a nearby position or two clearing fixes

The route has a pending maneuver and, after it, the arrival step. A
position near the maneuver passes it. A usable fix past it counts once;
a second one passes it. A position off the route or behind the maneuver
clears the count. Guidance never goes beyond the arrival step.

```quint
type GuidanceStep = PendingManeuver | ArrivalStep
type PassEvidence = NoEvidence | NearManeuver | OneClearFix | TwoClearFixes
type GuidanceProgress = { step: GuidanceStep, cleared: int, evidence: PassEvidence }
pure val initial: GuidanceProgress = { step: PendingManeuver, cleared: 0, evidence: NoEvidence }
pure def canNearPosition(s: GuidanceProgress): bool = s.step == PendingManeuver
pure def nearPosition(s: GuidanceProgress): GuidanceProgress = { step: ArrivalStep, cleared: 0, evidence: NearManeuver }
pure def canClearFix(s: GuidanceProgress): bool = s.step == PendingManeuver
pure def clearFix(s: GuidanceProgress): GuidanceProgress =
  if (s.cleared == 1) { step: ArrivalStep, cleared: 0, evidence: TwoClearFixes }
  else { ...s, cleared: 1, evidence: OneClearFix }
pure def canResetEvidence(s: GuidanceProgress): bool = s.step == PendingManeuver
pure def resetEvidence(s: GuidanceProgress): GuidanceProgress = { ...s, cleared: 0, evidence: NoEvidence }
pure def alwaysOneClearRetainsManeuver(s: GuidanceProgress): bool =
  (s.evidence == OneClearFix implies s.step == PendingManeuver and s.cleared == 1) and s.cleared >= 0 and s.cleared <= 1
pure def alwaysAdvancingHasEvidence(s: GuidanceProgress): bool =
  s.step == ArrivalStep implies (s.evidence == NearManeuver or s.evidence == TwoClearFixes)
pure def sometimesPassedOnTwoFixes(s: GuidanceProgress): bool = s.evidence == TwoClearFixes
pure def sometimesPassedNearby(s: GuidanceProgress): bool = s.evidence == NearManeuver
```

### A passed maneuver stays passed

Once guidance has moved to the arrival step, no later fix moves it back
to the maneuver.

```quint
pure def stepPassedStaysPassed(before: GuidanceProgress, after: GuidanceProgress): bool =
  before.step == ArrivalStep implies after.step == ArrivalStep
```
