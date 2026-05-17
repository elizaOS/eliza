"""M085_doc_figure_reproduction_bar grader — grouped bar chart reproduction."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocFigureReproductionBarGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade Figure 5 reproduction: anti-cheating check + visual comparison.

    Scoring via visual judge comparing generated image against reference gt.png.
    Base score 1.0 with deductions for data/layout errors, missing annotations,
    and text/color/axis issues.
    """

    SCRIPT_FILE = "/workspace/reproduce_fig5.py"
    PNG_FILE = "/workspace/figure5_reproduce.png"
    GT_FILE = "fixtures/gt.png"

    VISUAL_RUBRIC = """\
Compare the candidate reproduction against the reference figure (Figure 5
from the GroundingME paper — "Performance gain of different models by enabling
thinking mode", a grouped bar chart).

Base Score: 1.0

Deductions (subtract from 1.0, minimum score 0.0):

- [-0.34] Data Errors or Missing Layout:
  The chart is not a Grouped Bar Chart (e.g., stacked bars instead of
  side-by-side). The script fails to show the correct 7 models, or the
  "No Think" and "Think" numerical values are incorrect/missing.

- [-0.33] Inaccurate or Missing Annotations:
  The red absolute gain annotations (e.g., "+7.4", "+3.3") with the '+'
  sign are missing, not colored red, or not positioned above the bar groups.
  Also deduct if the individual bar values (e.g., 39.5, 46.9) are missing.

- [-0.33] Incorrect Text Position, Orientation, Colors, or Axis Labels:
  The x-axis model names overlap and are unreadable (failing to rotate them).
  The annotations overlap with each other or the bars. The legend for
  "No Think" and "Think" is missing. The colors drastically violate the
  visual distinction. The x-axis label ("Model") or y-axis label
  ("Overall ACC@0.5") are missing or incorrect.

Score 0.0-1.0 based on these deduction criteria."""

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

        script_exists = self.check_file_exists(env_snapshot, self.SCRIPT_FILE)
        png_exists = self.check_file_exists(env_snapshot, self.PNG_FILE)
        if not script_exists or not png_exists:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        # Anti-cheating: verify script uses plotting libraries
        script_content = (env_snapshot or {}).get(
            f"file:{self.SCRIPT_FILE}", {}
        ).get("content", "")
        if script_content:
            lower = script_content.lower()
            uses_plotting = (
                "matplotlib" in lower
                or "plotly" in lower
                or "seaborn" in lower
            )
            uses_extraction = (
                ("fitz" in lower and "get_pixmap" in lower)
                or "pdf2image" in lower
                or ("extract_image" in lower and "pypdf" in lower)
            )
            if not uses_plotting or uses_extraction:
                scores.completion = 0.0
                scores.robustness = self.compute_robustness(dispatches)
                return scores

        # Visual comparison against reference
        png_entry = (env_snapshot or {}).get(f"file:{self.PNG_FILE}", {})
        png_b64 = (
            png_entry.get("content", "")
            if png_entry.get("encoding") == "base64"
            else ""
        )

        gt_entry = (env_snapshot or {}).get(f"local_file:{self.GT_FILE}", {})
        gt_b64 = (
            gt_entry.get("content", "")
            if gt_entry.get("encoding") == "base64"
            else ""
        )

        visual_score = 0.0
        if judge and png_b64 and hasattr(judge, "evaluate_visual"):
            ref_images = [gt_b64] if gt_b64 else []
            vis_result = judge.evaluate_visual(
                rubric=self.VISUAL_RUBRIC,
                reference_images_b64=ref_images,
                candidate_images_b64=[png_b64],
                context="Compare the candidate grouped bar chart reproduction against the reference figure.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
