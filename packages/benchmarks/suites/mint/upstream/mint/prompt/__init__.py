import os
from mint.utils import load_file

PROMPT_DIR = os.path.join(os.path.dirname(__file__), "templates")
TEMPLATE_WITH_TOOL = load_file(os.path.join(PROMPT_DIR, "template_with_tool.txt"))
TEMPLATE_WITHOUT_TOOL = load_file(os.path.join(PROMPT_DIR, "template_without_tool.txt"))
TEMPLATE_FEEDBACK_AGENT = load_file(
    os.path.join(PROMPT_DIR, "template_feedback_agent.txt")
)


class PromptTemplate:
    """A prompt template."""

    def __init__(self, template: str):
        self.template: str = template

    def __call__(self, **kwargs) -> str:
        return self.template.format(**kwargs)


class ToolPromptTemplate(PromptTemplate):
    def __init__(self, use_tool: bool):
        if use_tool:
            template = TEMPLATE_WITH_TOOL
        else:
            template = TEMPLATE_WITHOUT_TOOL
        super().__init__(template)


class FeedbackPromptTemplate(PromptTemplate):
    def __init__(self):
        super().__init__(TEMPLATE_FEEDBACK_AGENT)
