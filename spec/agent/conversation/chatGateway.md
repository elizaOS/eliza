# Chat through a privileged gateway

A consumer's device host configures the resident agent's conversation
caller role (`ELIZA_CONVERSATION_CALLER_ROLE`), its action allowlist
(`ELIZA_ACTION_ALLOWLIST`), in-memory PGlite and provider routing. A
consumer's own action policy may admit, for example, REPLY, IGNORE, NONE and
CALCULATE. The sources are `packages/agent/src/api/client-chat-admin.ts`,
`packages/core/src/runtime/action-gate.ts` and
`packages/agent/src/runtime/assistant-plugins.ts`. A consumer may instead
run the resident-agent host with its own plugin profile and gateway
authority. [Core authorization](../../core/authorization.md),
[model dispatch](../../core/models.md) and
[turn lifecycle](../../core/journey.md) own their own state.

## Story: Carry an end user's chat through a privileged gateway

> As a device owner, my chat reaches the agent as my own principal, with
> only the actions my device allows, even though a privileged gateway
> carries it.

### The chat setting selects a distinct user principal

The host owner credential carries an end-user chat request under the
explicit USER setting. Agent API chat constructs a distinct end-user
entity and supplies a session USER grant. The default and explicit OWNER
setting preserve the operator caller. Invalid settings fail boot. The
retyping applies on chat only. The gateway must keep its owner credential
private and independently restrict its route surface. The source's fixed
entity seed and derivation remain a compatibility boundary.

```quint
import authorization as A from "../../core/authorization"
type CallerSetting = OwnerDefault | OwnerSelected | UserSelected | InvalidCallerSetting
type RouteSurface = ChatRoute | OtherRoute
type CallerProjection = { valid: bool, role: A::Role, productUser: bool }
pure def projectCaller(setting: CallerSetting, surface: RouteSurface, ownerAuthenticated: bool): CallerProjection =
  if (setting == InvalidCallerSetting) { valid: false, role: A::Unresolved, productUser: false }
  else if (not(ownerAuthenticated)) { valid: true, role: A::Unresolved, productUser: false }
  else if (setting == UserSelected and surface == ChatRoute) { valid: true, role: A::User, productUser: true }
  else { valid: true, role: A::Owner, productUser: false }
pure def lawUserChatUsesProductPrincipal(ownerAuthenticated: bool): bool = ownerAuthenticated implies (projectCaller(UserSelected, ChatRoute, ownerAuthenticated).role == A::User and projectCaller(UserSelected, ChatRoute, ownerAuthenticated).productUser)
pure def lawInvalidCallerConfigCannotBoot(surface: RouteSurface, ownerAuthenticated: bool): bool = not(projectCaller(InvalidCallerSetting, surface, ownerAuthenticated).valid)
```

### The exact host allowlist applies to discovery and execution

The source decoder distinguishes unset, a valid JSON array of exact
nonempty names, and invalid configuration. The host verifies all configured
names against registered actions once after deferred startup. A present
empty JSON array authorizes no actions in the core gate. A consumer whose
own asset loader requires a nonempty policy refuses an empty one at boot.
Every turn uses the same gate, with the documented private and disclosure
checks first. A request restriction is applied next after the allowlist.
An operator role override supplies its replacement role check only after
these earlier checks pass. Absent an override, the declared context role,
context, and top role are checked. Static discovery may skip the private
check. Real execution always checks it.

```quint
type AllowlistFormat = AllowlistUnset | AllowlistDecoded | AllowlistInvalid
type GateResult = GateAllows | GatePrivate | GateDisclosure | GateHostList | GateRequest | GateRole | GateContext
type GateFacts = { privateAllowed: bool, disclosureAllowed: bool, hostNameAllowed: bool, requestAllowed: bool, hasOverride: bool, overrideAllowed: bool, contextRoleAllowed: bool, contextAllowed: bool, topRoleAllowed: bool }
pure def exactNameAllowed(format: AllowlistFormat, names: Set[str], name: str): bool = format == AllowlistUnset or (format == AllowlistDecoded and names.contains(name))
pure def allowlistBoots(format: AllowlistFormat, names: Set[str], registered: Set[str], consumerRequiresNames: bool): bool = format == AllowlistUnset and not(consumerRequiresNames) or (format == AllowlistDecoded and names.subseteq(registered) and (not(consumerRequiresNames) or names.size() > 0))
pure def decideGate(facts: GateFacts, staticDiscovery: bool): GateResult =
  if (not(staticDiscovery) and not(facts.privateAllowed)) GatePrivate
  else if (not(facts.disclosureAllowed)) GateDisclosure
  else if (not(facts.hostNameAllowed)) GateHostList
  else if (not(facts.requestAllowed)) GateRequest
  else if (facts.hasOverride) (if (facts.overrideAllowed) GateAllows else GateRole)
  else if (not(facts.contextRoleAllowed)) GateRole
  else if (not(facts.contextAllowed)) GateContext
  else if (not(facts.topRoleAllowed)) GateRole
  else GateAllows
pure val factsValues = Set(
  { privateAllowed: true, disclosureAllowed: true, hostNameAllowed: true, requestAllowed: true, hasOverride: false, overrideAllowed: false, contextRoleAllowed: true, contextAllowed: true, topRoleAllowed: true },
  { privateAllowed: true, disclosureAllowed: true, hostNameAllowed: false, requestAllowed: true, hasOverride: true, overrideAllowed: true, contextRoleAllowed: true, contextAllowed: true, topRoleAllowed: true },
  { privateAllowed: false, disclosureAllowed: true, hostNameAllowed: true, requestAllowed: true, hasOverride: true, overrideAllowed: true, contextRoleAllowed: false, contextAllowed: false, topRoleAllowed: false },
  { privateAllowed: true, disclosureAllowed: false, hostNameAllowed: true, requestAllowed: true, hasOverride: true, overrideAllowed: true, contextRoleAllowed: true, contextAllowed: true, topRoleAllowed: true })
pure val namesValues = Set(Set(), Set("REPLY"), Set("REPLY", "CALCULATE"))
pure val registeredValues = Set(Set(), Set("REPLY", "CALCULATE", "IGNORED_ACTION"))
pure def lawMalformedAllowlistFailsBoot(names: Set[str], registered: Set[str], consumerRequiresNames: bool): bool = not(allowlistBoots(AllowlistInvalid, names, registered, consumerRequiresNames))
pure def lawBootChecksExactRegistration(names: Set[str], registered: Set[str], consumerRequiresNames: bool): bool = allowlistBoots(AllowlistDecoded, names, registered, consumerRequiresNames) implies names.subseteq(registered)
pure def lawProductFenceSurvivesRoleOverride(facts: GateFacts, staticDiscovery: bool): bool = not(facts.hostNameAllowed) implies decideGate(facts, staticDiscovery) != GateAllows
pure def lawExecutionAlwaysChecksPrivateAction(facts: GateFacts): bool = not(facts.privateAllowed) implies decideGate(facts, false) == GatePrivate
pure def lawDisclosureAlwaysPrecedesRole(facts: GateFacts, staticDiscovery: bool): bool = ((staticDiscovery or facts.privateAllowed) and not(facts.disclosureAllowed)) implies decideGate(facts, staticDiscovery) == GateDisclosure
```

### A missing inference credential keeps the device able to sign in

A device host uses the stored account Cloud credential when it is usable.
A development credential selects a direct provider and prevents the
account key from becoming inference authority. The controlled-account
debug environment also prevents Cloud inference. The host can start
signed out, with inference unconfigured. Conversation memory is scoped to
that runtime and comes from in-memory PGlite. Task storage follows the
distinct [task contracts](../tasks/).

```quint
type InferenceRoute = InferenceUnconfigured | CloudProxy | DirectProvider
pure def deviceInference(accountCredential: bool, developmentKey: bool, controlledAccount: bool): InferenceRoute =
  if (developmentKey) DirectProvider
  else if (accountCredential and not(controlledAccount)) CloudProxy
  else InferenceUnconfigured
pure def lawSignedOutCanHaveUnconfiguredInference(controlledAccount: bool): bool = deviceInference(false, false, controlledAccount) == InferenceUnconfigured
pure def lawControlledAccountDoesNotAuthorizeCloud(accountCredential: bool, developmentKey: bool): bool = deviceInference(accountCredential, developmentKey, true) != CloudProxy
```
