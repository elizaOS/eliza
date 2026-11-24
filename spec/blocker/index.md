# Focus blocking

## Story: Block distractions for a chosen interval

> As the owner, I can enable an application or website block for chosen targets and see whether the device applied it.

### Only the owner can request a block for an explicit set of targets and a future deadline

The shell canonicalizes website domains, application identifiers, and the device account. The model is one active request per owner and block kind. The OS applies the actual policy and supplies the observation.

```quint
type BlockKind = WebsiteBlock | ApplicationBlock
type BlockPhase = BlockIdle | ApplyingBlock | Blocking | ClearingBlock | BlockFailed
type FocusBlock = { phase: BlockPhase, ownerId: str, blockKind: BlockKind, targets: Set[str], generation: int, expiry: int }
pure val initial: FocusBlock = { phase: BlockIdle, ownerId: "", blockKind: WebsiteBlock, targets: Set(), generation: 0, expiry: 0 }
pure val ownerIdValues = Set("me", "other")
pure val targetsValues = Set(Set("social.example"), Set("com.chat.app"), Set())
pure val nowValues = Set(10, 20, 30)
pure val deadlineValues = Set(20, 30)
pure val generationValues = Set(1, 2, 3)
pure def canRequestBlock(s: FocusBlock, ownerId: str, targets: Set[str], now: int, deadline: int, by: str): bool =
  (s.phase == BlockIdle or s.phase == BlockFailed) and by == ownerId and ownerId != "" and targets.size() > 0 and now >= 0 and deadline > now
pure def requestBlock(s: FocusBlock, ownerId: str, blockKind: BlockKind, targets: Set[str], now: int, deadline: int, by: str): FocusBlock =
  { phase: ApplyingBlock, ownerId: ownerId, blockKind: blockKind, targets: targets, generation: s.generation + 1, expiry: deadline }
pure def alwaysPendingBlockHasTargets(s: FocusBlock): bool =
  (s.phase == ApplyingBlock or s.phase == Blocking or s.phase == ClearingBlock) implies (s.targets.size() > 0 and s.ownerId != "" and s.expiry > 0)
```

### A requested app is named by the id its device installed, whatever its letter case

Android application ids are case-sensitive (Slack installs as `com.Slack`)
and the device blocks the foreground application id exactly, so the shell
reads the installed application ids before it requests an application
block and sends each requested id as the device installed it. An id that
is an installed id is kept. An id that matches exactly one installed id
apart from letter case becomes that installed id, so `com.slack` names an
installed `com.Slack`. An id that matches none, or that matches several
installed ids apart from letter case, is sent as given, and so is every
id when the installed applications cannot be read. The shell folds letter
case; website domains are lowercased and never read against installed
applications.

```quint
type InstalledApp = { appId: str, foldedId: str }
pure def installedAppId(requested: str, folded: str, installed: List[InstalledApp]): str = {
  val caseless = installed.select(app => app.foldedId == folded)
  if (installed.some(app => app.appId == requested)) requested
  else if (caseless.length() == 1) caseless.nthOr(0, { appId: requested, foldedId: folded }).appId
  else requested
}
pure val requestedValues = Set("com.slack", "com.Slack", "COM.EXAMPLE", "org.unknown")
pure val foldedValues = Set("com.slack", "com.example", "org.unknown")
pure val installedValues = Set(
  List(),
  List({ appId: "com.Slack", foldedId: "com.slack" }),
  List({ appId: "com.Example", foldedId: "com.example" }, { appId: "com.example", foldedId: "com.example" }),
  List({ appId: "com.slack", foldedId: "com.slack" }, { appId: "com.Slack", foldedId: "com.slack" }))
pure def lawAnInstalledIdIsKept(requested: str, folded: str, installed: List[InstalledApp]): bool =
  installed.some(app => app.appId == requested) implies installedAppId(requested, folded, installed) == requested
pure def lawAnIdIsInstalledOrAsGiven(requested: str, folded: str, installed: List[InstalledApp]): bool = {
  val sent = installedAppId(requested, folded, installed)
  sent == requested or installed.some(app => app.appId == sent and app.foldedId == folded)
}
pure def lawOnlyOneCaselessMatchIsTaken(requested: str, folded: str, installed: List[InstalledApp]): bool =
  installed.select(app => app.foldedId == folded).length() != 1 implies installedAppId(requested, folded, installed) == requested
```

### Observations and expiry callbacks only affect the matching generation

A declined or indeterminate device reply leaves a failure visible. Expiry dispatch belongs to the host scheduler. An expired callback for an earlier generation cannot clear a newer block.

```quint
pure def canObserveApplied(s: FocusBlock, generation: int, by: str): bool =
  s.phase == ApplyingBlock and generation == s.generation and by == "device"
pure def observeApplied(s: FocusBlock, generation: int, applied: bool, by: str): FocusBlock =
  { ...s, phase: if (applied) Blocking else BlockFailed }
pure def canRequestClear(s: FocusBlock, generation: int, now: int, by: str): bool =
  s.phase == Blocking and generation == s.generation and
  (by == s.ownerId or (by == "scheduler" and now >= s.expiry))
pure def requestClear(s: FocusBlock, generation: int, now: int, by: str): FocusBlock = { ...s, phase: ClearingBlock }
pure def canObserveCleared(s: FocusBlock, generation: int, by: str): bool =
  s.phase == ClearingBlock and generation == s.generation and by == "device"
pure def observeCleared(s: FocusBlock, generation: int, cleared: bool, by: str): FocusBlock =
  if (cleared) { ...initial, generation: s.generation } else { ...s, phase: Blocking }
pure def stepBlockGenerationDoesNotDecrease(before: FocusBlock, after: FocusBlock): bool = after.generation >= before.generation
pure def sometimesBlockApplied(s: FocusBlock): bool = s.phase == Blocking
pure def sometimesBlockCleared(s: FocusBlock): bool = s.phase == BlockIdle and s.generation > 0
pure val eval_witness_sometimesBlockCleared = (("requestBlock", "me", WebsiteBlock, Set("social.example"), 10, 20, "me"), ("observeApplied", 1, true, "device"), ("requestClear", 1, 20, "scheduler"), ("observeCleared", 1, true, "device"))
pure val byValues = Set("me", "other", "device", "scheduler")
```
