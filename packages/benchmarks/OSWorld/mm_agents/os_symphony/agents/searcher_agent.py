import logging
import urllib.parse
from typing import Any, Dict, List, Optional
from mm_agents.os_symphony.memory.procedural_memory import PROCEDURAL_MEMORY
from mm_agents.os_symphony.utils.common_utils import (
    draw_coordinates, 
    call_llm_formatted,    
    parse_code_from_string,
    create_pyautogui_code
)
from mm_agents.os_symphony.core.mllm import LMMAgent
from mm_agents.os_symphony.agents.grounder_agent import GrounderAgent
import os
import time
import json


logger = logging.getLogger("desktopenv.searcher_agent")

# Agent action decorator
def searcher_agent_action(func):
    func.is_searcher_agent_action = True
    return func


# --- Abstract Base Class and Factory ---
class SearcherAgent:
    def __init__(self, engine_params: Dict, platform: str):
        self.engine_params = engine_params
        self.result_dir = ""
        self.tutorial_or_hint = ""
        self.tutorial_notes = []
        self.max_trajectory_length = 8 
        self.platform = platform
        self.budget = engine_params.get("budget", 20)

    @staticmethod
    def create(engine_params: Dict, search_env, grounder_agent: GrounderAgent, platform: str, client_password: str="password"):
        searcher_type = engine_params.get("type", "vlm")
        if searcher_type == "vlm":
            return VLMSearcherAgent(engine_params=engine_params, search_env=search_env, grounder_agent=grounder_agent, platform=platform, client_password=client_password)
        else:
            raise NotImplementedError
        
    def _get_search_time(self) -> int:
        """for the name of result directory"""
        if not self.result_dir: return 1
        search_times: list[int] = []
        try:
            if not os.path.exists(self.result_dir): return 1
            for item_name in os.listdir(self.result_dir):
                full_path = os.path.join(self.result_dir, item_name)
                if os.path.isdir(full_path) and item_name.startswith("search_"):
                    try:
                        time_val = int(item_name.split('_', 1)[1])
                        search_times.append(time_val)
                    except (ValueError, IndexError):
                        continue
        except Exception:
            return 1
        if not search_times: return 1
        return max(search_times) + 1
    
    def search(self, query: str, obs) -> str:
        """
        Args:
            query: Format like "How to xxxx?", must be a detailed subtask
            obs: Current screenshot
        """
        raise NotImplementedError("Subclasses must implement the 'search' method")
    
class VLMSearcherAgent(SearcherAgent):
    """
    Start a new, isolated vm, and open chrome in advance
    """
    def __init__(self, engine_params: Dict, search_env, grounder_agent: GrounderAgent, platform: str, client_password: str):
        SearcherAgent.__init__(self, engine_params=engine_params, platform=platform)

        self.grounder_agent = grounder_agent
        self.client_password = client_password
        self.env = search_env

        self.use_thinking = engine_params.get("model", "") in [
            "claude-opus-4-20250514",
            "claude-sonnet-4-20250514",
            "claude-3-7-sonnet-20250219",
            "claude-sonnet-4-5-20250929",
        ]

        self.engine = engine_params.get("engine", "google")

        # Reuse OSWorld's initialization script to set up Chrome, then directly perform a Google search using the query—currently, the query can be substituted by a placeholder field.
        self.task_config = {
            "id": "searcher",
            "instruction": "searcher",
            "config": [
                {
                    "type": "launch",
                    "parameters": {
                        "command": [
                            "google-chrome",
                            "--remote-debugging-port=1337"
                        ]
                    }
                },
                {
                    "type": "launch",
                    "parameters": {
                        "command": [
                            "socat",
                            "tcp-listen:9222,fork",
                            "tcp:localhost:1337"
                        ]
                    }
                },
                {
                    "type": "chrome_open_tabs",
                    "parameters": {
                        "urls_to_open": [
                            "GOOGLE_SEARCH_URL"    
                        ]
                    }
                },
                {
                    "type": "activate_window",
                    "parameters": {
                        "window_name": "Google Chrome"
                    }
                }
            ],
            "proxy": True
        }
        self.obs = None

    def reset(self, query):
        # When the search function is invoked, a new agent is created; the environment is instantiated only upon the first call, but it must be reset on every invocation.
        self.tutorial_notes = []
        self.tutorial_or_hint = ""
        self.system_prompt = PROCEDURAL_MEMORY.construct_vlm_searcher_procedural_memory(
            agent_class=type(self)
        ).replace("CURRENT_OS", self.platform).replace("QUERY", query)
        self.searcher_agent = LMMAgent(
            engine_params=self.engine_params,
            system_prompt=self.system_prompt
        )
        self.env.start()
        # config URL and initialize search environment (google/duckduckgo)
        search_url = f"https://www.google.com/search?q=" + urllib.parse.quote_plus(query) if self.engine == "google" else f"https://www.duckduckgo.com/?q=" + urllib.parse.quote_plus(query)
        self.task_config["config"][2]["parameters"]["urls_to_open"][0] = search_url
        
        self.env.reset(task_config=self.task_config)
        print("[Searcher] sleeping...")
        time.sleep(5)

    def flush_messages(self):
        """Flush messages based on the model's context limits.

        This method ensures that the agent's message history does not exceed the maximum trajectory length.

        Side Effects:
            - Modifies the messages of generator, reflection, and bon_judge agents to fit within the context limits.
        """
        engine_type = self.engine_params.get("engine_type", "")

        # Flush strategy for long-context models: keep all text, only keep latest images
        if engine_type in ["anthropic", "openai", "gemini"]:
            max_images = self.max_trajectory_length
            for agent in [self.searcher_agent]:
                if agent is None:
                    continue
                # keep latest k images
                # @Yang: keep the first main agent image
                img_count = 0
                for i in range(len(agent.messages) - 1, 1, -1):
                    for j in range(len(agent.messages[i]["content"]) - 1, -1, -1):
                        if "image" in agent.messages[i]["content"][j].get("type", ""):
                            img_count += 1
                            if img_count > max_images:
                                del agent.messages[i]["content"][j]

        # Flush strategy for non-long-context models: drop full turns
        else:
            # generator msgs are alternating [user, assistant], so 2 per round
            if len(self.searcher_agent.messages) > 2 * self.max_trajectory_length + 1:
                self.searcher_agent.messages.pop(1)
                self.searcher_agent.messages.pop(1)

    def assign_screenshot(self, obs):
        self.obs = obs
        
    def search(self, query: str, main_obs):
        # only create vm when search is called 
        self.reset(query=query) # reset
        search_result_dir = os.path.join(self.result_dir, f"search_{self._get_search_time()}")
        os.makedirs(search_result_dir, exist_ok=True)

        obs = self.env._get_obs() # Get the initial observation
        step_idx = 0
        initial_state_text = (
            "This screenshot shows the current visual context of the main GUI Agent you are assisting. "
            "Use this image to understand the application, the current view, and the overall environment. "
            "Your primary goal is to find a tutorial that is highly relevant and well-aligned with this specific context, "
            "ensuring the instructions you find are applicable to what the main agent is currently seeing."
        )
        self.searcher_agent.add_message(
            text_content=initial_state_text, 
            image_content=main_obs["screenshot"], 
            role="user"
        )
        execution_history = []
        completion_reason = ""
        final_answer = ""

        while step_idx < self.budget:
            # update system_prompt dynamically
            tutorial_notes_str = ""
            if len(self.tutorial_notes) > 0:
                for i, note in enumerate(self.tutorial_notes, 1):
                    tutorial_notes_str += f"Tutorial Note {i}: {note}\n\n"

            if step_idx == self.budget - 1:
                # eager mode
                self.system_prompt = PROCEDURAL_MEMORY.construct_searcher_eager_mode_procedural_memory(
                    agent_class=type(self)
                ).replace("CURRENT_OS", self.platform).replace("QUERY", query)
            
            system_prompt = self.system_prompt.replace("TUTORIAL_PLACEHOLDER", tutorial_notes_str)
            self.searcher_agent.add_system_prompt(system_prompt=system_prompt)

            # start a new turn
            self.assign_screenshot(obs=obs)
            generator_message = ""

            self.searcher_agent.add_message(
                generator_message, image_content=obs["screenshot"], role="user"
            )
            format_checkers = []

            # predict action
            plan = call_llm_formatted(
                self.searcher_agent,
                format_checkers,
                temperature=self.engine_params.get("temperture", 0.1),
                use_thinking=self.use_thinking,
            )

            self.searcher_agent.add_message(plan, role="assistant")
            execution_history.append(plan)
            logger.info("SEARCHER PLAN:\n %s", plan)

            plan_code = parse_code_from_string(plan)
            try:
                assert plan_code, "Plan code should not be empty"
                # exec_code e.g. import pyautogui; pyautogui.click(1, 2);
                exec_code, coords = create_pyautogui_code(self, plan_code, obs)
            except Exception as e:
                logger.error(
                    f"Could not evaluate the following plan code:\n{plan_code}\nError: {e}"
                )
                exec_code = self.wait(
                    1.333
                )  # Skip a turn if the code cannot be evaluated

            self.flush_messages()

            # execute action
            action = exec_code
            logger.info("Step %d: %s", step_idx + 1, action)

            # Save screenshot and trajectory information
            with open(os.path.join(search_result_dir, f"step_{step_idx + 1}.png"),
                    "wb") as _f:
                _f.write(obs['screenshot'])

            if coords is not None and isinstance(coords, list):
                draw_coordinates(
                    image_bytes=obs['screenshot'], 
                    coordinates=coords, 
                    save_path=os.path.join(search_result_dir, f"step_{step_idx + 1}_draw.png")
                )
                            
            with open(os.path.join(search_result_dir, "traj.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "query": query,
                    "step_num": step_idx + 1,
                    "action": action,
                    "response": {
                        "plan": plan,
                        "plan_code": plan_code,
                        "coordinates": coords
                    },
                    "screenshot_file": f"step_{step_idx + 1}.png"
                }, ensure_ascii=False))
                f.write("\n")
                
            with open(os.path.join(search_result_dir, f"traj_{step_idx+1}.json"), "w", encoding="utf-8") as f:
                json.dump({
                    "query": query,
                    "step_num": step_idx + 1,
                    "action": action,
                    "response": {
                        "plan": plan,
                        "plan_code": plan_code,
                        "coordinates": coords
                    },
                    "screenshot_file": f"step_{step_idx + 1}.png"
                }, f, indent=4, ensure_ascii=False)

            if exec_code in ["DONE", "FAIL"]:
                # terminate loop
                completion_reason = exec_code
                final_answer = self.tutorial_or_hint
                break
            else:
                obs, _, _, _ = self.env.step(action, 5)

            step_idx += 1

        if completion_reason == "":
            completion_reason = "BUDGET_EXHAUSTED"
            final_answer = "Sorry, can't get the useful tutorial about the GUI task you provided."

        return {
            "query": query,
            "completion_reason": completion_reason,
            "tutorial_notes": self.tutorial_notes,
            "execution_history": execution_history,
            "steps_executed": step_idx,
            "budget": self.budget,
            "final_answer": final_answer,
        }
    
    @searcher_agent_action
    def click(
        self,
        element_description: str,
        num_clicks: int = 1,
        button_type: str = "left",
    ):
        """Click on the element
        Args:
            element_description:str, a detailed descriptions of which element to click on. This description should be at least a full sentence.
            num_clicks:int, number of times to click the element
            button_type:str, which mouse button to press can be "left", "middle", or "right"
        """
        x, y = self.grounder_agent.generate_coords(element_description, self.obs)
        command = "import pyautogui; "
        command += f"""import pyautogui; pyautogui.click({x}, {y}, clicks={num_clicks}, button={repr(button_type)}); """

        # Return pyautoguicode to click on the element
        return (command, [x, y])
    
    @searcher_agent_action
    def type(
        self,
        element_description: Optional[str] = None,
        text: str = "",
        overwrite: bool = True,
        enter: bool = False
    ):
        """Type text/unicode into a specific element
        Args:
            element_description:str, a detailed description of which element to enter text in. This description should be at least a full sentence.
            text:str, the text to type
            overwrite:bool, Default is True, assign it to False if the text should not overwrite the existing text. Using this argument clears all text in an element.
            enter:bool, Assign it to True if the enter key should be pressed after typing the text, otherwise assign it to False.
        """
        commands = (
            "import os;"
            "import pyautogui;"
            "import pyperclip;"
            "import subprocess;"
            "import time;"
            "p_http = os.environ.get('http_proxy') or os.environ.get('HTTP_PROXY');"
            "p_https = os.environ.get('https_proxy') or os.environ.get('HTTPS_PROXY');"
            "proxy_prefix = (f'http_proxy={p_http} ' if p_http else '') + (f'https_proxy={p_https} ' if p_https else '');"
            f"subprocess.run(f'echo \"{self.client_password}\" | sudo -S {{proxy_prefix}}apt-get install -y xclip xsel', shell=True, check=True);"
        )


        
        click_coords = None
        if element_description is not None:
            x, y = self.grounder_agent.generate_coords(element_description, self.obs)
            click_coords = [x, y]

            commands += f"pyautogui.click({x}, {y});"

        if overwrite:
            commands += (
                f"pyautogui.hotkey('ctrl', 'a');"
                "pyautogui.press('backspace');"
            )

        # use paste to input
        commands += (
            "original_clipboard = pyperclip.paste();"
            f"pyperclip.copy({repr(text)});"
            "pyautogui.hotkey('ctrl', 'v');"
            "pyperclip.copy(original_clipboard);"
        )
        
        if enter:
            commands += "pyautogui.press('enter');"

        if click_coords is not None:
            return (commands, click_coords)
        else:
            return commands

    @searcher_agent_action
    def scroll(self, element_description: str, clicks: int, shift: bool = False):
        """Scroll the element in the specified direction
        Args:
            element_description:str, a very detailed description of which element to enter scroll in. This description should be at least a full sentence.
            clicks:int, the number of clicks to scroll can be positive (up) or negative (down).
            shift:bool, whether to use shift+scroll for horizontal scrolling
        """
        x, y = self.grounder_agent.generate_coords(element_description, self.obs)

        if shift:
            return (f"import pyautogui; import time; pyautogui.moveTo({x}, {y}); time.sleep(0.5); pyautogui.hscroll({clicks})", [x, y])
        else:
            return (f"import pyautogui; import time; pyautogui.moveTo({x}, {y}); time.sleep(0.5); pyautogui.vscroll({clicks})", [x, y])

    @searcher_agent_action
    def hotkey(self, keys: List):
        """Press a hotkey combination (can press a single key as well)
        Args:
            keys: List the keys to press in combination in a list format (e.g. ['ctrl', 'c'], ['enter'])
        """
        # add quotes around the keys
        keys = [f"'{key}'" for key in keys]
        return f"import pyautogui; pyautogui.hotkey({', '.join(keys)})"

    @searcher_agent_action
    def save_to_tutorial_notes(self, text: str):
        """Save high quality and useful information to a long-term knowledge bank for reuse during this search task.
        Args:
            text:str, the text to save to the tutorial notes
        """
        self.tutorial_notes.append(text)
        return """WAIT"""
    
    @searcher_agent_action
    def wait(self, time: float):
        """Wait for a specified amount of time
        Args:
            time:float the amount of time to wait in seconds
        """
        return f"""import time; time.sleep({time})"""

    @searcher_agent_action
    def done(
        self,
        tutorial: str
    ):
        """End the current task with a success. Use this when you believe the entire task has been fully completed.
        Args:
            tutorial:str, A detailed, step-by-step tutorial compiled from the search results to be passed to the main agent.
        """
        self.tutorial_or_hint = tutorial
        return """DONE"""

    @searcher_agent_action
    def fail(
        self,
        hint: str
    ):
        """End the current task with a failure. Use this when you believe the entire task is impossible to complete.
        Args:
            hint:str, A hint or reason explaining why the search failed, or what kind of information was missing.
        """
        self.tutorial_or_hint = hint
        return """FAIL"""
        


