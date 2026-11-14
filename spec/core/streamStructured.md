# Structured stream observations

The authoritative machine is [structuredStreamState](./structuredStreamState.md). This file is a pure observation library over that state; it owns no buffer, counter, registry or transition. The source is `StructuredFieldStreamExtractor` in `utils/streaming.ts`.

## Story: Inspect the exact current structured stream

### Observations derive field lengths and validation from the authoritative records

A field length is the length of its complete retained UTF-16 value. A delivered length comes from its exact emitted prefix. Validation and start/done identities come from the owning sets. No observation invents independent state that could diverge from those records.

```quint
import structuredStreamState as S from "./structuredStreamState"
type FieldObservation = { contentUnits: int, deliveredUnits: int, validated: bool, started: bool, done: bool }
pure def observeField(s: S::StructuredState, name: str): FieldObservation = { contentUnits: S::fieldAt(s.fieldRows, name).content.length(), deliveredUnits: S::fieldAt(s.fieldRows, name).emitted.length(), validated: s.validated.contains(name), started: s.started.contains(name), done: s.done.contains(name) }
pure def missingFields(s: S::StructuredState): List[str] = s.schema.select(name => S::fieldAt(s.fieldRows, name).status == S::PendingField)
pure def invalidFields(s: S::StructuredState): List[str] = s.schema.select(name => S::fieldAt(s.fieldRows, name).status == S::InvalidField)
pure def incompleteFields(s: S::StructuredState): List[str] = s.schema.select(name => S::fieldAt(s.fieldRows, name).status == S::PartialField)
pure def lawObservedLengthsNonnegative(s: S::StructuredState, name: str): bool = observeField(s, name).contentUnits >= 0 and observeField(s, name).deliveredUnits >= 0
pure def lawValidatedObservationIsExact(s: S::StructuredState, name: str): bool = observeField(s, name).validated == s.validated.contains(name)
pure val sValues: Set[S::StructuredState] = Set(S::initial)
```
