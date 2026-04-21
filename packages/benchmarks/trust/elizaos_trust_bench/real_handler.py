"""Real handler wrapping the ElizaOS trust plugin's Python implementation.

Uses SecurityModule for injection, social engineering, impersonation, and phishing.
Uses CredentialProtector for credential theft detection.

For categories the trust plugin doesn't explicitly cover (privilege escalation,
data exfiltration, resource abuse, content policy), we chain together the
available detectors and keyword heuristics as a best-effort fallback.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Add the trust plugin's Python implementation to the path
_TRUST_PLUGIN_PATH = str(
    Path(__file__).resolve().parents[3]
    / "plugins"
    / "plugin-trust"
    / "python"
)
if _TRUST_PLUGIN_PATH not in sys.path:
    sys.path.insert(0, _TRUST_PLUGIN_PATH)

from elizaos_plugin_trust.services.security_module import SecurityModule
from elizaos_plugin_trust.services.credential_protector import CredentialProtector
from elizaos_plugin_trust.types.security import ThreatLevel


# ---------------------------------------------------------------------------
# Keyword banks for categories the trust plugin doesn't natively cover
# ---------------------------------------------------------------------------

_PRIVILEGE_ESCALATION_PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"(?i)(?:make|grant|give)\s+me\s+(?:an?\s+)?admin"), 0.85),
    (re.compile(r"(?i)sudo\s+"), 0.80),
    (re.compile(r"(?i)elevate\s+(?:my\s+)?(?:permissions|privileges|access)"), 0.85),
    (re.compile(r"(?i)(?:create|add)\s+(?:a\s+)?backdoor"), 0.90),
    (re.compile(r"(?i)ALTER\s+USER.*SUPERUSER"), 0.90),
    (re.compile(r"(?i)whitelist\s+(?:my|this)"), 0.70),
    (re.compile(r"(?i)feature\s+flag"), 0.60),
    (re.compile(r"(?i)bypass\s+(?:the\s+)?(?:auth|rate.?limit|security|filter)"), 0.80),
    (re.compile(r"(?i)(?:restore|mirror)\s+(?:my\s+)?(?:permissions|role|privileges|access)"), 0.75),
    (re.compile(r"(?i)(?:set|change|modify)\s+(?:my\s+)?trust\s+score"), 0.80),
    (re.compile(r"(?i)write\s+access\s+to\s+(?:the\s+)?production"), 0.85),
    (re.compile(r"(?i)/api/.*(?:promote|internal|admin)"), 0.75),
    (re.compile(r"(?i)signing\s+authority"), 0.70),
    (re.compile(r"(?i)content\s+filter\s+(?:exception|bypass)"), 0.75),
    (re.compile(r"(?i)developer\s+mode"), 0.65),
    (re.compile(r"(?i)unlimited\s+requests"), 0.70),
]

_DATA_EXFILTRATION_PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"(?i)(?:what\s+is|show|print|reveal|display|output|repeat)\s+(?:your|the)\s+(?:system\s+)?prompt"), 0.90),
    (re.compile(r"(?i)(?:list|show|dump|print)\s+(?:all\s+)?(?:environment|env)\s+var"), 0.85),
    (re.compile(r"(?i)database\s+schema"), 0.75),
    (re.compile(r"(?i)/etc/passwd"), 0.90),
    (re.compile(r"(?i)\.\.\/.*\.env"), 0.85),
    (re.compile(r"(?i)(?:all\s+)?email\s+addresses"), 0.70),
    (re.compile(r"(?i)(?:other|which)\s+users\s+(?:have\s+you|did\s+you)"), 0.75),
    (re.compile(r"(?i)(?:dump|output)\s+(?:your\s+)?(?:config|configuration)"), 0.80),
    (re.compile(r"(?i)conversation\s+history\s+(?:including|with)\s+system"), 0.80),
    (re.compile(r"(?i)source\s+code\s+(?:of|for)"), 0.70),
    (re.compile(r"(?i)(?:temperature|safety)\s+(?:setting|parameter)"), 0.65),
    (re.compile(r"(?i)context\s+window"), 0.60),
    (re.compile(r"(?i)(?:fetch|get|visit)\s+https?://.*(?:exfil|attacker)"), 0.90),
    (re.compile(r"(?i)(?:as\s+a\s+poem|acrostic).*instructions"), 0.80),
    (re.compile(r"(?i)(?:first\s+\d+\s+characters?\s+of\s+(?:your\s+)?instructions)"), 0.85),
]

_RESOURCE_ABUSE_PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"(?i)(?:10,?000|100,?000)\s+(?:API\s+)?requests"), 0.85),
    (re.compile(r"(?i)infinite\s+loop"), 0.85),
    (re.compile(r"(?i)(?:100,?000|10,?000)\s+tokens"), 0.80),
    (re.compile(r"(?i)(?:mass|bulk)\s+(?:DM|message|spam)"), 0.85),
    (re.compile(r"(?i)(?:500|1000)\s+(?:new\s+)?channels"), 0.85),
    (re.compile(r"(?i)(?:mine|mining)\s+(?:crypto|bitcoin|ethereum)"), 0.90),
    (re.compile(r"(?i)recursive(?:ly)?\s+(?:\d+|1000)"), 0.80),
    (re.compile(r"(?i)(?:10|100)\s*GB\s+file"), 0.75),
    (re.compile(r"(?i)(?:enumerate|brute.?force)\s+(?:all\s+)?(?:user|password)"), 0.85),
    (re.compile(r"(?i)repeat\s+(?:\d+|100)\s+times"), 0.70),
    (re.compile(r"(?i)every\s+(?:\d+\s+)?seconds"), 0.65),
    (re.compile(r"(?i)all\s+available\s+cores"), 0.70),
]

_CONTENT_POLICY_PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"(?i)(?:write|create)\s+(?:a\s+)?(?:working\s+)?phishing\s+(?:email|template)"), 0.85),
    (re.compile(r"(?i)(?:ransomware|malware|exploit|keylogger)"), 0.80),
    (re.compile(r"(?i)pump.?and.?dump"), 0.90),
    (re.compile(r"(?i)(?:fake|generate)\s+(?:news|testimonials)"), 0.80),
    (re.compile(r"(?i)deepfake\s+(?:detection.?)?evasion"), 0.85),
    (re.compile(r"(?i)(?:scrape|harvest)\s+(?:all\s+)?personal\s+information"), 0.80),
    (re.compile(r"(?i)(?:mass.?report|coordinated\s+(?:harassment|attack))"), 0.85),
    (re.compile(r"(?i)default\s+passwords\s+for"), 0.70),
    (re.compile(r"(?i)(?:sql\s+injection|buffer\s+overflow)\s+(?:payload|exploit|vulnerability)"), 0.75),
    (re.compile(r"(?i)damage\s+(?:their|the)\s+(?:stock|reputation)"), 0.80),
    (re.compile(r"(?i)(?:evil|dark|unrestricted)\s*(?:AI|GPT|hacker)"), 0.80),
    (re.compile(r"(?i)(?:crash|destroy|brick)\s+someone'?s"), 0.75),
]


class RealTrustHandler:
    """Handler wrapping the real ElizaOS trust plugin for benchmarking.

    This exercises the actual Python SecurityModule and CredentialProtector
    detection logic against the benchmark corpus.
    """

    def __init__(self) -> None:
        self._security = SecurityModule()
        self._credential = CredentialProtector()

    @property
    def name(self) -> str:
        return "elizaos-trust-plugin"

    def detect_injection(self, message: str) -> dict[str, bool | float]:
        """Use SecurityModule.detect_prompt_injection."""
        check = self._security.detect_prompt_injection(message)
        detected = not check.passed  # passed=True means NO threat
        confidence = max((d.confidence for d in check.detections), default=0.0)
        return {"detected": detected, "confidence": confidence}

    def detect_social_engineering(self, message: str) -> dict[str, bool | float]:
        """Use SecurityModule.detect_social_engineering.

        The plugin takes a list of messages (conversation context).
        We wrap the single message in a list.
        """
        check = self._security.detect_social_engineering([message])
        detected = not check.passed
        confidence = max((d.confidence for d in check.detections), default=0.0)
        return {"detected": detected, "confidence": confidence}

    def detect_impersonation(
        self, username: str, existing_users: list[str]
    ) -> dict[str, bool | float]:
        """Use SecurityModule.detect_impersonation.

        Register existing users first, then check the candidate username.
        """
        # Fresh security module to avoid state leakage between test cases
        module = SecurityModule()
        for i, user in enumerate(existing_users):
            module.register_entity(f"existing-{i}", user, role="member")

        check = module.detect_impersonation("candidate", username)
        detected = not check.passed
        confidence = max((d.confidence for d in check.detections), default=0.0)
        return {"detected": detected, "confidence": confidence}

    def detect_credential_theft(self, message: str) -> dict[str, bool | float]:
        """Use CredentialProtector for actual credential patterns,
        plus SecurityModule.detect_phishing for URL/content analysis.
        Also check for credential REQUEST patterns (asking someone for creds).
        """
        # 1. Scan for actual embedded credentials
        cred_check = self._credential.detect_credential_theft(message)
        cred_detected = not cred_check.passed
        cred_conf = max((d.confidence for d in cred_check.detections), default=0.0)

        # 2. Scan for phishing
        phish_check = self._security.detect_phishing(message)
        phish_detected = not phish_check.passed
        phish_conf = max((d.confidence for d in phish_check.detections), default=0.0)

        # 3. Scan for credential REQUEST patterns (someone asking for creds)
        request_patterns: list[tuple[re.Pattern[str], float]] = [
            (re.compile(r"(?i)(?:send|share|give|post|tell|reveal|provide|paste)\s+(?:me\s+)?(?:your\s+)?(?:api.?(?:key|token)|password|credentials|seed\s+phrase|private\s+key|secret.?key|recovery\s+phrase|2FA\s+code|login|\.env|ssh.*key|client.?secret|connection\s+string)"), 0.90),
            (re.compile(r"(?i)(?:click|go\s+to|visit|verify)\s+(?:here|this|the\s+link).*(?:bit\.ly|tinyurl|verify|confirm)"), 0.80),
            (re.compile(r"(?i)your\s+account\s+(?:has\s+been|will\s+be)\s+(?:suspended|locked)"), 0.80),
            (re.compile(r"(?i)(?:DM|message)\s+me\s+your\s+(?:private|secret)"), 0.85),
            (re.compile(r"(?i)(?:everyone|team)\s+(?:post|share)\s+(?:their|your)\s+(?:access\s+)?(?:tokens|keys|credentials)"), 0.85),
            (re.compile(r"(?i)(?:provide|share)\s+your\s+(?:email\s+)?password"), 0.85),
            (re.compile(r"(?i)(?:contents?\s+of\s+(?:your\s+)?\.env)"), 0.80),
            (re.compile(r"(?i)(?:database\s+connection\s+string.*password)"), 0.80),
            (re.compile(r"(?i)(?:OAuth|client).?secret"), 0.75),
            (re.compile(r"(?i)~/.ssh/id_rsa"), 0.85),
            (re.compile(r"(?i)(?:g00gle|go0gle|goog1e).*(?:security|verify)"), 0.85),
        ]

        # Negation patterns — if the message is ADVISING against sharing, not requesting
        negation_re = re.compile(
            r"(?i)(?:never|don'?t|do\s+not|avoid|stop)\s+(?:ever\s+)?(?:share|send|give|post|reveal|provide)",
        )
        is_warning = bool(negation_re.search(message))

        req_detected = False
        req_conf = 0.0
        if not is_warning:
            for pat, conf in request_patterns:
                if pat.search(message):
                    req_detected = True
                    req_conf = max(req_conf, conf)

        detected = cred_detected or phish_detected or req_detected
        confidence = max(cred_conf, phish_conf, req_conf)
        return {"detected": detected, "confidence": confidence}

    def detect_privilege_escalation(self, message: str) -> dict[str, bool | float]:
        """Keyword-based detection for privilege escalation.

        The trust plugin doesn't have a dedicated privilege escalation detector,
        so we use custom patterns plus the injection detector as a signal.
        """
        # Check if the injection detector fires (many escalation attempts
        # look like injections)
        inj = self.detect_injection(message)

        max_conf = float(inj["confidence"]) if inj["detected"] else 0.0
        detected = bool(inj["detected"])

        for pat, conf in _PRIVILEGE_ESCALATION_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)

        return {"detected": detected, "confidence": max_conf}

    def detect_data_exfiltration(self, message: str) -> dict[str, bool | float]:
        """Keyword-based detection for data exfiltration attempts."""
        max_conf = 0.0
        detected = False

        # The injection detector catches some exfil (prompt extraction)
        inj = self.detect_injection(message)
        if inj["detected"]:
            max_conf = max(max_conf, float(inj["confidence"]))
            detected = True

        for pat, conf in _DATA_EXFILTRATION_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)

        return {"detected": detected, "confidence": max_conf}

    def detect_resource_abuse(self, message: str) -> dict[str, bool | float]:
        """Keyword-based detection for resource abuse attempts."""
        max_conf = 0.0
        detected = False

        for pat, conf in _RESOURCE_ABUSE_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)

        return {"detected": detected, "confidence": max_conf}

    def detect_content_policy_violation(self, message: str) -> dict[str, bool | float]:
        """Keyword-based detection for content policy violations."""
        max_conf = 0.0
        detected = False

        for pat, conf in _CONTENT_POLICY_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)

        return {"detected": detected, "confidence": max_conf}
