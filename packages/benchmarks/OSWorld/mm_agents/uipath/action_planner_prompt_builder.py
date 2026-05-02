from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from enum import Enum
from mm_agents.uipath.types_utils import PlanAction, key_maps
from mm_agents.uipath.utils import ValidationException
from mm_agents.uipath.memory import memory_system_template

system_template = """You are a computer use agent that perform computer-related tasks.
You will be given a task, a current screenshot, and a list of previous actions. You need to predict the next action.

## Available Actions:
{available_actions}

In addition there are some special actions that are not part of the main UI actions:
{special_actions}

Each action has a description and parameters. The action description is a single sentence which mentions the action and the control element to interact with.
This description will be used by the executor agent to locate the action's target element coordinates in the screen, so describe the element targeted by the action as detailed as possible.
Particularly for icons, you can describe their position, text on it, color, nearby elements etc...
Example of some action descriptions with more detailed information to help the executor agent locate the element:
- "Click on the Calendar icon with the text 'Thu 28'"
- "Click the 'Search' button on the top right corner next to the login button."
- "Click the 'First Name' input box from the UserInfo section to focus it before typing."

Your action response must be a valid JSON with the following format:
{{
    "type": str  # one of the valid action types
    "description": # action description
    "parameters": # optional, action parameters dictionary    
}}

## Action examples: example of valid actions:
{examples}

## Action Sequence Example:
Here is an example of the correct sequence for typing text into an input field.

Step 1: Scroll to make the 'Username' input field fully visible.

{{
  "type": "scroll",
  "description": "Scroll page to make the 'Username' input field fully visible."
  "parameters": {{"element_description": "the main page", "direction": "down", "distance": 3}}
}}

Step 2: Click the input field to focus it.

{{
  "type": "click",
  "description": "Click the 'Username' input field."
}}

Step 3: Type the desired text.

{{
  "type": "type",
  "description": "Type 'testuser' into the focused 'Username' input field.",
  "parameters": {{
    "text": "testuser"
  }}
}}

## Important Rules:
CRITICAL: Always click to focus an input field before using the type action if it is not focused already from a previous step. The model must predict a click on the element, and then in the next step, predict the type action.
Close any cookies, ads, login or registration pop-ups if they are not needed for the task.
Before finish action, ensure all necessary data entries or selections are committed by performing appropriate actions (e.g., pressing 'Enter'/ 'Tab', Ctrl+S for saving documents or clicking 'Save', changing focus, or blurring the input field).
- **Strict Adherence**: Only perform actions the user has explicitly requested; avoid unnecessary steps. E.g. For colors, ensure that if user requested to use "green" you use the color named green, not light green or other shades.
- CRITICAL: Make sure the modified files or settings are saved and if no file name is specified in the user task, use the default settings that appear.
- Dismiss "Authentication required" prompts by clicking "Cancel".
- Leave windows/applications open at task completion.
- **Completion Criteria**: Only finish when all user requirements are met in full and all running commands have finished.
- **Impossibility Handling**: Return failure if completion is blocked by environmental constraints.
- You must never logout/close the computer, otherwise you won't be able to interact with the environment, if an action requires this, mark it as failure
"""

user_message_template = """Here are the current information:
The current date is (YYYY-MM-DD): {current_date}
Task: {task}

Previous actions:
{history}
"""

### for chat conversation
user_task_info_template = """## Task Information:
The current date is (YYYY-MM-DD): {current_date}
Task: {task}
"""

user_command_template_chat = """Current Memory: {memory}
Check if the task is finished. If not provide the next action to perform.
Remember:
- Perform the task on provided application(s) or website(s). You are not allowed to use the browser "address bar".
- Close any cookies, ads, login or registration etc pop-ups if not needed.
- Only one action at a time (never "click and type", "click and drag", "type and press" etc..).
- For any opening input combobox, dropdown menu options, you must select an option or press Enter key to select default one.
- Caret is not always visible in input box even when the input box is focused
- CRITICAL: Scroll to make the target element fully visible on the screenshot before clicking or typing on it. Never click or type on an element not fully visible on the screenshot.
- CRITICAL: Before typing ensure the element is focused by first clicking it. Otherwise, the input box will not accept the text.
- Once focusing on an input box, if it has a default pre-typed value (not placeholder which is usually grayed-out), remove the existing value first by clicking on "X" icon or using "Ctrl A" + "Backspace" or "Backspace" if the value is already selected.
- For search input, if no search button or suggestions popup after typing, press 'Enter' to trigger search.
- Retry the drag action on slider control if needed to refine the slider values closer to expected values.
- Scroll / Pageup / Pagedown to explore or extract more content/data if needed (prefer 'key_press' action with key 'Pageup', 'Pagedown' for faster scrolling). Particularly when extraction data from table with hidden rows or columns.
- Scroll action must have a 'direction' parameter. Finish action must have a 'status' parameter.

MOST IMPORTANTLY, never type or click on element not visible on screenshot. Use scroll or pageup/pagedown to make the element visible first.

{execution_info_message}
Answer in json format:
{json_output_format}
"""

user_command_template = """Recall Task Again: {task}\n""" + user_command_template_chat


class PlanerCoTSectionsType(str, Enum):
    Review = "review"
    Thought = "thought"
    ActionDescription = "action_description"
    Memory = "memory"

PlanerCoTSections = OrderedDict(
    {
        PlanerCoTSectionsType.Review: {
            "display": "previous_action_result",
            "description": "Briefly describe the previous action result and UI change on the screenshot to see if is correctly performed.",
        },
        PlanerCoTSectionsType.Thought: {"display": "thought", "description": "Reason briefly about the next action to perform if the task is not finished."},
        PlanerCoTSectionsType.ActionDescription: {
            "display": "action_description",
            "description": "Describe the action to perform in a single sentence. The description must be precise and not rely on specific information in the current screen.",
        },
        PlanerCoTSectionsType.Memory: {
            "display": "update_memory",
            "description": "<Proceed with a memory update considering the previous actions. Emit a list of memory operations. If no memory update is needed, emit an empty list>",
        },
    }
)


@dataclass
class ActionDefinition:
    """Simple action definition with description, parameters, and examples"""

    type: str
    description: str
    parameters: Optional[Dict[str, str]] = None
    examples: List[Dict[str, Any]] = field(default_factory=list)


class ComputerUseAgentInterface:
    """Simple computer use agent with modular action definitions"""

    def __init__(self):
        self.ui_actions = {}
        self.special_actions = {}
        self._setup_default_actions()

    def get_planner_cot_sections(self) -> OrderedDict:
        cot_sections = PlanerCoTSections.copy()
        return cot_sections

    def _setup_default_actions(self):
        """Define all available actions"""

        # Click action - no parameters
        self.add_action(
            ActionDefinition(
                type="click",
                description="Click on a UI element",
                examples=[
                    {"type": "click", "description": "Click the 'Next' button."},
                    {
                        "type": "click",
                        "description": "Click the 'X' icon in the input box",
                    },
                    {"type": "click", "description": "Click the first name input box to focus on it."},
                ],
            )
        )

        # Right click action - no parameters
        self.add_action(
            ActionDefinition(
                type="right_click",
                description="Right click on a UI element",
                examples=[{"type": "right_click", "description": "Right click on the first row from the patient table to open the context menu."}],
            )
        )

        # Double click action - no parameters
        self.add_action(
            ActionDefinition(
                type="double_click",
                description="Double click on a UI element",
                examples=[
                    {"type": "double_click", "description": "Double click word app icon to open the application."},
                ],
            )
        )
        
        # Triple click action - no parameters
        self.add_action(
            ActionDefinition(
                type="triple_click",
                description="Triple click on a UI element",
                examples=[
                    {"type": "triple_click", "description": "Triple click the second paragraph to select it."},
                ],
            )
        )

        # Type action - with text parameter
        self.add_action(
            ActionDefinition(
                type="type",
                description="Type text into a focused input field. Ensure the input box is focused before typing. To focus the input box, you may need to click on it first.",
                parameters={"text": "str - the text to be typed"},
                examples=[
                    {"type": "type", "description": "Type 'John' in the first name input box.", "parameters": {"text": "John"}},
                    {"type": "type", "description": "Type 'Doe' in the last name input box.", "parameters": {"text": "Doe"}},
                    {"type": "type", "description": "Type 'Hello, world!' in the text area.", "parameters": {"text": "Hello, world!"}},
                ],
            )
        )

        # Scroll action - with direction parameter
        self.add_action(
            ActionDefinition(
                type="scroll",
                description="Scroll an UI element in a specified direction",
                parameters={
                    "element_description": "str - description of the element to be scrolled such that the executor can locate it",
                    "direction": "str - 'up', 'down', 'left', or 'right'",
                    "distance": "int - number of 'clicks' to scroll, e.g. on windows, 1 click = 120 units of scroll internally",
                },
                examples=[
                    {
                        "type": "scroll",
                        "description": "Scroll down the user table to see more content.",
                        "parameters": {"element_description": "Users table", "direction": "down", "distance": "6"},
                    },
                    {
                        "type": "scroll",
                        "description": "Scroll up to the top of the page.",
                        "parameters": {"element_description": "the main page", "direction": "up"},
                    },
                ],
            )
        )

        # Drag action
        self.add_action(
            ActionDefinition(
                type="drag",
                description="Drag an element or the mouse (with left click on) from one location to another.",
                parameters={"start_description": "description of the location to start dragging", "end_description": "description of the location to drag to"},
                examples=[
                    {
                        "type": "drag",
                        "description": "Drag the response.txt file to the responses folder",
                        "parameters": {
                            "start_description": "the response.txt file",
                            "end_description": "the responses folder",
                        },
                    },
                    {
                        "type": "drag",
                        "description": "Drag the profile picture image into the upload box",
                        "parameters": {
                            "start_description": "the profile picture image",
                            "end_description": "the upload box",
                        },
                    },
                ],
            )
        )

        # Mouse move action
        self.add_action(
            ActionDefinition(
                type="mouse_move",
                description="Move the mouse to a specific element",
                examples=[
                    {"type": "mouse_move", "description": "Move the mouse to the 'Submit' button."},
                    {"type": "mouse_move", "description": "Hover over the 'Settings' icon."},
                ],
            )
        )

        # Key press action - with key parameter
        self.add_action(
            ActionDefinition(
                type="key_press",
                description="Press a specific key on the keyboard",
                parameters={
                    "key": f'str  # the key or key combination (separated by space) to be pressed. Example of key combination "Ctrl A", "Shift Tab", "Ctrl C" etc. "<Key> + Click" is not a valid combination, use two separate actions. Beside normal keys like letters, numerics, punctuations etc.. here are special key list: {key_maps.keys()}.'
                },
                examples=[
                    {"type": "key_press", "description": "Press 'Ctrl A' to select all text.", "parameters": {"key": "Ctrl A"}},
                    {"type": "key_press", "description": "Press Pagedown key.", "parameters": {"key": "Pagedown"}},
                ],
            )
        )

        # Extract data action - with variable parameter
        self.add_special_action(
            ActionDefinition(
                type="extract_data",
                description="Use to extract some data from the screen for the task. This data will be stored in memory and used in the next actions or returned in the final result.",
                parameters={"description": "str - short description of the data to be extracted", "data": "str|json - the data to be extracted"},
                examples=[
                    {
                        "type": "extract_data",
                        "description": "Extract the product name and price from the screen.",
                        "parameters": {"description": "Available product name and price", "data": "Product Name: iPhone 14, Price: $999"},
                    },
                ],
            )
        )

        # Wait action
        self.add_special_action(
            ActionDefinition(
                type="wait",
                description="Use it to wait for the completion of an event.",
                examples=[
                    {"type": "wait", "description": "Wait for the running command to finish."},
                ],
            )
        )

        # Finish action - with status parameter
        self.add_special_action(
            ActionDefinition(
                type="finish",
                description=(
                    "Use it to finish the task with success or failure. "
                    "Before finishing, ensure all necessary data entries or selections required by the task are committed by performing appropriate actions (e.g., pressing 'Enter'/ 'Tab', pressing CTRL + S to save the document or clicking 'Save', changing focus, or blurring the input field). After typing a value that should be set/submitted, perform a COMMIT action (Enter, Tab, click Save/Apply or blur) before using the finish action.",
                    "Do not use the finish action while any essential process or command (e.g., downloading data, running a script, loading results) is still in progress; wait for it (emmit wait action) to fully complete before finishing. ",
                    "Failure status is used when the task is impossible to complete or you are unable to complete it (e.g. stuck in a loop, etc)."
                ),
                parameters={"status": "str - 'success' or 'failure'"},
                examples=[
                    {"type": "finish", "description": "Task completed successfully.", "parameters": {"status": "success"}},
                    {
                        "type": "finish",
                        "description": "After typing 'John Doe' and pressing TAB to save the value, finish the task successfully.",
                        "parameters": {"status": "success"},
                    },
                ],
            )
        )

    def add_action(self, action: ActionDefinition):
        """Add a new action to the agent"""
        self.ui_actions[action.type] = action

    def add_special_action(self, action: ActionDefinition):
        """Add a special action that is not part of the main UI actions"""
        self.special_actions[action.type] = action

    def get_action_definition(self, action_type: str) -> Optional[ActionDefinition]:
        """Get action definition by type"""
        return self.ui_actions.get(action_type) or self.special_actions.get(action_type)

    def validate_action(self, action: PlanAction):
        """Validate if the action is valid and has all required parameters"""
        action_definition = self.get_action_definition(action.action_type)
        if action_definition is None:
            raise ValidationException(f"Invalid action type: {action.action_type}")

        if action_definition.parameters:
            for parameter in action_definition.parameters:
                if parameter not in action.parameters:
                    raise ValidationException(f"Missing parameter '{parameter}' in action: {action}")

    def get_system_prompt(self) -> str:
        """Generate the complete prompt for the agent"""
        indentation = "  "

        def get_action_definition(action: ActionDefinition) -> str:
            """Format action definitions for the prompt"""

            action_prompt = f"- {action.type}: {action.description}"
            if action.parameters is not None and len(action.parameters) > 0:
                params = (",\n" + 2 * indentation).join(f"{k}: {v}" for k, v in action.parameters.items())
                parameter_def = f"{indentation}parameters:\n{indentation}{indentation}{params}"
                action_prompt += "\n" + parameter_def
            return action_prompt

        def get_examples(actions: List[ActionDefinition]) -> list[str]:
            """Format action examples for the prompt"""

            output_examples = []
            for action in actions:
                for example in action.examples:
                    example_type = example["type"]
                    example_description = example["description"]
                    type_str = f'"type": "{example_type}"'
                    description_str = f'"description": "{example_description}"'
                    example_parts = [type_str, description_str]

                    if "parameters" in example:
                        params = (",\n" + 2 * indentation).join(f'"{k}": "{v}"' for k, v in example["parameters"].items())
                        parameters_str = '"parameters"' + ": {\n" + 2 * indentation + params + "\n" + indentation + "}"
                        example_parts.append(parameters_str)
                    example_json = "{\n" + indentation + (",\n" + indentation).join(example_parts) + "\n}"
                    output_examples.append(example_json)

            return output_examples

        available_actions = "\n\n".join(get_action_definition(action) for action in self.ui_actions.values())
        special_actions = "\n\n".join(get_action_definition(action) for action in self.special_actions.values())
        examples = "\n\n".join(get_examples(list(self.ui_actions.values()) + list(self.special_actions.values())))

        out = system_template.format(available_actions=available_actions, special_actions=special_actions, examples=examples)
        out += "\n\n" + memory_system_template.format()
        return out


if __name__ == "__main__":
    agent = ComputerUseAgentInterface()
    print(agent.get_system_prompt())