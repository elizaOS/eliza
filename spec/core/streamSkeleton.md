# Skeleton stream observations

The authoritative machine is [skeletonStreamState](./skeletonStreamState.md). This file derives observations from its exact buffers, field values, gate and parser positions. It owns no second stream state. The source is `ResponseSkeletonStreamExtractor` in `utils/streaming.ts`.

## Story: Inspect stream gate and visible progress

### Visible lengths and gate decisions derive from the authoritative stream

Retained units are the full parser buffer. Visible units count the actual emitted chunks, including passthrough prose. The observation reports the source's independent held, gate-decided, active-field and pending-escape states rather than reducing them to one completion flag.

```quint
import skeletonStreamState as S from "./skeletonStreamState"
type SkeletonObservation = { retainedUnits: int, visibleUnits: int, gateHeadUnits: int, decided: bool, held: bool, activeField: str, escapeUnits: int }
pure def observe(s: S::SkeletonState): SkeletonObservation = { retainedUnits: s.buffer.length(), visibleUnits: s.chunks.foldl(0, (total, chunk) => total + chunk.units.length()), gateHeadUnits: s.gateHead.length(), decided: s.gateDecided, held: s.held, activeField: s.activeField, escapeUnits: s.pendingEscape.length() }
pure def lawObservedBufferIsExact(s: S::SkeletonState): bool = observe(s).retainedUnits == s.buffer.length() and observe(s).gateHeadUnits == s.gateHead.length()
pure def lawObservedLengthsNonnegative(s: S::SkeletonState): bool = observe(s).retainedUnits >= 0 and observe(s).visibleUnits >= 0 and observe(s).escapeUnits >= 0
pure val sValues: Set[S::SkeletonState] = Set(S::initial)
```
