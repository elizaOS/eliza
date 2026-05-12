from claw_eval.graders.pinbench_common import PinbenchAdaptedGrader


class PinbenchConfigChangePlanGrader(PinbenchAdaptedGrader):
    REQUIRED_TOOLS = {"config_list_integrations": 1, "config_get_integration": 1}
    REQUIRED_KEYWORDS = ["plan", "production"]
    OPTIONAL_KEYWORDS = ["status", "risk", "monitoring", "rotation", "retry", "validation",
                         "rollback", "backup"]
    FORBIDDEN_TOOLS = ["config_update_integration", "config_notify"]
    REQUIRED_PATTERNS = [r"^\d+\.\s|^[-*]\s"]
    MIN_FINAL_LENGTH = 500
