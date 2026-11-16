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
