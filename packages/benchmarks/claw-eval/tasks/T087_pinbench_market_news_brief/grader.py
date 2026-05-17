from claw_eval.graders.pinbench_common import PinbenchAdaptedGrader


class PinbenchMarketNewsBriefGrader(PinbenchAdaptedGrader):
    REQUIRED_TOOLS = {"rss_list_articles": 1, "rss_get_article": 1}
    REQUIRED_KEYWORDS = ["market", "takeaway", "brief"]
    OPTIONAL_KEYWORDS = ["GPT-5", "Kubernetes", "RAG", "AI", "cloud"]
    REQUIRED_PATTERNS = [r"^#+\s+|^\d+\.\s|^[-*]\s"]
    MIN_FINAL_LENGTH = 400
