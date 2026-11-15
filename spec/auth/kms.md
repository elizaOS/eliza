# Key management

The trusted host derives every encryption key it uses from one master key,
with HKDF and a distinct namespace per purpose (field encryption, backups,
session signing, audit signing), so a key for one purpose can never open
data sealed for another. Sealed data carries its namespace and an
authentication tag, and opening fails closed on any mismatch. The bundle of
operation keys a host works with is never released to a renderer or a
remote service. This is a library: the derivation and the seal are modeled
as values, with the cryptography itself supplied by the host.

New in v4, from develop `src/kms/` (the local adapters and the
`AGENT_BACKUP_*` namespaces). External key custody services are not part of
Eliza; the [vault](./vault.md) supplies the master key.

## Story: Encrypt fields and backups under namespaced keys

> As the trusted host, I want each kind of data sealed under a key of its
> own purpose, so that leaking or misusing one key, or mixing up one blob,
> never opens data of another kind.

### Each namespace derives a distinct key from the master key

```quint
type KeyNamespace = FieldEncryption | BackupEncryption | SessionSigning | AuditSigning
type DerivedKey = { master: int, namespace: KeyNamespace }
pure def deriveKey(master: int, namespace: KeyNamespace): DerivedKey = { master: master, namespace: namespace }
pure def lawNamespacesDeriveDistinctKeys(master: int, first: KeyNamespace, second: KeyNamespace): bool =
  first != second implies deriveKey(master, first) != deriveKey(master, second)
pure def lawMastersDeriveDistinctKeys(master: int, other: int, namespace: KeyNamespace): bool =
  master != other implies deriveKey(master, namespace) != deriveKey(other, namespace)
```

### Opening with the wrong namespace, the wrong key or a wrong tag fails closed

```quint
type SealedData = { namespace: KeyNamespace, keyMaster: int, plaintext: int, tag: int }
type OpenResult = { ok: bool, plaintext: int }
pure def namespaceCode(namespace: KeyNamespace): int =
  if (namespace == FieldEncryption) 1 else if (namespace == BackupEncryption) 2 else if (namespace == SessionSigning) 3 else 4
pure def tagOf(key: DerivedKey, plaintext: int): int = key.master * 100 + namespaceCode(key.namespace) * 10 + plaintext
pure def seal(key: DerivedKey, plaintext: int): SealedData = { namespace: key.namespace, keyMaster: key.master, plaintext: plaintext, tag: tagOf(key, plaintext) }
pure def unseal(key: DerivedKey, data: SealedData): OpenResult =
  if (data.namespace == key.namespace and data.keyMaster == key.master and data.tag == tagOf(key, data.plaintext)) { ok: true, plaintext: data.plaintext } else { ok: false, plaintext: 0 }
pure def lawSealedDataOpensWithItsKey(master: int, namespace: KeyNamespace, plaintext: int): bool =
  unseal(deriveKey(master, namespace), seal(deriveKey(master, namespace), plaintext)) == { ok: true, plaintext: plaintext }
pure def lawWrongNamespaceFailsClosed(master: int, first: KeyNamespace, second: KeyNamespace, plaintext: int): bool =
  first != second implies not(unseal(deriveKey(master, second), seal(deriveKey(master, first), plaintext)).ok)
pure def lawAlteredTagFailsClosed(master: int, namespace: KeyNamespace, plaintext: int, delta: int): bool =
  delta != 0 implies not(unseal(deriveKey(master, namespace), { ...seal(deriveKey(master, namespace), plaintext), tag: tagOf(deriveKey(master, namespace), plaintext) + delta }).ok)
pure def lawFailedOpenRevealsNothing(key: DerivedKey, data: SealedData): bool = not(unseal(key, data).ok) implies unseal(key, data).plaintext == 0
pure val keyValues = Set({ master: 1, namespace: FieldEncryption }, { master: 2, namespace: BackupEncryption })
pure val dataValues = Set({ namespace: FieldEncryption, keyMaster: 1, plaintext: 5, tag: 115 }, { namespace: FieldEncryption, keyMaster: 1, plaintext: 5, tag: 116 }, { namespace: BackupEncryption, keyMaster: 1, plaintext: 5, tag: 125 })
pure val plaintextValues = Set(0, 5, 9)
pure val deltaValues = Set(-1, 0, 1)
```

### Operation key bundles never leave the trusted host

```quint
type BundleDestination = TrustedHost | Renderer | RemoteService
pure def bundleReleasable(destination: BundleDestination): bool = destination == TrustedHost
pure def lawBundleStaysOnTheHost(destination: BundleDestination): bool = destination != TrustedHost implies not(bundleReleasable(destination))
```
