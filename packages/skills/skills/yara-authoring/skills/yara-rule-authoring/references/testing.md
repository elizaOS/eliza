# YARA-X Rule Testing

Testing is non-negotiable. Untested rules cause alert fatigue (false positives) or missed detections (false negatives).

## Testing Philosophy

Every rule needs three validation stages:

1. **Positive validation** — Matches all target samples
2. **Negative validation** — Zero matches on goodware
3. **Edge case validation** — Handles variants, packed versions, fragments

## Validation Workflow

```
┌──────────────────────┐
│ Write initial rule   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ yr check (validate)  │──── Fix issues ────┐
└──────────┬───────────┘                    │
           │                                │
           ▼                                │
┌──────────────────────┐                    │
│ Lint (style checks)  │──── Fix issues ────┤
└──────────┬───────────┘                    │
           │                                │
           ▼                                │
┌──────────────────────┐                    │
│ Test vs. samples     │──── Missing? ──────┤
└──────────┬───────────┘   (widen rule)     │
           │                                │
           ▼                                │
┌──────────────────────┐                    │
│ Test vs. goodware    │──── FPs? ──────────┤
└──────────┬───────────┘   (tighten rule)   │
           │                                │
           ▼                                │
┌──────────────────────┐                    │
│ Peer review          │──── Issues? ───────┘
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Deploy to production │
└──────────────────────┘
```

### Validation with yr check

Always validate rules before testing:

```bash
# Basic validation
yr check rule.yar

# Validate directory
yr check rules/

# Migration mode (identifies legacy YARA compatibility issues)
yr check --relaxed-re-syntax rules/
```

> **Note:** Use `--relaxed-re-syntax` only as a temporary diagnostic tool during migration.
> Fix all identified issues rather than relying on relaxed mode permanently.

YARA-X provides better error messages than legacy YARA, with precise source locations for issues.

## Goodware Testing

### Platform-Specific Goodware

Test against legitimate software in your target ecosystem, not just Windows binaries:

| Platform | Goodware Corpus |
|----------|-----------------|
| **PE files** | VirusTotal goodware, clean Windows installs |
| **JavaScript/Node** | Popular npm packages (lodash, react, express, axios) |
| **VS Code extensions** | Top 100 marketplace extensions by installs |
| **Browser extensions** | Chrome Web Store popular extensions |
| **npm packages** | Top 100+ packages by weekly downloads |
| **Python packages** | Top PyPI packages (requests, django, flask) |

**Critical:** A rule that fires on legitimate software in your target ecosystem is useless. VT's goodware corpus is PE-centric — supplement with ecosystem-appropriate files.

### Goodware Corpus Selection

Not all goodware is equal. Choose corpus that matches your rule's target:

| Rule Target | Minimum Goodware Corpus |
|-------------|------------------------|
| PE files | Chrome, Firefox, Adobe Reader, Microsoft Office, Python installer |
| JavaScript | lodash, react, express, webpack, electron |
| npm packages | Top 100 by weekly downloads + packages with postinstall scripts |
| Chrome extensions | Top 50 marketplace extensions |

**Expert baseline:** "Test against Chrome, Firefox, and Adobe Reader" — Kaspersky Applied YARA

### Interpreting Goodware Matches

```
Rule matched goodware — now what?
├─ Matched 1-2 files?
│  └─ Investigate: is the match legitimate? Add exclusion or tighten string
├─ Matched 3-5 files?
│  └─ Pattern is too common — find different indicators
├─ Matched 6+ files?
│  └─ Rule is fundamentally broken — start over
└─ Matched only one vendor's software?
   └─ Add vendor exclusion: `not $fp_vendor`
```

### VirusTotal Goodware Corpus (Recommended)

The gold standard. VirusTotal maintains a corpus of 1M+ clean files from major software vendors.

1. Upload your rule to [VirusTotal Intelligence](https://www.virustotal.com/gui/hunting)
2. Select "Goodware" corpus
3. Run retrohunt
4. Review any matches — each is a potential false positive

**Interpreting results:**

| Matches | Assessment | Action |
|---------|------------|--------|
| 0 | Excellent | Proceed to deployment |
| 1-2 | Investigate | Review matches, add exclusions or tighten strings |
| 3-5 | Too common | Find different indicators |
| 6+ | Broken | Start over with different indicators |

### Local Testing

```bash
# Should return zero matches
yr scan -r rules/ /path/to/goodware/

# Count matches (quiet mode)
yr scan -c rules/ /path/to/goodware/
```

### yarGen Database Lookup

Before deployment, check strings against yarGen's goodware database:

```bash
# Query strings against goodware database
python db-lookup.py -f strings.txt
```

Strings appearing in the database are likely to cause false positives.

### YARA-CI

[YARA-CI](https://yara-ci.cloud.virustotal.com/) provides cloud-based validation:

1. Connect GitHub repository
2. Each PR automatically tested
3. Reports syntax errors and performance issues
4. Integrates with VT goodware corpus

## Free Testing Alternatives

Not everyone has VirusTotal Intelligence access. Here are free alternatives:

### Free Online Tools

| Tool | Purpose | Access |
|------|---------|--------|
| **YARA-CI** | GitHub App tests PRs against 1M NIST goodware files | Free, [github.com/apps/virustotal-yara-ci](https://github.com/apps/virustotal-yara-ci) |
| **YaraDbg** | Web-based rule debugger with step-through execution | Free, [yaradbg.dev](https://yaradbg.dev) |
| **Klara** | Kaspersky's distributed YARA scanner | Open source, self-hosted |

### YARA-CI Setup

YARA-CI is the best free option for automated testing:

```bash
# 1. Install GitHub App from github.com/apps/virustotal-yara-ci
# 2. Connect your rules repository
# 3. Each PR automatically tested against 1M+ goodware files
# 4. View results at yara-ci.cloud.virustotal.com
```

Results include:
- Syntax validation
- Performance warnings
- Goodware matches (potential FPs)
- Slowloris detection (rules that timeout)

### Building a Local Goodware Corpus

For offline testing, build your own corpus:

**Windows PE files:**
```bash
# Fresh Windows 11 VM → export C:\Windows\System32\*.dll
# Download Chrome, Firefox, Adobe Reader installers
# Python/Node installers from official sources
```

**npm/JavaScript packages:**
```bash
# Download top packages
npm pack lodash react express axios webpack
# Extract for scanning
for f in *.tgz; do tar -xzf "$f"; done
```

**Chrome extensions:**
```bash
# Export installed extensions from chrome://extensions (Developer mode)
# Or download .crx files from Chrome Web Store using extension ID
```

**macOS applications:**
```bash
# Copy from /Applications/ on a fresh macOS install
# System binaries from /usr/bin/, /usr/sbin/
```

### NIST NSRL

The [NIST National Software Reference Library](https://www.nist.gov/itl/ssd/software-quality-group/national-software-reference-library-nsrl) provides hash sets of known-good files:

- **Size:** ~147GB compressed
- **Contains:** Hashes from legitimate software
- **Use:** Filter known-good files before scanning

```bash
# Download RDS (Reference Data Set)
# Available at: https://www.nist.gov/itl/ssd/software-quality-group/nsrl-download-links
# Use to exclude known-good files from your corpus
```

### macOS XProtect

Apple's built-in YARA rules are a good reference:

```bash
# Location on macOS
/System/Library/CoreServices/XProtect.bundle/Contents/Resources/XProtect.yara

# View rules (requires SIP disabled or extraction from DMG)
cat /System/Library/CoreServices/XProtect.bundle/Contents/Resources/XProtect.yara
```

XProtect rules demonstrate Apple's production patterns for macOS malware detection.

### Minimum Local Corpus by Platform

| Rule Target | Minimum Local Corpus |
|-------------|---------------------|
| PE files | Chrome.exe, Firefox.exe, python.exe (10+ files) |
| npm packages | lodash, react, express, webpack (top 50 by downloads) |
| Chrome extensions | uBlock Origin, React DevTools, Grammarly (top 20) |
| macOS | /Applications/* from fresh install |
| Android DEX | Top 10 Play Store apps (extracted APKs) |

## Malware Sample Testing

### Positive Testing

```bash
# Rule should match all target samples
yr scan -r MAL_Win_Emotet.yar samples/emotet/

# With matched strings shown
yr scan -s MAL_Win_Emotet.yar samples/emotet/

# Expected: all files listed
# If any missing: rule too narrow
```

### Variant Coverage

Test against:
- Multiple versions/builds
- Packed variants (UPX, custom packers)
- Different configurations
- Both 32-bit and 64-bit

## False Positive Investigation

When a rule matches goodware:

### 1. Identify the Match

```bash
yr scan -s rule.yar false_positive.exe
```

Shows which strings matched.

### 2. Analyze Why

Common causes:
- String too generic ("cmd.exe", API names)
- Shared library code
- Common development patterns
- Legitimate use of same techniques

### 3. Remediation Options

**Option A: Exclude the specific file**

```yara
strings:
    $fp_vendor = "Legitimate Software Inc"

condition:
    $malware_string and not $fp_vendor
```

**Option B: Add distinguishing string**

```yara
strings:
    $generic = "common_string"
    $specific = "unique_malware_marker"

condition:
    $generic and $specific  // Both required
```

**Option C: Tighten positional constraints**

```yara
condition:
    $marker in (0..1024) and  // Only in first 1KB
    filesize < 500KB          // Malware-typical size
```

**Option D: Replace the string**

Find a more unique indicator and remove the problematic string.

## Supply Chain Package Testing

For npm/PyPI/RubyGems rules, test against ecosystem-appropriate corpora:

### Recommended Test Corpora

| Corpus | Source | Purpose |
|--------|--------|---------|
| Top 1000 npm packages | `npm search --searchlimit=1000` | Avoid FPs on popular dependencies |
| Packages with postinstall scripts | Filter for `scripts.postinstall` in package.json | Common attack vector |
| Known malicious packages | [npm-shai-hulud-scanner](https://github.com/nickytonline/npm-shai-hulud-scanner) list | Positive validation |
| VS Code top extensions | Marketplace API | Extension-specific rules |

### Common Attack Pattern Testing

**Critical pattern:** `postinstall + network call + credential path` is the signature of supply chain attacks. Test that your rule catches this combo while ignoring legitimate build scripts.

```bash
# Build a test corpus from npm
mkdir -p test_corpus/legitimate test_corpus/suspicious

# Grab legitimate packages with postinstall (build tools)
npm pack webpack && tar -xzf webpack-*.tgz -C test_corpus/legitimate/
npm pack electron-builder && tar -xzf electron-builder-*.tgz -C test_corpus/legitimate/

# Your rule should NOT match legitimate postinstall scripts
yr scan -r supply_chain_rule.yar test_corpus/legitimate/
# Expected: zero matches
```

### Known Malicious Package Patterns

Rules targeting supply chain attacks should detect patterns from documented incidents:

| Incident | Key Indicators | Reference |
|----------|----------------|-----------|
| chalk/debug (Sept 2025) | `runmask`, `checkethereumw`, ERC-20 selectors | Stairwell |
| os-info-checker-es6 | Variation selectors, eval+atob | Veracode |
| event-stream | Flatmap dependency, Bitcoin wallet targeting | npm advisory |

**Positive validation:** Test your rule against recreated (defanged) versions of known malicious packages to ensure detection.

## Checklist

Before any rule goes to production:

- [ ] `yr check` passes (syntax and YARA-X compatibility)
- [ ] `yr fmt --check` passes (consistent formatting)
- [ ] Linter passes (`uv run yara_lint.py rule.yar`)
- [ ] Matches all target samples (positive testing)
- [ ] Zero matches on goodware corpus (negative testing)
- [ ] Tested against packed variants if applicable
- [ ] Performance acceptable (< 1s per file on average)
- [ ] Peer reviewed by second analyst
- [ ] Version and changelog updated

### Supply Chain Rule Additions

- [ ] Tested against top 100 packages in target ecosystem
- [ ] Does not match legitimate postinstall scripts (webpack, electron-builder, etc.)
- [ ] Validated against known malicious package patterns
