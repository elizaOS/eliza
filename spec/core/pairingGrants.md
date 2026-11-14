# Canonical pairing grant identities

This model migrates `PairingGrantIdentity` from `quint/PairingIdentity.qnt`. A grant owner is the exact agent/channel/sender tuple. Canonical grant-key derivation and fresh request UUIDs are cryptographic adapter boundaries. The state checks collision handling and the two indexes independently of the hash implementation.

## Story: Receive the actual stored grant identity

As a caller, I want an existing grant to return its stored id and a conflicting key to fail without a fabricated receipt.

### Both owner and grant-key indexes identify the same row

Writing an existing owner returns its existing key even if the caller proposes another. A fresh owner can occupy an unused candidate key. A candidate key owned by another tuple is rejected. Removal updates both indexes together. A returned successful receipt must name the row actually stored for that owner.

```quint
type GrantOwner = { agent: str, channel: str, sender: str }
type GrantRow = { owner: GrantOwner, key: str }
type PairingGrants = { rows: List[GrantRow], reported: bool, accepted: bool, reportedOwner: GrantOwner, reportedKey: str }
pure val emptyOwner: GrantOwner = { agent: "", channel: "", sender: "" }
pure val initial: PairingGrants = { rows: List(), reported: false, accepted: false, reportedOwner: emptyOwner, reportedKey: "" }
pure def writeGrant(s: PairingGrants, owner: GrantOwner, key: str): PairingGrants = {
  val previous = s.rows.select(row => row.owner == owner)
  val insertable = previous.length() == 0 and not(s.rows.some(row => row.key == key))
  val accepted = previous.length() > 0 or insertable
  { ...s, rows: if (insertable) s.rows.append({ owner: owner, key: key }) else s.rows, reported: true, accepted: accepted, reportedOwner: owner, reportedKey: if (previous.length() > 0) previous.nthOr(0, { owner: owner, key: key }).key else key }
}
pure def removeGrant(s: PairingGrants, key: str): PairingGrants = { ...s, rows: s.rows.select(row => row.key != key), reported: false }
pure def alwaysCanonicalGrantIndexesAgree(s: PairingGrants): bool = s.rows.every(row => s.rows.select(other => other.owner == row.owner).length() == 1 and s.rows.select(other => other.key == row.key).length() == 1)
pure def alwaysGrantReceiptNamesStoredOwner(s: PairingGrants): bool = s.reported and s.accepted implies s.rows.some(row => row.owner == s.reportedOwner and row.key == s.reportedKey)
pure def sometimesGrantKeyCollisionRejected(s: PairingGrants): bool = s.reported and not(s.accepted)
pure def sometimesGrantStored(s: PairingGrants): bool = s.reported and s.accepted
pure val ownerValues = Set({ agent: "a-b", channel: "c", sender: "d" }, { agent: "a", channel: "b-c", sender: "d" }, { agent: "a", channel: "b", sender: "c-d" })
```
