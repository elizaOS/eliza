import logging
import re
from base64 import b64encode
from typing import Dict, List

from .prompt.accessibility_tree_handle import linearize_accessibility_tree, trim_accessibility_tree
from .prompt.grounding_agent import GroundingAgent as Agent
from .tools.package.google_chrome import BrowserTools
from .prompt.procedural_memory import Prompt

logger = logging.getLogger("desktopenv.agent")

pure_text_settings = ["a11y_tree"]


def parse_code_from_string(input_string):
    # input_string = "\n".join([line.strip() for line in input_string.split(';') if line.strip()])
    if input_string.strip() in ["WAIT", "DONE", "FAIL"]:
        return [input_string.strip()]

    # This regular expression will match both ```code``` and ```python code```
    # and capture the `code` part. It uses a non-greedy match for the content inside.
    pattern = r"```(?:\w+\s+)?(.*?)```"
    # Find all non-overlapping matches in the string
    matches = re.findall(pattern, input_string, re.DOTALL)

    # The regex above captures the content inside the triple backticks.
    # The `re.DOTALL` flag allows the dot `.` to match newline characters as well,
    # so the code inside backticks can span multiple lines.

    # matches now contains all the captured code snippets

    codes = []

    for match in matches:
        match = match.strip()
        commands = ["WAIT", "DONE", "FAIL"]  # fixme: updates this part when we have more commands

        if match in commands:
            codes.append(match.strip())
        elif match.split("\n")[-1] in commands:
            if len(match.split("\n")) > 1:
                codes.append("\n".join(match.split("\n")[:-1]))
            codes.append(match.split("\n")[-1])
        else:
            codes.append(match)

    return codes


class AutoGLMAgent:
    def __init__(
        self,
        action_space="autoglm_computer_use",
        observation_type="a11y_tree",
        max_trajectory_length=3,
        a11y_tree_max_items=300,
        with_image: bool = False,
        client_password="password",
        gen_func=None,
        tool_in_sys_msg: bool = True,
    ):
        self.action_space = action_space
        self.observation_type = observation_type
        assert action_space in ["autoglm_computer_use"], "Invalid action space"
        assert observation_type in ["a11y_tree"], "Invalid observation type"
        self.max_trajectory_length = max_trajectory_length
        self.a11y_tree_max_items = a11y_tree_max_items
        self.with_image = with_image
        self.client_password = client_password
        self.gen_func = gen_func
        self.tool_in_sys_msg = tool_in_sys_msg

        self.tool_list = {
            "libreoffice_calc": "CalcTools",
            "libreoffice_impress": "ImpressTools",
            "libreoffice_writer": "WriterTools",
            "code": "CodeTools",
            "vlc": "VLCTools",
            "google_chrome": "BrowserTools",
        }
        self.contents = []

    @property
    def turn_number(self):
        return len(self.contents)

    def prepare(self, instruction: str, obs: Dict, history: List, last_result: str = "") -> List:
        """
        Predict the next action(s) based on the current observation.
        """
        if "exe_result" in obs and not last_result:
            last_result = obs["exe_result"]
            if self.contents:
                self.contents[-1]["exe_result"] = last_result

        cur_app = obs["cur_app"]
        logger.info(f"current app is {cur_app}")

        if cur_app:
            tool_name = cur_app.strip().lower().replace("-", "_")
            tool_name = tool_name if tool_name in self.tool_list.keys() else None
        else:
            tool_name = None

        setup_prompt, func_def_prompt, note_prompt = Prompt.construct_procedural_memory(
            Agent, app_name=tool_name, client_password=self.client_password
        )
        if self.tool_in_sys_msg:
            system_message = setup_prompt + "\n\n" + func_def_prompt + "\n\n" + note_prompt
        else:
            system_message = setup_prompt + "\n\n" + note_prompt
        system_message += "\n\n**IMPORTANT** You are asked to complete the following task: {}".format(instruction)

        messages = [
            {
                "role": "system",
                "content": system_message,
            }
        ]
        messages.extend(history)

        if obs["apps"]:
            app_str = "Window ID    App Name    Title\n"
            for window_id, app in obs["apps"].items():
                app_str += f"{window_id}    {app['app_name']}    {app['title']}\n"
        else:
            app_str = "None"

        last_result = last_result.strip() if last_result else "None"
        last_result = last_result[:2000] + "..." if len(last_result) > 2000 else last_result

        tree = linearize_accessibility_tree(obs["accessibility_tree"], "Ubuntu")
        tree = trim_accessibility_tree(tree, 300)

        app_info = obs["app_info"].strip() if obs["app_info"] else "None"
        app_info = app_info[:5000] + "..." if len(app_info) > 5000 else app_info

        prompt = "* Apps: {}\n\n* Current App: {}\n\n* A11y Tree: {}\n\n* App Info: {}\n\n* Previous Action Result: {}".format(
            app_str.strip(),
            obs["cur_window_id"].strip() if obs["cur_window_id"] in app_str else "None",
            tree.strip(),
            app_info,
            last_result if last_result else "None",
        ) + (
            "\n\n" + func_def_prompt if not self.tool_in_sys_msg else ""
        )

        content = [{"type": "text", "text": prompt}]
        if self.with_image and obs.get('screenshot'):
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/png;base64,{b64encode(obs['screenshot']).decode('utf-8')}",
                        "detail": "high",
                    },
                }
            )

        messages.append({"role": "user", "content": content})

        return messages

    def execute(self, response, obs):
        try:
            actions = parse_code_from_string(response)
            action = actions[0]
            logger.info(f"The pesudo action is {action}")

            if "Agent." in action:
                actions = [
                    eval(action),
                ]
            elif "BrowserTools." in action:  # TODO: special check for BrowserTools
                actions = [
                    eval(action),
                ]
            else:
                actions = Agent.tool_commands(action, obs["cur_app"].strip().replace("-", "_").lower())
                logger.info(f"The grounded action is {actions[0]}")
        except Exception as e:
            print("Failed to parse action from response", e)
            actions = []

        return actions

    def format_history(self, max_turns=30):
        history = []
        for ix in range(self.turn_number):
            if ix == 0:
                env_input = "**Environment State (Omitted)**"
            else:
                env_input = (
                    f"**Environment State (Omitted)**\nPrevious Action Result: {self.contents[ix - 1]['exe_result']}"
                )

            env_input = env_input[:2000] + "..." if len(env_input) > 2000 else env_input
            response = (
                self.contents[ix]["response"][:1500] + "..."
                if len(self.contents[ix]["response"]) > 1500
                else self.contents[ix]["response"]
            )
            history.append({"role": "user", "content": [{"type": "text", "text": env_input}]})
            history.append({"role": "assistant", "content": [{"type": "text", "text": response}]})

        return history[-max_turns * 2:]

    def predict(self, instruction: str, obs: Dict) -> List:
        history = self.format_history()
        messages = self.prepare(instruction, obs, history)

        assert self.gen_func is not None, "gen_func is not set"
        try:
            response = self.gen_func(messages)
        except Exception as e:
            logger.error("Failed to call gen_func, Error: " + str(e))
            response = ""

        logger.info("RESPONSE: %s", response)

        actions = self.execute(response, obs)

        # update the contents
        self.contents.append(
            {
                "instruction": instruction,
                "index": len(self.contents),
                "response": response,
                "action": "Parse error" if not actions else actions[0],
                "exe_result": "Invalid action" if not actions else "",
                **obs,
            }
        )
        return response, actions

    def reset(self, _logger=None):
        global logger
        logger = _logger if _logger is not None else logging.getLogger("desktopenv.aguvis_agent")

        self.contents = []
