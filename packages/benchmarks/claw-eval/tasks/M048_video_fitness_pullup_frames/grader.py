"""M048_video_fitness_pullup_frames grader — identify students completing pull-ups and extract frames."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


STUDENT1_RUBRIC = """\
Evaluate this extracted video frame:

The frame should show a student completing a standard pull-up (chin above the bar).
The student's appearance:
- Short-sleeve T-shirt with a blue-cyan mixed color as the main tone
- A prominent white graphic or pattern at the center of the shirt
- Black long pants

Scoring:
- Score 1.0 if the frame clearly shows this student performing a pull-up with chin above or at bar level, \
and the described clothing features (blue-cyan shirt with white graphic, black long pants) are visible.
- Score 0.5 if the student is visible with matching clothing but the pull-up completion (chin above bar) \
is not clearly shown, or only some clothing features match.
- Score 0.0 if the student's clothing does not match the description, or no pull-up is shown."""

STUDENT2_RUBRIC = """\
Evaluate this extracted video frame:

The frame should show a student completing a standard pull-up (chin above the bar).
The student's appearance:
- Light grey short-sleeve sports T-shirt
- Black triangular color-block panels on the sides (underarm area)
- Light-colored (off-white or light grey) sports shorts
- Black-framed glasses
- White mid-calf sports socks

Scoring:
- Score 1.0 if the frame clearly shows this student performing a pull-up with chin above or at bar level, \
and the described clothing features (grey shirt with black triangle panels, light shorts, black glasses, \
white socks) are visible.
- Score 0.5 if the student is visible with some matching clothing features but the pull-up completion \
is not clearly shown, or only some clothing features match.
- Score 0.0 if the student's clothing does not match the description, or no pull-up is shown."""


class WildFitness003Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade pull-up frame extractions for two students (1.0 total).

    - both_files_exist (0.1): both /workspace/student1.png and /workspace/student2.png saved
    - student1_visual (0.45): visual judge confirms student1 frame
    - student2_visual (0.45): visual judge confirms student2 frame
    """

    STUDENT1_FILE = "/workspace/student1.png"
    STUDENT2_FILE = "/workspace/student2.png"

    def _score_image(
        self,
        env_snapshot: dict,
        file_key: str,
        rubric: str,
        context: str,
        judge: Any,
    ) -> float:
        entry = env_snapshot.get(f"file:{file_key}", {})
        png_b64 = (
            entry.get("content", "")
            if entry.get("encoding") == "base64"
            else ""
        )
        if not png_b64 or not judge or not hasattr(judge, "evaluate_visual"):
            return 0.0
        result = judge.evaluate_visual(
            rubric=rubric,
            reference_images_b64=[],
            candidate_images_b64=[png_b64],
            context=context,
        )
        return result.score if result else 0.0

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

        env = env_snapshot or {}
        s1_exists = self.check_file_exists(env, self.STUDENT1_FILE)
        s2_exists = self.check_file_exists(env, self.STUDENT2_FILE)

        # 0.1 for both files existing
        completion = 0.1 if (s1_exists and s2_exists) else 0.0

        # 0.45 each for correct visual content
        if s1_exists and judge:
            s1_score = self._score_image(
                env, self.STUDENT1_FILE, STUDENT1_RUBRIC,
                "Frame of student 1: blue-cyan shirt with white graphic, black long pants, doing pull-up.",
                judge,
            )
            completion += 0.45 * s1_score

        if s2_exists and judge:
            s2_score = self._score_image(
                env, self.STUDENT2_FILE, STUDENT2_RUBRIC,
                "Frame of student 2: light grey shirt with black triangle panels, light shorts, "
                "black glasses, white socks, doing pull-up.",
                judge,
            )
            completion += 0.45 * s2_score

        scores.completion = round(completion, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
