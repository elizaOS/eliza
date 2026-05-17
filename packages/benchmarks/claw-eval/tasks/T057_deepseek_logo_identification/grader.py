"""Deterministic grader for T37_deepseek_logo_identification."""

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.image_qa_oracle import ImageQAOracleMixin


class DeepseekLogoIdentificationGrader(ImageQAOracleMixin, AbstractGrader):
    """Oracle-based image QA grader for T37_deepseek_logo_identification."""
