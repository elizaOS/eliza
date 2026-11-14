# Guarded stream buffer ownership

The source is `packages/core/src/security/guarded-stream.ts` at the pinned baseline. The scanner owns the pending exact character sequence. It chooses a safe cut using known token lengths, whitespace, grouped number/phone/mnemonic runs, credential openers, armor blocks and known token crossings. The normalized intervals below represent those detector results. The shell's detector-to-interval adapter must preserve that classification. Secret substitution precedes PII substitution; visible text restores PII and applies the secret reply policy.

## Story: Retain incomplete sensitive text across stream chunks

### Appending and releasing conserve every source character

A cut is permitted only inside the pending sequence and outside every sensitive interval. The buffer has no truncation operation. `sourceEmitted` records original source characters released to the transformation pipeline, preserving order independently of the transformed output length.

```quint
type SensitiveSpan = { start: int, end: int, open: bool }
type StreamBuffer = { received: List[int], pending: List[int], sourceEmitted: List[int], spans: List[SensitiveSpan], cancelled: bool, discarded: List[int], classified: bool, maxTokenLength: int }
pure val initial: StreamBuffer = { received: List(), pending: List(), sourceEmitted: List(), spans: List(), cancelled: false, discarded: List(), classified: false, maxTokenLength: 0 }
pure val chunkValues = Set(List(), List(65, 32), List(66, 67, 32))
pure val spansValues = Set(List(), List({ start: 0, end: 2, open: true }), List({ start: 1, end: 3, open: false }))
pure val maxTokenLengthValues = Set(0, 1, 2, 4)
pure val cutValues = Set(0, 1, 2, 3, 4)
pure def canAppendChunk(s: StreamBuffer, chunk: List[int]): bool = not(s.cancelled)
pure def appendChunk(s: StreamBuffer, chunk: List[int]): StreamBuffer = { ...s, received: s.received.concat(chunk), pending: s.pending.concat(chunk), classified: false }
pure def canClassify(s: StreamBuffer, spans: List[SensitiveSpan], maxTokenLength: int): bool = not(s.cancelled) and maxTokenLength >= 0 and spans.every(span => span.start >= 0 and span.end >= span.start and span.end <= s.pending.length())
pure def classify(s: StreamBuffer, spans: List[SensitiveSpan], maxTokenLength: int): StreamBuffer = { ...s, spans: spans, classified: true, maxTokenLength: maxTokenLength }
type Partition = { seen: int, prefix: List[int], suffix: List[int] }
pure def splitChars(chars: List[int], cut: int): Partition = chars.foldl({ seen: 0, prefix: List(), suffix: List() }, (parts, char) => { seen: parts.seen + 1, prefix: if (parts.seen < cut) parts.prefix.append(char) else parts.prefix, suffix: if (parts.seen < cut) parts.suffix else parts.suffix.append(char) })
pure def canRelease(s: StreamBuffer, cut: int): bool = not(s.cancelled) and s.classified and cut >= 0 and (cut == 0 or cut <= s.pending.length() - s.maxTokenLength) and s.spans.every(span => cut <= span.start or (not(span.open) and cut >= span.end))
pure def release(s: StreamBuffer, cut: int): StreamBuffer = { ...s, sourceEmitted: s.sourceEmitted.concat(splitChars(s.pending, cut).prefix), pending: splitChars(s.pending, cut).suffix, spans: s.spans.select(span => span.end > cut).listMap(span => { start: span.start - cut, end: span.end - cut, open: span.open }) }
pure def canFlush(s: StreamBuffer): bool = not(s.cancelled)
pure def flush(s: StreamBuffer): StreamBuffer = { ...s, sourceEmitted: s.sourceEmitted.concat(s.pending), pending: List(), spans: List() }
pure def cancel(s: StreamBuffer): StreamBuffer = { ...s, cancelled: true, discarded: s.discarded.concat(s.pending), pending: List(), spans: List() }
pure def alwaysEveryCharacterRetained(s: StreamBuffer): bool = s.received == s.sourceEmitted.concat(s.discarded).concat(s.pending)
pure def alwaysTokenWindowIsValid(s: StreamBuffer): bool = s.maxTokenLength >= 0
pure def alwaysSpansWithinBuffer(s: StreamBuffer): bool = s.spans.every(span => span.start >= 0 and span.end >= span.start and span.end <= s.pending.length())
pure def alwaysCancelledBufferEmpty(s: StreamBuffer): bool = s.cancelled implies s.pending.length() == 0
pure def sometimesBufferedTail(s: StreamBuffer): bool = s.pending.length() > 0 and s.sourceEmitted.length() > 0
```
