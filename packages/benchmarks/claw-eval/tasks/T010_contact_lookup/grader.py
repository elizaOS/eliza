"""T05en_contact_lookup grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T009zh_contact_lookup")


class ContactLookupGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    CORRECT_CONTACT = {
        "id": "c_001",
        "name": "David Zhang",
        "department": "Engineering",
        "title": "Senior Engineer",
        "email": "dzhang@company.com",
        "phone": "138-0001-1001",
    }

    HOMOPHONE_DISTRACTOR = {
        "id": "c_007",
        "name": "David Chang",
        "department": "Engineering",
        "title": "Junior Engineer",
        "email": "dchang@company.com",
        "phone": "133-0007-7007",
    }

    SIMILAR_NAMES = ["David Zhang", "David Chang", "Dave Zhang", "D. Zhang"]

    # ------------------------------------------------------------------ #
    # LLM Judge rubric (English)
    # ------------------------------------------------------------------ #

    _DISAMBIGUATION_RUBRIC = """\
Evaluate the agent's disambiguation quality when facing multiple similar-name \
search results.

Context: The user asked for "David Zhang in Engineering". Search results include:
- David Zhang (c_001, Engineering, Senior Engineer) — correct target
- David Chang (c_007, Engineering, Junior Engineer) — similar-name distractor, \
same department
- Dave Zhang, D. Zhang, etc. — other similar names

Key disambiguation criteria:
1. Did the agent list multiple search results to show the user there are \
similar names?
2. Did the agent clearly distinguish David Zhang (Senior Engineer) from \
David Chang (Junior Engineer) — both in Engineering?
3. Did the agent clearly recommend the correct David Zhang (c_001), not \
David Chang (c_007)?
4. Did the agent use department filtering to proactively narrow results?
5. Did the agent provide additional useful info like location?

Important: If the agent recommended the wrong contact (David Chang/c_007 \
instead of David Zhang/c_001), this should be heavily penalized.

Scoring:
- 0.9-1.0: Listed multiple results, clearly distinguished Zhang vs Chang, \
correct recommendation with reasoning
- 0.7-0.8: Correct recommendation but distinction explanation not thorough
- 0.4-0.6: Mentioned multiple results but disambiguation unclear
- 0.1-0.3: No effective disambiguation, or recommended wrong contact
- 0.0: No disambiguation analysis at all"""
