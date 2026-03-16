# YARA-X String Selection

Choosing the right strings is the most critical decision in YARA rule writing.

> **YARA-X Note:** YARA-X enforces stricter validation on strings. Base64 modifier requires 3+ character strings, and regex patterns must have properly escaped metacharacters.

## String Quality Judgment

Before using any string, run through this mental checklist:

```
Is this string good enough?
├─ At least 4 bytes? (minimum for useful atoms)
├─ Contains 4 consecutive unique bytes? (not 0000, 9090, FFFF)
├─ NOT an API name? (VirtualAlloc, CreateRemoteThread = reject)
├─ NOT a common path? (C:\Windows\, cmd.exe = reject)
├─ NOT a format string? (%s, %d, Error: %s = reject)
├─ Would match in Windows system files? (if yes = reject)
├─ Specific to this malware family? (if yes = use it)
└─ Found in other malware too? (combine with unique marker)
```

## High-Value String Sources

**Gold tier** — Almost always unique:
- Mutex names: `"Global\\MyMalwareMutex"`
- Stack strings (decoded at runtime)
- PDB paths: `"C:\\Users\\dev\\malware.pdb"`

**Silver tier** — Usually unique:
- C2 paths: `"/api/beacon/check"`
- Configuration markers: `"CONFIG_START"`
- Custom protocol headers: `"BEACON_1.0"`

**Bronze tier** — Unique with context:
- Unique error messages: `"Failed to inject into explorer"`
- Campaign IDs: `"OPERATION_X"`

## String Types

### Text Strings

```yara
$text = "Hello World"              // Basic ASCII
$text_wide = "Hello" wide          // UTF-16LE (Windows Unicode)
$text_both = "Hello" ascii wide    // Match either encoding
$text_nocase = "hello" nocase      // Case-insensitive (performance cost)
$text_full = "hello" fullword      // Word boundaries only
```

### Hex Strings

```yara
$hex = { 4D 5A 90 00 }             // Exact bytes
$wild = { 4D 5A ?? ?? }            // Single-byte wildcards
$jump = { 4D 5A [2-4] 50 45 }      // Variable-length jump (bounded!)
$alt = { 4D 5A ( 90 00 | 00 00 ) } // Alternatives
```

### Regular Expressions

```yara
// ALWAYS bound your regex
$url = /https?:\/\/[a-z0-9]{5,50}\.onion/    // Good: bounded
$bad = /https?:\/\/.*/                        // BAD: unbounded
```

**YARA-X regex requirements:**
- Literal `{` must be escaped as `\{` (YARA-X strict mode)
- Invalid escape sequences error instead of becoming literals
- Use `yr check` to validate regex patterns before deployment

```yara
// BAD: Fails in YARA-X
$pattern = /config{key}/

// GOOD: Escape the brace
$pattern = /config\{key\}/
```

## Modifiers and Their Costs

| Modifier | Performance Impact | When to Use |
|----------|-------------------|-------------|
| `ascii` | None | Default, always included |
| `wide` | Minimal | Windows Unicode strings |
| `nocase` | **Doubles atoms** | Only when necessary |
| `fullword` | Minimal | Prevent substring matches |
| `xor` | **High (255x patterns)** | Only with specific range |
| `base64` | Moderate (3x patterns) | Encoded payloads (**3+ chars required in YARA-X**) |
| `private` | None | Hide pattern from scan output (YARA-X 1.3.0+) |

**Modifier judgment:**
- `nocase` — Only use for user-facing strings that might vary in case
- `xor(0x00-0xFF)` — Almost always too broad; find the actual key
- `xor(0x41)` — Specific key is acceptable
- `base64` — YARA-X requires strings of 3+ characters (won't match on shorter strings)

### Private Patterns (YARA-X 1.3.0+)

Mark helper patterns as private to exclude them from scan output:

```yara
strings:
    $public = "malware_marker"
    private $helper = "internal_pattern"  // Matches but not in output

condition:
    $public and $helper
```

## Bad String Sources (Always Reject)

### API Names

Every Windows program uses these:

```yara
// REJECT: Found in all executables
$bad = "VirtualAlloc"
$bad = "CreateRemoteThread"
$bad = "WriteProcessMemory"
$bad = "NtCreateThreadEx"
```

**Expert response:** Use hex pattern of the call site, not the import name.

### Common Paths

```yara
// REJECT: Found everywhere
$bad = "C:\\Windows\\System32"
$bad = "cmd.exe"
$bad = "powershell.exe"
$bad = "\\AppData\\Local"
```

**Expert response:** Find malware-specific full paths.

### Format Strings

```yara
// REJECT: Every C program
$bad = "%s"
$bad = "%d"
$bad = "Error: %s"
```

**Expert response:** Find unique format strings: `"Beacon initialized: %s:%d with key %08X"`

### Common Libraries

```yara
// REJECT: Every Windows program
$bad = "KERNEL32.dll"
$bad = "ntdll.dll"
$bad = "USER32.dll"
```

### JavaScript Framework Patterns

```yara
// REJECT: Every Node.js application
$bad = "require("
$bad = "fs.readFile"
$bad = "child_process"
$bad = "process.env"
$bad = "fetch("
$bad = "axios"
```

**Expert response:** Combine with suspicious context:

```yara
// child_process alone = every CLI tool
// child_process + base64 decode + network fetch = suspicious
strings:
    $exec = /child_process['"]\s*\)\.exec/
    $decode = /atob\s*\(|Buffer\.from\s*\([^)]+,\s*['"]base64/
    $exfil = /discord\.com\/api|telegram\.org\/bot/

condition:
    $exec and $decode and $exfil
```

## Stack Strings Pattern

Malware often builds strings on the stack to evade static analysis. These are almost always unique:

```yara
// Looking for stack-built "cmd.exe"
$stack_cmd = {
    C6 45 ?? 63    // mov byte ptr [ebp+?], 'c'
    C6 45 ?? 6D    // mov byte ptr [ebp+?], 'm'
    C6 45 ?? 64    // mov byte ptr [ebp+?], 'd'
    C6 45 ?? 2E    // mov byte ptr [ebp+?], '.'
    C6 45 ?? 65    // mov byte ptr [ebp+?], 'e'
    C6 45 ?? 78    // mov byte ptr [ebp+?], 'x'
    C6 45 ?? 65    // mov byte ptr [ebp+?], 'e'
}
```

**Expert heuristic:** If yarGen returns only API names, look for stack strings — the sample likely decodes sensitive strings at runtime.

## Hex String Best Practices

### Wildcards

```yara
// Single byte wildcard
{ 4D 5A ?? 00 }

// Nibble wildcard (half byte)
{ 4D 5? }              // Matches 4D 50 through 4D 5F

// BOUNDED jumps only
{ 4D 5A [2-4] 50 45 }  // 2-4 bytes between MZ and PE

// NEVER unbounded
{ 4D 5A [-] 50 45 }    // REJECT: unlimited = slow
```

### Leading Bytes Matter

```yara
// BAD: No stable atom at start
{ ?? ?? 4D 5A 90 00 }

// GOOD: Stable bytes first
{ 4D 5A 90 00 ?? ?? }
```

The first 4 bytes determine atom quality. Put your unique bytes there.

## Combining Strings Effectively

### Group by Purpose

```yara
strings:
    // Core identification (all required)
    $mutex = "Global\\MyMutex"
    $config = { 43 4F 4E 46 49 47 }

    // C2 indicators (any one)
    $c2_1 = "/api/beacon"
    $c2_2 = "/check_in"

condition:
    all of ($mutex, $config) and
    any of ($c2_*)
```

### False Positive Exclusions

```yara
strings:
    $malware = "SuspiciousString"
    $fp_legitimate = "Legitimate Vendor Inc"

condition:
    $malware and not $fp_legitimate
```

## Using yarGen Effectively

yarGen extracts candidate strings, but you must validate:

```bash
python yarGen.py -m /path/to/samples --excludegood
```

**Expert heuristic:** yarGen output needs 80% filtering. Most suggestions are:
- API names (reject)
- Common library strings (reject)
- Format strings (reject)
- Paths to common Windows directories (reject)

Keep only the unique mutex names, C2 paths, and configuration markers.

## JavaScript-Specific Patterns

For JavaScript/TypeScript malware (npm packages, VS Code extensions, browser extensions):

### Obfuscator Signatures

```yara
// javascript-obfuscator tool signature (hex variable names)
$hex_var = /_0x[a-fA-F0-9]{4,}/

// String.fromCharCode chains (hiding strings)
$fromcharcode = /String\.fromCharCode\s*\(\s*\d+(\s*,\s*\d+){5,}\)/

// Bracket notation chains (property access obfuscation)
$bracket_chain = /\[['"][a-zA-Z]+['"]\]\s*\[['"][a-zA-Z]+['"]\]\s*\[['"][a-zA-Z]+['"]\]/

// atob/btoa with concatenation (base64 evasion)
$atob_concat = /atob\s*\(\s*['"][^'"]+['"]\s*\+/
```

### Expert Patterns from Production Rules

These patterns come from Neo23x0 signature-base and Burp-Yara-Rules — battle-tested in production.

**javascript-obfuscator tool signature (Neo23x0):**

```yara
// Initialization pattern at file start
$init = "var a0_0x" at 0

// Infinite loop (self-defending code)
$loop = "while(!![])"

// Global scope access hack
$scope_hack = "{}.constructor(\"return this\")"

condition:
    $init at 0 or
    (filesize < 1MB and 3 of ($loop, $scope_hack, ...))
```

**Expert insight:** The `filesize < 1MB` constraint plus threshold (`3 of`) significantly reduces FPs.

**eval + decode combo (most common obfuscation):**

```yara
// nocase handles case variations in minified/obfuscated code
$eval_decode = /eval\s*\(\s*(unescape|atob)\s*\(/ nocase
$func_decode = /Function\s*\(\s*atob\s*\(/ nocase
```

**Hex-encoded string array:**

```yara
// Matches: var _0x1234 = ["\x48\x65\x6c\x6c\x6f", ...]
$hex_array = /var\s+\w+\s*=\s*\[\s*["']\\x[0-9a-fA-F]+/
```

### Invisible Unicode (Stealth)

Two Unicode ranges are commonly abused: standard Variation Selectors (U+FE00-FE0F) and Variation Selectors Supplement (U+E0100-E01EF). Detect both.

**Standard Variation Selectors (VS1-16):**

```yara
// UTF-8 variation selectors U+FE00-FE0F (invisible characters hiding code)
$vs_utf8 = { EF B8 (80|81|82|83|84|85|86|87|88|89|8A|8B|8C|8D|8E|8F) }

// Zero-width characters
$zwc = { E2 80 (8B|8C|8D|8E|8F|AA|AB|AC|AD|AE|AF) }

condition:
    #vs_utf8 > 5 and any of ($eval, $function)  // 5+ is suspicious per Veracode research
```

**Expert heuristic:** Legitimate i18n uses few variation selectors. 10+ in a JS file is suspicious.

### Unicode Steganography (Variation Selectors Supplement)

**Variation Selectors Supplement (U+E0100-E01EF):**

The `os-info-checker-es6` attack (2025) used this range — invisible nonspacing marks appended to visible characters with data encoded in the low byte.

**Byte pattern for detection:**

```yara
rule SUSP_JS_Unicode_Steganography
{
    strings:
        // UTF-8 encoding of Variation Selectors Supplement
        // U+E0100-E01EF encodes as: F3 A0 84 80 to F3 A0 87 AF
        $var_selectors = { F3 A0 (84|85|86|87) }
        $eval_decode = /eval\s*\(\s*atob\s*\(/

    condition:
        // 5+ variation selectors + eval/atob = highly suspicious
        // Legitimate i18n rarely uses these; 5+ is almost never accidental
        #var_selectors > 5 and $eval_decode
}
```

**Why this works:** Variation Selectors Supplement exists for specialized typography (CJK ideograph variants). JavaScript source code has no legitimate use for them. Any significant count combined with eval is malicious.

### Modern Exfiltration Channels

**Good indicators (specific, suspicious):**

```yara
$discord_webhook = /discord\.com\/api\/webhooks\/\d+\//
$telegram_bot = /api\.telegram\.org\/bot[0-9]+:[A-Za-z0-9_-]+/
$pastebin_raw = /pastebin\.com\/raw\//
$free_hosting = /(vercel\.app|netlify\.app|railway\.app|render\.com)\/api/
```

**Bad indicators (too common alone):**

```yara
// REJECT without additional context
$bad = "fetch("           // Every web app
$bad = "axios.post"       // Every API client
$bad = /https?:\/\//      // Every URL
```

**Combine for specificity:**

```yara
strings:
    $cred_path = /\.(npmrc|env|ssh\/id_rsa|aws\/credentials)/
    $read_file = /fs\.readFile|readFileSync/
    $discord = /discord\.com\/api\/webhooks/

condition:
    $cred_path and $read_file and $discord
```

### Credential Theft Patterns

```yara
// Browser credential databases
$chrome_login = "Login Data"
$firefox_logins = "logins.json"

// Config file paths
$npmrc = ".npmrc"
$ssh_key = /\.ssh\/(id_rsa|id_ed25519)/
$aws_creds = ".aws/credentials"
$env_file = /\.env(\.local)?/

// Combined with file read = suspicious
condition:
    any of ($chrome_*, $firefox_*, $npmrc, $ssh_*, $aws_*, $env_*) and
    any of ($read_file_*)
```
