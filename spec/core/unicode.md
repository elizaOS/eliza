# Unicode byte lengths and boundaries

Source `utils/unicode.ts` defines UTF-8 byte counting, lone-surrogate sanitation, prefix and suffix boundaries, and deep payload sanitation. The model represents a JavaScript string as its exact UTF-16 code-unit sequence. Converting a JavaScript string to that sequence is the future adapter's mechanical contract.

## Story: Preserve Unicode in provider requests and diagnostics

As a caller, I want emoji and multilingual text preserved across encoding and authorized boundary operations.

### Byte counting combines surrogate pairs and replaces unpaired surrogates

ASCII code units consume one UTF-8 byte, code units below 2048 consume two, other BMP code units consume three, and a high/low surrogate pair consumes four. A lone surrogate has the three-byte replacement representation. This function counts the entire supplied sequence.

```quint
type Utf8Counter = { pendingHigh: bool, bytes: int }
pure def highSurrogate(code: int): bool = code >= 55296 and code <= 56319
pure def lowSurrogate(code: int): bool = code >= 56320 and code <= 57343
pure def countStandalone(bytes: int, code: int): Utf8Counter = if (highSurrogate(code)) { pendingHigh: true, bytes: bytes } else { pendingHigh: false, bytes: bytes + (if (code < 128) 1 else if (code < 2048) 2 else 3) }
pure def countCodeUnit(c: Utf8Counter, code: int): Utf8Counter = if (c.pendingHigh and lowSurrogate(code)) { pendingHigh: false, bytes: c.bytes + 4 } else countStandalone(c.bytes + (if (c.pendingHigh) 3 else 0), code)
pure def utf8Length(codeUnits: List[int]): int = {
  val counter = codeUnits.foldl({ pendingHigh: false, bytes: 0 }, (c, code) => countCodeUnit(c, code))
  counter.bytes + (if (counter.pendingHigh) 3 else 0)
}
pure def lawPairUsesFourBytes(high: int, low: int): bool = (highSurrogate(high) and lowSurrogate(low)) implies utf8Length(List(high, low)) == 4
pure def lawLoneHighUsesReplacement(high: int): bool = highSurrogate(high) implies utf8Length(List(high)) == 3
pure def lawLoneLowUsesReplacement(low: int): bool = lowSurrogate(low) implies utf8Length(List(low)) == 3
pure val highValues = Set(55295, 55296, 56319, 56320)
pure val lowValues = Set(56319, 56320, 57343, 57344)
```

### Prefix and suffix boundaries cannot introduce a split surrogate pair

Prefix truncation backs off one code unit when the requested cut falls between a high/low pair. Tail selection advances one code unit in the dual case. Existing lone surrogates retain their bytes until the explicit sanitation operation.

```quint
pure def prefixBoundary(requested: int, left: int, right: int): int = if (requested > 0 and highSurrogate(left) and lowSurrogate(right)) requested - 1 else requested
pure def suffixBoundary(requested: int, left: int, right: int): int = if (highSurrogate(left) and lowSurrogate(right)) requested + 1 else requested
pure def lawPrefixBacksOffPair(requested: int, high: int, low: int): bool = (requested > 0 and highSurrogate(high) and lowSurrogate(low)) implies prefixBoundary(requested, high, low) == requested - 1
pure def lawSuffixSkipsSplitPair(requested: int, high: int, low: int): bool = (highSurrogate(high) and lowSurrogate(low)) implies suffixBoundary(requested, high, low) == requested + 1
```
