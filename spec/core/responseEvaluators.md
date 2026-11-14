# Response-handler evaluator registry

`packages/core/src/runtime.ts:2411-2453` and `runtime/response-handler-evaluators.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517` define a distinct registry from ordinary evaluators and response-field evaluators. Registration compares the exact evaluator name; removal trims the caller's name and removes its first exact match. Registration retains handler object identity and insertion order.

## Story: Register each named response evaluator once

As a plugin I keep the first evaluator registered under an exact name and can remove a matching normalized name without touching peers.

### Duplicate registration preserves the original evaluator identity

The string adapter supplies `normalizedName = name.trim()` for removal. Registered names are not trimmed or case-folded. Thus a whitespace-padded registered name is distinct and is not silently normalized into another registration.

```quint
type ResponseEvaluator = {name: str, reference: int}
type ResponseEvaluators = {entries: List[ResponseEvaluator]}
pure val initial: ResponseEvaluators = {entries: List()}
pure val nameValues = Set("first", "First", " first ")
pure val normalizedNameValues = Set("", "first", "First")
pure val referenceValues = Set(1, 2)
pure def canRegister(s: ResponseEvaluators, name: str, reference: int): bool = reference > 0
pure def register(s: ResponseEvaluators, name: str, reference: int): ResponseEvaluators = if (s.entries.some(e => e.name == name)) s else {entries: s.entries.append({name: name, reference: reference})}
pure def unregister(s: ResponseEvaluators, normalizedName: str): ResponseEvaluators = if (normalizedName == "") s else {entries: s.entries.select(e => e.name != normalizedName)}
pure def alwaysExactNamesUnique(s: ResponseEvaluators): bool = s.entries.every(e => s.entries.select(other => other.name == e.name).length() == 1)
pure def stepRegistrationKeepsPriorNames(before: ResponseEvaluators, via: str, after: ResponseEvaluators): bool = via == "register" implies before.entries.every(e => after.entries.includes(e))
pure def sometimesCaseDistinctEvaluators(s: ResponseEvaluators): bool = s.entries.some(a => a.name == "first") and s.entries.some(b => b.name == "First")
```
