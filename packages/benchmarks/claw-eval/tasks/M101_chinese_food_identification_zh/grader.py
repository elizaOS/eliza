"""Deterministic grader for T29_chinese_food_identification."""

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.image_qa_oracle import ImageQAOracleMixin


class ChineseFoodIdentificationGrader(ImageQAOracleMixin, AbstractGrader):
    """Oracle-based image QA grader for T29_chinese_food_identification."""
