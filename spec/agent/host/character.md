# Character

The agent's character is its name, voice and persona. The owner's character
lives in the host's configuration. A product that builds on the host may
supply its own character; it is kept in a scope of its own and restored
from there at boot, so it never overwrites what the owner configured. When
the owner renames the agent, the new name is written to the configuration
before a receipt confirms it.

## Story: Boot and persist the agent's character

> As the owner, my agent boots with the character I gave it, or with the
> one my product ships, and when I rename it the new name sticks.

### A product character is kept in its own scope and never written over the owner's

```quint
type Character = { ownerCharacter: str, productCharacter: str, active: str, pendingName: str, receiptName: str, boots: int }
pure val initial: Character = { ownerCharacter: "agent", productCharacter: "", active: "agent", pendingName: "", receiptName: "", boots: 0 }
pure val nameValues = Set("ada", "sam")
pure def canSupplyProductCharacter(c: Character, name: str): bool = name != "" and name != c.productCharacter
pure def supplyProductCharacter(c: Character, name: str): Character = { ...c, productCharacter: name }
pure def stepProductCharacterLeavesOwnerConfig(before: Character, via: str, after: Character): bool =
  via == "supplyProductCharacter" implies after.ownerCharacter == before.ownerCharacter
```

### Boot restores the product character from its scope, or else the owner's

```quint
pure def bootCharacter(owner: str, product: str): str = if (product != "") product else owner
pure def boot(c: Character): Character = { ...c, active: bootCharacter(c.ownerCharacter, c.productCharacter), boots: c.boots + 1 }
pure def stepBootRestoresFromScope(before: Character, via: str, after: Character): bool =
  via == "boot" implies after.active == bootCharacter(before.ownerCharacter, before.productCharacter)
pure def sometimesProductCharacterActive(c: Character): bool = c.boots > 0 and c.active == c.productCharacter and c.active != c.ownerCharacter
```

### A rename is written to the configuration before its receipt

```quint
pure def canRequestRename(c: Character, name: str): bool = name != "" and c.pendingName == ""
pure def requestRename(c: Character, name: str): Character = { ...c, pendingName: name }
pure def canPersistRename(c: Character): bool = c.pendingName != ""
pure def persistRename(c: Character): Character = { ...c, ownerCharacter: c.pendingName, receiptName: c.pendingName, pendingName: "" }
pure def canRenameFailed(c: Character): bool = c.pendingName != ""
pure def renameFailed(c: Character): Character = { ...c, pendingName: "" }
pure def alwaysReceiptNamesPersistedName(c: Character): bool = c.receiptName == "" or c.receiptName == c.ownerCharacter
pure def sometimesRenamedWithReceipt(c: Character): bool = c.receiptName != "" and c.receiptName != "agent"
```

## Story: Boot a provisioned agent as its assigned character

> As the operator of a provisioned or local deployment, my agent boots as the
> character I supplied, and a broken override leaves it with the character it
> already had rather than half of mine.

### An injected character beats a local character file, and a malformed or nameless override changes nothing

A character override comes from the value the provisioner injected, else
from the local character file a path names, else from the character file
at the package root; a switch turns local files off. An override that does
not parse, is not an object, or has no name from itself or the configured
agent name leaves the configuration as it was.

```quint
type OverrideSource = NoOverride | InjectedOverride | PathFileOverride | RootFileOverride
type OverrideInput = { injected: bool, localDisabled: bool, pathNamed: bool, rootFile: bool }
type OverrideText = { parses: bool, isObject: bool, hasName: bool }
pure def overrideSource(i: OverrideInput): OverrideSource =
  if (i.injected) InjectedOverride
  else if (i.localDisabled) NoOverride
  else if (i.pathNamed) PathFileOverride
  else if (i.rootFile) RootFileOverride
  else NoOverride
pure def overrideApplied(i: OverrideInput, t: OverrideText): bool =
  overrideSource(i) != NoOverride and t.parses and t.isObject and t.hasName
pure val iValues = Set({ injected: true, localDisabled: true, pathNamed: true, rootFile: true }, { injected: false, localDisabled: true, pathNamed: true, rootFile: true },
  { injected: false, localDisabled: false, pathNamed: false, rootFile: true }, { injected: false, localDisabled: false, pathNamed: false, rootFile: false })
pure val tValues = Set({ parses: true, isObject: true, hasName: true }, { parses: false, isObject: false, hasName: false }, { parses: true, isObject: true, hasName: false })
pure def lawInjectedCharacterWins(i: OverrideInput): bool = i.injected implies overrideSource(i) == InjectedOverride
pure def lawBrokenOverrideChangesNothing(i: OverrideInput, t: OverrideText): bool =
  not(t.parses and t.isObject and t.hasName) implies not(overrideApplied(i, t))
pure def lawDisabledLocalFilesNeverOverride(i: OverrideInput, t: OverrideText): bool =
  (i.localDisabled and not(i.injected)) implies not(overrideApplied(i, t))
```

### A provisioned agent answers on the routing id it was given, and connects its character's connectors only when it owns them

A provisioner may inject the id its gateways route to the agent; when it
does, the agent answers on that id, and otherwise on the id derived from its
name. By default the gateway owns the agent's platform connectors and
forwards their messages, so the connectors a character names are connected
by the agent itself only when the operator says it owns them, and never by
both.

```quint
pure def routingId(injectedId: str, derivedId: str): str = if (injectedId != "") injectedId else derivedId
pure def agentConnects(ownsConnectors: bool, characterNamesConnectors: bool): bool = ownsConnectors and characterNamesConnectors
pure def gatewayConnects(ownsConnectors: bool, characterNamesConnectors: bool): bool = not(ownsConnectors) and characterNamesConnectors
pure val injectedIdValues = Set("", "route-1")
pure val derivedIdValues = Set("name-1")
pure def lawInjectedRoutingIdWins(injectedId: str, derivedId: str): bool =
  (injectedId != "" implies routingId(injectedId, derivedId) == injectedId) and
    (derivedId != "" implies routingId(injectedId, derivedId) != "")
pure def lawAConnectorIsNeverConnectedTwice(ownsConnectors: bool, characterNamesConnectors: bool): bool =
  not(agentConnects(ownsConnectors, characterNamesConnectors) and gatewayConnects(ownsConnectors, characterNamesConnectors)) and
    (not(ownsConnectors) implies not(agentConnects(ownsConnectors, characterNamesConnectors)))
```
