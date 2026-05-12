from claw_eval.graders.pinbench_common import PinbenchAdaptedGrader


class PinbenchApmMarketResearchGrader(PinbenchAdaptedGrader):
    REQUIRED_TOOLS = {"kb_search": 1, "kb_get_article": 3}
    REQUIRED_KEYWORDS = ["executive summary", "Datadog", "Dynatrace"]
    OPTIONAL_KEYWORDS = [
        "New Relic",
        "Grafana",
        "Splunk",
        "OpenTelemetry",
        "pricing",
    ]
    FORBIDDEN_TOOLS = ["kb_update_article"]
    REQUIRED_PATTERNS = [r"\|.*\|.*\|", r"^#+\s+"]
    MIN_FINAL_LENGTH = 1500
