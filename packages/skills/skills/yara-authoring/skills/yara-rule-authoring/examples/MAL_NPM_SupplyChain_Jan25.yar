/*
    Real YARA Rules: npm Supply Chain Attack Detection

    These rules detect patterns from documented npm supply chain attacks.
    They demonstrate best practices for JavaScript/package detection:
    - No magic bytes (text files)
    - Combining behavioral patterns to reduce false positives
    - Targeting specific attack artifacts, not generic JavaScript

    Sources:
    - chalk/debug compromise (Sept 2025): Stairwell Threat Research
    - os-info-checker-es6: Veracode Security Research
    - event-stream/flatmap-stream: npm security advisory

    Attribution: Stairwell Threat Research, Veracode, npm Security
*/

rule MAL_NPM_ChalkDebug_Sept25
{
    meta:
        description = "Detects malicious wallet-drainer code from chalk/debug npm supply-chain compromise"
        author = "Stairwell Threat Research (adapted)"
        reference = "https://stairwell.com/resources/how-to-detect-npm-package-manager-supply-chain-attacks-with-yara/"
        date = "2025-09-11"
        modified = "2025-01-30"
        score = 95

    strings:
        // Unique function names from the malicious payload
        $s1 = "runmask" ascii
        $s2 = "checkethereumw" ascii

        // Ethereum function selector for approve(address,uint256)
        // This ERC-20 method grants token spending permission
        $function_selector = "0x095ea7b3" ascii

    condition:
        filesize < 5MB and
        all of them
}

rule MAL_NPM_ChalkDebug_ERC20Selectors
{
    meta:
        description = "Detects malicious npm packages targeting ERC-20 token operations"
        author = "Trail of Bits (based on Stairwell research)"
        reference = "https://github.com/chalk/chalk/issues/656"
        date = "2025-01-30"
        score = 80

    strings:
        // ERC-20 function selectors (4-byte Keccak hashes)
        // These appear in wallet-draining malware
        $erc20_transfer = { 70 a0 82 31 }   // transfer(address,uint256)
        $erc20_approve = { 09 5e a7 b3 }    // approve(address,uint256)
        $erc20_transferFrom = { 23 b8 72 dd } // transferFrom(address,address,uint256)

        // Context: must be in a JavaScript/npm context
        $npm_context1 = "package.json" ascii
        $npm_context2 = "node_modules" ascii
        $js_context = "module.exports" ascii

    condition:
        filesize < 2MB and
        // Need multiple ERC-20 selectors (legitimate code rarely has multiple)
        2 of ($erc20_*) and
        // Confirm npm/JS context
        any of ($npm_context*, $js_context)
}

rule MAL_NPM_ZeroWidthSteganography
{
    meta:
        description = "Detects hidden code using zero-width Unicode characters (os-info-checker-es6 technique)"
        author = "Trail of Bits (based on Veracode research)"
        reference = "https://www.veracode.com/blog/security-news/npm-package-uses-unicode-invisible-characters-hide-backdoor-code"
        date = "2025-01-30"
        score = 75

    strings:
        // Zero-width characters used to hide payloads
        // These encode binary data as invisible Unicode
        $zw_sequence = { E2 80 8B E2 80 8C E2 80 8D }  // ZWSP + ZWNJ + ZWJ
        $zw_double = { E2 80 8B E2 80 8B }   // Double zero-width space
        $zw_mixed = { E2 80 8C E2 80 8D }    // ZWNJ + ZWJ pair

        // Typical decoding pattern
        $eval_atob = /eval\s*\(\s*atob\s*\(/

    condition:
        filesize < 1MB and
        // Need significant zero-width char density
        (#zw_sequence > 3 or #zw_double > 5 or #zw_mixed > 5) and
        // Plus execution mechanism
        $eval_atob
}

rule MAL_NPM_EventStream_Pattern
{
    meta:
        description = "Detects patterns similar to event-stream/flatmap-stream backdoor"
        author = "Trail of Bits (based on npm security advisory)"
        reference = "https://github.com/dominictarr/event-stream/issues/116"
        date = "2025-01-30"
        score = 70

    strings:
        // The attack targeted Copay Bitcoin wallet
        $target1 = "copay" ascii nocase
        $target2 = "bitpay" ascii nocase
        $target3 = "bitcoin" ascii nocase

        // Malicious dependency injection
        $flatmap = "flatmap-stream" ascii
        $pump = "pump" ascii

        // Encrypted payload indicators
        $aes = "createDecipher" ascii
        $buffer_from = /Buffer\.from\s*\([^)]+,\s*['"]hex['"]\)/

    condition:
        filesize < 500KB and
        // Bitcoin wallet targeting
        any of ($target*) and
        // Crypto/decode patterns
        ($aes or $buffer_from) and
        // One of the attack-specific patterns
        ($flatmap or #pump > 2)
}

rule SUSP_NPM_PostinstallExfil
{
    meta:
        description = "Detects suspicious npm packages with postinstall hooks accessing credentials and network"
        author = "Trail of Bits"
        reference = "https://blog.phylum.io/npm-supply-chain-attack-patterns/"
        date = "2025-01-30"
        score = 60

    strings:
        // Package.json install hooks
        $hook1 = /"postinstall"\s*:\s*"[^"]+"/
        $hook2 = /"preinstall"\s*:\s*"[^"]+"/

        // Credential access patterns
        $cred1 = /process\.env\.NPM_TOKEN/i
        $cred2 = /process\.env\.GITHUB_TOKEN/i
        $cred3 = /process\.env\.AWS_/

        // Network exfiltration
        $net1 = /fetch\s*\(\s*['"`]https?:\/\//
        $net2 = /axios\.(post|put)\s*\(/
        $net3 = /webhook/i

        // False positive exclusions
        $fp1 = "webpack" ascii
        $fp2 = "electron-builder" ascii
        $fp3 = "typescript" ascii

    condition:
        filesize < 5MB and
        // Has install hook
        any of ($hook*) and
        // Accesses credentials
        any of ($cred*) and
        // Has network capability
        any of ($net*) and
        // Not a known build tool
        not 2 of ($fp*)
}
