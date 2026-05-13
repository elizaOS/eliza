"""Deterministic grader for T39_phone_model_comparison."""

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.image_qa_oracle import ImageQAOracleMixin


class PhoneModelComparisonGrader(ImageQAOracleMixin, AbstractGrader):
    """Oracle-based image QA grader for T39_phone_model_comparison."""
