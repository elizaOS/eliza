# YARA-X DEX Module Reference

The `dex` module enables analysis of Android Dalvik Executable (DEX) files. Use it to detect Android malware based on class structure, method signatures, string content, and obfuscation patterns.

**Version requirements:** YARA-X v1.11.0+

**Important:** The YARA-X `dex` module is **not compatible** with legacy YARA's `dex` module. The API is completely different. Rules must be rewritten.

## Module Import

```yara
import "dex"
```

## API Reference

### File Type Validation

| Field | Type | Description |
|-------|------|-------------|
| `dex.is_dex` | bool | Returns true if file is valid DEX |

**Always check `dex.is_dex` first.** Other fields will not work correctly on non-DEX files.

### Header Information

Access via `dex.header.*`:

| Field | Type | Description |
|-------|------|-------------|
| `dex.header.magic` | integer | DEX magic bytes (hex) |
| `dex.header.version` | integer | DEX version (35, 36, 37, ...) |
| `dex.header.checksum` | integer | Adler32 checksum from header (hex) |
| `dex.header.signature` | string | SHA-1 hash from header |
| `dex.header.file_size` | integer | Total file size in bytes |
| `dex.header.header_size` | integer | Header size (hex, usually 0x70) |
| `dex.header.endian_tag` | integer | Endianness indicator (hex) |
| `dex.header.link_size` | integer | Link section size |
| `dex.header.link_off` | integer | Link section offset (hex) |
| `dex.header.data_size` | integer | Data section size |
| `dex.header.data_off` | integer | Data section offset (hex) |

### Collections

| Field | Type | Description |
|-------|------|-------------|
| `dex.strings` | string[] | Array of all strings in DEX |
| `dex.types` | string[] | Array of type descriptors |
| `dex.protos` | array | Array of method prototypes |
| `dex.fields` | array | Array of field definitions |
| `dex.methods` | array | Array of method definitions |
| `dex.class_defs` | array | Array of class definitions |

### Method Item Structure

Each item in `dex.methods`:

| Field | Type | Description |
|-------|------|-------------|
| `class` | string | Owning class name |
| `name` | string | Method name |
| `proto.shorty` | string | Short-form method signature |
| `proto.return_type` | string | Return type descriptor |
| `proto.parameters_count` | integer | Number of parameters |
| `proto.parameters` | string[] | Parameter type descriptors |

### Class Definition Structure

Each item in `dex.class_defs`:

| Field | Type | Description |
|-------|------|-------------|
| `class` | string | Fully qualified class name |
| `access_flags` | integer | Class access modifiers |
| `superclass` | string | Parent class name |
| `source_file` | string | Source file name (if present) |

### Convenience Functions

These functions search across all entries efficiently using binary search:

| Function | Description | Example |
|----------|-------------|---------|
| `dex.contains_string(pattern)` | Check if any string matches | `dex.contains_string("decrypt")` |
| `dex.contains_method(pattern)` | Check if any method name matches | `dex.contains_method("loadClass")` |
| `dex.contains_class(pattern)` | Check if any class matches | `dex.contains_class("Ldalvik/system/DexClassLoader;")` |

### Integrity Functions

| Function | Description |
|----------|-------------|
| `dex.checksum()` | Compute actual Adler32 checksum (compare with `dex.header.checksum`) |
| `dex.signature()` | Compute actual SHA-1 signature (compare with `dex.header.signature`) |

```yara
// Detect tampered DEX files
rule SUSP_DEX_ChecksumMismatch
{
    condition:
        dex.is_dex and
        dex.checksum() != dex.header.checksum
}
```

## Obfuscation Detection

### Single-Letter Class Names

Heavy obfuscation often produces single-letter class/package names:

```yara
import "dex"

rule SUSP_DEX_HeavyObfuscation
{
    meta:
        description = "Detects DEX with likely ProGuard/R8 aggressive obfuscation"

    condition:
        dex.is_dex and

        // Count classes with single-letter names
        for 10 c in dex.class_defs : (
            c.class matches /^L[a-z]\/[a-z]\/[a-z];$/
        )
}
```

### Missing Source File Info

Legitimate apps usually preserve source file names for crash reports:

```yara
rule SUSP_DEX_StrippedDebugInfo
{
    meta:
        description = "DEX has no source file information - unusual for production apps"

    condition:
        dex.is_dex and

        // No class has source file info
        for all c in dex.class_defs : (
            c.source_file == ""
        )
}
```

### String Encryption Detection

Malware often encrypts strings to evade static analysis:

```yara
rule SUSP_DEX_StringDecryption
{
    meta:
        description = "Detects common string decryption patterns in Android malware"

    condition:
        dex.is_dex and

        // Look for decryption method patterns
        (
            dex.contains_method("decrypt") or
            dex.contains_method("deobfuscate")
        ) and

        // Combined with XOR or Base64 indicators
        dex.contains_string("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
}
```

## Common Malware Patterns

### Reflection-Based Loading

Malware uses reflection to load code dynamically:

```yara
import "dex"

rule SUSP_DEX_ReflectionLoading
{
    meta:
        description = "Detects dynamic class loading via reflection"

    condition:
        dex.is_dex and

        // DexClassLoader or PathClassLoader usage
        (
            dex.contains_class("Ldalvik/system/DexClassLoader;") or
            dex.contains_class("Ldalvik/system/PathClassLoader;") or
            dex.contains_class("Ldalvik/system/InMemoryDexClassLoader;")
        ) and

        // Combined with reflection
        (
            dex.contains_method("loadClass") or
            dex.contains_method("forName")
        )
}
```

### SMS/Call Interception

Banking trojans commonly intercept SMS for 2FA bypass:

```yara
import "dex"

rule MAL_DEX_SMSInterception
{
    meta:
        description = "Detects SMS interception capabilities"
        score = 70

    condition:
        dex.is_dex and

        // SMS receiver registration
        dex.contains_string("android.provider.Telephony.SMS_RECEIVED") and

        // SMS content access
        (
            dex.contains_string("content://sms") or
            dex.contains_method("getMessageBody")
        ) and

        // Network exfiltration
        (
            dex.contains_class("Ljava/net/HttpURLConnection;") or
            dex.contains_class("Lokhttp3/OkHttpClient;")
        )
}
```

### Accessibility Service Abuse

Malware abuses accessibility for overlay attacks:

```yara
import "dex"

rule SUSP_DEX_AccessibilityAbuse
{
    meta:
        description = "Detects potential accessibility service abuse for overlay attacks"

    condition:
        dex.is_dex and

        // AccessibilityService implementation
        for any c in dex.class_defs : (
            c.superclass contains "AccessibilityService"
        ) and

        // Window overlay
        (
            dex.contains_string("android.permission.SYSTEM_ALERT_WINDOW") or
            dex.contains_string("TYPE_APPLICATION_OVERLAY")
        ) and

        // Combined with sensitive actions
        (
            dex.contains_string("performGlobalAction") or
            dex.contains_method("dispatchGesture")
        )
}
```

## Example Rules

### Banking Trojan Detection

```yara
import "dex"

rule MAL_DEX_BankingTrojan
{
    meta:
        description = "Detects common banking trojan patterns"
        score = 80

    strings:
        // Overlay injection strings
        $overlay1 = "android.app.action.ADD_DEVICE_ADMIN" ascii
        $overlay2 = "BIND_ACCESSIBILITY_SERVICE" ascii

        // Target banking app packages
        $bank1 = "com.chase.sig.android" ascii
        $bank2 = "com.wellsfargo.mobile" ascii
        $bank3 = "com.bankofamerica" ascii

    condition:
        dex.is_dex and

        // Has accessibility abuse potential
        for any c in dex.class_defs : (
            c.superclass contains "AccessibilityService"
        ) and

        // Overlay indicators
        any of ($overlay*) and

        // Targets specific banks (reduce FPs)
        any of ($bank*) and

        // Network capability
        (
            dex.contains_class("Lokhttp3/") or
            dex.contains_class("Ljava/net/HttpURLConnection;")
        )
}
```

### RAT Detection

```yara
import "dex"

rule MAL_DEX_RemoteAccessTrojan
{
    meta:
        description = "Detects Android RAT capabilities"
        score = 85

    condition:
        dex.is_dex and

        // Camera/mic access
        (
            dex.contains_string("android.permission.CAMERA") and
            dex.contains_string("android.permission.RECORD_AUDIO")
        ) and

        // Location tracking
        dex.contains_string("android.permission.ACCESS_FINE_LOCATION") and

        // Command channel
        (
            dex.contains_string("socket") or
            dex.contains_class("Ljava/net/Socket;")
        ) and

        // File exfiltration
        (
            dex.contains_method("getExternalStorage") or
            dex.contains_string("/sdcard/")
        )
}
```

## Best Practices

1. **Always validate file type first** — Start with `dex.is_dex`

2. **Use `contains_*()` functions** — They use binary search and are optimized

3. **Combine class/method patterns** — Single indicators are weak; combinations are stronger

4. **Account for obfuscation** — Class names may be mangled; look for method behaviors

5. **Test on legitimate apps** — Top Play Store apps are your goodware corpus

6. **Consider multi-dex** — Large apps split into multiple DEX files; scan all

## Troubleshooting

**Rule doesn't match DEX files:**
- Verify the file is valid DEX (`file sample.dex` should show "Dalvik dex file")
- Check YARA-X version is v1.11.0+
- Use `yr dump -m dex sample.dex` to inspect module output

**contains_* functions not working:**
- Requires YARA-X v1.11.0+
- String patterns are case-sensitive by default
- Use exact class names with L prefix and ; suffix: `Lcom/example/Class;`

**Migrating from legacy YARA dex module:**
- APIs are completely different — rewrite is required
- Legacy: `dex.has_class("...")` → YARA-X: `dex.contains_class("...")`
- Legacy field names differ from YARA-X field names
