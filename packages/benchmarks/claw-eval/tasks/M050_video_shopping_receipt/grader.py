"""M050_video_shopping_receipt grader — shopping items and prices summary."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


# (item_name, price) — both must match to count as correct
GROUND_TRUTH: list[tuple[str, str]] = [
    ("蚝油", "39.9"),
    ("厨房纸巾", "49.9"),
    ("垃圾袋", "49.9"),
    ("麻辣牛肉", "79.8"),
    ("鱿鱼", "79.9"),
    ("眼肉牛排", "238.66"),
    ("薄切西冷", "243.09"),
    ("大蒜", "19.9"),
    ("玉米", "59.9"),
    ("番茄", "39.9"),
    ("鸡蛋", "56.8"),
    ("生菜", "15.9"),
    ("甜杆西兰花", "19.9"),
    ("辣椒", "15.9"),
    ("西兰花", "17.9"),
    ("鳕鱼片", "115.9"),
    ("脱骨鸭掌", "69.9")
]

TOTAL = len(GROUND_TRUTH)

TEXT_RUBRIC = f"""\
The agent was asked to summarize the items purchased and their prices from a shopping video, \
saving the result as a text file.

Ground-truth items ({TOTAL} total, item name + price):
""" + "\n".join(
    f"- {name}：{price}元" for name, price in GROUND_TRUTH
) + f"""

Scoring instructions:
- For each of the {TOTAL} items, award 1 point only if BOTH the item name AND price are correctly identified.
- Compute recall = correct_count / {TOTAL}.
- Return a score equal to recall (a float between 0.0 and 1.0).

Important:
- An item is correct only when name and price are both right.
- Minor name variations are acceptable if clearly referring to the same item \
(e.g. "薄切西冷牛排" for "薄切西冷").
- Prices must be numerically correct (e.g. "243" and "243.0" are equivalent, but "243" ≠ "243.09").
- Do NOT give partial credit for an item where only the name or only the price is correct.
NOTE: Ignore whether any actions were taken. Judge the answer text only."""


class WildShopping004Grader(AbstractGrader, MultimodalGraderMixin):
    """Grade shopping summary txt file (1.0).

    - file_exists (0.1): txt file saved at /workspace/summary.txt
    - content_score (0.9): recall over 9 ground-truth (item, price) pairs, scaled by 0.9
    """

    OUTPUT_FILE = "/workspace/summary.txt"

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

        file_exists = self.check_file_exists(env_snapshot, self.OUTPUT_FILE)

        # 0.1 for file existence
        completion = 0.1 if file_exists else 0.0

        # 0.9 for content correctness (recall-based)
        if file_exists and judge:
            entry = (env_snapshot or {}).get(f"file:{self.OUTPUT_FILE}", {})
            text = (
                entry.get("content", "").strip()
                if entry.get("encoding") != "base64"
                else ""
            )
            if text:
                result = judge.evaluate(
                    task_prompt=task.prompt.text,
                    conversation=text,
                    actions_summary="",
                    rubric=TEXT_RUBRIC,
                )
                recall = result.score if result else 0.0
                completion += 0.9 * recall

        scores.completion = round(completion, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
