---
name: yara-authoring
description: "Write and test YARA rules for malware detection and threat hunting. Use when creating YARA signatures, detecting malware families, scanning files or memory for indicators of compromise, or building detection rules for threat intelligence."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# YARA Rule Authoring

## When to Use

- Writing YARA rules to detect malware samples or families
- Creating detection signatures for indicators of compromise (IOCs)
- Scanning files or directories for known threat patterns
- Building threat hunting rules from intelligence reports
- Classifying unknown samples based on behavioral or structural patterns

## When NOT to Use

- Dynamic malware analysis (use sandbox environments)
- Network traffic analysis (use Suricata/Snort rules)
- Static analysis of source code (use Semgrep/CodeQL)

## Rule Template

```yara
rule MalwareFamily_Variant : tag1 tag2 {
    meta:
        author = "analyst"
        description = "Detects MalwareFamily variant based on unique strings"
        date = "2024-01-01"
        reference = "https://example.com/report"
        hash = "abc123..."
        severity = "high"

    strings:
        $s1 = "unique_malware_string" ascii
        $s2 = { 4D 5A 90 00 03 00 }  // hex pattern
        $s3 = /https?:\/\/[a-z0-9]+\.evil\.com/ nocase  // regex

    condition:
        uint16(0) == 0x5A4D and  // MZ header (PE file)
        filesize < 5MB and
        (2 of ($s*))
}
```

## String Types

| Type | Syntax | Use Case |
|------|--------|----------|
| Text | `"string"` | ASCII strings |
| Hex | `{ AA BB CC }` | Byte patterns, shellcode |
| Regex | `/pattern/` | Flexible text matching |

### Modifiers
- `ascii` / `wide` — encoding
- `nocase` — case insensitive
- `fullword` — word boundary matching
- `xor` — XOR-encoded strings
- `base64` — base64-encoded strings

## Condition Operators

```yara
condition:
    all of them           // All strings match
    any of ($a*)          // Any string starting with $a
    2 of ($s1, $s2, $s3)  // At least 2 of listed strings
    #s1 > 3               // String $s1 appears more than 3 times
    @s1 < 0x100           // String $s1 found before offset 0x100
    filesize < 1MB        // File size constraint
    uint16(0) == 0x5A4D   // Magic bytes at offset
```

## Scanning

```bash
# Scan a file
yara rule.yar target_file

# Scan directory recursively
yara -r rules/ /path/to/scan/

# Scan with metadata output
yara -m -s rule.yar target_file

# Compile rules for faster repeated scanning
yarac rules/ compiled.yarc
yara -C compiled.yarc /path/to/scan/
```

## Best Practices

1. Always include `meta` with author, description, date, and reference
2. Use `filesize` and magic byte checks to limit scope
3. Prefer multiple weak indicators over one strong indicator
4. Test against known samples AND clean files for false positives
5. Use `private` rules for helper conditions
6. Avoid overly broad regex patterns that cause performance issues
7. Version control your rules and track detection rates

## Resources

- YARA Documentation — https://yara.readthedocs.io/
- YARA Rules Repository — https://github.com/Yara-Rules/rules
- VirusTotal YARA — https://docs.virustotal.com/docs/yara
