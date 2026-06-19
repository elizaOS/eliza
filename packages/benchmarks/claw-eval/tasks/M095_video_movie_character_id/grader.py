"""Grader for M095_video_movie_character_id: Movie Character Identification and Portrait Extraction.

4 ground-truth characters (by appearance order):
  1. 夏洛 (Xialuo)    — GT image: fixtures/xialuo.png
  2. 马冬梅 (Ma Dongmei) — GT image: fixtures/madongmei.png
  3. 秋雅 (Qiuya)      — GT image: fixtures/qiuya.png
  4. 袁华 (Yuanhua)    — GT image: fixtures/yuanhua.png

Scoring: total = 1.0, split equally across 4 characters (0.25 each).
  Per character:
    - 0.125 for correct name (Chinese / English / pinyin match)
    - 0.125 for correct portrait (visual comparison against GT image)
"""

from __future__ import annotations

import json
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


CHARACTERS_FILE = "/workspace/characters.json"

# Ground-truth characters in appearance order
GT_CHARACTERS = [
    {
        "name_zh": "夏洛",
        "name_en": "xialuo",
        "alt_names": ["夏洛", "xialuo", "xia luo", "charlotte"],
        "gt_image": "/workspace/fixtures/xialuo.png",
        "description": "male student in school uniform",
    },
    {
        "name_zh": "马冬梅",
        "name_en": "madongmei",
        "alt_names": ["马冬梅", "madongmei", "ma dongmei", "ma dong mei"],
        "gt_image": "/workspace/fixtures/madongmei.png",
        "description": "female student, school uniform with green-black striped inner shirt",
    },
    {
        "name_zh": "秋雅",
        "name_en": "qiuya",
        "alt_names": ["秋雅", "qiuya", "qiu ya"],
        "gt_image": "/workspace/fixtures/qiuya.png",
        "description": "female student, school uniform with black polka-dot white inner shirt",
    },
    {
        "name_zh": "袁华",
        "name_en": "yuanhua",
        "alt_names": ["袁华", "yuanhua", "yuan hua"],
        "gt_image": "/workspace/fixtures/yuanhua.png",
        "description": "male, yellow plaid T-shirt",
    },
]

NAME_RUBRIC = """\
The agent was asked to identify named characters from a movie clip of "夏洛特烦恼".

Below is the characters.json the agent produced. For each ground-truth character listed \
below, determine whether the agent correctly identified that character by name.

Ground-truth characters (in appearance order):
1. 夏洛 (Xialuo)
2. 马冬梅 (Ma Dongmei)
3. 秋雅 (Qiuya)
4. 袁华 (Yuanhua)

For EACH of the 4 ground-truth characters, answer YES or NO: did the agent's output \
contain an entry whose name matches this character? Accept Chinese characters, pinyin, \
or English transliterations (case-insensitive).

Return your score as: (number of correctly identified characters) / 4.
For example, if 3 out of 4 are found, score = 0.75. If all 4, score = 1.0."""

PORTRAIT_RUBRIC = """\
You are comparing two face images from the movie "夏洛特烦恼".

The REFERENCE image (first) shows the ground-truth appearance of a specific character.
The CANDIDATE image (second) is the agent's extracted portrait.

Determine whether the candidate image shows the SAME PERSON as the reference image.

Scoring:
- Score 1.0 if the candidate clearly shows the same person as the reference
- Score 0.5 if likely the same person but image quality is poor or angle is very different
- Score 0.0 if a different person, no face visible, or image is empty/corrupt"""


class Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Character identification and portrait extraction grader.

    Total score = sum over 4 characters of:
        0.125 * name_match + 0.125 * portrait_match
    """

    def grade(
        self,
        messages: list[TraceMessage],
        dispatches: list[ToolDispatch],
        task: TaskDefinition,
        audit_data: dict[str, dict] | None = None,
        judge: Any | None = None,
        media_events: list[MediaLoad] | None = None,
        env_snapshot: dict | None = None,
    ) -> DimensionScores:
        scores = DimensionScores()
        scores.safety = 1.0
        snapshot = env_snapshot or {}
        total = 0.0

        # ------------------------------------------------------------------
        # 1. Name evaluation (0.125 × 4 = 0.5 total) via LLM judge
        # ------------------------------------------------------------------
        name_score = 0.0
        json_entry = snapshot.get(f"file:{CHARACTERS_FILE}", {})
        json_content = (
            json_entry.get("content", "").strip()
            if json_entry.get("encoding") != "base64"
            else ""
        )

        if json_content and judge:
            try:
                chars_data = json.loads(json_content)
                if not isinstance(chars_data, list):
                    json_content = f"[Invalid: not a list] {json_content}"
            except json.JSONDecodeError:
                json_content = f"[Invalid JSON] {json_content}"

            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Agent's characters.json:\n{json_content}",
                actions_summary="",
                rubric=NAME_RUBRIC,
            )
            name_score = result.score if result else 0.0

        total += 0.5 * name_score  # 0.125 per character × 4

        # ------------------------------------------------------------------
        # 2. Portrait evaluation (0.125 × 4 = 0.5 total) via visual judge
        #    Compare each agent portrait against GT reference image
        # ------------------------------------------------------------------
        # Collect agent portrait images (char_1.png .. char_4.png + any extras)
        agent_portraits: list[tuple[str, str]] = []
        for i in range(1, 8):  # check up to 7 in case agent creates more
            path = f"/workspace/char_{i}.png"
            entry = snapshot.get(f"file:{path}", {})
            b64 = (
                entry.get("content", "")
                if entry.get("encoding") == "base64"
                else ""
            )
            if b64:
                agent_portraits.append((path, b64))

        portrait_score_total = 0.0
        if agent_portraits and judge and hasattr(judge, "evaluate_visual"):
            for gt_char in GT_CHARACTERS:
                gt_entry = snapshot.get(f"file:{gt_char['gt_image']}", {})
                gt_b64 = (
                    gt_entry.get("content", "")
                    if gt_entry.get("encoding") == "base64"
                    else ""
                )
                if not gt_b64:
                    continue

                # Find the best matching agent portrait for this GT character
                best_score = 0.0
                for _path, agent_b64 in agent_portraits:
                    result = judge.evaluate_visual(
                        rubric=PORTRAIT_RUBRIC,
                        reference_images_b64=[gt_b64],
                        candidate_images_b64=[agent_b64],
                        context=(
                            f"Comparing agent portrait against GT for "
                            f"{gt_char['name_zh']} ({gt_char['name_en']})"
                        ),
                    )
                    s = result.score if result else 0.0
                    if s > best_score:
                        best_score = s

                portrait_score_total += 0.125 * best_score

        total += portrait_score_total

        # ------------------------------------------------------------------
        # Final
        # ------------------------------------------------------------------
        scores.completion = round(min(total, 1.0), 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
