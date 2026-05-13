"""M031_video_room_floorplan grader — room tour floor plan reconstruction."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoRoomFloorplanGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade floor plan reconstruction: file(0.1) + objects(0.3) + spatial(0.6).

    Two visual judge calls:
      Call 1 — object coverage (9 objects with correct quantities)
      Call 2 — spatial relationship accuracy (10 direction pairs)
    """

    OUTPUT_FILE = "/workspace/floorplan.png"

    OBJECTS_RUBRIC = """\
Evaluate this floor plan for object coverage.

Ground-truth objects:
| Object | Expected Quantity |
|--------|-------------------|
| Dining Table | 1 |
| Kitchen Island | 1 |
| Counter Stools | 4 |
| Armchair | 2 |
| Cabinets | 1 |
| Sofa | 2 |
| Coffee Table | 2 |
| Window | 1 |
| TV | 1 |

For each object: score 1 if present, correctly labeled, AND quantity matches; 0 otherwise.
Synonym labels acceptable (Sofa=Couch, TV=Television, Cabinets=Cabinet).
Recall = sum of scores / 9.

Evaluate coverage only. Do NOT penalize for wrong position, size, or shape.
Extra objects not in ground truth should be ignored.

Score = Recall (0.0-1.0)."""

    SPATIAL_RUBRIC = """\
Evaluate this floor plan for spatial relationship accuracy.

Ground-truth spatial relationships (10 pairs):
Directions: above/below (vertical ±22.5°), left/right (horizontal ±22.5°), \
top-left/top-right/bottom-left/bottom-right (diagonal quadrants).

1. Dining Table relative to Sofa (bottom): top-left
2. Cabinets relative to Window: bottom-left
3. Window relative to Armchairs: top-right
4. Armchairs relative to TV: left
5. Armchairs relative to Sofa (top): bottom-left
6. Kitchen Island relative to Dining Table: below
7. Dining Table relative to Coffee Table: top-left
8. Dining Table relative to Window: top-left
9. Coffee Table relative to Sofa (bottom): above
10. Cabinets relative to Armchairs: left

For each pair: score 1 if direction matches (lenient for small deviations), 0 otherwise.
If either object is missing, score = 0 for that pair.

Score = correct_pairs / 10 (0.0-1.0)."""

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

        # Check file exists
        file_exists = self.check_file_exists(env_snapshot, self.OUTPUT_FILE)
        if not file_exists:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        # Extract image
        png_entry = (env_snapshot or {}).get(f"file:{self.OUTPUT_FILE}", {})
        png_b64 = (
            png_entry.get("content", "")
            if png_entry.get("encoding") == "base64"
            else ""
        )
        if not png_b64:
            scores.completion = 0.1  # file exists but can't read
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        objects_score = 0.0
        spatial_score = 0.0

        # Call 1: Object coverage
        if judge and hasattr(judge, "evaluate_visual"):
            result = judge.evaluate_visual(
                rubric=self.OBJECTS_RUBRIC,
                reference_images_b64=[],
                candidate_images_b64=[png_b64],
                context="Evaluate object coverage in a room floor plan diagram.",
            )
            objects_score = result.score if result else 0.0

        # Call 2: Spatial relationships
        if judge and hasattr(judge, "evaluate_visual"):
            result = judge.evaluate_visual(
                rubric=self.SPATIAL_RUBRIC,
                reference_images_b64=[],
                candidate_images_b64=[png_b64],
                context="Evaluate spatial relationship accuracy in a room floor plan diagram.",
            )
            spatial_score = result.score if result else 0.0

        scores.completion = round(0.1 + 0.3 * objects_score + 0.6 * spatial_score, 2)
        scores.completion = min(scores.completion, 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
