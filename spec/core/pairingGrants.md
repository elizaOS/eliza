# Canonical pairing grant identities

This migrates `quint/PairingIdentity.qnt`, the allowlist write and readback in `services/pairing.ts`, and the retained grant type from `types/pairing.ts`. The written candidate key is the deterministic UUID of the exact JSON tuple `["allowlist", agentId, channel, senderId]`. Hashing, timestamp conversion, metadata property details and database conformance at this boundary remain explicit.

## Story: Receive the actual stored grant identity

As a caller, I want an existing grant to return its stored ID, creation time and complete metadata. A conflicting candidate key fails without a fabricated receipt.

### Both owner and grant-key indexes identify the same complete row

An existing owner returns the existing row unchanged even if the caller proposes a different identity or metadata. A fresh owner can occupy an unused key. A key owned by another tuple rejects. Source lookup after the write returns the actual retained authoritative row (including an older concurrently installed row) or a typed failure if no row was retained. The local abstract action represents atomic storage selection of the retained canonical row; read and mutation adapters must preserve that correspondence.

```quint
import pairingAdmission as R from "./pairingAdmission"
type GrantRow = { owner: R::PairingScope, key: str, createdAt: int, metadata: R::PairingMetadata }
type GrantStatus = NoGrantReceipt | GrantRetained | GrantKeyOwnedElsewhere | GrantWriteFailed | GrantMissingAfterWrite
type GrantWrite = { candidate: GrantRow, ack: GrantStatus }
type PairingGrants = { rows: List[GrantRow], status: GrantStatus, reported: GrantRow }
pure val emptyOwner: R::PairingScope = { agent: "", channel: "", sender: "" }
pure val emptyGrant: GrantRow = { owner: emptyOwner, key: "", createdAt: 0, metadata: R::absentMetadata }
pure val initial: PairingGrants = { rows: List(), status: NoGrantReceipt, reported: emptyGrant }
pure def grantAt(s: PairingGrants, owner: R::PairingScope): GrantRow = s.rows.select(row => row.owner == owner).nthOr(0, emptyGrant)
pure def candidateFor(owner: R::PairingScope, key: str, createdAt: int, metadata: R::PairingMetadata): GrantRow = { owner: owner, key: key, createdAt: createdAt, metadata: metadata }
pure def canWriteGrant(s: PairingGrants, request: GrantWrite): bool = request.candidate.key != "" and R::validMetadata(request.candidate.metadata) and (request.ack == GrantRetained or request.ack == GrantWriteFailed or request.ack == GrantMissingAfterWrite)
pure def writeGrant(s: PairingGrants, request: GrantWrite): PairingGrants = {
  val candidate = request.candidate
  val previous = grantAt(s, candidate.owner)
  val keyUsed = s.rows.some(row => row.key == candidate.key)
  if (previous.key != "") { ...s, status: GrantRetained, reported: previous }
  else if (keyUsed) { ...s, status: GrantKeyOwnedElsewhere, reported: emptyGrant }
  else if (request.ack == GrantRetained) { ...s, rows: s.rows.append(candidate), status: GrantRetained, reported: candidate }
  else { ...s, status: request.ack, reported: emptyGrant }
}
pure def removeGrant(s: PairingGrants, key: str): PairingGrants = { ...s, rows: s.rows.select(row => row.key != key), status: NoGrantReceipt, reported: emptyGrant }
pure def alwaysCanonicalGrantIndexesAgree(s: PairingGrants): bool = s.rows.every(row => row.key != "" and s.rows.select(other => other.owner == row.owner).length() == 1 and s.rows.select(other => other.key == row.key).length() == 1)
pure def alwaysGrantReceiptNamesStoredOwner(s: PairingGrants): bool = s.status == GrantRetained implies s.rows.includes(s.reported)
pure def stepExistingGrantDataRetained(before: PairingGrants, via: str, after: PairingGrants): bool = via == "writeGrant" implies before.rows.every(row => after.rows.includes(row))
pure def sometimesGrantKeyCollisionRejected(s: PairingGrants): bool = s.status == GrantKeyOwnedElsewhere
pure def sometimesGrantStored(s: PairingGrants): bool = s.status == GrantRetained
pure def sometimesMissingReadback(s: PairingGrants): bool = s.status == GrantMissingAfterWrite
pure val grantOne: GrantRow = { owner: { agent: "a-b", channel: "c", sender: "d" }, key: "grant1", createdAt: 0, metadata: R::absentMetadata }
pure val grantTwo: GrantRow = { owner: { agent: "a", channel: "b-c", sender: "d" }, key: "grant2", createdAt: 1, metadata: { present: true, entries: List({ key: "display", value: "Alias" }) } }
pure val requestValues: Set[GrantWrite] = Set({ candidate: grantOne, ack: GrantRetained }, { candidate: grantTwo, ack: GrantRetained }, { candidate: { ...grantTwo, key: "grant1" }, ack: GrantRetained }, { candidate: { ...grantTwo, owner: grantOne.owner }, ack: GrantRetained }, { candidate: grantOne, ack: GrantWriteFailed }, { candidate: grantOne, ack: GrantMissingAfterWrite })
pure val keyValues = Set("grant1", "grant2")
pure val ownerValues = Set(grantOne.owner, grantTwo.owner)
```
