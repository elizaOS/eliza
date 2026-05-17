from typing import Any, Callable, Optional
from desktop_env.desktop_env import DesktopEnv

from .autogen.llm_config import LLMConfig
from .autogen.code_utils import PYTHON_VARIANTS
from .autogen.agentchat.contrib.multimodal_conversable_agent import MultimodalConversableAgent


CODER_SYSTEM_MESSAGE = """# Your role
- You are a programmer, you need to solve a task step-by-step given by the user. 
- You can write code in ```bash...``` code blocks for bash scripts, and ```python...``` code blocks for python code. 
- Your linux username is "user".
- If you want to use sudo, follow the format: "echo {CLIENT_PASSWORD} | sudo -S [YOUR COMMANDS]" (no quotes for the word "{CLIENT_PASSWORD}").

# Requirements
- You MUST verify the result before save the changes.
- When you write code, you must identify the language (whether it is python or bash) of the code.
- Wrap all your code in ONE code block. DO NOT let user save the code as a file and execute it for you.
- Do not include __main__ in your python code.
- When you modify a spreadsheet, **make sure every value is in the expected cell**.
- When importing a package, you need to check if the package has been installed. If not, you need to install it yourself.
- You need to print the progressive and final result.
- If you met execution error, you need to analyze the error message and try to fix the error.
"""

class TerminalProxyAgent(MultimodalConversableAgent):
    def __init__(
            self, 
        name: str, 
        env: DesktopEnv,
        llm_config: LLMConfig = False, 
        system_message: str = "",
        human_input_mode: str = "NEVER",
        code_execution_config = {},
        is_termination_msg: Optional[Callable[[dict[str, Any]], bool]] = None,
        max_consecutive_auto_reply: Optional[int] = None,
        default_auto_reply: Optional[str] = None,
        description: Optional[str] = None,
    ):
        super().__init__(
            name=name,
            system_message=system_message,
            is_termination_msg=is_termination_msg,
            max_consecutive_auto_reply=max_consecutive_auto_reply,
            human_input_mode=human_input_mode,
            code_execution_config=code_execution_config,
            llm_config=llm_config,
            default_auto_reply=default_auto_reply,
            description=description
        )
        self.env = env

    def run_code(self, code: str, lang: str = "python", **kwargs):
        exitcode = 1
        logs = ""
        image = None
        if lang in ["bash", "shell", "sh"]:
            output_dict = self.env.controller.run_bash_script(code)
            if output_dict["status"] == "success":
                exitcode = 0
                logs = output_dict["output"]
            else:
                exitcode = 0
                logs = output_dict["output"]
        elif lang in PYTHON_VARIANTS:
            output_dict = self.env.controller.run_python_script(code)
            if output_dict["status"] == "error":
                exitcode = 0
                logs = output_dict["output"]
            else:
                exitcode = 0
                logs = output_dict["message"]
        else:
            exitcode = -1
            logs = f"unknown language {lang}"
        return exitcode, logs, image
