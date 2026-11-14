# Prompt optimization score cards

Source `prompt-optimization.ts` stores ScoreSignal records and calculates a weighted composite. Host hooks own prompt-template merging and registry/baseline/failure trace persistence. They retain complete trace fields and typed asynchronous failure propagation.

## Story: Aggregate trace signals with explicit weight precedence

As an optimizer, I want the stored signals preserved while composite scoring follows the source's override and NaN rules.

### Numeric signals remain ordered and NaN values are skipped only during aggregation

`add` accepts any JavaScript number, including NaN and infinities. Non-numbers are ignored. `bySource` and `byKind` filter the stored order. `toJSON` copies the signal array, and `fromJSON` re-adds records and recomputes the score while ignoring the supplied composite field.

```quint
type NumericKind = FiniteValue | NaNValue | PositiveInfinity | NegativeInfinity | NonNumeric
type ScoreSignal = { source: str, kind: str, numericKind: NumericKind, value: int, metadata: str }
type ScoreCard = { signals: List[ScoreSignal] }
pure val initial: ScoreCard = { signals: List() }
pure def addSignal(c: ScoreCard, source: str, kind: str, numericKind: NumericKind, value: int, metadata: str): ScoreCard = if (numericKind == NonNumeric) c else { signals: c.signals.append({ source: source, kind: kind, numericKind: numericKind, value: value, metadata: metadata }) }
pure def bySource(c: ScoreCard, source: str): List[ScoreSignal] = c.signals.foldl(List(), (selected, signal) => if (signal.source == source) selected.append(signal) else selected)
pure def byKind(c: ScoreCard, kind: str): List[ScoreSignal] = c.signals.foldl(List(), (selected, signal) => if (signal.kind == kind) selected.append(signal) else selected)
pure def contributes(signal: ScoreSignal): bool = signal.numericKind != NaNValue and signal.numericKind != NonNumeric
pure def alwaysStoredSignalsNumeric(c: ScoreCard): bool = c.signals.every(signal => signal.numericKind != NonNumeric)
pure def sometimesNaNSignalRetained(c: ScoreCard): bool = c.signals.some(signal => signal.numericKind == NaNValue)
pure def sometimesSignalsCollected(c: ScoreCard): bool = c.signals.length() > 0
```

### Signal weight wins over exact call and constructor overrides

Composite merges constructor overrides with call overrides first. For each signal, precedence is explicit signal weight, merged exact `source:kind` override, exact default, source wildcard default, then one. Custom wildcard overrides are not consulted. An empty card or a zero total weight returns zero. Otherwise the source computes the IEEE weighted sum divided by total weight, preserving infinities and possible NaN. The [captured numeric fixtures](./baseline/numeric-fixtures.json) record source outputs. The integer value field here records finite test numerators; floating arithmetic and metadata bytes remain explicit future proof/fixture boundaries.

```quint
type WeightOrigin = SignalWeight | CallWeight | ConstructorWeight | ExactDefaultWeight | SourceDefaultWeight | UnitWeight
pure def weightOrigin(signalWeight: bool, callWeight: bool, constructorWeight: bool, exactDefault: bool, sourceDefault: bool): WeightOrigin = if (signalWeight) SignalWeight else if (callWeight) CallWeight else if (constructorWeight) ConstructorWeight else if (exactDefault) ExactDefaultWeight else if (sourceDefault) SourceDefaultWeight else UnitWeight
pure def lawExplicitSignalWeightWins(callWeight: bool, constructorWeight: bool, exactDefault: bool, sourceDefault: bool): bool = weightOrigin(true, callWeight, constructorWeight, exactDefault, sourceDefault) == SignalWeight
pure def lawCallOverridesConstructor(exactDefault: bool, sourceDefault: bool): bool = weightOrigin(false, true, true, exactDefault, sourceDefault) == CallWeight
pure def lawNaNSkipped(source: str, kind: str, value: int, metadata: str): bool = not(contributes({ source: source, kind: kind, numericKind: NaNValue, value: value, metadata: metadata }))
```
