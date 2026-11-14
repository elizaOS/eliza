# Connector account value contracts

`connectors/account-manager.ts` normalizes account identity, defaults, role aliases and patch fields before storage. String canonicalization at the boundary trims IDs/provider/account keys, lowercases providers and uppercases role names; purposes are trimmed and empty entries removed. Fields that the source preserves verbatim (label and external identity strings) remain verbatim. This model operates on those exact canonical string values. Metadata values are opaque immutable value identities; a shallow copy preserves every key/value and does not merge patches.

## Story: Patch account policy without changing its durable identity

### Normalization preserves explicit values and applies only documented defaults

Missing role defaults to OWNER; SERVICE maps to AGENT and ADMIN/MEMBER/VIEWER map to TEAM. Other nonempty role strings remain unchanged after canonicalization. Missing gate/status default to open/connected. An explicit empty ID or provider rejects instead of falling back. Empty account key and external identity fields normalize to absence, while empty labels remain present. A patch preserves original provider/ID/creation time and gives explicit null its clearing meaning for external identities.

```quint
type OptionalText = { present: bool, text: str }
type OptionalTime = { present: bool, time: int }
type PatchText = { specified: bool, clear: bool, text: str }
type MetadataEntry = { key: str, value: str }
type Metadata = { present: bool, entries: List[MetadataEntry] }
type AccountValue = { id: str, provider: str, accountKey: OptionalText, label: OptionalText, role: str, purposes: List[str], gate: str, status: str, externalId: OptionalText, displayHandle: OptionalText, ownerBindingId: OptionalText, ownerIdentityId: OptionalText, createdAt: int, updatedAt: int, metadata: Metadata }
type AccountInput = { id: OptionalText, provider: OptionalText, accountKey: OptionalText, label: OptionalText, role: OptionalText, purposes: List[str], gate: OptionalText, status: OptionalText, externalId: OptionalText, displayHandle: OptionalText, ownerBindingId: OptionalText, ownerIdentityId: OptionalText, createdAt: OptionalTime, metadata: Metadata }
type AccountPatch = { labelSpecified: bool, roleSpecified: bool, gateSpecified: bool, statusSpecified: bool, accountKey: OptionalText, label: OptionalText, role: OptionalText, purposesPresent: bool, purposes: List[str], gate: OptionalText, status: OptionalText, externalId: PatchText, displayHandle: PatchText, ownerBindingId: PatchText, ownerIdentityId: PatchText, metadata: Metadata }
pure val absentText: OptionalText = { present: false, text: "" }
pure val absentMetadata: Metadata = { present: false, entries: List() }
pure val emptyAccount: AccountValue = { id: "", provider: "", accountKey: absentText, label: absentText, role: "OWNER", purposes: List(), gate: "open", status: "connected", externalId: absentText, displayHandle: absentText, ownerBindingId: absentText, ownerIdentityId: absentText, createdAt: 0, updatedAt: 0, metadata: absentMetadata }

pure val noPatchText: PatchText = { specified: false, clear: false, text: "" }
pure val emptyInput: AccountInput = { id: absentText, provider: absentText, accountKey: absentText, label: absentText, role: absentText, purposes: List(), gate: absentText, status: absentText, externalId: absentText, displayHandle: absentText, ownerBindingId: absentText, ownerIdentityId: absentText, createdAt: { present: false, time: 0 }, metadata: absentMetadata }
pure val emptyPatch: AccountPatch = { labelSpecified: false, roleSpecified: false, gateSpecified: false, statusSpecified: false, accountKey: absentText, label: absentText, role: absentText, purposesPresent: false, purposes: List(), gate: absentText, status: absentText, externalId: noPatchText, displayHandle: noPatchText, ownerBindingId: noPatchText, ownerIdentityId: noPatchText, metadata: absentMetadata }
pure val valueValues: Set[OptionalText] = Set(absentText, { present: true, text: "OWNER" })
pure val roleValues: Set[OptionalText] = Set(absentText, { present: true, text: "SERVICE" }, { present: true, text: "ADMIN" })
pure val previousTextValues = valueValues
pure val storedTextValues = valueValues
pure val providerTextValues = valueValues
pure val storedMetadataValues: Set[Metadata] = Set(absentMetadata)
pure val providerMetadataValues = storedMetadataValues
pure val externalPatchValues: Set[PatchText] = Set(noPatchText, { specified: true, clear: true, text: "" })
pure val inputValues: Set[AccountInput] = Set(emptyInput, { ...emptyInput, id: { present: true, text: "account1" }, provider: { present: true, text: "provider1" } })
pure val accountValues: Set[AccountValue] = Set({ ...emptyAccount, id: "account1", provider: "provider1" })
pure val storedAccountValues = accountValues
pure val providerAccountValues = accountValues
pure val patchValues: Set[AccountPatch] = Set(emptyPatch)
pure def nonempty(value: OptionalText): OptionalText = if (value.present and value.text != "") value else absentText
pure def normalizedRole(role: OptionalText): str = if (not(role.present) or role.text == "") "OWNER" else if (role.text == "SERVICE") "AGENT" else if (List("ADMIN", "MEMBER", "VIEWER").includes(role.text)) "TEAM" else role.text
pure def normalizedId(input: AccountInput, fallback: str): str = if (input.id.present) input.id.text else fallback
pure def normalizedProvider(input: AccountInput, fallback: str): str = if (input.provider.present) input.provider.text else fallback
pure def validAccountIdentity(input: AccountInput, fallbackId: str, fallbackProvider: str): bool = normalizedId(input, fallbackId) != "" and normalizedProvider(input, fallbackProvider) != ""
pure def normalizedAccount(input: AccountInput, fallbackId: str, fallbackProvider: str, now: int): AccountValue = { id: normalizedId(input, fallbackId), provider: normalizedProvider(input, fallbackProvider), accountKey: nonempty(input.accountKey), label: input.label, role: normalizedRole(input.role), purposes: input.purposes, gate: if (input.gate.present) input.gate.text else "open", status: if (input.status.present) input.status.text else "connected", externalId: nonempty(input.externalId), displayHandle: nonempty(input.displayHandle), ownerBindingId: nonempty(input.ownerBindingId), ownerIdentityId: nonempty(input.ownerIdentityId), createdAt: if (input.createdAt.present) input.createdAt.time else now, updatedAt: now, metadata: input.metadata }
pure def patchedExternal(previousText: OptionalText, externalPatch: PatchText): OptionalText = if (not(externalPatch.specified)) previousText else if (externalPatch.clear or externalPatch.text == "") absentText else { present: true, text: externalPatch.text }
pure def patchedAccount(account: AccountValue, patch: AccountPatch, now: int): AccountValue = { ...account, accountKey: if (patch.accountKey.present) nonempty(patch.accountKey) else account.accountKey, label: if (patch.labelSpecified) patch.label else account.label, role: if (patch.roleSpecified) normalizedRole(patch.role) else account.role, purposes: if (patch.purposesPresent) patch.purposes else account.purposes, gate: if (patch.gateSpecified) (if (patch.gate.present) patch.gate.text else "open") else account.gate, status: if (patch.statusSpecified) (if (patch.status.present) patch.status.text else "connected") else account.status, externalId: patchedExternal(account.externalId, patch.externalId), displayHandle: patchedExternal(account.displayHandle, patch.displayHandle), ownerBindingId: patchedExternal(account.ownerBindingId, patch.ownerBindingId), ownerIdentityId: patchedExternal(account.ownerIdentityId, patch.ownerIdentityId), updatedAt: now, metadata: if (patch.metadata.present) patch.metadata else account.metadata }
pure def lawPatchPreservesIdentity(account: AccountValue, patch: AccountPatch, now: int): bool = patchedAccount(account, patch, now).id == account.id and patchedAccount(account, patch, now).provider == account.provider and patchedAccount(account, patch, now).createdAt == account.createdAt
pure def lawExplicitNullClears(previousText: OptionalText, text: str): bool = not(patchedExternal(previousText, { specified: true, clear: true, text: text }).present)
pure def lawServiceRoleNormalizes(text: str): bool = text == "SERVICE" implies normalizedRole({ present: true, text: text }) == "AGENT"
```

### Provider refresh preserves stored identity and protected policy fields

Stored disable/revoke decisions win. When the provider owns status, other statuses refresh from it; otherwise the stored status wins. Stored optional fields fall back to provider values only when absent. Provider metadata is overlaid by stored metadata by key, and update time is the maximum. A missing provider account becomes pending except for stored disabled/revoked decisions.

```quint
pure def optionalFallback(storedText: OptionalText, providerText: OptionalText): OptionalText = if (storedText.present) storedText else providerText
pure def putMetadata(entries: List[MetadataEntry], incoming: MetadataEntry): List[MetadataEntry] = if (entries.some(entry => entry.key == incoming.key)) entries.listMap(entry => if (entry.key == incoming.key) incoming else entry) else entries.append(incoming)
pure def mergedMetadata(providerMetadata: Metadata, storedMetadata: Metadata): Metadata = { present: true, entries: storedMetadata.entries.foldl(providerMetadata.entries, (entries, incoming) => putMetadata(entries, incoming)) }
pure def refreshedAccount(storedAccount: AccountValue, providerAccount: AccountValue, providerOwnsStatus: bool): AccountValue = { ...storedAccount, accountKey: optionalFallback(storedAccount.accountKey, providerAccount.accountKey), label: optionalFallback(storedAccount.label, providerAccount.label), externalId: optionalFallback(storedAccount.externalId, providerAccount.externalId), displayHandle: optionalFallback(storedAccount.displayHandle, providerAccount.displayHandle), ownerBindingId: optionalFallback(storedAccount.ownerBindingId, providerAccount.ownerBindingId), ownerIdentityId: optionalFallback(storedAccount.ownerIdentityId, providerAccount.ownerIdentityId), status: if (providerOwnsStatus and storedAccount.status != "disabled" and storedAccount.status != "revoked") providerAccount.status else storedAccount.status, updatedAt: if (providerAccount.updatedAt > storedAccount.updatedAt) providerAccount.updatedAt else storedAccount.updatedAt, metadata: mergedMetadata(providerAccount.metadata, storedAccount.metadata) }
pure def missingProviderAccount(storedAccount: AccountValue): AccountValue = { ...storedAccount, status: if (storedAccount.status == "disabled" or storedAccount.status == "revoked") storedAccount.status else "pending" }
pure def lawRefreshPreservesPolicy(storedAccount: AccountValue, providerAccount: AccountValue, providerOwnsStatus: bool): bool = refreshedAccount(storedAccount, providerAccount, providerOwnsStatus).role == storedAccount.role and refreshedAccount(storedAccount, providerAccount, providerOwnsStatus).purposes == storedAccount.purposes and refreshedAccount(storedAccount, providerAccount, providerOwnsStatus).gate == storedAccount.gate and refreshedAccount(storedAccount, providerAccount, providerOwnsStatus).id == storedAccount.id and refreshedAccount(storedAccount, providerAccount, providerOwnsStatus).provider == storedAccount.provider
pure def lawDisabledStaysDisabled(storedAccount: AccountValue, providerAccount: AccountValue): bool = storedAccount.status == "disabled" implies refreshedAccount(storedAccount, providerAccount, true).status == "disabled"
```

### Account policy checks use exact sets and preserve the first denial

An absent status list defaults to connected; an explicitly empty list permits no status. Roles use the same normalized role aliases as account values. Any requested purpose suffices, including the optional call-specific purpose. Access-gate lists are optional, but the disabled gate always refuses. An owner_binding gate additionally requires a verified binding obtained from the provider/external-ID/instance tuple. Policies are alternatives: the first allowing policy succeeds; an optional policy may allow the operation when no account matches.

```quint
type AccountPolicy = { provider: str, statusesPresent: bool, statuses: List[str], roles: List[str], purposes: List[str], gates: List[str], required: bool }
type PolicyDenial = PolicyAllowed | StatusDenied | RoleDenied | PurposeDenied | GateDenied | GateDisabled | OwnerBindingMissing
pure def accountPolicyDenial(account: AccountValue, policy: AccountPolicy, purpose: OptionalText, verifiedBinding: bool): PolicyDenial = {
  val statuses = if (policy.statusesPresent) policy.statuses else List("connected")
  val purposes = if (purpose.present and purpose.text != "") policy.purposes.append(purpose.text) else policy.purposes
  val roles = policy.roles.listMap(role => normalizedRole({ present: true, text: role }))
  if (not(statuses.includes(account.status))) StatusDenied
  else if (roles.length() > 0 and not(roles.includes(normalizedRole({ present: true, text: account.role })))) RoleDenied
  else if (purposes.length() > 0 and not(purposes.some(requested => account.purposes.includes(requested)))) PurposeDenied
  else if (policy.gates.length() > 0 and not(policy.gates.includes(account.gate))) GateDenied
  else if (account.gate == "disabled") GateDisabled
  else if (account.gate == "owner_binding" and not(verifiedBinding)) OwnerBindingMissing
  else PolicyAllowed
}
pure def policyResult(policy: AccountPolicy, anyMatchingAccount: bool, requiredParameterMissing: bool): bool = not(policy.required) or (policy.provider != "" and not(requiredParameterMissing) and anyMatchingAccount)
pure def lawDisabledGateRefuses(account: AccountValue, policy: AccountPolicy, purpose: OptionalText, verifiedBinding: bool): bool = account.gate == "disabled" implies accountPolicyDenial(account, policy, purpose, verifiedBinding) != PolicyAllowed
pure val purposeValues = valueValues
pure val policyValues: Set[AccountPolicy] = Set({ provider: "provider1", statusesPresent: false, statuses: List(), roles: List(), purposes: List(), gates: List(), required: true }, { provider: "provider1", statusesPresent: true, statuses: List(), roles: List("ADMIN"), purposes: List("messaging"), gates: List("owner_binding"), required: false })
```
