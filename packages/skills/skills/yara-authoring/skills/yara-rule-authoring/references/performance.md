# YARA-X Performance Guidelines

Understanding how YARA-X works internally helps you write rules that scan fast.

> **YARA-X Performance:** YARA-X is 5-10x faster than legacy YARA for regex-heavy rules due to its Rust-based regex engine. The atom extraction and matching principles remain the same.

## How YARA Scanning Works

### Three-Phase Process

1. **Atom Extraction** — YARA extracts short byte sequences (atoms) from your strings
2. **Aho-Corasick Matching** — Fast multi-pattern search finds atom occurrences
3. **Bytecode Verification** — For each atom hit, verify the full string/condition

The key insight: **Phase 2 is fast, Phase 3 is slow.** Poor atoms cause excessive Phase 3 verification.

### What Makes a Good Atom

YARA extracts 4-byte atoms from your strings. The best atoms are:

- **Rare in target files** — Unique byte sequences
- **Unambiguous** — No wildcards in the 4-byte window
- **Not in common data** — Avoid patterns found in every PE

```
String: "MalwareConfig"
Atom:   "Malw" (bytes 0-3)

String: { 4D 5A ?? ?? 50 45 }
Atom:   { 50 45 ?? ?? } — wildcards limit options
```

## Slow Pattern Killers

### Short Strings (< 4 bytes)

```yara
// TERRIBLE: No valid 4-byte atom
$bad = "abc"        // Only 3 bytes
$bad = { 4D 5A }    // Only 2 bytes

// GOOD: Full atoms available
$good = "abcdef"
$good = { 4D 5A 90 00 50 45 }
```

Short strings force YARA to check every file, defeating the Aho-Corasick optimization.

### Repeated Byte Patterns

```yara
// SLOW: Atom "0000" matches constantly
$nops = { 90 90 90 90 90 90 }  // NOP sled
$null = { 00 00 00 00 }         // Null bytes

// BETTER: Add context
$nop_context = { E8 ?? ?? ?? ?? 90 90 90 90 }  // Call followed by NOPs
```

### Unbounded Regex

```yara
// CATASTROPHIC: Backtracking explosion
$url = /https?:\/\/.*/

// SLOW: Still too broad
$url = /https?:\/\/[^\s]+/

// ACCEPTABLE: Bounded
$url = /https?:\/\/[a-z0-9\.\-]{5,50}\/[a-z0-9\/]{1,100}/
```

### Leading Wildcards

```yara
// SLOW: No stable atom at start
$bad = { ?? ?? 4D 5A 90 00 }

// FAST: Stable bytes first
$good = { 4D 5A 90 00 ?? ?? }
```

### Common Byte Sequences

```yara
// SLOW: Found in most PE files
$pe_header = { 4D 5A }         // MZ
$dos_stub = "This program"     // DOS stub message

// BETTER: Add unique context
$pe_anomaly = { 4D 5A 00 00 00 00 00 00 }  // Unusual null-padded MZ
```

## Optimization Techniques

### Short-Circuit with Cheap Checks

Order conditions from cheapest to most expensive:

```yara
condition:
    // 1. Instant: filesize check
    filesize < 10MB and

    // 2. Near-instant: magic bytes
    uint16(0) == 0x5A4D and

    // 3. Fast: string matches (if good atoms)
    all of ($strings_*) and

    // 4. Moderate: module imports
    pe.imports("kernel32.dll", "VirtualAlloc") and

    // 5. Slow: expensive computations
    pe.imphash() == "abc123..."
```

If the cheap check fails, expensive checks never run.

**Platform adaptation:**

| Platform | Short-circuit pattern |
|----------|----------------------|
| **PE files** | `filesize < 10MB and uint16(0) == 0x5A4D and ...` |
| **JavaScript** | `filesize < 1MB and ...` (no magic bytes, JS files are text) |
| **npm packages** | Check for `"name":` or `package.json` content first |
| **Office docs (OOXML)** | `filesize < 50MB and uint32(0) == 0x504B0304 and ...` |
| **Chrome extensions** | `crx.is_crx and ...` (use crx module) |
| **Android apps** | `dex.header.magic == "dex\n" and ...` (use dex module) |

### Use `for..of` Efficiently

```yara
// SLOW: Checks all strings even after match
any of them

// FAST: Short-circuits after first match
for any of them : ( $ )

// OPTIMIZED: With early exit
for any i in (0..#s1) : ( @s1[i] < 1000 )
```

### Prefer `in` Over Position Calculations

```yara
// SLOWER: Arithmetic
$header at pe.entry_point + 100

// FASTER: Range check
$header in (pe.entry_point..pe.entry_point + 200)
```

### Avoid Module Overhead When Possible

```yara
// EXPENSIVE: Loads PE module
pe.entry_point

// CHEAP: Direct byte access
uint32(uint32(0x3C) + 0x28)  // Entry point from PE header
```

Use modules when you need complex analysis, but simple byte checks are faster.

### Bounded Regex Patterns

```yara
// BAD
$url = /https?:\/\/[^\s]*/

// GOOD: Explicit length bounds
$url = /https?:\/\/[a-z0-9\.\-]{5,50}\//

// BETTER: Fixed prefix for better atom
$url = /https:\/\/api\.[a-z]{5,20}\.com\//
```

### Regex Performance Rules

**Expert guidance:** Anchor every regex to a string atom. Unanchored regex consumes memory proportional to file size.

```yara
// CATASTROPHIC: Runs against every byte, unbounded backtracking
$bad = /eval\(.*\)/

// SLOW: Still unbounded despite negated class
$bad = /eval\([^\)]+\)/

// GOOD: Bounded, controlled, anchored to "eval"
$good = /eval\s*\(\s*(atob|unescape)\s*\(/ nocase
```

**Rule of thumb:** If your regex doesn't have a literal string of 4+ characters that YARA can extract as an atom, it will be slow. The atom determines which files get checked.

```yara
// NO ATOM: Entirely character classes
$no_atom = /[a-z]+\.[a-z]+\([^)]*\)/

// HAS ATOM: "fetch" is extracted, limits files checked
$has_atom = /fetch\s*\(\s*['"][^'"]{1,100}['"]\s*\)/
```

**Controlled ranges table:**

| Pattern | Performance | Use Case |
|---------|-------------|----------|
| `.*` | Catastrophic | Never use |
| `.+` | Catastrophic | Never use |
| `[^x]*` | Slow | Avoid |
| `.{0,30}` | Good | Short variable content |
| `.{0,100}` | Acceptable | Longer bounded content |
| `[a-z]{5,20}` | Best | Known character set + length |

### Use `fullword` for Word Boundaries

```yara
// May match "MalwareAnalysis" in middle of binary
$s = "Malware"

// Only matches isolated word
$s = "Malware" fullword
```

## Module Usage Guidelines

### Expensive Operations

| Operation | Cost | Alternative |
|-----------|------|-------------|
| `pe.imphash()` | High | Pre-filter with uint16(0) == 0x5A4D |
| `hash.md5()` | Very High | Use for small files only |
| `pe.rich_header` | Moderate | Pre-filter with filesize |
| `math.entropy()` | High | Use for specific sections only |

### Pre-Filter Before Modules

```yara
import "pe"
import "hash"

rule Example
{
    condition:
        // Pre-filters (instant)
        filesize > 1KB and
        filesize < 5MB and
        uint16(0) == 0x5A4D and

        // Now safe to use expensive checks
        pe.number_of_sections > 3 and
        hash.md5(0, filesize) == "abc123..."
}
```

## Measuring Performance

### YARA-X Profiling

```bash
# Time rule execution
time yr scan rules/ /path/to/files/

# Count matches without output
yr scan -c rules/ /path/to/files/
```

### Rule-by-Rule Analysis

Test individual rules against a corpus:

```bash
for rule in rules/*.yar; do
    echo "Testing: $rule"
    time yr scan "$rule" /corpus/ > /dev/null
done
```

### String Quality Check

Use the atom analyzer script:

```bash
uv run {baseDir}/scripts/atom_analyzer.py rule.yar
```

## Real-World Examples

### Before Optimization

```yara
rule Slow_Example
{
    strings:
        $s1 = "exe"                          // 3 bytes
        $s2 = { 00 00 00 00 }                // Common nulls
        $url = /.*/                          // Unbounded

    condition:
        pe.imphash() == "abc123" and         // Expensive first
        any of them
}
```

### After Optimization

```yara
rule Fast_Example
{
    strings:
        $s1 = "malware.exe" fullword         // 11 bytes, unique
        $s2 = { 43 4F 4E 46 00 00 00 00 }    // "CONF" + nulls
        $url = /https:\/\/[a-z]{5,20}\.com/  // Bounded

    condition:
        filesize < 10MB and                  // Instant
        uint16(0) == 0x5A4D and              // Instant
        2 of ($s*) and                       // Fast strings
        pe.imphash() == "abc123"             // Expensive last
}
```

## Checklist

Before deploying rules:

- [ ] No strings under 4 bytes
- [ ] No unbounded regex (`.*`, `.+`, `[^x]*`)
- [ ] No repeated byte patterns without context
- [ ] Conditions ordered: cheap → expensive
- [ ] Module checks pre-filtered with magic bytes/filesize
- [ ] Tested against large corpus for timing
- [ ] Atom analyzer shows no warnings
