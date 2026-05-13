"""M049_video_phone_comparison grader — phone comparison markdown table."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


GROUND_TRUTH = [
    {
        "型号": "IQ Z10 turbo",
        "屏幕大小": "6.78英寸",
        "处理器": "天玑8400满血版",
        "相机": "前置1600万像素，后置主摄5000万像素",
        "电池续航": "7620mAh，支持90W有线快充",
        "价格": "1275",
    },
    {
        "型号": "红米 Turbo 4",
        "屏幕大小": "6.67英寸",
        "处理器": "天玑8400-Ultra",
        "相机": "前置2000万像素，后置主摄5000万像素+800万广角",
        "电池续航": "6550mAh，支持90W快充",
        "价格": "1299",
    },
    {
        "型号": "OPPO K13 Turbo",
        "屏幕大小": "6.8英寸",
        "处理器": "天玑8450",
        "相机": "前置1600万像素，后置5000万主摄+200万超广角",
        "电池续航": "7000mAh，支持80W快充",
        "价格": "1299",
    },
    {
        "型号": "红米 K80",
        "屏幕大小": "6.67英寸",
        "处理器": "第三代骁龙8",
        "相机": "前置2000万像素，后置主摄5000万像素+800万广角",
        "电池续航": "6550mAh，支持90W快充",
        "价格": "1592",
    },
    {
        "型号": "一加Ace 5",
        "屏幕大小": "6.78英寸",
        "处理器": "骁龙8 Gen3",
        "相机": "前置1600万像素，后置主摄5000万像素+800万超广角",
        "电池续航": "6415mAh，支持80W有线快充",
        "价格": "1699",
    },
    {
        "型号": "荣耀400",
        "屏幕大小": "6.55英寸",
        "处理器": "第四代骁龙7",
        "相机": "前置5000万像素，后置2亿AI超清主摄+1200万超广",
        "电池续航": "7200mAh，支持80W快充",
        "价格": "1781",
    },
]

TOTAL = len(GROUND_TRUTH)

FORMAT_RUBRIC = """\
Check whether the markdown document contains a properly formatted table where:
- Rows represent phone models
- Columns represent spec dimensions (screen size, processor, camera, battery, price, etc.)
- The table uses valid markdown table syntax (header row + separator row + data rows)

Score 1.0 if a correctly structured markdown table is present.
Score 0.5 if a table is present but the format is partially correct (e.g. missing separator row, \
inconsistent columns).
Score 0.0 if no table is present."""

CONTENT_RUBRIC = f"""\
The agent was asked to summarize specs of phones from a comparison video into a markdown table.

Ground-truth phones ({TOTAL} total). For each phone, ALL dimensions must be correct to count:
""" + "\n".join(
    f"- 型号：{p['型号']}｜屏幕：{p['屏幕大小']}｜处理器：{p['处理器']}｜"
    f"相机：{p['相机']}｜电池续航：{p['电池续航']}｜价格：¥{p['价格']}"
    for p in GROUND_TRUTH
) + f"""

Scoring instructions:
- For each of the {TOTAL} phones, award 1 point only if the model name AND all spec dimensions \
(screen size, processor, camera, battery, price) are correctly stated.
- Compute recall = correct_count / {TOTAL}.
- Return a score equal to recall (a float between 0.0 and 1.0).

Important:
- Minor phrasing variations are acceptable if the information is substantively correct \
(e.g. "90W快充" vs "支持90W（有线）快充").
- Numeric values must be correct (prices, screen sizes, battery capacity, megapixels).
- A phone is only correct when the model name and ALL dimensions are right; \
no partial credit per phone.
NOTE: Ignore whether any actions were taken. Judge the answer text only."""


class WildPhoneCompare005Grader(AbstractGrader, MultimodalGraderMixin):
    """Grade phone comparison markdown table (1.0).

    - file_exists (0.1): markdown saved at /workspace/summary.md
    - format_score (0.2): table structure correct (rows=phones, cols=dimensions)
    - content_score (0.7): recall over 6 ground-truth phones × all dimensions, scaled by 0.7
    """

    OUTPUT_FILE = "/workspace/summary.md"

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
        completion = 0.1 if file_exists else 0.0

        if file_exists:
            entry = (env_snapshot or {}).get(f"file:{self.OUTPUT_FILE}", {})
            md_text = (
                entry.get("content", "").strip()
                if entry.get("encoding") != "base64"
                else ""
            )

            if md_text and judge:
                # Format score (0.2)
                fmt_result = judge.evaluate(
                    task_prompt=task.prompt.text,
                    conversation=md_text,
                    actions_summary="",
                    rubric=FORMAT_RUBRIC,
                )
                fmt_score = fmt_result.score if fmt_result else 0.0
                completion += 0.2 * fmt_score

                # Content score (0.7)
                content_result = judge.evaluate(
                    task_prompt=task.prompt.text,
                    conversation=md_text,
                    actions_summary="",
                    rubric=CONTENT_RUBRIC,
                )
                recall = content_result.score if content_result else 0.0
                completion += 0.7 * recall

        scores.completion = round(completion, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
