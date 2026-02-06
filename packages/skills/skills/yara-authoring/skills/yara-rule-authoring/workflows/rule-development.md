# YARA Rule Development Workflow

This guide walks through the complete process of developing a production-quality YARA-X rule, from sample collection to deployment.

## Overview

```
┌─────────────────┐
│ Sample Collection│
└────────┬────────┘
         ▼
┌─────────────────┐
│ String Extraction│
└────────┬────────┘
         ▼
┌─────────────────┐
│   Rule Writing   │
└────────┬────────┘
         ▼
┌─────────────────┐
│   Validation     │
└────────┬────────┘
         ▼
┌─────────────────┐
│ Goodware Testing │
└────────┬────────┘
         ▼
┌─────────────────┐
│   Deployment     │
└─────────────────┘
```

---

## Phase 1: Sample Collection

### Minimum Requirements

| Sample Count | Confidence Level | Recommended For |
|--------------|------------------|-----------------|
| 1 sample | Low (fragile rule) | Urgent threat, will refine later |
| 3-5 samples | Medium | Standard detection |
| 10+ samples | High | Stable, long-term rule |

**Single-sample rules are brittle.** The malware author changes one string and your rule is useless.

### Gathering Variants

1. **Hash pivot** — Search VT for related hashes (imphash, ssdeep, TLSH)
2. **Behavior pivot** — Search for samples with same C2, mutex, or dropped files
3. **Infrastructure pivot** — Samples communicating with related domains/IPs
4. **Time pivot** — Samples submitted around the same campaign window

### Packed vs. Unpacked

**Check before proceeding:**

```bash
# Check entropy
yr dump -m math sample.exe --output-format yaml | grep entropy

# Check strings count
strings sample.exe | wc -l
```

| Indicator | Likely Packed | Action |
|-----------|---------------|--------|
| Entropy > 7.0 | Yes | Unpack first or detect packer |
| < 50 readable strings | Probably | Unpack first |
| UPX/MPRESS signatures | Yes | Unpack with `upx -d` |

**Expert rule:** Don't write string-based rules against packed samples. Either unpack first or write a rule targeting the packer itself.

### Using yr dump for File Analysis

Before writing rules, inspect the sample's structure with YARA-X's native `yr dump`:

```bash
# Inspect PE structure (imports, exports, sections, resources)
yr dump -m pe sample.exe --output-format yaml

# Check entropy (indicates packing)
yr dump -m math sample.exe --output-format yaml | grep entropy

# For Chrome extensions
yr dump -m crx extension.crx --output-format yaml

# For Android apps
yr dump -m dex classes.dex --output-format yaml
```

`yr dump` shows exactly what YARA-X modules can see. Use this to:
- Understand available fields before writing conditions
- Debug why module conditions aren't matching
- Find unique structural indicators when strings fail

---

## Phase 2: String Extraction

### Using yarGen

yarGen extracts candidate strings but generates legacy YARA syntax. Always validate output for YARA-X compatibility.

```bash
# Basic extraction
python yarGen.py -m samples/ --excludegood -o candidate_rule.yar

# Recommended flags
python yarGen.py -m samples/ \
    --excludegood \           # Filter against known goodware strings
    -g /path/to/good/files \  # Add custom goodware
    --nosimple \              # Exclude simple strings
    --nomagic \               # Don't add magic header checks (do manually)
    -o candidate_rule.yar

# CRITICAL: Validate for YARA-X compatibility
yr check candidate_rule.yar
yr fmt -w candidate_rule.yar   # Apply YARA-X formatting
```

**Common yarGen → YARA-X fixes:**
- Escape literal `{` in regex: `/{/` → `/\{/`
- Fix invalid escapes: `\R` → `\\R` or `R`
- Remove duplicate modifiers

### FLOSS for Packed/Obfuscated Samples

When yarGen returns only API names or the sample appears packed, use FLOSS:

```bash
# Extract all string types (static, stack, tight, decoded)
floss sample.exe -o strings.txt

# Quick extraction (faster, less thorough)
floss --only static sample.exe

# For Go/Rust binaries (special handling)
floss --only go sample.exe
```

FLOSS extracts:
- **Static strings** — Same as `strings` command
- **Stack strings** — Built character-by-character at runtime
- **Tight strings** — Small decoding loops
- **Decoded strings** — From common encoding routines

**Expert tip:** Stack strings are often the most unique indicators. If FLOSS finds them, prioritize those over static strings.

```bash
# Look for unique patterns in FLOSS output
sort strings.txt | uniq -c | sort -rn | head -50
```

### Filtering Criteria

**Reject 80% of yarGen output.** Apply these filters:

| Category | Reject | Reason |
|----------|--------|--------|
| API names | `VirtualAlloc`, `CreateRemoteThread` | Present in legitimate software |
| Common paths | `C:\Windows\`, `%TEMP%` | Too generic |
| Format strings | `%s`, `%d\n`, `Error: %s` | Present everywhere |
| Single words | `config`, `data`, `error` | Not specific enough |
| Short strings | < 4 bytes | Poor atom quality |

| Category | Keep | Reason |
|----------|------|--------|
| Mutex names | `Global\\MyMutex123` | Unique to family |
| PDB paths | `C:\Users\dev\project\x.pdb` | Reveals dev environment |
| C2 paths | `/api/beacon.php` | Specific to campaign |
| Stack strings | Built char-by-char | Unique patterns |
| Error messages | Custom error text | Not library errors |
| Config markers | `[CONFIG_START]` | Family-specific format |

---

## Phase 3: Rule Writing

### Template

```yara
rule {CATEGORY}_{PLATFORM}_{FAMILY}_{VARIANT}_{DATE}
{
    meta:
        description = "Detects {WHAT} via {HOW}"
        author = "Your Name <email@example.com>"
        reference = "{URL to analysis or report}"
        date = "{YYYY-MM-DD}"
        modified = "{YYYY-MM-DD}"
        hash = "{sample hash for reference}"
        score = {confidence 0-100}

    strings:
        // Group 1: High-confidence unique indicators
        $unique_mutex = "Global\\UniqueString123" ascii wide
        $unique_pdb = "C:\\Dev\\Malware\\Release\\loader.pdb" ascii

        // Group 2: Behavioral patterns (hex for specificity)
        $decrypt_routine = { 8B 45 ?? 33 C1 C1 C0 0D }

        // Group 3: Configuration/C2 patterns
        $c2_path = "/api/v1/beacon" ascii

        // Exclusions for known FPs (if needed)
        $fp_legitimate = "Legitimate Vendor Inc" ascii

    condition:
        // 1. Cheap filters first
        filesize < 5MB and
        uint16(0) == 0x5A4D and

        // 2. String matching logic
        (
            $unique_mutex or                    // Definitive alone
            ($unique_pdb and $c2_path) or       // Two medium = high
            (2 of ($decrypt_*, $c2_*))          // Behavioral combo
        ) and

        // 3. Exclusions last
        not $fp_legitimate
}
```

### Metadata Checklist

- [ ] `description` starts with "Detects" and explains what AND how
- [ ] `author` includes contact info
- [ ] `reference` links to analysis (not just "internal")
- [ ] `date` in YYYY-MM-DD format
- [ ] `hash` of at least one sample
- [ ] `score` reflects confidence (< 50 suspicious, 50-75 likely, > 75 confirmed malware)

### Condition Ordering

**Order by cost:**

1. `filesize < X` — Instant
2. `uint16(0) == 0x5A4D` — Near-instant
3. String matches — Cheap with good atoms
4. `for` loops — Medium cost
5. Module calls — More expensive
6. Regex patterns — Most expensive

**Bad:**
```yara
condition:
    pe.imports("kernel32.dll", "VirtualAlloc") and
    $mutex and
    filesize < 5MB
```

**Good:**
```yara
condition:
    filesize < 5MB and
    uint16(0) == 0x5A4D and
    $mutex and
    pe.imports("kernel32.dll", "VirtualAlloc")
```

---

## Phase 4: Validation

### Syntax Check

```bash
# Validate syntax
yr check rule.yar

# Validate entire directory
yr check rules/

# If migrating from legacy YARA, identify issues first
yr check --relaxed-re-syntax rule.yar
# Then fix each issue and validate without relaxed mode
```

### Format Consistency

```bash
# Check formatting
yr fmt --check rule.yar

# Auto-format
yr fmt -w rule.yar
```

### Linter Check

```bash
# Run the skill's linter
uv run {baseDir}/scripts/yara_lint.py rule.yar
```

**All three must pass before proceeding.**

### Positive Testing

```bash
# Should match all samples
yr scan rule.yar samples/

# With matched strings shown
yr scan -s rule.yar samples/
```

**Expected:** All target samples match.

**If samples don't match:**
- Strings too specific → Use wildcards or alternatives
- Condition too strict → Relax grouping
- Packed variants → Create separate unpacked rule

---

## Phase 5: Goodware Testing

### Corpus Selection

| Target Platform | Recommended Corpus |
|-----------------|-------------------|
| Windows PE | Chrome, Firefox, Adobe Reader, Office, Python |
| JavaScript | lodash, react, express, webpack |
| npm packages | Top 100 by downloads + postinstall packages |
| Chrome extensions | Top 50 Web Store extensions |
| Android APK | Top 20 Play Store apps |

### Local Testing

```bash
# Should return zero matches
yr scan rule.yar /path/to/goodware/

# Count matches
yr scan -c rule.yar /path/to/goodware/
```

### VirusTotal Retrohunt (Recommended)

1. Upload rule to [VT Intelligence](https://www.virustotal.com/gui/hunting)
2. Select "Goodware" corpus
3. Run retrohunt
4. Review every match — each is a potential FP

### Interpreting Results

| Goodware Matches | Assessment | Action |
|------------------|------------|--------|
| 0 | Excellent | Proceed to deployment |
| 1-2 | Investigate | Check if legitimate FP, add exclusion or tighten |
| 3-5 | Too broad | Find different indicators |
| 6+ | Broken | Start over |

### FP Investigation

```bash
# See which string matched
yr scan -s rule.yar false_positive.exe
```

**Common fixes:**
- Add vendor exclusion: `not $fp_vendor_string`
- Add distinguishing string: require unique + generic together
- Add positional constraint: `$marker in (0..1024)`
- Replace the string entirely with more specific indicator

---

## Phase 6: Deployment

### Peer Review Checklist

Before merge, reviewer checks:

- [ ] Naming follows convention
- [ ] Metadata complete and accurate
- [ ] Strings justify confidence score
- [ ] Condition ordered by cost
- [ ] Tested against goodware
- [ ] No obvious FP risks
- [ ] Performance acceptable

### Version Control

```bash
# Add to repo
git add rules/malware/MAL_Win_Example_Jan25.yar

# Commit with meaningful message
git commit -m "Add MAL_Win_Example detection rule

- Targets Example malware family loader component
- Based on samples from Jan 2025 campaign
- Tested against VT goodware (0 matches)
- Reference: https://example.com/analysis"
```

### Production Monitoring

After deployment:

1. **Monitor for FPs** — Set up alerting for first 48 hours
2. **Track detection rate** — Rule should detect new samples in the family
3. **Review periodically** — Malware evolves; rules need updates

---

## Decision Points

### When to Pivot from Strings to Structure

If yarGen returns only API names and paths:

```
→ Try pe.imphash() for import clustering
→ Try pe.rich_signature for build environment
→ Try math.entropy() on sections
→ Try pe module for section anomalies
→ If nothing works: sample may not be YARA-detectable
```

### When to Split vs. Combine Rules

**Split when:**
- Different variants have no common strings
- Performance degrades with combined rule
- Different confidence levels needed

**Combine when:**
- Variants share core indicators
- Single rule can cover family with `any of` variants

### When to Abandon an Approach

Stop and pivot when:

| Situation | Action |
|-----------|--------|
| Can't find 3 unique strings | Target unpacked version or detect packer |
| Goodware matches > 5 | Find completely different indicators |
| Performance > 2s per file | Split into focused rules |
| Can't write clear description | Rule is too vague — reconsider scope |

### String Selection Quick Decision

```
Is this string good enough?
├─ Less than 4 bytes? → NO
├─ API name? → NO
├─ Common path? → NO
├─ In Windows/common libraries? → NO
├─ Unique to malware family? → YES
└─ In other malware too? → MAYBE (combine with unique marker)
```

---

## Quick Reference

### Essential Commands

```bash
yr check rule.yar          # Validate syntax
yr fmt -w rule.yar         # Format
yr scan -s rule.yar file   # Scan with matched strings
yr dump -m pe file.exe     # Inspect PE structure
```

### Required Metadata

```yara
meta:
    description = "Detects X via Y"
    author = "Name <email>"
    reference = "URL"
    date = "YYYY-MM-DD"
```

### Condition Order

1. `filesize`
2. Magic bytes (`uint16/uint32`)
3. Strings
4. Module calls

### Goodware Thresholds

- 0 matches = Deploy
- 1-2 matches = Investigate
- 3-5 matches = Find new indicators
- 6+ matches = Start over
