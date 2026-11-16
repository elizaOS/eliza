# Key management

The trusted host derives every encryption key it uses from one master key,
with HKDF and a distinct namespace per purpose (field encryption, backups,
session signing, audit signing), so a key for one purpose can never open
data sealed for another. Sealed data carries its namespace and an
authentication tag, and opening fails closed on any mismatch. The bundle of
operation keys a host works with is never released to a renderer or a
remote service. This is a library: the derivation and the seal are modeled
as values, with the cryptography itself supplied by the host.

External key custody services are not part of Eliza; the [vault](./vault.md)
supplies the master key. Rotating the master key and re-sealing what it
protects is not yet specified, and is needed before production; until then a
host keeps one master key.

## Story: Encrypt fields and backups under namespaced keys

> As the trusted host, I want each kind of data sealed under a key of its
> own purpose, so that leaking or misusing one key, or mixing up one blob,
> never opens data of another kind.

### Each namespace derives a distinct key from the master key

A derived key is identified by its master key and namespace, so two
different pairs are two different keys.

```quint
type KeyNamespace = FieldEncryption | BackupEncryption | SessionSigning | AuditSigning
type DerivedKey = { master: int, namespace: KeyNamespace }
pure def deriveKey(master: int, namespace: KeyNamespace): DerivedKey = { master: master, namespace: namespace }
```

### Opening with the wrong namespace, the wrong key or a wrong tag fails closed

The tag is the keyed MAC the host computes over the plaintext with the
derived key; nothing more of it is assumed.

```quint
const mac: (int, KeyNamespace, int) => int
type SealedData = { namespace: KeyNamespace, keyMaster: int, plaintext: int, tag: int }
type OpenResult = { ok: bool, plaintext: int }
pure def tagOf(key: DerivedKey, plaintext: int): int = mac(key.master, key.namespace, plaintext)
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
pure val dataValues = Set({ namespace: FieldEncryption, keyMaster: 1, plaintext: 5, tag: 1 }, { namespace: FieldEncryption, keyMaster: 1, plaintext: 5, tag: 2 }, { namespace: BackupEncryption, keyMaster: 1, plaintext: 5, tag: 1 })
pure val masterValues = Set(1, 2)
pure val plaintextValues = Set(0, 5)
pure val deltaValues = Set(-1, 0, 1)
```
