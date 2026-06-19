"""M047_video_fitness_exercise_summary grader — fitness video exercise summary in markdown."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


# (exercise_name, target_muscles) — both must match to count as correct
GROUND_TRUTH: list[tuple[str, str]] = [
    ("坐姿髋外展", "臀大肌/臀中肌"),
    ("哈克深蹲", "臀大肌/股四头肌"),
    ("倒蹬", "臀大肌/股四头肌"),
    ("坐姿腿屈伸", "股四头肌"),
    ("俯身腿弯举", "腘绳肌"),
    ("蝴蝶机夹胸", "胸大肌"),
    ("上斜卧推", "胸大肌上部"),
    ("下斜卧推", "胸大肌外轮廓和中下部"),
    ("卧推", "胸大肌"),
    ("双杠臂屈伸", "胸大肌外轮廓和中下部"),
    ("高位下拉", "背阔肌/大小圆肌"),
    ("高位下拉(分动)", "背阔肌/大小圆肌"),
    ("器械下拉(分动)", "背阔肌/大小圆肌/斜方肌"),
    ("器械下拉(反手)", "背阔肌/大小圆肌/斜方肌"),
    ("坐姿器械划船", "背阔肌"),
    ("坐姿单臂划船", "背阔肌"),
    ("俯身划船", "背阔肌"),
    ("坐姿推肩", "三角肌前束"),
    ("屈时侧平举", "三角肌中束"),
    ("侧平举", "三角肌中束"),
    ("反向蝴蝶机飞鸟", "三角肌后束"),
    ("器械二头弯举", "肱二头肌"),
    ("三头下压", "肱三头肌"),
]

TOTAL = len(GROUND_TRUTH)

TEXT_RUBRIC = f"""\
The agent was asked to summarize all exercises in a fitness video and their target muscles, \
saving the result as a markdown document.

Ground-truth exercises ({TOTAL} total, exercise name + target muscles):
""" + "\n".join(
    f"- {name}：目标肌群：{muscles}" for name, muscles in GROUND_TRUTH
) + f"""

Scoring instructions:
- For each of the {TOTAL} exercises, award 1 point only if BOTH the exercise name AND target muscles \
are correctly identified (exact or clearly equivalent phrasing).
- Compute recall = correct_count / {TOTAL}.
- Return a score equal to recall (a float between 0.0 and 1.0).

Important:
- An exercise is correct only when name and muscles are both right.
- Minor formatting differences are acceptable (e.g. "/" vs "、" as separator), \
but the muscle group names must be substantively correct.
- Do NOT give partial credit for an exercise where only the name or only the muscles are correct.
NOTE: Ignore whether any actions were taken. Judge the answer text only."""


class WildFitness002Grader(AbstractGrader, MultimodalGraderMixin):
    """Grade fitness exercise summary markdown (1.0).

    - file_exists (0.1): markdown file saved at /workspace/summary.md
    - content_score (0.9): recall over 23 ground-truth (exercise, muscle) pairs, scaled by 0.9
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

        # 0.1 for file existence
        completion = 0.1 if file_exists else 0.0

        # 0.9 for content correctness (recall-based)
        if file_exists and judge:
            md_entry = (env_snapshot or {}).get(f"file:{self.OUTPUT_FILE}", {})
            md_text = (
                md_entry.get("content", "").strip()
                if md_entry.get("encoding") != "base64"
                else ""
            )
            if md_text:
                result = judge.evaluate(
                    task_prompt=task.prompt.text,
                    conversation=md_text,
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
