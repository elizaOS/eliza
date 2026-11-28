# Goal grounding, prompt safety, and carve-out rules

Safety invariants for rendering untrusted goal and evidence values into
semantic-evaluation prompts, clamping evaluation scores, validating cadence
slots, and enforcing private-by-default goal metadata.

## Story: Keep goal evaluation prompts safe and goal metadata well formed

> As an owner, I want semantic goal reviews to fail closed on cyclic or deeply
> nested evidence, clamp scores into `[0, 1]`, reject duplicate cadence slot
> keys, and keep goal metadata private by default.

### Prompt value rendering fails closed on excessive depth, cycles, or hostile accessors

`formatPromptValue` walks goal and evidence structures up to a ceiling of 32
levels (`MAX_GOAL_PROMPT_VALUE_DEPTH`). Any value exceeding that depth,
containing an object cycle, or exposing a getter/setter or sparse array slot
fails closed with `GOAL_PROMPT_VALUE_UNBOUNDED`.

```quint
pure val maxPromptValueDepth = 32
type PromptValueCheck = PromptOk | PromptDepthExceeded | PromptCycleDetected | PromptHostileAccessor
pure def checkPromptValue(depth: int, hasCycle: bool, hasHostileAccessor: bool): PromptValueCheck =
  if (depth < 0 or depth > maxPromptValueDepth) PromptDepthExceeded
  else if (hasCycle) PromptCycleDetected
  else if (hasHostileAccessor) PromptHostileAccessor
  else PromptOk
pure val depthValues = Set(-1, 0, 16, 32, 33)
pure def lawDeepPromptValueFailsClosed(depth: int, hasCycle: bool, hasHostileAccessor: bool): bool =
  depth > maxPromptValueDepth implies checkPromptValue(depth, hasCycle, hasHostileAccessor) == PromptDepthExceeded
pure def lawCyclicPromptValueFailsClosed(depth: int, hasHostileAccessor: bool): bool =
  (depth >= 0 and depth <= maxPromptValueDepth) implies checkPromptValue(depth, true, hasHostileAccessor) == PromptCycleDetected
pure def lawHostileAccessorFailsClosed(depth: int): bool =
  (depth >= 0 and depth <= maxPromptValueDepth) implies checkPromptValue(depth, false, true) == PromptHostileAccessor
```

### Evaluation scores stay bounded in percent units and duplicate cadence slots are refused

Grounding confidence and semantic progress scores are clamped into the closed
unit interval (modeled here as integer basis points `0..1000`). A
`times_per_day` cadence with duplicate slot keys is refused at write time so no
declared check-in slot is silently overwritten. Goal metadata whose
`privacyClass` is empty or `"private"` blocks visibility in public contexts
(`metadataBlocksPublic`).

```quint
pure def clampUnitBps(scoreBps: int): int =
  if (scoreBps < 0) 0 else if (scoreBps > 1000) 1000 else scoreBps
pure def cadenceWriteAllowed(isTimesPerDay: bool, hasDuplicateSlotKey: bool): bool =
  not(isTimesPerDay and hasDuplicateSlotKey)
pure def metadataBlocksPublic(privacyClass: str): bool =
  privacyClass == "" or privacyClass == "private"
pure val scoreBpsValues = Set(-50, 0, 500, 1000, 1500)
pure val privacyClassValues = Set("", "private", "shared")
pure def lawClampedScoreWithinUnitInterval(scoreBps: int): bool =
  clampUnitBps(scoreBps) >= 0 and clampUnitBps(scoreBps) <= 1000
pure def lawDuplicateTimesPerDaySlotRefused(isTimesPerDay: bool): bool =
  isTimesPerDay implies not(cadenceWriteAllowed(isTimesPerDay, true))
pure def lawDefaultPrivacyBlocksPublicContext(privacyClass: str): bool =
  (privacyClass == "" or privacyClass == "private") implies metadataBlocksPublic(privacyClass)
```
