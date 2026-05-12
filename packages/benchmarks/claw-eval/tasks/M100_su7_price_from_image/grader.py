"""T26en_su7_price_from_image grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("M099_su7_price_from_image_zh")


class SU7PriceFromImageGraderEN(_Base):
    """English variant — reuses deterministic multimodal grading logic."""
