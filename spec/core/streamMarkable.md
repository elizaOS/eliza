# Passthrough and markable streaming

Source `utils/streaming.ts` exports `PassthroughExtractor`, `MarkableExtractor`, `createStreamingRetryState` and `createStreamingContext`. Text is represented here by UTF-16 units. The passthrough and markable extractors return the complete supplied chunk. The wrapping streaming context suppresses dispatch after completion.

## Story: Track completion and retry text without changing a chunk

As a streaming host, I want completion, reset and accumulated retry text to agree with the exact text delivered to my callback.

### Bare push echoes its input and the context gates completed delivery

The real chunk limit is 1,048,576 UTF-16 code units and nonstrings raise TypeError. Marking complete changes only completion state. Reset clears completion and wrapper accumulation. Flush adds no data for these two extractors.

```quint
type Markable = { done: bool, echo: List[int], delivered: List[int] }
pure val initial: Markable = { done: false, echo: List(), delivered: List() }
pure def canPushRaw(m: Markable, units: List[int]): bool = units.length() <= 1048576 and units.every(unit => unit >= 0 and unit <= 65535)
pure def pushRaw(m: Markable, units: List[int]): Markable = { ...m, echo: units }
pure def canPushContext(m: Markable, units: List[int]): bool = not(m.done) and canPushRaw(m, units)
pure def pushContext(m: Markable, units: List[int]): Markable = { ...m, echo: units, delivered: m.delivered.concat(units) }
pure def markComplete(m: Markable): Markable = { ...m, done: true }
pure def reset(m: Markable): Markable = initial
pure def alwaysValidDeliveredUnits(m: Markable): bool = m.delivered.every(unit => unit >= 0 and unit <= 65535)
pure def stepCompletionBlocksContext(before: Markable, via: str, after: Markable): bool = before.done and via != "reset" implies before.delivered == after.delivered
pure def sometimesStreamComplete(m: Markable): bool = m.done
pure def sometimesStreamDelivered(m: Markable): bool = m.delivered.length() > 0
```
