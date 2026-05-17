"""M086_doc_figure_reproduction_line grader — line chart reproduction."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocFigureReproductionLineGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade Figure 6 reproduction: anti-cheating check + visual comparison.

    Scoring via visual judge comparing generated image against reference gt.png.
    Base score 1.0 with deductions for data/layout errors, missing baselines,
    and label/legend/axis issues.
    """

    SCRIPT_FILE = "/workspace/reproduce_fig6.py"
    PNG_FILE = "/workspace/figure6_reproduce.png"
    GT_FILE = "fixtures/gt.png"

    VISUAL_RUBRIC = """\
Compare the candidate reproduction against the reference figure (Figure 6
from the GroundingME paper — "Out-of-domain performance of fine-tuned
Qwen3-VL-8B-Instruct", a line chart with markers).

Base Score: 1.0

Deductions (subtract from 1.0, minimum score 0.0):

- [-0.34] Data Errors or Missing Layout:
  The chart is not a Line Chart with markers. The script fails to show the
  correct 5 SFT data ratios (1:8, 1:4, 1:2, 1:1, 2:1), or the values for
  the two lines ("GroundingME w/o Rej." and "Rejection Category") are
  incorrect/missing.

- [-0.33] Inaccurate Baselines or Annotations:
  The chart lacks the two horizontal dashed lines for the baselines (y=38.8
  and y=0). Deduct if the baselines are missing, not dashed, or if the
  individual data point numerical annotations (e.g., 32.8, 27.9) are absent.

- [-0.33] Incorrect Labels, Legend, or Axes:
  The legend is missing, misplaced, or incomplete (must cover the lines and
  baselines). The x-axis label ("SFT Data Ratio (Negative to Positive)")
  or the y-axis label ("ACC@0.5") is missing/incorrect. Colors drastically
  violate the visual distinction.

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
                context="Compare the candidate line chart reproduction against the reference figure.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
