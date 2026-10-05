import re
from typing import Any, Dict, List, Optional, Tuple

from mm_agents.os_symphony.memory.procedural_memory import PROCEDURAL_MEMORY
from mm_agents.os_symphony.core.mllm import LMMAgent
from mm_agents.os_symphony.utils.common_utils import call_llm_safe
from mm_agents.os_symphony.agents.coder_agent import CoderAgent
from mm_agents.os_symphony.agents.grounder_agent import GrounderAgent
from mm_agents.os_symphony.agents.searcher_agent import SearcherAgent
import logging
from mm_agents.os_symphony.agents.ocr import OCRProcessor


logger = logging.getLogger("desktopenv.agent")

# Agent action decorator
def agent_action(func):
    func.is_agent_action = True
    return func

# GrounderAgent primitives are parameterized by description, and coordinate generation uses a pretrained grounding model
class OSACI:
    def __init__(
        self,
        env,
        search_env,
        platform: str,
        client_password: str,
        engine_params_for_ocr: Dict,
        engine_params_for_grounder: Dict,
        engine_params_for_coder: Dict,
        engine_params_for_searcher: Dict,
        screen_width: int = 1920,
        screen_height: int = 1080
    ):

        self.env = env
        self.platform = platform
        self.client_password = client_password

        self.result_dir = ""
        
        self.grounder_agent = GrounderAgent(engine_params=engine_params_for_grounder, screen_width=screen_width, screen_height=screen_height)
        
        # Configure text grounding agent
        self.ocr_processor = OCRProcessor()
        self.text_span_agent = LMMAgent(
            engine_params=engine_params_for_ocr,
            system_prompt=PROCEDURAL_MEMORY.PHRASE_TO_WORD_COORDS_PROMPT,
        )

        # Configure code agent
        self.coder_agent = CoderAgent(
            engine_params=engine_params_for_coder,
            platform=self.platform,
            client_password=client_password
        )

        # Configure search agent
        self.searcher_agent = SearcherAgent.create(
            engine_params=engine_params_for_searcher, 
            search_env=search_env, 
            grounder_agent=self.grounder_agent, 
            platform=self.platform,
            client_password=self.client_password
        )

        # Store task instruction for code agent
        self.current_task_instruction = None
        self.last_code_agent_result = None
        self.last_search_agent_result = None
        self.notes: List[str] = []
        # Tutorial should be a global info, not a local context, so how to add it to the global info
        self.tutorials = []


    def assign_screenshot(self, obs):
        self.obs = obs

    # Given the state and worker's text phrase, generate the coords of the first/last word in the phrase
    def generate_text_coords(
        self, phrase: str, obs: Dict, alignment: str = ""
    ) -> List[int]:
 
        screenshot, global_offset_x, global_offset_y= obs["screenshot"], 0, 0

        ocr_table, ocr_elements = self.ocr_processor.get_ocr_elements(screenshot, "easyocr")

        alignment_prompt = ""
        if alignment == "start":
            alignment_prompt = "**Important**: Output the word id of the FIRST word in the provided phrase.\n"
        elif alignment == "end":
            alignment_prompt = "**Important**: Output the word id of the LAST word in the provided phrase.\n"

        # Load LLM prompt
        self.text_span_agent.reset()
        self.text_span_agent.add_message(
            alignment_prompt + "Phrase: " + phrase + "\n" + ocr_table, role="user"
        )
        self.text_span_agent.add_message(
            "Screenshot:\n", image_content=screenshot, role="user"
        )

        # Obtain the target element
        response = call_llm_safe(self.text_span_agent)
        print("TEXT SPAN AGENT RESPONSE:", response)
        numericals = re.findall(r"\d+", response)
        if len(numericals) > 0:
            text_id = int(numericals[-1])
        else:
            text_id = 0
        elem = ocr_elements[text_id]

        # Compute the element coordinates
        # Note: 0.1 * elem["height"] is used to adjust coordinates to select the last character more precisely.
        if alignment == "start":
            coords = [elem["left"], elem["top"] + (elem["height"] // 2)]
        elif alignment == "end":
            coords = [elem["left"] + elem["width"] + 0.15 * elem["height"], elem["top"] + (elem["height"] // 2)]
        
        print(f'[OCR] output coordinates: {[coords[0] + global_offset_x, coords[1] + global_offset_y]}')
        return [int(coords[0] + global_offset_x), int(coords[1] + global_offset_y)]

    def set_task_instruction(self, task_instruction: str):
        """Set the current task instruction for the code agent."""
        self.current_task_instruction = task_instruction

    @agent_action
    def click(
        self,
        element_description: str,
        num_clicks: int = 1,
        button_type: str = "left",
        hold_keys: List = []
    ):
        """Click on the element
        Args:
            element_description:str, a detailed descriptions of which element to click on. This description needs to be VERY unambiguous. If the page contains many similar elements, ensure the description uniquely identifies the target element.
            num_clicks:int, number of times to click the element
            button_type:str, which mouse button to press can be "left", "middle", or "right"
            hold_keys:List, list of keys to hold while clicking
        """
        x, y = self.grounder_agent.generate_coords(element_description, self.obs)

        command = "import pyautogui; "

        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"""import pyautogui; pyautogui.click({x}, {y}, clicks={num_clicks}, button={repr(button_type)}); """
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "
        # Return pyautoguicode to click on the element

        action = {"function": "click", "args": {"x": x, "y": y, "button": button_type, "clicks": num_clicks}}
        return (command, action)

    @agent_action
    def open(self, app_or_filename: str):
        """Open any application or file with name app_or_filename. Use this action to open applications or files on the desktop, do not open manually.
        Args:
            app_or_filename:str, the name of the application or filename to open
        
        **Important**: 
        Provide only the name of the application or file. Do not include the full path (e.g., "/home/user/Desktop/my_report.docx"). The function works by searching for the name, not by accessing a file path directly.
        """
        action = {"function": "open", "args": {"name": app_or_filename}}
        if self.platform == "linux":
            return (f"import pyautogui; pyautogui.hotkey('win'); time.sleep(1.0); pyautogui.write({repr(app_or_filename)}); time.sleep(1.0); pyautogui.hotkey('enter'); time.sleep(1.0)", action)
        elif self.platform == "macos":
            return (f"import pyautogui; import time; pyautogui.hotkey('command', 'space', interval=0.5); pyautogui.typewrite({repr(app_or_filename)}); pyautogui.press('enter'); time.sleep(1.0)", action)
        elif self.platform == "windows":
            return (f"import pyautogui; import time; pyautogui.hotkey('win'); time.sleep(0.5); pyautogui.write({repr(app_or_filename)}); time.sleep(1.0); pyautogui.press('enter'); time.sleep(0.5)", action)
        else:
            assert (
                False
            ), f"Unsupported platform: {self.platform}. Supported platforms are: darwin, linux, windows."
    
    def _paste(self, is_terminal):
        if self.platform == 'macos':
            return "pyautogui.hotkey('command', 'v');"
        
        elif self.platform == 'linux':
            if is_terminal:
                return "pyautogui.hotkey('ctrl', 'shift', 'v');"
            else:
                return "pyautogui.hotkey('ctrl', 'v');"
                
        elif self.platform == 'windows':
            return "pyautogui.hotkey('ctrl', 'v');"
        
        return ""
    
    def _clear_all(self, is_terminal):
        """
        Clean the content of current line
        """
        # common apps in GUI
        if not is_terminal:
            if self.platform == 'macos':
                # macOS GUI: Command + A -> Backspace
                return "pyautogui.hotkey('command', 'a'); pyautogui.press('backspace');"
            else:
                # Windows/Linux GUI: Ctrl + A -> Backspace
                return "pyautogui.hotkey('ctrl', 'a'); pyautogui.press('backspace');"

        # terminal
        else:
            if self.platform == 'windows':
                return "pyautogui.press('esc');"
            else:
                return "pyautogui.hotkey('ctrl', 'e'); pyautogui.hotkey('ctrl', 'u');"
    
    def _type(
        self,
        text: str,
        is_terminal: bool
    ):
        """
        use copy and paste to input Chinese, otherwise type normally
        """
        commands = ""
        has_unicode = any(ord(char) > 127 for char in text)
        if has_unicode and self.platform != "macos":
            commands += (
                "original_clipboard = pyperclip.paste();"
                f"pyperclip.copy({repr(text)});"
                "time.sleep(0.1);"
            )
            commands += self._paste(is_terminal=is_terminal)
            commands += "pyperclip.copy(original_clipboard);"
        else:
            commands += f"pyautogui.write({repr(text)}, interval=0.1);"

        return commands
    
    @agent_action
    def type(
        self,
        element_description: str,
        text: str = "",
        overwrite: bool = False,
        enter: bool = False,
        is_terminal = False
    ):
        """Type text/unicode into a specific element
        Args:
            element_description: str, a detailed description of which element to enter text in. If provided, the agent will click on this element before typing.
            text:str, the text to type
            overwrite:bool, Default is False, assign it to True if the text should overwrite the whole existing text. Using this argument clears all text in an element.
            enter:bool, Assign it to True if the enter key should be pressed after typing all the text, otherwise assign it to False.
            is_terminal:bool, (MANDATORY) You MUST set this to True whenever the target you will type into is a terminal.
        """
        commands = (
            "import os;"
            "import pyautogui;"
            "import pyperclip;"
            "import subprocess;"
            "import time;"
        )


        if self.platform == "linux":
            commands += (
                "p_http = os.environ.get('http_proxy') or os.environ.get('HTTP_PROXY');"
                "p_https = os.environ.get('https_proxy') or os.environ.get('HTTPS_PROXY');"
                "proxy_prefix = (f'http_proxy={p_http} ' if p_http else '') + (f'https_proxy={p_https} ' if p_https else '');"
                f"subprocess.run(f'echo \"{self.client_password}\" | sudo -S {{proxy_prefix}}apt-get install -y xclip xsel', shell=True, check=True);"
            )

        x, y = None, None
        if element_description is not None:
            x, y = self.grounder_agent.generate_coords(element_description, self.obs)
            commands += (
                f"pyautogui.click({x}, {y}, clicks=2);" 
                f"time.sleep(1.0);"
                f"pyautogui.click({x}, {y});"
            )

        if overwrite:
            commands += self._clear_all(is_terminal=is_terminal)

        commands += self._type(text=text, is_terminal=is_terminal)
        
        if enter:
            commands += "pyautogui.press('enter');"

        if element_description is not None:
            action = {"function": "type", "args": {"x": x, "y": y, "text": text}}
        else:
            action = {"function": "type", "args": {"text": text}}
        return (commands, action)
    
    @agent_action
    def drag_and_drop(
        self, starting_description: str, ending_description: str, hold_keys: List = []
    ):
        """Drag from the starting description to the ending description
        Args:
            starting_description:str, a very detailed description of where to start the drag action. This description should be at least a full sentence.
            ending_description:str, a very detailed description of where to end the drag action. This description should be at least a full sentence.
            hold_keys:List list of keys to hold while dragging
        """
        x1, y1 = self.grounder_agent.generate_coords(starting_description, self.obs)
        x2, y2 = self.grounder_agent.generate_coords(ending_description, self.obs)

        command = "import pyautogui; "

        command += f"pyautogui.moveTo({x1}, {y1}); "
        # TODO: specified duration?
        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"pyautogui.dragTo({x2}, {y2}, duration=3., button='left'); pyautogui.mouseUp(); "
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "

        # Return pyautoguicode to drag and drop the elements
        action = {"function": "drag", "args": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}}
        return (command, action)

    @agent_action
    def highlight_text_span(
        self, 
        starting_phrase: str, 
        ending_phrase: str, 
        button: str = "left",
        text: Optional[str|None] = None
    ):
        """Highlight a text span between a provided starting phrase and ending phrase. Use this to highlight words, lines, and paragraphs.
        Args:
            starting_phrase: str, the sequence of words that marks the beginning of the text span. Provide a unique sequence of 5 to 10 words.
            ending_phrase: str, the sequence of words that marks the end of the text span. Provide a unique sequence of 5 to 10 words.
            button:str, the button to use to highlight the text span. Defaults to "left". Can be "left", "right", or "middle".
            text: str | None, The text to overwrite the highlighted span with. Providing text here ensures the replacement happens immediately after selection, preventing focus loss.
        """
        x1, y1 = self.generate_text_coords(
            starting_phrase, self.obs, alignment="start"
        )
        x2, y2 = self.generate_text_coords(
            ending_phrase, self.obs, alignment="end"
        )

        command = "import pyautogui; import time;"
        command += f"pyautogui.moveTo({x1}, {y1}); "
        # Click in advance to simulate selecting the text box.
        command += (
            f"pyautogui.click({x1}, {y1}, clicks=2);"
            f"time.sleep(1.0); pyautogui.click({x1}, {y1}); time.sleep(1.0);"
        )
        command += f"pyautogui.dragTo({x2}, {y2}, duration=5., button='{button}'); time.sleep(0.5); pyautogui.mouseUp(); "

        if text:
            if self.platform == "linux":
                command += "subprocess.run('echo \"password\" | sudo -S apt-get install -y xclip xsel', shell=True, check=True, env={\"http_proxy\": \"http://10.1.8.5:23128\", \"https_proxy\": \"http://10.1.8.5:23128\"});"

            command += (
                "original_clipboard = pyperclip.paste();"
                f"pyperclip.copy({repr(text)});"
            )
            command += self._paste(is_terminal=False)
            command += "pyperclip.copy(original_clipboard);"

        # Return pyautoguicode to drag and drop the elements
        action = {"function": "drag", "args": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}}
        return (command, action)
    
    @agent_action
    def locate_cursor(
        self,
        phrase: str,
        start_or_end: str="start",
        text: Optional[str|None] = None
    ):
        """Click at the beginning or end of a specific text phrase to precisely control cursor positioning. Please prefer using the "click" action in general situations, and use this action only in text-intensive software such as libreoffice_writer, impress, etc.

        Args:
            phrase: str, The text phrase where you want to position the cursor. Provide a unique sequence of 5 to 10 words. Do NOT use single words unless the total text is extremely short.    
            start_or_end: str, Whether to click at the "start" (beginning) or "end" (trailing edge) of the identified text phrase. Use "start" to position before the text, "end" to position after it.
            text: str | None, The text to enter immediately after positioning the cursor. Use this parameter instead of a separate 'type' action to ensure precise input.
        """
        x, y = self.generate_text_coords(
            phrase, self.obs, alignment=start_or_end
        )
        command = (
            "import pyautogui;"
            "import time;"
            "import subprocess;"
            "import pyperclip;" 
            f"pyautogui.click({x}, {y}, button='left', clicks=2);"
            "time.sleep(1.0);"
            f"pyautogui.click({x}, {y}, button='left');"
        )
        if text:
            if self.platform == "linux":
                command += "subprocess.run('echo \"password\" | sudo -S apt-get install -y xclip xsel', shell=True, check=True, env={\"http_proxy\": \"http://10.1.8.5:23128\", \"https_proxy\": \"http://10.1.8.5:23128\"});"

            command += self._type(text=text, is_terminal=False)

        if text:
            action = {"function": "type", "args": {"x": x, "y": y, "text": text}}
        else:
            action = {"function": "click", "args": {"x": x, "y": y, "clicks": 1, "button": "left"}}
        return (command, action)


    @agent_action
    def call_code_agent(self, task: str):
        """Calls the code agent to execute a well-defined, self-contained goal that can be completed with code.

        Args:
            task: str, A specific, self-contained goal that the code agent can work on until completion.

        **🚨 CRITICAL GUIDELINES:**

        **Decompose the Main Objective into Logical Goals:**
        - You **MUST** break down the overall mission into distinct, logical goals or stages.
        - Your role is to define *what* needs to be done for a specific stage. The code agent's role is to figure out *how* to do it with code.
        - Pass only one logical goal at a time. The `task` parameter is **REQUIRED**.

        **Define a Self-Contained, Continuous Goal:**
        - The `task` you provide should be a single, continuous goal. The code agent is capable of handling a multi-step process internally (e.g., opening a file, processing its data, and then saving it) to achieve this one goal.
        - **Crucially, do not pass a task that combines multiple distinct objectives.** For example, instead of passing "Analyze the sales data, AND email the result," you should first pass the self-contained goal: "Analyze the sales data." After that goal is complete, you can proceed with the next logical goal (e.g., emailing the result) in a subsequent step.
        - **If unsure, err on the side of caution.** If a task feels like it has two separate parts, break it down and pass only the first part.
        - Your instruction must describe the desired end-state, NOT the recipe to get there. Do not specify any solution!
        
        **Goal Purity is Essential:**
        - **NEVER** rephrase, paraphrase, or modify the subtask instruction you have decided on. Pass the exact, original wording of the subtask to prevent instruction drift and hallucination.

        Use this for tasks that can be fully accomplished through code execution, particularly for:
        - Spreadsheet applications: data processing, filtering, sorting, calculations, formulas, data analysis
        - Document editors: text processing, content editing, formatting, document manipulation
        - Code editors: code editing, file processing, text manipulation, configuration
        - Data analysis tools: statistical analysis, data transformation, reporting
        - File management: bulk operations, file processing, content extraction
        - System utilities: configuration, setup, automation
        """
        logger.info("=" * 50)
        logger.info("ACI: Calling Code Agent")
        logger.info("=" * 50)
        task_to_execute = task
        logger.info(f"Executing SUBTASK: {task_to_execute}")

        print("obs keys: ", self.obs.keys())
        screenshot = self.obs.get("screenshot", "") if self.obs else ""
        logger.info(f"Screenshot available: {'Yes' if screenshot else 'No'}")

        logger.info("Executing code agent...")

        result = self.coder_agent.execute(
            task_to_execute, screenshot, self.env.controller
        )

        # Store the result for the worker to access
        self.last_code_agent_result = result

        logger.info("Code agent execution completed")
        logger.info(f"Result - Completion reason: {result['completion_reason']}")
        logger.info(f"Steps executed: {result['steps_executed']}")
        logger.info(f"Summary: {result['summary']}")

        logger.info("=" * 50)
        logger.info("GROUNDING AGENT: Code Agent Call Finished")
        logger.info("=" * 50)

        action = {"function": "call_code_agent", "args": {"query": task, "result": True if result["completion_reason"] == "DONE" else False}}
        # Return code to be executed in the environment
        return ("import time; time.sleep(2.222)", action)

    @agent_action
    def scroll(self, element_description: str, clicks: int, shift: bool = False):
        """Scroll the element in the specified direction
        Args:
            element_description:str, a very detailed description of which element to enter scroll in. This description should be at least a full sentence.
            clicks:int, the number of clicks to scroll can be positive (up) or negative (down).
            shift:bool, whether to use shift+scroll for horizontal scrolling
        """
        x, y = self.grounder_agent.generate_coords(element_description, self.obs)
        action = {"function": "scroll", "args": {"x": x, "y": y, "clicks": clicks, "shift": shift}}
        if shift:
            return (f"import pyautogui; import time; pyautogui.moveTo({x}, {y}); time.sleep(0.5); pyautogui.hscroll({clicks})", action)
        else:
            return (f"import pyautogui; import time; pyautogui.moveTo({x}, {y}); time.sleep(0.5); pyautogui.vscroll({clicks})", action)

    @agent_action
    def hotkey(self, keys: List):
        """Press a hotkey combination (can press a single key as well)
        Args:
            keys:List the keys to press in combination in a list format (e.g. ['ctrl', 'c'], ['enter'])
        """
        # add quotes around the keys
        keys = [f"'{key}'" for key in keys]
        keys_string = " ".join(keys)
        action = {"function": "key", "args": {"keys": keys_string}}
        return (f"import pyautogui; pyautogui.hotkey({', '.join(keys)});", action)

    @agent_action
    def hold_and_press(self, hold_keys: List, press_keys: List):
        """Hold a list of keys and press a list of keys
        Args:
            hold_keys:List, list of keys to hold
            press_keys:List, list of keys to press in a sequence
        """

        press_keys_str = "[" + ", ".join([f"'{key}'" for key in press_keys]) + "]"
        command = "import pyautogui; "
        for k in hold_keys:
            command += f"pyautogui.keyDown({repr(k)}); "
        command += f"pyautogui.press({press_keys_str}); "
        for k in hold_keys:
            command += f"pyautogui.keyUp({repr(k)}); "

        hold_keys_string = " ".join(hold_keys)
        press_keys_string = " ".join(press_keys)
        action = {"function": "key", "args": {"keys": hold_keys_string + ";" + press_keys_string}}
        return (command, action)

    @agent_action
    def wait(self, time: float):
        """Wait for a specified amount of time
        Args:
            time:float, the amount of time to wait in seconds
        """
        return (f"""import time; time.sleep({time});""", {"function": "wait", "args": {}})

    @agent_action
    def done(
        self,
    ):
        """        
        End the current task with a success. Use this when you believe the entire task has been fully completed. You must ensure all visual information aligns with the user's true intent.
        """
        return ("""DONE""", {"function": "done", "args": {}})

    @agent_action
    def fail(self):
        """End the current task with a failure. Use this when you believe the entire task is impossible to complete."""
        return ("""FAIL""", {"function": "fail", "args": {}})
    
    @agent_action
    def call_search_agent(
        self, 
        query: str,
    ):
        """
        Calls a specialized 'Searcher Agent' to find a detailed, step-by-step tutorial on the internet for a specific GUI action.
        Args:
            query:str, the search phrase or question for the tutorial. The formulation of this query is critical for success and must follow the guidelines below.

        **Query Formulation Guidelines:**

        Your query must be a well-defined question targeting a **single, specific action** within a **specific application**. To get the best results, adhere to these rules:

        1.  **Start with "How to":** Your query must begin with the phrase "How to" to frame it as a request for instructions.
        2.  **Include the Application Name:** Always specify the name of the software you are working in (e.g., "GIMP", "Google Chrome", "Libreoffice Writer").
        3.  **Focus on a Single Intent:** The query should represent one clear goal. Do not combine multiple steps or tasks into one query.
        4.  **Be Specific, Not Abstract:** Ask a concrete question. Avoid repeating the user's high-level or abstract instructions.
        5.  **Decompose Complex Tasks:** If the user's overall instruction involves multiple actions (e.g., "download a file and then email it"), and you are stuck on one part, search *only for that specific part*.

        **Examples:**

        *   **User's Overall Instruction:** "Please help me download my latest bank statement and then send it to my accountant."
            *   **Correct Query (if stuck on downloading):** "How to download a bank statement from the Bank of America website?"
            *   **Correct Query (if stuck on attaching a file):** "How to attach a file to an email in Gmail?"
            *   **Incorrect Query:** "Download my bank statement and email it to my accountant" *(This query is too broad, contains multiple sub-tasks, and does not start with "How to".)*
        """
        logger.info("=" * 50)
        logger.info(f"ACI: Calling Search Agent(query={query})")
        logger.info("=" * 50)
        self.searcher_agent.result_dir = self.result_dir
        result = self.searcher_agent.search(query=query, main_obs=self.obs)
        self.last_search_agent_result = result
        if result["completion_reason"] == "DONE":
            self.tutorials.append(result["final_answer"])
        action = {"function": "call_search_agent", "args": {"query": query, "result": True if result["completion_reason"] == "DONE" else False}}
        return ("import time; time.sleep(2.222)", action)
    