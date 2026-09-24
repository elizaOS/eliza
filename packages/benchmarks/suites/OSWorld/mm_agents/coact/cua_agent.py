import base64
import json
import logging
import os
import time
from typing import Any, Dict, List, Tuple

import openai
from desktop_env.desktop_env import DesktopEnv
from openai import OpenAI  # pip install --upgrade openai>=1.30

logger = logging.getLogger("desktopenv")

GPT4O_INPUT_PRICE_PER_1M_TOKENS = 3.00
GPT4O_OUTPUT_PRICE_PER_1M_TOKENS = 12.00

PROMPT_TEMPLATE = """# Task
{instruction}

# Hints
- Sudo password is "{CLIENT_PASSWORD}".
- Keep the windows/applications opened at the end of the task.
- Do not use shortcut to reload the application except for the browser, just close and reopen.
- If "The document has been changed by others" pops out, you should click "cancel" and reopen the file.
- If you have completed the user task, reply with the information you want the user to know along with 'TERMINATE'.
- If you don't know how to continue the task, reply your concern or question along with 'IDK'.
""".strip()
DEFAULT_REPLY = "Please continue the user task. If you have completed the user task, reply with the information you want the user to know along with 'TERMINATE'."


def _cua_to_pyautogui(action) -> str:
    """Convert an Action (dict **or** Pydantic model) into a pyautogui call."""
    def fld(key: str, default: Any = None) -> Any:
        return action.get(key, default) if isinstance(action, dict) else getattr(action, key, default)

    act_type = fld("type")
    if not isinstance(act_type, str):
        act_type = str(act_type).split(".")[-1]
    act_type = act_type.lower()

    if act_type in ["click", "double_click"]:
        button = fld('button', 'left')
        if button == 1 or button == 'left':
            button = 'left'
        elif button == 2 or button == 'middle':
            button = 'middle'
        elif button == 3 or button == 'right':
            button = 'right'

        if act_type == "click":
            return f"pyautogui.click({fld('x')}, {fld('y')}, button='{button}')"
        if act_type == "double_click":
            return f"pyautogui.doubleClick({fld('x')}, {fld('y')}, button='{button}')"
        
    if act_type == "scroll":
        cmd = ""
        if fld('scroll_y', 0) != 0:
            cmd += f"pyautogui.scroll({-fld('scroll_y', 0) / 100}, x={fld('x', 0)}, y={fld('y', 0)});"
        return cmd
    if act_type == "drag":
        path = fld('path', [{"x": 0, "y": 0}, {"x": 0, "y": 0}])
        cmd = f"pyautogui.moveTo({path[0]['x']}, {path[0]['y']}, _pause=False); "
        cmd += f"pyautogui.dragTo({path[1]['x']}, {path[1]['y']}, duration=0.5, button='left')"
        return cmd

    if act_type == 'move':
        return f"pyautogui.moveTo({fld('x')}, {fld('y')})"

    if act_type == "keypress":
        keys = fld("keys", []) or [fld("key")]
        if len(keys) == 1:
            return f"pyautogui.press('{keys[0].lower()}')"
        else:
            return "pyautogui.hotkey('{}')".format("', '".join(keys)).lower()
        
    if act_type == "type":
        text = str(fld("text", ""))
        return "pyautogui.typewrite({:})".format(repr(text))
    
    if act_type == "wait":
        return "WAIT"
    
    return "WAIT"  # fallback


def _to_input_items(output_items: list) -> list:
    """
    Convert `response.output` into the JSON-serialisable items we're allowed
    to resend in the next request.  We drop anything the CUA schema doesn't
    recognise (e.g. `status`, `id`, …) and cap history length.
    """
    cleaned: List[Dict[str, Any]] = []

    for item in output_items:
        raw: Dict[str, Any] = item if isinstance(item, dict) else item.model_dump()

        # ---- strip noisy / disallowed keys ---------------------------------
        raw.pop("status", None)
        cleaned.append(raw)

    return cleaned  # keep just the most recent 50 items


def call_openai_cua(client: OpenAI,
                    history_inputs: list,
                    screen_width: int = 1920,
                    screen_height: int = 1080,
                    environment: str = "linux") -> Tuple[Any, float]:
    retry = 0
    response = None
    while retry < 3:
        try:
            response = client.responses.create(
                model="computer-use-preview",
                tools=[{
                    "type": "computer_use_preview",
                    "display_width": screen_width,
                    "display_height": screen_height,
                    "environment": environment,
                }],
                input=history_inputs,
                reasoning={
                    "summary": "concise"
                },
                tool_choice="required",
                truncation="auto",
            )
            break
        except openai.BadRequestError as e:
            retry += 1
            logger.error(f"Error in response.create: {e}")
            time.sleep(0.5)
        except openai.InternalServerError as e:
            retry += 1
            logger.error(f"Error in response.create: {e}")
            time.sleep(0.5)
    if retry == 3:
        raise Exception("Failed to call OpenAI.")

    cost = 0.0
    if response and hasattr(response, "usage") and response.usage:
        input_tokens = response.usage.input_tokens
        output_tokens = response.usage.output_tokens
        input_cost = (input_tokens / 1_000_000) * GPT4O_INPUT_PRICE_PER_1M_TOKENS
        output_cost = (output_tokens / 1_000_000) * GPT4O_OUTPUT_PRICE_PER_1M_TOKENS
        cost = input_cost + output_cost

    return response, cost


def run_cua(
    env: DesktopEnv,
    instruction: str,
    max_steps: int,
    save_path: str = './',
    screen_width: int = 1920,
    screen_height: int = 1080,
    sleep_after_execution: float = 0.3,
    truncate_history_inputs: int = 100,
    client_password: str = "",
) -> Tuple[str, float]:
    client = OpenAI()

    # 0 / reset & first screenshot
    logger.info(f"Instruction: {instruction}")
    obs = env.controller.get_screenshot()
    screenshot_b64 = base64.b64encode(obs).decode("utf-8")
    with open(os.path.join(save_path, "initial_screenshot.png"), "wb") as f:
        f.write(obs)
    history_inputs = [{
        "role": "user",
        "content": [
            {"type": "input_text", "text": PROMPT_TEMPLATE.format(instruction=instruction, CLIENT_PASSWORD=client_password)},
            {"type": "input_image", "image_url": f"data:image/png;base64,{screenshot_b64}"},
        ],
    }]

    response, cost = call_openai_cua(client, history_inputs, screen_width, screen_height)
    total_cost = cost
    logger.info(f"Cost: ${cost:.6f} | Total Cost: ${total_cost:.6f}")
    step_no = 0
    
    reasoning_list = []
    reasoning = ""

    # 1 / iterative dialogue
    while step_no < max_steps:
        step_no += 1
        history_inputs += _to_input_items(response.output)

        # --- robustly pull out computer_call(s) ------------------------------
        calls: List[Dict[str, Any]] = []
        # completed = False
        breakflag = False
        for i, o in enumerate(response.output):
            typ = o["type"] if isinstance(o, dict) else getattr(o, "type", None)
            if not isinstance(typ, str):
                typ = str(typ).split(".")[-1]
            if typ == "computer_call":
                calls.append(o if isinstance(o, dict) else o.model_dump())
            elif typ == "reasoning" and len(o.summary) > 0:
                reasoning = o.summary[0].text
                reasoning_list.append(reasoning)
                logger.info(f"[Reasoning]: {reasoning}")
            elif typ == 'message':
                if 'TERMINATE' in o.content[0].text:
                    reasoning_list.append(f"Final output: {o.content[0].text}")
                    reasoning = "My thinking process\n" + "\n- ".join(reasoning_list) + '\nPlease check the screenshot and see if it fulfills your requirements.'
                    breakflag = True
                    break
                if 'IDK' in o.content[0].text:
                    reasoning = f"{o.content[0].text}. I don't know how to complete the task. Please check the current screenshot."
                    breakflag = True
                    break
                try:
                    json.loads(o.content[0].text)
                    history_inputs.pop(len(history_inputs) - len(response.output) + i)
                    step_no -= 1
                except Exception as e:
                    logger.info(f"[Message]: {o.content[0].text}")
                    if '?' in o.content[0].text:
                        history_inputs += [{
                            "role": "user",
                            "content": [
                                {"type": "input_text", "text": DEFAULT_REPLY},
                            ],
                        }]
                    elif "{" in o.content[0].text and "}" in o.content[0].text:
                        history_inputs.pop(len(history_inputs) - len(response.output) + i)
                        step_no -= 1
                    else:
                        logger.info(f"[Message]: {o.content[0].text}")
                        history_inputs.pop(len(history_inputs) - len(response.output) + i)
                        reasoning = o.content[0].text
                        reasoning_list.append(reasoning)
                        step_no -= 1

        if breakflag:
            break

        for action_call in calls:
            py_cmd = _cua_to_pyautogui(action_call["action"])

            # --- execute in VM ---------------------------------------------------
            obs, *_ = env.step(py_cmd, sleep_after_execution)

            # --- send screenshot back -------------------------------------------
            screenshot_b64 = base64.b64encode(obs["screenshot"]).decode("utf-8")
            with open(os.path.join(save_path, f"step_{step_no}.png"), "wb") as f:
                f.write(obs["screenshot"])
            history_inputs += [{
                "type": "computer_call_output",
                "call_id": action_call["call_id"],
                "output": {
                    "type": "computer_screenshot",
                    "image_url": f"data:image/png;base64,{screenshot_b64}",
                },
            }]
            if "pending_safety_checks" in action_call and len(action_call.get("pending_safety_checks", [])) > 0:
                history_inputs[-1]['acknowledged_safety_checks'] = [
                    {
                        "id": psc["id"],
                        "code": psc["code"],
                        "message": "Please acknowledge this warning if you'd like to proceed."
                    }
                    for psc in action_call.get("pending_safety_checks", [])
                ]
        
        # truncate history inputs while preserving call_id pairs
        if len(history_inputs) > truncate_history_inputs:
            original_history = history_inputs[:]
            history_inputs = [history_inputs[0]] + history_inputs[-truncate_history_inputs:]
            
            # Find all call_ids in the truncated history
            call_ids_in_truncated = set()
            for item in history_inputs:
                if isinstance(item, dict) and 'call_id' in item:
                    call_ids_in_truncated.add(item['call_id'])
            
            # Check if any call_ids are missing their pairs
            call_id_types = {}  # call_id -> list of types that reference it
            for item in history_inputs:
                if isinstance(item, dict) and 'call_id' in item:
                    call_id = item['call_id']
                    item_type = item.get('type', '')
                    if call_id not in call_id_types:
                        call_id_types[call_id] = []
                    call_id_types[call_id].append(item_type)
            
            # Find unpaired call_ids (should have both computer_call and computer_call_output)
            unpaired_call_ids = []
            for call_id, types in call_id_types.items():
                # Check if we have both call and output
                has_call = 'computer_call' in types
                has_output = 'computer_call_output' in types
                if not (has_call and has_output):
                    unpaired_call_ids.append(call_id)
            
            # Add missing pairs from original history while preserving order
            if unpaired_call_ids:
                # Find missing paired items in their original order
                missing_items = []
                for item in original_history:
                    if (isinstance(item, dict) and 
                        item.get('call_id') in unpaired_call_ids and 
                        item not in history_inputs):
                        missing_items.append(item)
                
                # Insert missing items back, preserving their original order
                # We need to find appropriate insertion points to maintain chronology
                for missing_item in missing_items:
                    # Find the best insertion point based on original history order
                    original_index = original_history.index(missing_item)
                    
                    # Find insertion point in truncated history
                    insert_pos = len(history_inputs)  # default to end
                    for i, existing_item in enumerate(history_inputs[1:], 1):  # skip first item (initial prompt)
                        if existing_item in original_history:
                            existing_original_index = original_history.index(existing_item)
                            if existing_original_index > original_index:
                                insert_pos = i
                                break
                    
                    history_inputs.insert(insert_pos, missing_item)

        response, cost = call_openai_cua(client, history_inputs, screen_width, screen_height)
        total_cost += cost
        logger.info(f"Cost: ${cost:.6f} | Total Cost: ${total_cost:.6f}")
    
    logger.info(f"Total cost for the task: ${total_cost:.4f}")
    history_inputs[0]['content'][1]['image_url'] = "<image>"
    for item in history_inputs:
        if item.get('type', None) == 'computer_call_output':
            item['output']['image_url'] = "<image>"
    return history_inputs, reasoning, total_cost

