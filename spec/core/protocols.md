# Protocol value contracts

The `protocol`, `schema-types`, `permissions`, `task-events`, `task-widgets`, `speech` and `view-interaction` leaves expose renderer-safe DTOs and pure functions. Their complete declarations are pinned in [the public surface](./baseline/core-public-surface.json). Core owns message, content, entity, relationship, effect, model, plugin, trigger, notification, payment, view and connector contracts. Hosts own HTTP server registration and platform-specific configuration. Effect failures retain typed tags and causes at the public Promise boundary.

## Story: Share canonical values across hosts and plugins

As a consumer, I want serialized values and callback payloads to preserve their identity and validation rules across runtime boundaries.

### A public value retains identity and explicitly declared version

Event ids, run ids, agent ids, room ids, entity ids, parent ids and discriminants remain opaque exact values. Versioned backup and protocol schemas accept the declared version and reject another version before mutation. The source's optional fields remain optional.

```quint
type VersionedValue = { id: str, version: int, payload: str }
pure def versionAccepted(value: VersionedValue, expected: int): bool = value.version == expected
pure def preserveValue(value: VersionedValue): VersionedValue = value
pure val valueValues = Set({ id: "request-a", version: 1, payload: "body" })
pure def lawProtocolIdentity(value: VersionedValue): bool = preserveValue(value) == value
pure def lawVersionMismatchRejected(value: VersionedValue, expected: int): bool = value.version != expected implies not(versionAccepted(value, expected))
```

### Binary helpers preserve byte contents and the input slice ownership contract

`utils/buffer.ts` accepts Buffer and Uint8Array values. Buffer slicing retains Buffer's shared storage behavior, while Uint8Array slicing returns its standard copied representation. Hex conversion strips non-hex separators before decoding. UTF-8 and base64 conversions, zero-filled allocation and cryptographic random bytes retain the source behavior. Byte lists below describe content independently of representation ownership.

```quint
pure def sameBytes(left: List[int], right: List[int]): bool = left == right
pure def lawByteEqualityReflexive(bytes: List[int]): bool = sameBytes(bytes, bytes)
pure def lawByteEqualitySymmetric(left: List[int], right: List[int]): bool = sameBytes(left, right) == sameBytes(right, left)
```
