# Exact UTF-16 stream operations

Streaming buffers are JavaScript strings represented here by their complete UTF-16 code-unit lists. No hash, byte count, prefix sample or truncated summary substitutes for their contents. These pure operations support the parser-state models; conversion between strings and unit lists is an exact codec boundary.

## Story: Preserve every buffered unit until it is consumed or explicitly withheld

### Slices, prefix search and whitespace stripping preserve exact unit order

The whitespace predicate is the ECMAScript whitespace and line-terminator set used by the source's `\s`. Search selects the first exact occurrence. A slice consumes only the requested half-open interval.

```quint
type SliceWalk = { offset: int, units: List[int] }
type SearchWalk = { offset: int, found: int }
type TrimWalk = { offset: int, first: int, final: int }
pure def sliceUnits(units: List[int], start: int, end: int): List[int] = units.foldl({ offset: 0, units: List() }, (walk, code) => { offset: walk.offset + 1, units: if (walk.offset >= start and walk.offset < end) walk.units.append(code) else walk.units }).units
pure def unitPrefix(units: List[int], prefix: List[int]): bool = units.length() >= prefix.length() and sliceUnits(units, 0, prefix.length()) == prefix
pure def findUnits(units: List[int], pattern: List[int]): int = units.foldl({ offset: 0, found: if (pattern.length() == 0) 0 else -1 }, (walk, code) => { offset: walk.offset + 1, found: if (walk.found >= 0) walk.found else if (sliceUnits(units, walk.offset, walk.offset + pattern.length()) == pattern) walk.offset else -1 }).found
pure def whitespace(code: int): bool = (code >= 9 and code <= 13) or code == 32 or code == 160 or code == 5760 or (code >= 8192 and code <= 8202) or code == 8232 or code == 8233 or code == 8239 or code == 8287 or code == 12288 or code == 65279
pure def trimUnits(units: List[int]): List[int] = {
  val bounds = units.foldl({ offset: 0, first: -1, final: -1 }, (walk, code) => { offset: walk.offset + 1, first: if (walk.first < 0 and not(whitespace(code))) walk.offset else walk.first, final: if (whitespace(code)) walk.final else walk.offset })
  if (bounds.first < 0) List() else sliceUnits(units, bounds.first, bounds.final + 1)
}
pure def dropLeadingWhitespace(units: List[int]): List[int] = {
  val bounds = units.foldl({ offset: 0, found: -1 }, (walk, code) => { offset: walk.offset + 1, found: if (walk.found >= 0 or whitespace(code)) walk.found else walk.offset })
  if (bounds.found < 0) List() else sliceUnits(units, bounds.found, units.length())
}
pure def lawWholeSlicePreservesUnits(units: List[int]): bool = sliceUnits(units, 0, units.length()) == units
pure def lawPrefixSliceLength(units: List[int], end: int): bool = end >= 0 and end <= units.length() implies sliceUnits(units, 0, end).length() == end
```

### A well-formed conversion retains pairs and replaces only unpaired surrogates

Interior lone surrogates become U+FFFD without changing the number of code units. A buffered trailing high surrogate can be retained separately before this function is called, then joined with the next chunk's low surrogate.

```quint
type WellFormedWalk = { pending: int, units: List[int] }
pure def high(code: int): bool = code >= 55296 and code <= 56319
pure def low(code: int): bool = code >= 56320 and code <= 57343
pure def sanitizeUnit(walk: WellFormedWalk, code: int): WellFormedWalk =
  if (walk.pending >= 0 and low(code)) { pending: -1, units: walk.units.append(walk.pending).append(code) }
  else if (high(code)) { pending: code, units: if (walk.pending >= 0) walk.units.append(65533) else walk.units }
  else { pending: -1, units: (if (walk.pending >= 0) walk.units.append(65533) else walk.units).append(if (low(code)) 65533 else code) }
pure def wellFormed(units: List[int]): List[int] = {
  val result = units.foldl({ pending: -1, units: List() }, (walk, code) => sanitizeUnit(walk, code))
  if (result.pending >= 0) result.units.append(65533) else result.units
}
pure def lawWellFormedLengthPreserved(units: List[int]): bool = wellFormed(units).length() == units.length()
pure def lawPairPreserved(highUnit: int, lowUnit: int): bool = high(highUnit) and low(lowUnit) implies wellFormed(List(highUnit, lowUnit)) == List(highUnit, lowUnit)
pure val highUnitValues = Set(55296, 56319)
pure val lowUnitValues = Set(56320, 57343)
```

### JSON boundary scanning retains incomplete escapes and balanced containers

The source boundary scanner finds a closing quote without validating JSON contents. A backslash skips its next unit; `\u` skips four following units and remains incomplete until all four arrive. Container scanning tracks the exact expected closing-bracket stack and ignores brackets inside strings. Strict JSON decoding is a separate pure boundary.

```quint
type JsonScan = { offset: int, skipUntil: int, end: int, valid: bool, inString: bool, closers: List[int] }
pure def scanJsonUnit(scan: JsonScan, units: List[int], code: int, balanced: bool): JsonScan = {
  val position = scan.offset
  val advanced = { ...scan, offset: position + 1 }
  val following = units.nthOr(position + 1, -1)
  if (not(scan.valid) or scan.end >= 0 or position < scan.skipUntil) advanced
  else if (scan.inString and code == 92) { ...advanced, valid: following != -1 and (following != 117 or position + 5 < units.length()), skipUntil: position + (if (following == 117) 6 else 2) }
  else if (scan.inString and code == 34) { ...advanced, inString: false, end: if (balanced) -1 else position + 1 }
  else if (scan.inString) advanced
  else if (code == 34) { ...advanced, inString: true }
  else if (code == 123 or code == 91) { ...advanced, closers: scan.closers.append(if (code == 123) 125 else 93) }
  else if (code == 125 or code == 93) { ...advanced, valid: scan.closers.nthOr(scan.closers.length() - 1, -1) == code, closers: sliceUnits(scan.closers, 0, scan.closers.length() - 1), end: if (scan.closers.length() == 1 and scan.closers.nthOr(0, -1) == code) position + 1 else -1 }
  else advanced
}
pure def jsonStringEnd(units: List[int]): int = {
  val scan = units.foldl({ offset: 0, skipUntil: 1, end: -1, valid: true, inString: true, closers: List() }, (scanState, code) => scanJsonUnit(scanState, units, code, false))
  if (units.nthOr(0, -1) == 34 and scan.valid) scan.end else -1
}
pure def balancedJsonEnd(units: List[int]): int = {
  val scan = units.foldl({ offset: 0, skipUntil: 0, end: -1, valid: true, inString: false, closers: List() }, (scanState, code) => scanJsonUnit(scanState, units, code, true))
  if (scan.valid) scan.end else -1
}
pure def hexValue(code: int): int = if (code >= 48 and code <= 57) code - 48 else if (code >= 65 and code <= 70) code - 55 else if (code >= 97 and code <= 102) code - 87 else -1
pure def decodeEscape(units: List[int]): List[int] = {
  val second = units.nthOr(1, -1)
  val a = hexValue(units.nthOr(2, -1))
  val b = hexValue(units.nthOr(3, -1))
  val c = hexValue(units.nthOr(4, -1))
  val d = hexValue(units.nthOr(5, -1))
  if (units.nthOr(0, -1) != 92) units
  else if (units.length() == 6 and second == 117 and a >= 0 and b >= 0 and c >= 0 and d >= 0) List(a * 4096 + b * 256 + c * 16 + d)
  else if (units.length() != 2) units
  else if (second == 34 or second == 47 or second == 92) List(second)
  else if (second == 98) List(8)
  else if (second == 102) List(12)
  else if (second == 110) List(10)
  else if (second == 114) List(13)
  else if (second == 116) List(9)
  else units
}
pure def lawOrdinaryStringBoundary(code: int): bool = code != 34 and code != 92 implies jsonStringEnd(List(34, code, 34)) == 3
pure def lawUnicodeEscapeDecodes(code: int): bool = code == 65 implies decodeEscape(List(92, 117, 48, 48, 52, 49)) == List(code)
```
