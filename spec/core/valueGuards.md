# Structural values and boolean configuration

Source `utils/type-guards.ts` defines strict plain records and loose non-array objects. Source `utils/boolean.ts` preserves existing truthy/falsy vocabulary and optional absence. Input kind and prototype are observations made before model transitions, preserving real JavaScript descriptor and prototype semantics.

## Story: Narrow untrusted values without changing their meaning

As a plugin, I want predictable structural type guards at public boundaries.

### Plain records require the intrinsic object prototype or a null prototype

Null, arrays and primitives fail both record guards. Class instances and built-in objects pass the loose record guard. The strict guard reads the prototype directly and never consults a spoofable constructor property. `hasPlainObjectTag` applies the loose guard and then the object-tag observation.

```quint
type ObjectKind = PrimitiveValue | NullValue | ArrayValue | PlainObject | NullPrototypeObject | ClassObject | BuiltInObject
pure def plainRecord(kind: ObjectKind): bool = kind == PlainObject or kind == NullPrototypeObject
pure def objectRecord(kind: ObjectKind): bool = plainRecord(kind) or kind == ClassObject or kind == BuiltInObject
pure def plainObjectTag(kind: ObjectKind, objectTag: bool): bool = objectRecord(kind) and objectTag
pure def lawPlainRecordIsLoose(kind: ObjectKind): bool = plainRecord(kind) implies objectRecord(kind)
pure def lawArrayNeverRecord(kind: ObjectKind): bool = kind == ArrayValue implies not(plainRecord(kind)) and not(objectRecord(kind))
pure def lawClassOnlyLoose(kind: ObjectKind): bool = kind == ClassObject implies objectRecord(kind) and not(plainRecord(kind))
```

### Truthy vocabulary wins an overlapping normalized boolean match

Boolean inputs pass through. Strings are trimmed and lowercased along with custom vocabulary. Empty and unmatched strings return absence. When custom truthy and falsy sets overlap, the truthy match wins.

```quint
type BooleanResult = BooleanAbsent | BooleanTrue | BooleanFalse
pure val defaultTruthy = Set("true", "1", "yes", "on")
pure val defaultFalsy = Set("false", "0", "no", "off")
pure def parseNormalizedBoolean(text: str, truthy: Set[str], falsy: Set[str]): BooleanResult = if (text == "") BooleanAbsent else if (truthy.contains(text)) BooleanTrue else if (falsy.contains(text)) BooleanFalse else BooleanAbsent
pure def lawTruthyWinsOverlap(text: str, truthy: Set[str], falsy: Set[str]): bool = (text != "" and truthy.contains(text)) implies parseNormalizedBoolean(text, truthy, falsy) == BooleanTrue
pure def lawDefaultYes(text: str): bool = text == "yes" implies parseNormalizedBoolean(text, defaultTruthy, defaultFalsy) == BooleanTrue
pure def lawDefaultOff(text: str): bool = text == "off" implies parseNormalizedBoolean(text, defaultTruthy, defaultFalsy) == BooleanFalse
```
