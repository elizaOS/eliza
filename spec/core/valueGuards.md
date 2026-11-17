# Structural values and boolean configuration

Source `utils/type-guards.ts` defines strict plain records and loose non-array objects. Source `utils/boolean.ts` preserves existing truthy/falsy vocabulary and optional absence. Each structural predicate consumes its own native observations, without sharing an eager classifier.

## Story: Narrow untrusted values without changing their meaning

As a plugin, I want predictable structural type guards at public boundaries.

### Plain records require the intrinsic object prototype or a null prototype

Null and non-object values fail both record guards. The loose guard observes whether an object is an array, without reading its prototype. The strict guard reads the prototype directly, without checking array status or constructor identity. It therefore accepts an array whose prototype is null or the intrinsic Object prototype, while the loose guard rejects it. Other non-array objects pass the loose guard regardless of their prototype.

`hasPlainObjectTag` first applies the loose guard. Only an admitted object has its tag observed through `Object.prototype.toString.call`; refusal performs no tag read. The model receives completed observations. Native observation failures propagate through the synchronous boundary without being converted into a false result.

```quint
type PlainObservation = PlainNotObject | PlainNullPrototype | PlainIntrinsicPrototype | PlainOtherPrototype
type LooseObservation = LooseNotObject | LooseArray | LooseNonArrayObject
type TagObservation = TagNotLoose | TagMatches | TagDiffers
pure def plainRecord(observation: PlainObservation): bool = observation == PlainNullPrototype or observation == PlainIntrinsicPrototype
pure def objectRecord(observation: LooseObservation): bool = observation == LooseNonArrayObject
pure def plainObjectTag(observation: TagObservation): bool = observation == TagMatches
pure def lawAllowedPrototypesArePlain(observation: PlainObservation): bool = (observation == PlainNullPrototype or observation == PlainIntrinsicPrototype) implies plainRecord(observation)
pure def lawOtherObservationsAreNotPlain(observation: PlainObservation): bool = (observation == PlainNotObject or observation == PlainOtherPrototype) implies not(plainRecord(observation))
pure def lawLooseRecordsAreNonArrayObjects(observation: LooseObservation): bool = objectRecord(observation) == (observation == LooseNonArrayObject)
pure def lawTagObservations(observation: TagObservation): bool = plainObjectTag(observation) == (observation == TagMatches)
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
