# Protocol value contracts

The renderer-safe `protocol`, `schema-types`, `permissions`, `task-events`, `task-widgets`, `speech` and `view-interaction` leaves expose DTOs and pure functions whose declarations are pinned in [the public surface](./baseline/core-public-surface.json). Connector accounts are [account lifecycle and storage](./connectorStorage.md), the capability catalog is [capability routing](./capabilityRouting.md) and the device bridge is [device bridge](./deviceBridge.md). Hosts own HTTP server registration and platform configuration. Effect failures keep their typed tags and causes at the public Promise boundary. The binary helpers in `utils/buffer.ts` accept Buffer and Uint8Array values and keep the platform's storage contract: a Buffer slice shares the source's storage, a Uint8Array slice is a copy, hex decoding strips non-hex separators, and UTF-8, base64, zero-filled allocation and cryptographic random bytes keep the source behavior.

## Story: Share canonical values across hosts and plugins

> As a consumer, I want serialized values and callback payloads to keep
> their identity and validation rules across runtime boundaries, so that a
> host and a plugin read the same value.

### A store holds only values of the version it declares

Versioned backup and protocol schemas accept the declared version and reject
any other before mutation, so a rejected value leaves the store unchanged and
a store never holds a value of another version. Event, run, agent, room,
entity and parent ids and discriminants pass through as opaque exact values,
and optional fields stay optional.

```quint
type VersionedValue = { id: str, version: int, payload: str }
pure def versionAccepted(value: VersionedValue, expected: int): bool = value.version == expected
pure def admitVersioned(stored: List[VersionedValue], value: VersionedValue, expected: int): List[VersionedValue] =
  if (versionAccepted(value, expected)) stored.append(value) else stored
pure val valueValues = Set({ id: "request-a", version: 1, payload: "body" }, { id: "request-a", version: 2, payload: "body" })
pure val storedValues = Set(List(), List({ id: "request-b", version: 1, payload: "kept" }))
pure val expectedValues = Set(1, 2)
pure def lawStoreHoldsOnlyTheDeclaredVersion(stored: List[VersionedValue], value: VersionedValue, expected: int): bool =
  stored.every(v => v.version == expected) implies admitVersioned(stored, value, expected).every(v => v.version == expected)
```
