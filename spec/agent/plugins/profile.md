# Plugin plan

The plugins one agent process loads, in what order, and when the plan stops
boot. The launch names a load list, an optional product plugin, the privacy
switches, the allowed actions and an optional workflow worker; the bundle
says which plugins were compiled into it. Registration of each plugin is
core plugins' (`spec/core/plugins.md`); the action allowlist and its umbrella
rules are [action planning](../../core/actionPlanning.md), used here and not
restated. A refused plan ends the process with the `Config` exit class of
the launch (`spec/agent/host/launch.md`).

## Story: Load only the plugins my product lists

> As the maker of a product, I want my agent to load exactly the plugins my
> launch lists, so that no plugin I did not choose ever reaches my users.

### A load list names only plugins the bundle carries or the agent's own modules

The agent's own optional modules are named plugins like any other.
`@elizaos/agent/basic-actions` registers one action, `CALCULATE`: arithmetic
only, no I/O, for a User caller. Any other name refuses boot.

```quint
import actionPlanning as AP from "../../core/actionPlanning"
import authorization as Z from "../../core/authorization"
type ProductChoice = NoProduct | Product({ name: str })
type WorkerLaunch = NoWorkerNamed | WorkerNamed({ digest: str })
type WorkerState = NoWorker | Unverified({ expected: str }) | Verified({ pinned: str })
type PlanFailure = UnknownPlugin | ReservedPlugin | MissingProduct | RouteClaimed | StaleAllowlist | WorkerMismatch
type PlanPhase = Choosing | Registering | Ready | Refused({ cause: PlanFailure })
type ProcessValue = PlainSetting | DeviceCredential | LaunchToken | StorageKey
type ProductStep = NoProductPlugin | ProductPending({ name: str }) | ProductRegistered({ name: str })
type PluginPlan = { phase: PlanPhase, bundled: Set[str], privacyOn: bool, product: ProductStep, order: List[str], next: int, allowed: Set[str], actions: Set[str], moduleRoutes: Set[str], productRoutes: Set[str], worker: WorkerState, workerEnv: Set[ProcessValue], workerRuns: int }
pure val initial: PluginPlan = { phase: Choosing, bundled: Set(), privacyOn: false, product: NoProductPlugin, order: List(), next: 0, allowed: Set(), actions: Set(), moduleRoutes: Set(), productRoutes: Set(), worker: NoWorker, workerEnv: Set(), workerRuns: 0 }
pure val builtinModules = Set("@elizaos/agent/basic-actions", "@elizaos/agent/approvals", "@elizaos/agent/notifications", "@elizaos/agent/views", "@elizaos/agent/device-actions", "@elizaos/agent/reply-draft", "@elizaos/agent/triggers", "@elizaos/agent/scheduled-tasks", "@elizaos/agent/tasks", "@elizaos/agent/surface")
pure val calculateAction: AP::ActionDecl = { name: "CALCULATE", subactions: List(), minRole: Z::User }
pure def available(bundled: Set[str]): Set[str] = bundled.union(builtinModules)
pure def productName(product: ProductChoice): str = match product { | Product(p) => p.name | NoProduct => "" }
pure def lawUnknownPluginRefusesBoot(bundled: Set[str], load: List[str], product: ProductChoice): bool =
  load.some(n => not(available(bundled).contains(n))) implies planPhase(bundled, load, product) != Registering
pure def sometimesUnknownPluginRefused(s: PluginPlan): bool = s.phase == Refused({ cause: UnknownPlugin })
```

### Storage, the cloud link and the privacy service always load and cannot be listed

They are the agent's own; a load list that names one, or a product plugin
named like one of them or like an agent module, refuses boot.

```quint
pure def planPhase(bundled: Set[str], load: List[str], product: ProductChoice): PlanPhase = {
  val name = productName(product)
  if (load.some(n => fixedPlugins.contains(n)) or reserved(name)) Refused({ cause: ReservedPlugin })
  else if (load.some(n => not(available(bundled).contains(n)))) Refused({ cause: UnknownPlugin })
  else if (name != "" and not(bundled.contains(name))) Refused({ cause: MissingProduct })
  else Registering
}
pure val storagePlugin = "@elizaos/agent/storage"
pure val cloudLinkPlugin = "@elizaos/agent/cloud"
pure val privacyPlugin = "@elizaos/core/privacy"
pure val fixedPlugins = Set("@elizaos/agent/storage", "@elizaos/agent/cloud", "@elizaos/core/privacy")
pure def reserved(name: str): bool = fixedPlugins.contains(name) or builtinModules.contains(name)
pure def lawListedFixedPluginRefusesBoot(bundled: Set[str], load: List[str], product: ProductChoice): bool =
  load.some(n => fixedPlugins.contains(n)) implies planPhase(bundled, load, product) == Refused({ cause: ReservedPlugin })
pure def sometimesListedFixedPluginRefused(s: PluginPlan): bool = s.phase == Refused({ cause: ReservedPlugin })
```

### Storage loads first, then the cloud link, the privacy service, the listed plugins in order and the product plugin last

The privacy service is core's, in the launch's mode, and loads only when
either privacy switch is on. Each plugin registers through core plugins in
this order, one at a time, and the product plugin registers only after every
other plugin has. The plan starts from an admitted launch, which already
names each plugin once and never names the product plugin in the load list
(`spec/agent/host/launch.md`), so no plugin is planned twice.

```quint
pure val messageServiceActions = Set("REPLY", "IGNORE", "NONE")
pure def distinct(xs: List[str]): bool = xs.every(x => xs.select(y => y == x).length() == 1)
pure def planOrder(load: List[str], privacyOn: bool): List[str] =
  List(storagePlugin, cloudLinkPlugin).concat(if (privacyOn) List(privacyPlugin) else List()).concat(load)
pure val bundledValues = Set(Set("@elizaos/plugin-workflow", "product"), Set("@elizaos/plugin-workflow"))
pure val loadValues = Set(List(), List("@elizaos/agent/basic-actions"), List("@elizaos/agent/tasks", "@elizaos/plugin-workflow"), List("@elizaos/plugin-wallet"), List("@elizaos/agent/storage"))
pure val productValues = Set(NoProduct, Product({ name: "product" }), Product({ name: "@elizaos/agent/tasks" }))
pure val allowedValues = Set(Set("REPLY", "CALCULATE"), Set("REPLY", "PRODUCT_ACTION"), Set("REPLY", "RENAMED"))
pure val workerLaunchValues = Set(NoWorkerNamed, WorkerNamed({ digest: "aa" }))
pure def canChoosePlan(s: PluginPlan, bundled: Set[str], load: List[str], product: ProductChoice, privacyOn: bool, allowed: Set[str], workerLaunch: WorkerLaunch): bool =
  s.phase == Choosing and not(bundled.contains("")) and not(load.includes("")) and distinct(load) and not(load.includes(productName(product)))
pure def choosePlan(s: PluginPlan, bundled: Set[str], load: List[str], product: ProductChoice, privacyOn: bool, allowed: Set[str], workerLaunch: WorkerLaunch): PluginPlan = {
  val phase = planPhase(bundled, load, product)
  if (phase != Registering) { ...s, phase: phase }
  else { ...s, phase: Registering, bundled: bundled, privacyOn: privacyOn, order: planOrder(load, privacyOn), allowed: allowed, actions: messageServiceActions,
    product: match product { | Product(p) => ProductPending({ name: p.name }) | NoProduct => NoProductPlugin },
    worker: match workerLaunch { | WorkerNamed(w) => Unverified({ expected: w.digest }) | NoWorkerNamed => NoWorker } }
}
pure def productRegistered(plugin: ProductStep): bool = match plugin { | ProductRegistered(p) => true | _ => false }
pure def productPending(plugin: ProductStep): bool = match plugin { | ProductPending(p) => true | _ => false }
pure def alwaysProductRegistersAfterEveryOtherPlugin(s: PluginPlan): bool = productRegistered(s.product) implies s.next == s.order.length()
pure def alwaysNextWithinPlan(s: PluginPlan): bool = s.next >= 0 and s.next <= s.order.length()
pure def alwaysPlannedPluginsAreAvailable(s: PluginPlan): bool = s.order.every(n => fixedPlugins.contains(n) or available(s.bundled).contains(n))
pure def alwaysPrivacyServiceFollowsTheSwitch(s: PluginPlan): bool = s.order.length() > 0 implies (s.order.includes(privacyPlugin) iff s.privacyOn)
pure def alwaysNoPluginPlannedTwice(s: PluginPlan): bool = distinct(s.order)
pure def sometimesReadyWithProductAndPrivacy(s: PluginPlan): bool = s.phase == Ready and s.privacyOn and productRegistered(s.product)
```

### A refused plan loads nothing more

```quint
pure def isRefused(phase: PlanPhase): bool = match phase { | Refused(r) => true | _ => false }
pure def stepRefusalIsFinal(before: PluginPlan, after: PluginPlan): bool =
  isRefused(before.phase) implies (after.phase == before.phase and after.next == before.next)
```

## Story: Register my product's own actions and routes

> As the maker of a product, I want my own plugin to add its actions and
> routes to the agent, so that my product's abilities run beside Eliza's
> without taking over any of the agent's own.

### The product plugin must be in the bundle

```quint
pure def lawMissingProductRefusesBoot(bundled: Set[str], product: ProductChoice): bool =
  (productName(product) != "" and not(reserved(productName(product))) and not(bundled.contains(productName(product)))) implies
    planPhase(bundled, List(), product) == Refused({ cause: MissingProduct })
pure def sometimesMissingProductRefused(s: PluginPlan): bool = s.phase == Refused({ cause: MissingProduct })
```

### A product route never claims a route prefix an agent module owns

Each registration names its actions and the route prefixes its routes fall
under. A product route under a prefix that storage, the cloud link or one of
the agent's own modules registered refuses boot; the product plugin, which
registers last, cannot be shadowed by a later module.

```quint
pure val actionsValues = Set(Set(), Set("REPLY"), Set("CALCULATE"), Set("PRODUCT_ACTION"))
pure val routesValues = Set(Set(), Set("/api/tasks"), Set("/api/product"))
pure def agentModule(name: str): bool = name == storagePlugin or name == cloudLinkPlugin or builtinModules.contains(name)
pure def overlaps(a: Set[str], b: Set[str]): bool = a.exists(r => b.contains(r))
pure def canRegisterNext(s: PluginPlan, actions: Set[str], routes: Set[str]): bool = s.phase == Registering and s.next < s.order.length()
pure def registerNext(s: PluginPlan, actions: Set[str], routes: Set[str]): PluginPlan = {
  val name = s.order.nthOr(s.next, "")
  { ...s, next: s.next + 1, actions: s.actions.union(actions), moduleRoutes: if (agentModule(name)) s.moduleRoutes.union(routes) else s.moduleRoutes }
}
pure def canRegisterProduct(s: PluginPlan, actions: Set[str], routes: Set[str]): bool =
  s.phase == Registering and s.next == s.order.length() and productPending(s.product)
pure def registerProduct(s: PluginPlan, actions: Set[str], routes: Set[str]): PluginPlan = {
  val product = s.product
  match product {
    | ProductPending(p) => if (overlaps(routes, s.moduleRoutes)) { ...s, phase: Refused({ cause: RouteClaimed }) }
        else { ...s, product: ProductRegistered({ name: p.name }), actions: s.actions.union(actions), productRoutes: routes }
    | _ => s
  }
}
pure def alwaysOnlyARegisteredProductHasRoutes(s: PluginPlan): bool = s.productRoutes.size() > 0 implies productRegistered(s.product)
pure def alwaysProductRoutesAvoidModuleRoutes(s: PluginPlan): bool = not(overlaps(s.productRoutes, s.moduleRoutes))
pure def sometimesProductRouteRefused(s: PluginPlan): bool = s.phase == Refused({ cause: RouteClaimed })
```

### The agent is ready only when every allowed action is registered

When the last plugin has registered, the launch's allowlist goes through
core's boot check against every registered action, the message service's
`REPLY`, `IGNORE` and `NONE` included; an empty or stale allowlist refuses
boot.

```quint
pure def launchAllowlist(names: Set[str]): AP::AllowlistSetting = { present: true, blank: false, parses: true, names: names }
pure def allowlistAdmitted(s: PluginPlan): bool = AP::allowlistBoot(launchAllowlist(s.allowed), s.actions) == AP::AllowlistAdmitted
pure def awaitingWorker(worker: WorkerState): bool = match worker { | Unverified(w) => true | _ => false }
pure def canFinishPlan(s: PluginPlan): bool = s.phase == Registering and s.next == s.order.length() and not(productPending(s.product)) and not(awaitingWorker(s.worker))
pure def finishPlan(s: PluginPlan): PluginPlan = { ...s, phase: if (allowlistAdmitted(s)) Ready else Refused({ cause: StaleAllowlist }) }
pure def alwaysReadyLoadedTheWholePlan(s: PluginPlan): bool =
  s.phase == Ready implies (s.next == s.order.length() and not(productPending(s.product)) and allowlistAdmitted(s) and not(awaitingWorker(s.worker)))
pure def sometimesStaleAllowlistRefused(s: PluginPlan): bool = s.phase == Refused({ cause: StaleAllowlist })
```

## Story: Run my workflows only in the pinned worker

> As the maker of a product, I want workflows to run only in the worker my
> launch pinned, so that no other program runs with my user's data.

### The worker is installed only after its executable digest matches the launch

The shell reads the executable under the launch's `runtimeDir` and passes
its SHA-256; a different digest refuses boot.

```quint
pure val digestValues = Set("aa", "bb")
pure def expectedDigest(worker: WorkerState): str = match worker { | Unverified(w) => w.expected | _ => "" }
pure def canVerifyWorker(s: PluginPlan, digest: str): bool = s.phase == Registering and awaitingWorker(s.worker)
pure def verifyWorker(s: PluginPlan, digest: str): PluginPlan =
  if (digest == expectedDigest(s.worker)) { ...s, worker: Verified({ pinned: digest }) } else { ...s, phase: Refused({ cause: WorkerMismatch }) }
pure def sometimesWorkerMismatchRefused(s: PluginPlan): bool = s.phase == Refused({ cause: WorkerMismatch })
```

### The worker never receives the credential, the launch token or the storage key

```quint
pure val offeredValues = Set(Set(PlainSetting), Set(PlainSetting, DeviceCredential, LaunchToken, StorageKey))
pure def workerVerified(worker: WorkerState): bool = match worker { | Verified(w) => true | _ => false }
pure def canSpawnWorker(s: PluginPlan, offered: Set[ProcessValue]): bool = s.phase == Ready and workerVerified(s.worker)
pure def spawnWorker(s: PluginPlan, offered: Set[ProcessValue]): PluginPlan =
  { ...s, workerEnv: s.workerEnv.union(offered.filter(v => v == PlainSetting)), workerRuns: s.workerRuns + 1 }
pure def alwaysWorkerGetsNoSecret(s: PluginPlan): bool = s.workerEnv.forall(v => v == PlainSetting)
pure def alwaysOnlyAVerifiedWorkerRuns(s: PluginPlan): bool = s.workerRuns >= 0 and (s.workerRuns > 0 implies workerVerified(s.worker))
pure def sometimesWorkerRan(s: PluginPlan): bool = s.workerRuns > 0
```
