"""T23en_cve_research grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T045zh_cve_research")


class CVEResearchGraderEN(_Base):
    """English variant — adjusts keyword lists for English-only output."""

    VULN_ID_CONCEPTS = {
        "cve_number": ["CVE-2021-44228"],
        "common_name": ["Log4Shell", "log4shell"],
        "cvss": ["CVSS", "10.0", "critical severity"],
        "library": ["Log4j", "log4j", "Apache Log4j"],
    }

    AFFECTED_VERSIONS_CONCEPTS = {
        "vulnerable_range_end": ["2.14.1"],
        "fix_versions": ["2.17", "2.16", "2.15"],
        "beta_start": ["2.0-beta9", "beta9", "2.0-beta"],
    }

    EXPLOIT_MECHANISM_CONCEPTS = {
        "jndi": ["JNDI", "jndi"],
        "lookup": ["lookup", "Lookup", "${jndi:", "message lookup"],
        "protocol": ["LDAP", "ldap", "RMI", "rmi"],
        "rce": ["remote code execution", "RCE", "arbitrary code execution"],
    }

    REMEDIATION_CONCEPTS = {
        "patch_version": ["2.17.0", "2.17.1", "2.17.2"],
        "mitigation_flag": ["formatMsgNoLookups", "LOG4J_FORMAT_MSG_NO_LOOKUPS"],
        "class_removal": ["JndiLookup", "JndiLookup.class"],
        "waf": ["WAF", "web application firewall", "firewall rule"],
    }

    REAL_WORLD_CONCEPTS = {
        "exploitation": ["exploitation", "exploited", "exploit",
                        "actively exploited", "in the wild"],
        "crypto": ["cryptocurrency", "cryptomining", "crypto mining",
                  "cryptojacking"],
        "ransomware": ["ransomware", "Conti", "Khonsari"],
        "state_actor": ["state-sponsored", "APT", "nation-state",
                       "advanced persistent threat"],
    }

    DETECTION_CONCEPTS = {
        "scanner": ["scanner", "scan", "log4j-scan", "detection tool"],
        "sbom": ["SBOM", "Software Bill of Materials", "Syft", "Grype"],
    }

    COMPLIANCE_CONCEPTS = {
        "cisa": ["CISA"],
        "bod": ["BOD 22-01", "BOD", "Binding Operational Directive"],
        "mandatory": ["mandatory", "required", "obligatory",
                     "Known Exploited Vulnerabilities", "KEV"],
    }
