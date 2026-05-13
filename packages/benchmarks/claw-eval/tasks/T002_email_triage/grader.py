"""T01en_email_triage grader — English variant."""

import json
import logging
import re
import time
import random
from typing import Any

from claw_eval.graders.base import load_peer_grader

log = logging.getLogger(__name__)

_Base = load_peer_grader("T001zh_email_triage")


class EmailTriageGraderEN(_Base):
    """English variant — overrides language-specific class attributes only."""

    EXPECTED_CLASSIFICATIONS = {
        "msg_001": {"expected": ["needs reply"], "sender": "boss@company.com", "subject": "Need your input on Q1 report"},
        "msg_002": {"expected": ["needs reply"], "sender": "collaborator@partner.org", "subject": "Joint project progress update"},
        "msg_003": {"expected": ["FYI"], "sender": "newsletter@techdigest.io", "subject": "This Week in AI"},
        "msg_004": {"expected": ["spam"], "sender": "winner-notification@lottery-intl.xyz", "subject": "Congratulations You Won"},
        "msg_005": {"expected": ["FYI", "needs reply"], "sender": "hr@company.com", "subject": "Employee benefits plan update"},
        "msg_006": {"expected": ["FYI", "spam"], "sender": "partner-events@techpartner.com", "subject": "Exclusive partner training"},
        "msg_007": {"expected": ["needs reply"], "sender": "security@company.com", "subject": "Security alert"},
        "msg_008": {"expected": ["spam", "FYI"], "sender": "noreply@survey-platform.net", "subject": "Customer satisfaction survey"},
    }

    ALL_CATEGORIES = ["needs reply", "FYI", "spam"]

    def _llm_score_classifications(self, judge: Any, final_text: str) -> float:
        """
        English-variant override: same logic as the ZH parent but with an
        English prompt and English category labels.
        """
        email_list = "\n".join(
            f'{i + 1}. {msg_id}: from {info["sender"]}, subject "{info["subject"]}"'
            for i, (msg_id, info) in enumerate(self.EXPECTED_CLASSIFICATIONS.items())
        )

        prompt = (
            "Given the assistant's response below, determine what email category "
            "was assigned to each email.\n\n"
            "For each email output EXACTLY one of:\n"
            '  "needs reply" — the assistant indicated this email requires a reply or action\n'
            '  "FYI"         — the assistant indicated this is a notification / informational email\n'
            '  "spam"        — the assistant indicated this is spam or junk\n'
            '  "unmentioned" — the email was not mentioned or no category was assigned\n\n'
            f"Emails:\n{email_list}\n\n"
            f"Assistant's response:\n{final_text}\n\n"
            'Output JSON only, msg_ids as keys, e.g. {"msg_001": "needs reply", ...}'
        )
        max_retries = 30
        for attempt in range(max_retries + 1):
            try:
                resp = judge.client.chat.completions.create(
                    model=judge.model_id,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.0,
                    max_tokens=8192,
                )
                raw = resp.choices[0].message.content or "{}"
                raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
                raw = re.sub(r"\s*```$", "", raw.strip())
                m = re.search(r'\{[^{}]*\}', raw)
                if m:
                    raw = m.group(0)
                classifications = json.loads(raw)

                correct = sum(
                    1
                    for msg_id, info in self.EXPECTED_CLASSIFICATIONS.items()
                    if classifications.get(msg_id) in info["expected"]
                )
                return correct / len(self.EXPECTED_CLASSIFICATIONS)

            except Exception as exc:
                status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
                delay = min(2 ** (attempt + 1), 16) + random.uniform(0, 1)
                print(f"[judge-retry] ({status or type(exc).__name__}), "
                      f"attempt {attempt + 1}/{max_retries}, waiting {delay:.1f}s ...")
                time.sleep(delay)

        return 0.0
