"""Real handler using the elizaOS Python runtime trust security module.

Uses :class:`SecurityModuleService` for prompt-injection-style checks and
lightweight heuristics for categories the Python port does not expose as
separate detectors yet.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import re
from collections.abc import Coroutine
from difflib import SequenceMatcher
from typing import Any, TypeVar

from elizaos.core_capabilities.trust import SecurityContext, SecurityModuleService

_R = TypeVar("_R")

# ---------------------------------------------------------------------------
# Keyword banks for categories without a dedicated runtime detector in Python
# ---------------------------------------------------------------------------

_SOCIAL_ENGINEERING_PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"(?i)urgent.*(?:verify|confirm|click|update)"), 0.82),
    (re.compile(r"(?i)(?:act\s+now|within\s+\d+\s+(?:hour|minute|sec))"), 0.78),
    (re.compile(r"(?i)(?:your\s+account|wallet).*(?:suspend|locked|compromised)"), 0.85),
    (re.compile(r"(?i)(?:irs|tax|police).*(?:call|pay|gift\s+card)"), 0.80),
    (re.compile(r"(?i)you\s+have\s+won|claim\s+your\s+prize"), 0.75),
    (re.compile(r"(?i)microsoft|apple|google|support\s+team(?![^.]{0,40}\.)"), 0.70),
]

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

_CREDENTIAL_REQUEST_PATTERNS: list[tuple[re.Pattern[str], float]] = [
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

_EMBEDDED_CREDENTIAL_PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"(?i)(?:api[_-]?key|apikey|secret|token|password)\s*[=:]\s*[\w\-]{12,}"), 0.88),
    (re.compile(r"(?i)BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY"), 0.92),
    (re.compile(r"(?i)sk-[a-zA-Z0-9]{20,}"), 0.90),
]


def _run_async(coro: Coroutine[Any, Any, _R]) -> _R:
    """Run ``asyncio`` coroutine from sync code (handles nested loops)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


class RealTrustHandler:
    """Handler backed by runtime :class:`SecurityModuleService` + heuristics."""

    def __init__(self) -> None:
        self._security = SecurityModuleService()

    @property
    def name(self) -> str:
        return "elizaos-trust-runtime"

    def detect_injection(self, message: str) -> dict[str, bool | float]:
        async def _run() -> dict[str, bool | float]:
            check = await self._security.detect_prompt_injection(message, SecurityContext())
            return {"detected": check.detected, "confidence": check.confidence}

        return _run_async(_run())

    def detect_social_engineering(self, message: str) -> dict[str, bool | float]:
        inj = self.detect_injection(message)
        max_conf = float(inj["confidence"]) if inj["detected"] else 0.0
        detected = bool(inj["detected"])
        for pat, conf in _SOCIAL_ENGINEERING_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)
        return {"detected": detected, "confidence": max_conf}

    def detect_impersonation(self, username: str, existing_users: list[str]) -> dict[str, bool | float]:
        c = username.strip().lower()
        best = 0.0
        detected = False
        for user in existing_users:
            u = user.strip().lower()
            if c == u:
                continue
            ratio = SequenceMatcher(None, c, u).ratio()
            if ratio >= 0.86:
                detected = True
                best = max(best, ratio * 0.95)
        return {"detected": detected, "confidence": best}

    def detect_credential_theft(self, message: str) -> dict[str, bool | float]:
        negation_re = re.compile(
            r"(?i)(?:never|don'?t|do\s+not|avoid|stop)\s+(?:ever\s+)?(?:share|send|give|post|reveal|provide)",
        )
        is_warning = bool(negation_re.search(message))

        max_conf = 0.0
        detected = False

        inj = self.detect_injection(message)
        if inj["detected"]:
            max_conf = max(max_conf, float(inj["confidence"]))
            detected = True

        for pat, conf in _EMBEDDED_CREDENTIAL_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)

        if not is_warning:
            for pat, conf in _CREDENTIAL_REQUEST_PATTERNS:
                if pat.search(message):
                    detected = True
                    max_conf = max(max_conf, conf)

        return {"detected": detected, "confidence": max_conf}

    def detect_privilege_escalation(self, message: str) -> dict[str, bool | float]:
        inj = self.detect_injection(message)
        max_conf = float(inj["confidence"]) if inj["detected"] else 0.0
        detected = bool(inj["detected"])
        for pat, conf in _PRIVILEGE_ESCALATION_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)
        return {"detected": detected, "confidence": max_conf}

    def detect_data_exfiltration(self, message: str) -> dict[str, bool | float]:
        max_conf = 0.0
        detected = False
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
        max_conf = 0.0
        detected = False
        for pat, conf in _RESOURCE_ABUSE_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)
        return {"detected": detected, "confidence": max_conf}

    def detect_content_policy_violation(self, message: str) -> dict[str, bool | float]:
        max_conf = 0.0
        detected = False
        for pat, conf in _CONTENT_POLICY_PATTERNS:
            if pat.search(message):
                detected = True
                max_conf = max(max_conf, conf)
        return {"detected": detected, "confidence": max_conf}
