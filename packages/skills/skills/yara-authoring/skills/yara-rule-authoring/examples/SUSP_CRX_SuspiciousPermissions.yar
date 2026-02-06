/*
    Example YARA-X Rule: Chrome Extension Analysis

    This rule demonstrates the YARA-X crx module for detecting suspicious
    Chrome extensions. Key features shown:
    - `import "crx"` for module access
    - `crx.is_crx` for file type validation
    - Permission iteration with `for any perm in crx.permissions`
    - `crx.permhash()` for threat hunting
    - Red flag permission combinations

    Requires YARA-X v1.5.0+ (crx module), v1.11.0+ (permhash)

    Note: This is an educational example. Real rules should be tuned
    based on your specific threat model and false positive tolerance.
*/

import "crx"

rule SUSP_CRX_HighRiskPermissionCombo
{
    meta:
        description = "Detects Chrome extensions with dangerous permission combinations that enable data exfiltration"
        author = "YARA Skill Example <yara-authoring@example.com>"
        reference = "https://developer.chrome.com/docs/extensions/reference/permissions-list"
        date = "2025-01-29"
        score = 70

    condition:
        // Validate file type first - crx module only works on CRX files
        crx.is_crx and

        // Red flag combination: native messaging + broad host access
        // Allows extension to communicate with local executables
        // while accessing data from many websites
        (
            for any perm in crx.permissions : (
                perm == "nativeMessaging"
            )
        ) and
        (
            for any perm in crx.permissions : (
                perm == "<all_urls>" or
                perm == "*://*/*" or
                perm == "http://*/*" or
                perm == "https://*/*"
            )
        )
}

rule SUSP_CRX_DebuggerPermission
{
    meta:
        description = "Detects Chrome extensions requesting debugger permission - can modify any page and intercept traffic"
        author = "YARA Skill Example <yara-authoring@example.com>"
        reference = "https://developer.chrome.com/docs/extensions/reference/api/debugger"
        date = "2025-01-29"
        score = 80

    condition:
        crx.is_crx and

        // The debugger permission is extremely powerful:
        // - Attach to any tab
        // - Intercept/modify network requests
        // - Execute scripts in page context
        // - Access cookies and storage
        // Legitimate uses exist (DevTools extensions) but rare
        for any perm in crx.permissions : (
            perm == "debugger"
        )
}

rule SUSP_CRX_DataExfilPotential
{
    meta:
        description = "Detects Chrome extensions with permissions enabling credential/data theft"
        author = "YARA Skill Example <yara-authoring@example.com>"
        reference = "https://example.com/crx-threat-research"
        date = "2025-01-29"
        score = 60

    strings:
        // Look for exfiltration patterns in extension code
        // These appear in background scripts or content scripts
        $fetch_post = /fetch\s*\([^)]+method\s*:\s*['"]POST['"]/
        $xhr_send = /\.send\s*\(\s*JSON\.stringify/
        $ws_send = /WebSocket[^;]+\.send\s*\(/

        // Credential access patterns
        $password_field = /document\.querySelector[^)]+type\s*=\s*['"]password['"]/
        $form_data = /new\s+FormData\s*\(\s*document\./

    condition:
        crx.is_crx and

        // Has storage access (for caching stolen data)
        for any perm in crx.permissions : (
            perm == "storage" or
            perm == "unlimitedStorage"
        ) and

        // Has broad page access
        for any perm in crx.permissions : (
            perm == "<all_urls>" or
            perm == "activeTab" or
            perm == "tabs"
        ) and

        // Shows data collection + exfiltration behavior
        (1 of ($fetch_post, $xhr_send, $ws_send)) and
        (1 of ($password_field, $form_data))
}

rule SUSP_CRX_PermhashCluster
{
    meta:
        description = "Detects extensions matching known malicious permission profile hash cluster"
        author = "YARA Skill Example <yara-authoring@example.com>"
        reference = "https://example.com/crx-permhash-research"
        date = "2025-01-29"
        score = 50

    condition:
        crx.is_crx and

        // permhash() generates a hash of the extension's permissions
        // Useful for clustering extensions with identical capability profiles
        // These are fictional hashes for demonstration
        (
            crx.permhash() == "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" or
            crx.permhash() == "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3"
        )
}
