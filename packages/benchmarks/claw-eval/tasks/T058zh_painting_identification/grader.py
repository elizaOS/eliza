"""Deterministic grader for T38_painting_identification."""

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.image_qa_oracle import ImageQAOracleMixin


class PaintingIdentificationGrader(ImageQAOracleMixin, AbstractGrader):
    """Oracle-based image QA grader for T38_painting_identification."""
