# Action planning and tool calls

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/actions.ts`, `actions/action-schema.ts`, `actions/to-tool.ts`, `actions/validate-tool-args.ts`, `actions/validation.ts`, `actions/resolve-action-args.ts`, `actions/subaction-dispatch.ts`, `actions/promote-subactions.ts`, and `packages/core/src/runtime/execute-planned-tool-call.ts`, `planner-types.ts`, `tool-arg-aliases.ts`, `action-gate.ts`, `action-role-policy.ts` and `direct-action-routing.ts`. The planner proposes tool calls; this machine decides which of them run. How a running handler's result and callbacks settle is [action settlement](./execution.md), and the receipts its callbacks bind are [action receipts](./actionReceipts.md).

## Story: Plan and execute tool calls

> As a user, I want the agent to run only the actions it registered, with
> arguments that passed their schema and with no more authority than I have,
> and each call to finish exactly once, so that a model's proposal can never
> run something unknown, malformed or beyond my role.

### Action names are unique in the registry

A plugin registers an action under a name, with the subactions its umbrella handler dispatches and the lowest caller [role](./authorization.md) allowed to run it, ranked as authorization ranks the caller's resolved role. A second registration of the same name is refused, so a planned call names exactly one declaration.

```quint
import authorization as Z from "./authorization"
type ActionDecl = { name: str, subactions: List[str], minRole: Z::Role }
type CallPhase = Planned | Validated | Rejected | Invoked | Succeeded | Failed
type RejectReason = NotRejected | UnknownAction | UnknownSubaction | NotPermitted | InvalidArguments
type PlannedCall = { id: int, actionName: str, parent: int, role: Z::Role, argsValid: bool, phase: CallPhase, reason: RejectReason }
type Planning = { registry: List[ActionDecl], calls: List[PlannedCall] }
pure val initial: Planning = { registry: List(), calls: List() }
pure val declValues = Set({ name: "reply", subactions: List(), minRole: Z::Guest }, { name: "manage", subactions: List("create", "remove"), minRole: Z::Admin })
pure def registered(s: Planning, name: str): bool = s.registry.some(d => d.name == name)
pure val noDecl: ActionDecl = { name: "", subactions: List(), minRole: Z::Unresolved }
pure def declOf(s: Planning, name: str): ActionDecl = s.registry.select(d => d.name == name).nthOr(0, noDecl)
pure def canRegisterAction(s: Planning, decl: ActionDecl): bool = decl.name != "" and not(registered(s, decl.name))
pure def registerAction(s: Planning, decl: ActionDecl): Planning = { ...s, registry: s.registry.append(decl) }
pure def alwaysActionNamesUnique(s: Planning): bool = s.registry.every(d => d.name != "" and s.registry.select(other => other.name == d.name).length() == 1)
```

### Only a registered action with valid arguments and a permitted role is invoked

A planned call carries the caller's resolved gate role, one of Guest, User, Admin and Owner (`packages/core/src/runtime/action-gate.ts`): the agent's own message resolves to Owner, a sender with no stored role to Guest, and a failed role lookup plans no call. A planned call is validated before anything runs. An unknown action, a caller below the action's role, or arguments that fail the action's parameter schema reject the call with that reason. A rejected call never invokes a handler.

```quint
pure val idValues = Set(1, 2, 3)
pure val roleValues = Set(Z::Guest, Z::Admin)
pure val actionNameValues = Set("reply", "manage", "create")
pure val noCall: PlannedCall = { id: 0, actionName: "", parent: 0, role: Z::Unresolved, argsValid: false, phase: Rejected, reason: UnknownAction }
pure def callAt(s: Planning, id: int): PlannedCall = s.calls.select(c => c.id == id).nthOr(0, noCall)
pure def knownCall(s: Planning, id: int): bool = s.calls.some(c => c.id == id)
pure def canPlanCall(s: Planning, id: int, actionName: str, role: Z::Role): bool = id > 0 and not(knownCall(s, id)) and Z::rank(role) > 0
pure def planCall(s: Planning, id: int, actionName: str, role: Z::Role): Planning =
  { ...s, calls: s.calls.append({ id: id, actionName: actionName, parent: 0, role: role, argsValid: false, phase: Planned, reason: NotRejected }) }
pure def verdict(s: Planning, call: PlannedCall, argsValid: bool): RejectReason =
  if (call.parent != 0) (if (declOf(s, callAt(s, call.parent).actionName).subactions.includes(call.actionName)) (if (argsValid) NotRejected else InvalidArguments) else UnknownSubaction)
  else if (not(registered(s, call.actionName))) UnknownAction
  else if (Z::rank(call.role) < Z::rank(declOf(s, call.actionName).minRole)) NotPermitted
  else if (not(argsValid)) InvalidArguments
  else NotRejected
pure def canValidateCall(s: Planning, id: int, argsValid: bool): bool = knownCall(s, id) and callAt(s, id).phase == Planned
pure def validateCall(s: Planning, id: int, argsValid: bool): Planning = {
  val reason = verdict(s, callAt(s, id), argsValid)
  { ...s, calls: s.calls.listMap(c => if (c.id == id) { ...c, argsValid: argsValid, reason: reason, phase: if (reason == NotRejected) Validated else Rejected } else c) }
}
pure def permitted(s: Planning, c: PlannedCall): bool =
  c.argsValid and (if (c.parent == 0) registered(s, c.actionName) and Z::rank(c.role) >= Z::rank(declOf(s, c.actionName).minRole) else declOf(s, callAt(s, c.parent).actionName).subactions.includes(c.actionName))
pure def ran(c: PlannedCall): bool = c.phase == Invoked or c.phase == Succeeded or c.phase == Failed
pure def alwaysOnlyPermittedCallsRun(s: Planning): bool = s.calls.every(c => (ran(c) or c.phase == Validated) implies permitted(s, c))
pure def alwaysRejectionNamesItsReason(s: Planning): bool = s.calls.every(c => (c.phase == Rejected) iff (c.reason != NotRejected))
pure def sometimesUnknownActionRejected(s: Planning): bool = s.calls.some(c => c.reason == UnknownAction)
pure def sometimesRoleRejected(s: Planning): bool = s.calls.some(c => c.reason == NotPermitted)
pure def sometimesInvalidArgumentsRejected(s: Planning): bool = s.calls.some(c => c.reason == InvalidArguments)
```

### Arguments are validated before invocation

A handler is invoked only for a call that passed validation; a planned call cannot skip straight to its handler.

```quint
pure def canInvokeCall(s: Planning, id: int): bool = knownCall(s, id) and callAt(s, id).phase == Validated
pure def invokeCall(s: Planning, id: int): Planning = { ...s, calls: s.calls.listMap(c => if (c.id == id) { ...c, phase: Invoked } else c) }
pure def stepInvokedOnlyAfterValidation(before: Planning, after: Planning): bool =
  after.calls.every(c => c.phase != Invoked or before.calls.some(b => b.id == c.id and (b.phase == Validated or b.phase == Invoked)))
```

### A subaction stays within its parent's authority

An umbrella action dispatches a subaction only while it is itself running. The subaction runs with the parent's caller role, never another, and only a subaction the parent's declaration names can pass validation; any other is rejected as unknown.

```quint
pure val parentValues = Set(1, 2)
pure def canPlanSubaction(s: Planning, id: int, parent: int, actionName: str): bool =
  id > 0 and not(knownCall(s, id)) and knownCall(s, parent) and callAt(s, parent).phase == Invoked
pure def planSubaction(s: Planning, id: int, parent: int, actionName: str): Planning =
  { ...s, calls: s.calls.append({ id: id, actionName: actionName, parent: parent, role: callAt(s, parent).role, argsValid: false, phase: Planned, reason: NotRejected }) }
pure def alwaysSubactionWithinParentAuthority(s: Planning): bool =
  s.calls.every(c => c.parent == 0 or (knownCall(s, c.parent) and c.parent != c.id and callAt(s, c.parent).role == c.role and ran(callAt(s, c.parent))))
pure def sometimesSubactionSucceeded(s: Planning): bool = s.calls.some(c => c.parent != 0 and c.phase == Succeeded)
pure def sometimesUnknownSubactionRejected(s: Planning): bool = s.calls.some(c => c.reason == UnknownSubaction)
```

### A parent settles only after its subactions

A subaction's handler runs inside its parent's handler, so the parent's result settles only once every subaction it planned has been rejected or has settled.

```quint
pure def resolved(c: PlannedCall): bool = c.phase == Rejected or c.phase == Succeeded or c.phase == Failed
pure def canSettleCall(s: Planning, id: int, ok: bool): bool =
  knownCall(s, id) and callAt(s, id).phase == Invoked and s.calls.every(c => c.parent != id or resolved(c))
pure def settleCall(s: Planning, id: int, ok: bool): Planning = { ...s, calls: s.calls.listMap(c => if (c.id == id) { ...c, phase: if (ok) Succeeded else Failed } else c) }
pure def alwaysParentSettlesAfterSubactions(s: Planning): bool =
  s.calls.every(p => not(p.phase == Succeeded or p.phase == Failed) or s.calls.every(c => c.parent != p.id or resolved(c)))
```

### A planned call settles once

A rejected, succeeded or failed call keeps that outcome; nothing runs it again or changes its result.

```quint
pure def stepSettledCallKeepsItsOutcome(before: Planning, after: Planning): bool =
  before.calls.every(b => not(resolved(b)) or after.calls.some(c => c == b))
pure def alwaysCallIdentitiesUnique(s: Planning): bool = s.calls.every(c => c.id > 0 and s.calls.select(other => other.id == c.id).length() == 1)
```

## Story: Offer only the actions a product allows

> As the maker of a product built on the agent, I name the actions my product
> offers; nothing else runs for anyone, the owner and the agent's own turns
> included, and a broken or stale list stops the agent from starting rather
> than opening everything up.

### A product allowlist refuses every action it does not name, for every caller

A host may set a product allowlist of exact action names. When it is set, an
action it does not name is refused before any role or context gate is
consulted, whatever the caller's role, including the owner and the agent's
own autonomous and scheduled turns. Without an allowlist every action stays
subject to its own gates.

```quint
type ProductAllowlist = { set: bool, names: Set[str] }
pure def productAllows(allowlist: ProductAllowlist, actionName: str): bool = not(allowlist.set) or allowlist.names.contains(actionName)
pure def gateAdmits(allowlist: ProductAllowlist, actionName: str, role: Z::Role, minRole: Z::Role): bool =
  productAllows(allowlist, actionName) and Z::rank(role) >= Z::rank(minRole)
pure val allowlistValues = Set({ set: false, names: Set() }, { set: true, names: Set("reply") }, { set: true, names: Set("reply", "manage") }, { set: true, names: Set("reply", "manage_create") })
pure val minRoleValues = Set(Z::Guest, Z::Admin)
pure def lawAllowlistRefusesUnnamedActionsForEveryone(allowlist: ProductAllowlist, actionName: str, role: Z::Role, minRole: Z::Role): bool =
  (allowlist.set and not(allowlist.names.contains(actionName))) implies not(gateAdmits(allowlist, actionName, role, minRole))
pure def lawOwnerIsNotExemptFromTheAllowlist(allowlist: ProductAllowlist, actionName: str): bool =
  gateAdmits(allowlist, actionName, Z::Owner, Z::Guest) implies productAllows(allowlist, actionName)
```

### A promoted subaction is checked by its own name and its umbrella's, so allowing an umbrella allows none of its subactions and refusing it refuses them all

An umbrella action may promote each of its subactions to a top-level action
of its own name that runs the umbrella's handler. Each promoted name, and
each subaction a running umbrella plans, passes the allowlist only when both
its own name and its umbrella's are named: a product that allows the
umbrella and names none of its subactions refuses them all, and a product that refuses the umbrella refuses
every one of its subactions, even one it names.

```quint
pure def subactionAllowed(allowlist: ProductAllowlist, parentName: str, subactionName: str): bool =
  productAllows(allowlist, parentName) and productAllows(allowlist, subactionName)
pure val parentNameValues = Set("manage", "reply")
pure val subactionNameValues = Set("manage_create", "create")
pure def lawAllowingAnUmbrellaAllowsNoSubaction(allowlist: ProductAllowlist, parentName: str, subactionName: str): bool =
  (allowlist.set and not(allowlist.names.contains(subactionName))) implies not(subactionAllowed(allowlist, parentName, subactionName))
pure def lawRefusedUmbrellaRefusesEverySubaction(allowlist: ProductAllowlist, parentName: str, subactionName: str): bool =
  (allowlist.set and not(allowlist.names.contains(parentName))) implies not(subactionAllowed(allowlist, parentName, subactionName))
```

### An empty, malformed or stale allowlist stops boot

A set allowlist that is empty, does not parse as a list of nonempty names,
or names an action no plugin registered when boot finishes stops the boot,
so a broken setting or an action renamed upstream never leaves the product
with everything or without what it promised.

```quint
type AllowlistSetting = { present: bool, blank: bool, parses: bool, names: Set[str] }
type AllowlistBoot = AllowlistAbsent | AllowlistAdmitted | AllowlistRefused
pure def allowlistBoot(setting: AllowlistSetting, registeredNames: Set[str]): AllowlistBoot =
  if (not(setting.present)) AllowlistAbsent
  else if (setting.blank or not(setting.parses) or setting.names.size() == 0) AllowlistRefused
  else if (not(setting.names.subseteq(registeredNames))) AllowlistRefused
  else AllowlistAdmitted
pure val settingValues = Set(
  { present: false, blank: false, parses: false, names: Set() },
  { present: true, blank: true, parses: false, names: Set() },
  { present: true, blank: false, parses: true, names: Set("reply") },
  { present: true, blank: false, parses: true, names: Set("reply", "renamed") }
)
pure val registeredNamesValues = Set(Set("reply"), Set("reply", "manage"))
pure def lawBrokenOrStaleAllowlistStopsBoot(setting: AllowlistSetting, registeredNames: Set[str]): bool =
  (setting.present and (setting.blank or not(setting.parses) or not(setting.names.subseteq(registeredNames)))) implies
    allowlistBoot(setting, registeredNames) == AllowlistRefused
pure def lawAdmittedAllowlistNamesOnlyRegisteredActions(setting: AllowlistSetting, registeredNames: Set[str]): bool =
  allowlistBoot(setting, registeredNames) == AllowlistAdmitted implies (setting.names.size() > 0 and setting.names.subseteq(registeredNames))
```
