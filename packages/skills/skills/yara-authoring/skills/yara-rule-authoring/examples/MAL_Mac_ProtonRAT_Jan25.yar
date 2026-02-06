/*
    Real YARA Rule: macOS Proton RAT Detection

    This rule is adapted from Airbnb's BinaryAlert open-source YARA rules.
    It demonstrates best practices for macOS malware detection:
    - Mach-O magic bytes validation (including universal binaries)
    - Multi-category string grouping ($a* for libraries, $b* for behaviors)
    - Cross-category matching requirement

    Original source: https://github.com/airbnb/binaryalert
    Attribution: @mimeframe / Airbnb Security
    Reference: https://objective-see.org/blog/blog_0x1D.html
*/

private rule MachO
{
    meta:
        description = "Detects all Mach-O binary formats including 32-bit, 64-bit, and universal binaries"
        author = "Airbnb BinaryAlert"
        reference = "https://github.com/airbnb/binaryalert"
        date = "2017-01-01"

    condition:
        // 32-bit Mach-O (little/big endian)
        uint32(0) == 0xfeedface or uint32(0) == 0xcefaedfe or
        // 64-bit Mach-O (little/big endian)
        uint32(0) == 0xfeedfacf or uint32(0) == 0xcffaedfe or
        // Universal binary / fat binary (little/big endian)
        uint32(0) == 0xcafebabe or uint32(0) == 0xbebafeca
}

rule MAL_Mac_ProtonRAT_Generic
{
    meta:
        description = "Detects macOS Proton RAT via WebSocket library and SSH tunnel strings"
        author = "@mimeframe (Airbnb Security, adapted)"
        reference = "https://objective-see.org/blog/blog_0x1D.html"
        date = "2017-05-04"
        modified = "2025-01-30"
        score = 80

    strings:
        // Category A: Library indicators
        // SocketRocket is a WebSocket library - legitimate but rare in malware context
        $a1 = "SRWebSocket" nocase ascii wide
        $a2 = "SocketRocket" nocase ascii wide

        // Category B: SSH tunnel behavioral indicators
        // From joeroback/SSHTunnel - distinctive error/status messages
        $b1 = "SSH tunnel not launched" nocase ascii wide
        $b2 = "SSH tunnel still running" nocase ascii wide
        $b3 = "SSH tunnel already launched" nocase ascii wide
        $b4 = "Entering interactive session." nocase ascii wide

    condition:
        // File type validation
        MachO and
        filesize < 20MB and

        // Require indicators from BOTH categories
        // This reduces FPs: SocketRocket alone is legitimate
        // SSH tunneling alone is legitimate
        // BOTH together is suspicious for a GUI app
        any of ($a*) and any of ($b*)
}

rule MAL_Mac_ProtonRAT_Keylogger
{
    meta:
        description = "Detects macOS Proton RAT keylogger functionality via CoreGraphics event tap APIs"
        author = "Trail of Bits (based on Objective-See research)"
        reference = "https://objective-see.org/blog/blog_0x1D.html"
        date = "2025-01-30"
        score = 85

    strings:
        // Keylogger API usage (CoreGraphics event tap)
        $key1 = "CGEventTapCreate" ascii
        $key2 = "kCGEventKeyDown" ascii
        $key3 = "kCGEventKeyUp" ascii

        // Credential theft indicators
        $cred1 = "security find-generic-password" ascii
        $cred2 = "keychain" ascii nocase

        // Persistence paths
        $persist1 = "Library/LaunchAgents" ascii
        $persist2 = "com.apple" ascii  // Masquerading as Apple

    condition:
        MachO and
        filesize < 20MB and

        // Need keylogger functionality
        2 of ($key*) and

        // Plus credential or persistence indicators
        (any of ($cred*) or any of ($persist*))
}
