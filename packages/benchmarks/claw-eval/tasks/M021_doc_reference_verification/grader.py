"""M021_doc_reference_verification grader — arXiv reference verification."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocReferenceVerificationGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade arXiv reference verification task.

    Reads /workspace/updated_publications.csv from env_snapshot and
    scores via LLM judge against the ground-truth paper+venue list.
    """

    OUTPUT_FILE = "/workspace/updated_publications.csv"

    RUBRIC = """\
Ground Truth (15 arXiv papers now published at formal venues):
1. Molmo and pixmo: Open weights and open data for state-of-the-art multimodal models. → CVPR 2025
2. Mme: A comprehensive evaluation benchmark for multimodal large language models. → NeurIPS 2025
3. Video-mme: The first-ever comprehensive evaluation benchmark of multi-modal llms in video analysis. → CVPR 2025
4. Rewardbench: Evaluating reward models for language modeling. → Findings of NAACL 2025
5. MathVista: Evaluating Mathematical Reasoning of Foundation Models in Visual Contexts. → ICLR 2024
6. Scaling LLM Test-Time Compute Optimally Can be More Effective than Scaling Parameters for Reasoning. → ICLR 2025
7. Learning to summarize from human feedback. → NeurIPS 2020
8. Aligning large multimodal models with factually augmented rlhf. → Findings of ACL 2024
9. Large language models are not fair evaluators. → ACL 2024
10. Style over substance: Evaluation biases for large language models. → COLING 2025
11. Llava-critic: Learning to evaluate multimodal models. → CVPR 2025
12. RLAIF-V: Aligning MLLMs through Open-Source AI Feedback for Super GPT-4V Trustworthiness. → CVPR 2025
13. Mmmu-pro: A more robust multi-discipline multimodal understanding benchmark. → ACL 2025
14. MATHVERSE: Does Your Multi-modal LLM Truly See the Diagrams in Visual Math Problems?. → ECCV 2024
15. RMB: Comprehensively benchmarking reward models in LLM alignment. → ICLR 2025

Start with a base score of 1.0. Apply the following deductions (minimum score 0.0):
- -0.1 pts for each paper in the Ground Truth that is missing from the output,
  or has an incorrect formal venue.
- -0.1 pts for each extra paper included in the output that is NOT in the Ground
  Truth (e.g., papers still on arXiv or hallucinated papers).

Evaluate the CSV output against the ground truth using these criteria.
Output a score between 0.0 and 1.0."""

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

        if not self.check_file_exists(env_snapshot, self.OUTPUT_FILE):
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        content = (env_snapshot or {}).get(
            f"file:{self.OUTPUT_FILE}", {}
        ).get("content", "")

        if judge and content.strip():
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Contents of {self.OUTPUT_FILE}:\n{content}",
                actions_summary="",
                rubric=self.RUBRIC,
            )
            scores.completion = result.score if result else 0.0

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
