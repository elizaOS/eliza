/*
    Real YARA Rule: Windows Remcos RAT Detection

    This rule is adapted from Elastic Security's production rules for
    detecting Remcos RAT. It demonstrates best practices for PE malware:
    - Multiple rule versions targeting different indicators
    - Proper metadata with attribution and references
    - String selection based on unique behavioral markers
    - Graduated string requirements (2 of, 3 of, 4 of)

    Original source: https://github.com/elastic/protections-artifacts
    License: Elastic License v2
    Attribution: Elastic Security
*/

rule MAL_Win_Remcos_Watchdog
{
    meta:
        description = "Detects Remcos RAT via unique watchdog mutex name and restart status strings"
        author = "Elastic Security (adapted)"
        reference = "https://www.elastic.co/security-labs/exploring-the-ref2731-intrusion-set"
        date = "2021-06-10"
        modified = "2025-01-30"
        score = 90

    strings:
        // Unique watchdog-related strings
        $a1 = "Remcos restarted by watchdog!" ascii fullword
        $a2 = "Mutex_RemWatchdog" ascii fullword

        // Version/logging format strings
        $a3 = "%02i:%02i:%02i:%03i" ascii
        $a4 = "* Remcos v" ascii fullword

    condition:
        // Filesize and magic bytes first (instant checks)
        filesize < 5MB and
        uint16(0) == 0x5A4D and

        // Require 2 of these unique markers
        2 of them
}

rule MAL_Win_Remcos_Features
{
    meta:
        description = "Detects Remcos RAT via unique feature directory names and configuration file artifacts"
        author = "Elastic Security (adapted)"
        reference = "https://www.elastic.co/security-labs/exploring-the-ref2731-intrusion-set"
        date = "2023-06-23"
        modified = "2025-01-30"
        score = 85

    strings:
        // Service/feature identifiers
        $a1 = "ServRem" ascii fullword
        $a2 = "Screenshots" ascii fullword
        $a3 = "MicRecords" ascii fullword

        // Binary/config names
        $a4 = "remcos.exe" wide nocase fullword
        $a5 = "Remcos" wide fullword
        $a6 = "logs.dat" wide fullword

    condition:
        filesize < 5MB and
        uint16(0) == 0x5A4D and

        // Need 3 because individual strings are more common
        3 of them
}

rule MAL_Win_Remcos_Agent
{
    meta:
        description = "Detects Remcos RAT agent initialization messages and credential theft status strings"
        author = "Elastic Security (adapted)"
        reference = "https://github.com/elastic/protections-artifacts"
        date = "2025-01-30"
        score = 95

    strings:
        // Agent initialization and C2 communication
        $a1 = "Remcos Agent initialized (" ascii fullword
        $a2 = "Remcos v" ascii fullword
        $a3 = "Uploading file to Controller: " ascii fullword

        // Notification and logging artifacts
        $a4 = "alarm.wav" ascii fullword
        $a5 = "[%04i/%02i/%02i %02i:%02i:%02i " wide fullword
        $a6 = "time_%04i%02i%02i_%02i%02i%02i" wide fullword

        // Browser credential theft indicators
        $a7 = "[Cleared browsers logins and cookies.]" ascii fullword
        $a8 = "[Chrome StoredLogins found, cleared!]" ascii fullword

    condition:
        filesize < 10MB and
        uint16(0) == 0x5A4D and

        // Require 4 because some strings could appear elsewhere
        4 of them
}
