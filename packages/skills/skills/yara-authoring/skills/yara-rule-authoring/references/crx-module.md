# YARA-X CRX Module Reference

The `crx` module enables analysis of Chrome extension packages (CRX files). Use it to detect malicious extensions based on their declared permissions, manifest structure, and metadata.

**Version requirements:** YARA-X v1.5.0+

## Module Import

```yara
import "crx"
```

## API Reference

### File Type Validation

| Field | Type | Description |
|-------|------|-------------|
| `crx.is_crx` | bool | Returns true if file is a valid CRX package |

**Always check `crx.is_crx` first.** The module's other fields will not work correctly on non-CRX files.

### Extension Metadata

| Field | Type | Description |
|-------|------|-------------|
| `crx.id` | string | Extension identifier |
| `crx.version` | string | Extension version string |
| `crx.name` | string | Extension display name (localized) |
| `crx.description` | string | Extension description (localized) |
| `crx.raw_name` | string | Extension name without localization |
| `crx.raw_description` | string | Extension description without localization |
| `crx.homepage_url` | string | Extension homepage URL |

### CRX Format Information

| Field | Type | Description |
|-------|------|-------------|
| `crx.crx_version` | integer | CRX format version (2 or 3) |
| `crx.header_size` | integer | Size of the CRX header in bytes |

### Permission Analysis

| Field | Description | Example |
|-------|-------------|---------|
| `crx.permissions` | Array of declared permissions | `for any perm in crx.permissions` |
| `crx.optional_permissions` | Array of optional permissions | `for any perm in crx.optional_permissions` |
| `crx.host_permissions` | Array of host patterns (MV3) | `for any host in crx.host_permissions` |
| `crx.optional_host_permissions` | Array of optional host patterns | `for any host in crx.optional_host_permissions` |

### Signature Verification

| Field | Type | Description |
|-------|------|-------------|
| `crx.signatures` | array | Array of signature objects |
| `crx.signatures[i].key` | string | Public key for this signature |
| `crx.signatures[i].verified` | bool | Whether signature verification passed |

```yara
// Check if extension has a verified signature
rule CRX_VerifiedSignature
{
    condition:
        crx.is_crx and
        for any sig in crx.signatures : (sig.verified)
}
```

## Permission Risk Assessment

### High-Risk Permissions

These permissions enable significant access and should trigger careful review:

| Permission | Risk | Legitimate Uses |
|------------|------|-----------------|
| `debugger` | Can intercept all traffic, modify any page | DevTools extensions |
| `nativeMessaging` | Communicate with local executables | Password managers, native integrations |
| `<all_urls>` | Access all websites | Ad blockers, universal tools |
| `proxy` | Route all traffic through specified proxy | VPN extensions |
| `webRequest` + `webRequestBlocking` | Intercept/modify requests | Ad blockers, privacy tools |
| `cookies` (with broad hosts) | Access authentication tokens | Session managers |
| `history` | Read complete browsing history | Productivity trackers |

### Red Flag Combinations

These permission combinations are especially suspicious:

```yara
// Data exfiltration potential
condition:
    crx.is_crx and
    for any perm in crx.permissions : (perm == "nativeMessaging") and
    for any perm in crx.permissions : (perm == "<all_urls>" or perm == "*://*/*")

// Credential theft potential
condition:
    crx.is_crx and
    for any perm in crx.permissions : (perm == "webRequest") and
    for any perm in crx.permissions : (perm == "webRequestBlocking") and
    for any host in crx.host_permissions : (host contains "://*/*")

// Man-in-the-browser potential
condition:
    crx.is_crx and
    for any perm in crx.permissions : (perm == "debugger") and
    for any perm in crx.permissions : (perm == "tabs")
```

## Example Rules

### Detect High-Risk Extension

```yara
import "crx"

rule SUSP_CRX_HighRiskProfile
{
    meta:
        description = "Detects extensions with high-risk permission combinations"
        score = 70

    condition:
        crx.is_crx and

        // Count dangerous permissions
        (
            (for any p in crx.permissions : (p == "debugger")) +
            (for any p in crx.permissions : (p == "nativeMessaging")) +
            (for any p in crx.permissions : (p == "proxy")) +
            (for any p in crx.permissions : (p == "webRequestBlocking"))
        ) >= 2 and

        // Has broad host access
        for any h in crx.host_permissions : (
            h == "<all_urls>" or h contains "://*/*"
        )
}
```

### Detect Unverified Signatures

```yara
import "crx"

rule SUSP_CRX_UnverifiedSignature
{
    meta:
        description = "Detects CRX files with unverified or missing signatures"
        score = 60

    condition:
        crx.is_crx and
        not for any sig in crx.signatures : (sig.verified)
}
```

### Combine with String Patterns

```yara
import "crx"

rule SUSP_CRX_CryptoMiner
{
    meta:
        description = "Detects potential cryptomining extensions"
        score = 80

    strings:
        $miner1 = "CoinHive" ascii wide nocase
        $miner2 = "coinhive.min.js" ascii
        $miner3 = /Miner\.(start|stop)\s*\(/
        $wasm_miner = "cryptonight" ascii
        $pool_stratum = /stratum\+tcp:\/\//

    condition:
        crx.is_crx and

        // Needs background execution
        for any perm in crx.permissions : (
            perm == "background" or perm == "alarms"
        ) and

        // Miner indicators
        (2 of ($miner*) or $wasm_miner or $pool_stratum)
}
```

## Best Practices

1. **Always validate file type first** — Start conditions with `crx.is_crx`

2. **Don't over-match on common permissions** — `storage`, `activeTab`, `tabs` are used by most extensions

3. **Combine permissions with behavioral indicators** — Permission + suspicious string pattern is stronger than permission alone

4. **Use signatures for hunting** — Extensions with unverified signatures are worth investigating

5. **Test against legitimate extensions** — Chrome Web Store top extensions are your goodware corpus

## Troubleshooting

**Rule doesn't match CRX files:**
- Verify the file is a valid CRX (not just a renamed ZIP)
- Check YARA-X version (`yr --version`) meets requirements
- Use `yr dump -m crx extension.crx` to inspect what the module sees

**Permission iteration not working:**
- Ensure proper syntax: `for any perm in crx.permissions : (perm == "...")`
- Permissions are strings, not identifiers

**Signature verification questions:**
- `crx.signatures` may be empty for unsigned extensions
- CRX v2 uses RSA signatures; CRX v3 uses ECDSA
