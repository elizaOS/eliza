import json
import logging
import os
import time
from typing import Any, Dict, List, Tuple, Callable
from desktop_env.desktop_env import DesktopEnv
from openai import OpenAI
from mm_agents.gta1.format_message import FormatMessage
from mm_agents.gta1.cua_tool import response_api_tools as CUA_TOOLS
import inspect
import concurrent.futures
import re
from mm_agents.utils.qwen_vl_utils import smart_resize
from mm_agents.gta1.gta1_agent import OSWorldACI
import httpx
import numpy as np
from PIL import Image
from io import BytesIO
from mm_agents.gta1.format_message import encode_numpy_image_to_base64, encode_image_bytes


GTA1_SERVICE_URL=os.getenv("GTA1_SERVICE_URL",None)

GTA1_GROUNDING_SYSTEM_PROMPT=(
    "You are a GUI agent. You are given a task and a screenshot of the screen. "
    "You need to perform a series of pyautogui actions to complete the task."
)

CUA_SYSTEM_PROMPT_GPT5 = """# Role and Objective
- An agent with strong computer knowledge and a good internet connection, designed to execute desktop computer tasks on Ubuntu precisely as instructed by the user.
- Assumes tool calls will run to control the computer.
- Has access to all its reasoning and knowledge for use in tasks.

# Instructions
- Begin each user task with a concise checklist (3–7 items) of conceptual, non-implementation sub-tasks.
- Revise the sub-tasks checklist as the task progresses, based on the latest screenshot and previous actions.
- Interact solely using the provided tool actions; do not invent or assume any unlisted methods. Use only tools explicitly listed in the available actions for every step.
- Base every action on observable elements in the latest screenshot; never anticipate or assume elements not yet present or visible.
- For each step, you will receive a new screenshot, tool execution results, and the remaining number of steps allowed in the user task.
- If an option or input is not specified in the user task (e.g., creating a new file without specifying a name), use the default settings.

## Action Execution Guidelines
- Execute exactly one tool call per interaction.
- Prefer the `hotkey` action (tool call) over `click` or `drag_and_drop` where possible.
- For spreadsheet value or formula changes in LibreOffice Calc, Writer, Impress, always use `set_cell_values` for both single-cell and multi-cell value or formula editing.
- When highlighting text, use only the `highlight_text_span` or `hotkey` (tool calls).
- Dismiss "Authentication required" prompts by clicking "Cancel".
- All tool calls are permitted within the provided action list; do not attempt actions outside this set.

# Additional Information
- Leave windows/applications open at task completion.
- Upon fully completing the user's task, briefly summarize results if applicable, then return `TERMINATE`.
- **Feasibility First**: Confirm the task can be completed with available files, applications, and environments before starting.
- **Strict Adherence**: Only perform actions the user has explicitly requested; avoid unnecessary steps.
- **Completion Criteria**: Only return "TERMINATE" when all user requirements are met in full.
- **Impossibility Handling**: Return "INFEASIBLE" if completion is blocked by environmental constraints.
- **Screenshot Verification**: Always check the screenshot before proceeding.

# Additional Rules
- The sudo password is "{CLIENT_PASSWORD}"; use it if sudo privileges are required.
- Leave all windows and applications open after completing the task.
- Only use `TERMINATE` when all user requirements have been fully satisfied; provide a brief summary of results if applicable.
- Before proceeding, confirm that the task is feasible with the currently available files, applications, and environment; if it is impossible to complete due to environmental constraints, return `INFEASIBLE`.
- Strictly follow user instructions, avoiding unnecessary or extraneous steps.
- Always review the latest screenshot before every action.

# Execution Procedure
- Briefly review prior actions, the current checklist, and the latest screenshot before each tool call.
- Before each action, state in one line the purpose and required minimal inputs.
- After each action, validate the result in 1–2 lines using the updated screenshot. If the action was unsuccessful, adapt your approach before proceeding.
- Only return the selected action(s); do not elaborate or output other information.
- Work deliberately and avoid unnecessary or extraneous steps; strictly adhere to user instructions.

Proceed methodically and efficiently, ensuring all user requirements are met before terminating."""

CUA_START_MESSAGE = """
Please check the screenshot and see if the task is impossible to complete due to environmental constraints. If it is, reply with 'INFEASIBLE'.
If it is possible to complete, please complete the task, and before making any tool call, you should reasoning the next move according to the UI screenshot and instruction, while refer to the previous actions (tool calls), screenshots, and observations for reflection.

User task:
{instruction}

""".strip()


CUA_DEFAULT_REPLY = """Note the user task is:

{instruction}

If you have completed the user task, reply with 'TERMINATE'.
If the task is impossible to complete due to environmental constraints, reply with 'INFEASIBLE'."""


GTA1_JUDGE_SYSTEM_PROMPT='''# Role and Objective
Assess the planning and reasoning of a UI agent to determine the most effective action for advancing toward a specified task goal. You may use the computer password '{CLIENT_PASSWORD}' during this process if needed.

# Workflow Checklist
Begin each assessment by generating a concise checklist (adapt as appropriate for task complexity) of evaluation steps to ensure a systematic and methodical analysis.
# Inputs
For each assessment, you will receive:
- The task goal
- The history of planning and actions performed
- A current UI screenshot
- A list of {N_PLANNING} alternative planning approaches for achieving the goal, in the current context. Each approach will be formatted as:
    - Thought: <summary, goal, screenshot observation>
    - Action: <proposed UI action>

# Action Function Definition
Actions are formatted as function calls. The specification for these calls is provided here:
{FUNCTION_CALL_DEFINITION}

# Assessment Criteria
- Correctness: Does the proposed action logically advance the goal?
- Effectiveness: Is immediate progress made?
- Alignment: Does it support both the step and overall objective?
- Planning Quality: Reasoning is clear, concise, and logical.
- Appropriateness: Action is valid/executable in the current context.
- Matchness: Does the action correspond exactly to names/nouns in the user task? Avoid generalization or conflation.
- Exactness: Does the action relate to the user task? No extra or unnecessary steps are performed.
- Completeness: If terminate, does the action complete the user task?

Be aware that some planning approaches may be similar—evaluate each on its own merits, and do not allow the frequency of similar approaches to bias your assessment.
Carefully assess each approach and select the best one based on the above criteria.

# Output Format
Produce a single, strictly valid JSON object with the following fields:
- `explaining` (string, required): A concise (1–4 sentences) justification for why the chosen approach is optimal in light of the assessment criteria; or, if none are effective, briefly explain why.
- `index` (integer, required): The 0-based index (0, 1, ..., {N_INDEX}) identifying the best approach. You must choose one of the approaches.
Do not output anything except the required JSON object.

**Carefully evaluate each approach and select the best one based on the criteria.**'''

def make_single_request(client: OpenAI, logger: logging.Logger, *args, **kwargs):
    for retry in range(10):
        try:
            response = client.responses.create(
                *args,
                **kwargs
            )
            response.output_text
            return response
        except Exception as e:
            if os.getenv("VERBOSEDEBUG", None) is not None:
                print(f"Error in response.create: {e}")
            time.sleep(min(retry**2, 16))
    return None

def extract_answer_from_response(response):
    if not response or not isinstance(response, str):
        raise ValueError("Response must be a non-empty string")
    json_pattern = r'```json\s*(.*?)\s*```'
    json_match = re.search(json_pattern, response, re.DOTALL)
    
    if json_match:
        json_str = json_match.group(1)
        try:
            answer = json.loads(json_str)
            if "explaining" in answer and "index" in answer:
                answer["index"] = int(answer["index"])
                return answer
            else:
                raise ValueError("JSON missing required fields 'explaining' or 'index'")
                
        except json.JSONDecodeError:
            pass
    
    direct_json_pattern = r'\{[\s\S]*?"explaining"[\s\S]*?"index"[\s\S]*?\}'
    direct_match = re.search(direct_json_pattern, response)
    
    if direct_match:
        try:
            json_str = direct_match.group(0)
            json_str = json_str.replace(''', "'").replace(''', "'").replace('"', '"').replace('"', '"')
            answer = json.loads(json_str)
            answer["index"] = int(answer["index"])
            return answer
        except json.JSONDecodeError:
            pass
    index_pattern = r'"index"\s*:\s*(\d+)'
    index_match = re.search(index_pattern, response)
    
    explaining_pattern = r'"explaining"\s*:\s*"(.*?)"(?=,|\s*})'
    explaining_match = re.search(explaining_pattern, response, re.DOTALL)
    
    if not explaining_match:
        explaining_pattern = r'"explaining"\s*:\s*(.*?)(?=,\s*"index"|\s*})'
        explaining_match = re.search(explaining_pattern, response, re.DOTALL)
    
    if index_match and explaining_match:
        return {
            "index": int(index_match.group(1)),
            "explaining": explaining_match.group(1).strip('" \t\n')
        }
    if index_match:
        return {
            "index": int(index_match.group(1)),
            "explaining": "Explanation not found in response"
        }
    raise ValueError("Could not extract valid answer from response")

def select_response(summary_info, responses, client_password):  
    summary_info, curr_obs, instruction = summary_info
    
    MAX_RETRY_TIMES = 10

    system_promt = GTA1_JUDGE_SYSTEM_PROMPT.format(N_PLANNING=len(responses), N_INDEX=len(responses)-1, CLIENT_PASSWORD=client_password, FUNCTION_CALL_DEFINITION=json.dumps(CUA_TOOLS,indent=2))

    message_formater = FormatMessage()
    messages = [
        message_formater.create_system_message(system_promt),
        message_formater.create_user_message(text=f"The goal of the task is:\n{instruction}\n\n\n"),
        
    ]

    if len(summary_info) == 0:
        messages.append(message_formater.create_user_message(text=f"No history available. The action just started.\n"))
    else:
        for idx, (curr_obs, action_call, content_text) in enumerate(summary_info):
            name = action_call['name']
            args = action_call['arguments']
            action = f"{name}({args})"
            if os.getenv("JUDGE_SCREENSHOT_PROMPT", None) is not None and idx >= len(summary_info) - 5:
                messages.append(message_formater.create_user_message(text=f"\n### {idx} Screenshot before taking the action:\n"))
                messages.append(message_formater.create_user_message(image=curr_obs['screenshot']))
                messages.append(message_formater.create_user_message(text=f"\n"))
            messages.append(message_formater.create_user_message(text=f"### Past step {idx}:\nThought:{content_text}\nAction:{action_call}\n\n\n"))
    messages.append(message_formater.create_user_message(text=f"Here are the different plans to compare:\n"))
    for idx, plan in enumerate(responses):
        messages.append(message_formater.create_user_message(text=f"### Index {idx}:\n{plan}\n\n\n"))

    messages.append(message_formater.create_user_message(text=f"Here are the current screenshot:\n"))
    messages.append(message_formater.create_user_message(image=curr_obs['screenshot']))
    messages.append(message_formater.create_user_message(text=f"Here are the different plans to compare for completing the task:\n"))
    for idx, rsp in enumerate(responses):
        content_text = rsp.output_text
        action = "No Action is performed."
        for i, o in enumerate(rsp.output):
            typ = o["type"] if isinstance(o, dict) else getattr(o, "type", None)
            if typ == 'function_call':
                name = o.name
                args = json.loads(o.arguments)
                action = f"{name}({args})"
                break
        messages.append(message_formater.create_user_message(text=f"### Index {idx}:\nThought:{content_text}\nAction:{action}\n\n\n"))

    messages.append(message_formater.create_user_message(text=f"Please select the best plan to complete the task."))

    if os.getenv("X_API_KEY") and os.getenv("X_API_URL"):
        client = OpenAI(base_url=os.getenv("X_API_URL"), api_key="dummy", default_headers = {"X-Api-Key": os.getenv("X_API_KEY")})
    else:
        client = OpenAI()
    wait = 1
    for _ in range(MAX_RETRY_TIMES):
        try:
            prediction = client.responses.create(
                model="gpt-5",
                input=messages,
                reasoning={"effort": "high"}, 
                max_output_tokens=4096 * 4,
                timeout=100,
            )
            prediction = prediction.output_text
            if os.getenv("VERBOSEDEBUG", None) is not None:
                print(f"Prediction: {prediction}")
            prediction = extract_answer_from_response(prediction)
            return responses[prediction['index']]
        except:
            time.sleep(wait)
            wait *=2
            wait = min(wait,16)
            continue
    return responses[0]

def call_openai_cua(client: OpenAI,
                    history_inputs: list,
                    cua_model: str,
                    logger: logging.Logger = None,
                    tts_step: int = 1,
                    summary_info: List[Any] = None,
                    client_password: str = "",
                    ) -> Tuple[Any, float]:
    retry = 0
    response = None
    if tts_step == 1:
        response = make_single_request(client, logger,
                                    model=cua_model, 
                                    tools=CUA_TOOLS, 
                                    parallel_tool_calls=False, 
                                    reasoning={"effort": "high"}, 
                                    max_output_tokens=4096 * 4, 
                                    input=history_inputs, 
                                    timeout=500)
    else:
        potential_responses = []
        retry = 0
        while len(potential_responses) < tts_step and retry < 5:
            retry += 1
            with concurrent.futures.ThreadPoolExecutor(max_workers=tts_step-len(potential_responses)) as executor:
                futures = [executor.submit(make_single_request, client, logger,
                                         model=cua_model, 
                                         tools=CUA_TOOLS, 
                                         parallel_tool_calls=False, 
                                         reasoning={"effort": "high"}, 
                                         max_output_tokens=4096 * 4, 
                                         input=history_inputs, 
                                         timeout=500) for _ in range(tts_step-len(potential_responses))]
                responses = [future.result() for future in concurrent.futures.as_completed(futures)]
            responses = [response for response in responses if response is not None]
            potential_responses.extend(responses)
        responses = potential_responses
        if os.getenv("VERBOSEDEBUG", None) is not None:
            print(f"Responses: {responses}")
        response = select_response(summary_info,responses,client_password)
    return response

def _tool_call_to_pyautogui(agent: OSWorldACI,
                            action_call: Dict[str, Any],
                            obs: Dict[str, Any],
                            request_vllm: Callable,
                            logger: logging.Logger = None) -> Tuple[str, str]:
    tool_output = "Action (tool call) is executed. For your reference, you have maximum of {max_steps} steps, and current step is {step_no} out of {max_steps}."
    method = None
    try:
        name = action_call['name']
        args = action_call['arguments']
        # Default: no coordinates needed
        agent.coords1, agent.coords2 = None, None

        # Compute coordinates for description-based actions
        if name == "click" and isinstance(args.get("instruction"), str):
            agent.coords1 = agent.generate_coords(args["instruction"], obs, request_vllm)
        elif name == "type":
            element_description = args.get("element_description")
            if isinstance(element_description, str) and element_description:
                agent.coords1 = agent.generate_coords(element_description, obs, request_vllm)
        elif name == "scroll" and isinstance(args.get("instruction"), str):
            agent.coords1 = agent.generate_coords(args["instruction"], obs, request_vllm)
        elif name == "drag_and_drop":
            sd = args.get("starting_description")
            ed = args.get("ending_description")
            if isinstance(sd, str) and isinstance(ed, str):
                agent.coords1 = agent.generate_coords(sd, obs, request_vllm)
                agent.coords2 = agent.generate_coords(ed, obs, request_vllm)
        elif name == "highlight_text_span":
            sp = args.get("starting_phrase")
            ep = args.get("ending_phrase")
            if isinstance(sp, str) and isinstance(ep, str):
                agent.coords1 = agent.generate_text_coords(sp, obs, alignment="start")
                agent.coords2 = agent.generate_text_coords(ep, obs, alignment="end")

        # Dispatch to OSWorldACI method to build pyautogui command
        if hasattr(agent, name):
            method = getattr(agent, name)
            # Some arguments may be missing; rely on method defaults
            return method(**args),tool_output
    except Exception as e:
        if os.getenv("VERBOSEDEBUG", None) is not None:
            print(f"Error in _tool_call_to_pyautogui: {e}")
        tool_output = "Error: " + str(e).replace("OSWorldACI.","").strip() 
        if method is not None:
            sig = inspect.signature(method)
            tool_output += f"\nThe tool signature is: {method.__name__}{sig}"

    return "WAIT", tool_output

def request_vllm(image, prompt):
        CLICK_REGEXES = [
        # pyautogui.click(x=123, y=456)
        re.compile(r"click\s*\(\s*x\s*=\s*(\d+)\s*,\s*y\s*=\s*(\d+)\s*\)", re.IGNORECASE),
        # pyautogui.click(123, 456) or click(123,456)
        re.compile(r"click\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)", re.IGNORECASE),
        ]

        def parse_xy_from_text(text: str):
            if "click" not in text.lower():
                return [-1, -1]
            for rx in CLICK_REGEXES:
                m = rx.search(text)
                if m:
                    try:
                        return int(m.group(1)), int(m.group(2))
                    except Exception:
                        continue
            return None

        if isinstance(image, bytes):
            image = np.array(Image.open(BytesIO(image)).convert('RGB'))
        H, W, C = image.shape
        H, W = smart_resize(
            H,
            W,
            factor=28,
            min_pixels=1000,
            max_pixels=1000000000000,
            )
        assert C == 3
        if isinstance(image, np.ndarray):
            image_base64 = encode_numpy_image_to_base64(image)
        elif isinstance(image, bytes):
            image_base64 = encode_image_bytes(image)
        else:
            raise ValueError(f"Invalid image type: {type(image)}")
        messages=[
            {"role": "system", "content": GTA1_GROUNDING_SYSTEM_PROMPT},    
            {
                "role": "user",
                "content": [
                    {
                        "type": "image","image": f"data:image/png;base64,{image_base64}"
                    },
                    {
                        "type": "text",
                        "text": prompt
                    },
                ],
            }]
        base_url = GTA1_SERVICE_URL
        payload = {
            "messages": messages,
            "max_new_tokens": 100,
            "temperature": 0.0,
            "top_p": 0.9,
        }
        for _ in range(10):
            try:
                httpx_client = httpx.Client()
                r = httpx_client.post(f"{base_url}/call_llm", json=payload, timeout=10)
                r.raise_for_status()
                resp = r.json()
                if isinstance(resp, dict):
                    result_items = [resp]
                else:
                    result_items = resp
                first = result_items[0]
                x,y = parse_xy_from_text(first.get("response"))
                x = x/W
                y = y/H
                return x,y
            except:
                if os.getenv("VERBOSEDEBUG", None) is not None:
                    print(resp)
                time.sleep(1)
                continue
        raise RuntimeError(f"Failed to execute grounding")



def _prune_history_images(messages: List[Dict[str, Any]], max_recent_images: int) -> None:
    """Keep only the very first image message and the latest N image messages.

    - Preserves the earliest image-containing message (initial screenshot)
    - Preserves up to `max_recent_images` most recent image messages
    - Removes any other image messages
    """
    try:
        if max_recent_images is None:
            return
        if max_recent_images < 0:
            return

        image_indices: List[int] = []
        for idx, msg in enumerate(messages):
            if isinstance(msg, dict) and isinstance(msg.get('content'), list):
                for blk in msg['content']:
                    if isinstance(blk, dict) and blk.get('type') in ('image_url', 'input_image'):
                        image_indices.append(idx)
                        break

        if len(image_indices) <= 1:
            return  # Zero or one image message — nothing to prune

        first_image_idx = image_indices[0]
        recent_keep: List[int] = image_indices[-max_recent_images:] if max_recent_images > 0 else []
        keep_set = set([first_image_idx] + recent_keep)
        delete_indices = [i for i in image_indices if i not in keep_set]

        # Remove from end to avoid reindexing issues
        if os.getenv("VERBOSEDEBUG", None) is not None:
            print(f"Pruning history images: {delete_indices}")
        for i in sorted(delete_indices, reverse=True):
            messages.pop(i)
    except Exception:
        # Be conservative: never fail the main loop due to pruning
        pass

def run_cua_gpt5gta1(
    env: DesktopEnv,
    instruction: str,
    max_steps: int,
    save_path: str = './',
    sleep_after_execution: float = 0.3,
    client_password: str = "",
    cua_model: str = "gpt-5",
    tts_step: int = 8,
    purge_history_images: int = 8,
    request_vllm: Callable = request_vllm,
    logger: logging.Logger = None,
    **kwargs: Any,
):
    if os.getenv("X_API_KEY"):
        client = OpenAI(base_url=os.getenv("X_API_URL"), api_key="dummy", default_headers = {"X-Api-Key": os.getenv("X_API_KEY")})
    else:
        client = OpenAI()
    agent = OSWorldACI(platform="linux")
    message_formater = FormatMessage()
    default_reply = CUA_DEFAULT_REPLY.format(instruction=instruction)

    # 0 / reset & first screenshot
    os.makedirs(save_path, exist_ok=True)
    obs_bytes = env.controller.get_screenshot()
    with open(os.path.join(save_path, "initial_screenshot.png"), "wb") as f:
        f.write(obs_bytes)
    traj = []
    history_inputs = [
        message_formater.create_system_message(CUA_SYSTEM_PROMPT_GPT5.format(CLIENT_PASSWORD=client_password)),
        message_formater.create_user_message(text=CUA_START_MESSAGE.format(instruction=instruction),image=obs_bytes,image_first=False),
    ]

    curr_obs = {"screenshot": obs_bytes}

    summary_info = []
    step_no = 0
    logger.info(f"--------------------------------CUA Step {step_no+1}--------------------------------")    
    response = call_openai_cua(client, history_inputs, cua_model, logger=logger, tts_step=tts_step, summary_info=[summary_info,curr_obs,instruction], client_password=client_password)
    reasoning = ""
    # 1 / iterative dialogue
    while step_no < max_steps:
        step_no += 1

        # --- extract function calls and handle assistant content -------------
        calls: List[Dict[str, Any]] = []
        content_text = ""
        buffer_history = []

        # Collect function calls from chat completions tool_calls
        for i, o in enumerate(response.output):
            typ = o["type"] if isinstance(o, dict) else getattr(o, "type", None)
            if typ == 'function_call':
                buffer_history.append(o)
                calls.append({
                    'call_id': o.call_id,
                    'name': o.name,
                    'arguments': json.loads(o.arguments),
                })
            elif typ == 'message':
                content_text = o.content[0].text
                if os.getenv("VERBOSEDEBUG", None) is not None:
                    print(content_text)
                buffer_history.append(
                        {"role": o.role, "content": o.content}
                    )
        assert len(calls) <= 1, f"Unexpected assistant content: {content_text} \n {calls}"

        history_inputs.extend(buffer_history)
        for action_call in calls:
            traj.append(action_call)
            logger.info(f"[Action Call]: {action_call}")
            py_cmd, tool_output = _tool_call_to_pyautogui(agent, action_call, curr_obs, request_vllm, logger=logger)
            summary_info.append([curr_obs, action_call, content_text])
            # --- execute in VM ---------------------------------------------------
            obs, *_ = env.step(py_cmd, sleep_after_execution)

            # --- send screenshot back -------------------------------------------
            with open(os.path.join(save_path, f"step_{step_no}.png"), "wb") as f:
                f.write(obs["screenshot"])
            
            history_inputs.append(
                {
                    'type': 'function_call_output',
                    'call_id': action_call['call_id'],
                    'output':tool_output.format(max_steps=max_steps, step_no=step_no) 
                }
            )
            # Provide the screenshot as a separate user message so the model can actually see it
            history_inputs.append(
                message_formater.create_user_message(
                    text=f"Here is the screenshot after the {step_no}-th action (tool call) is executed.",
                    image=obs['screenshot']
                )
            )
            # Prune history to keep first image and at most N latest images
            if purge_history_images > 0:
                _prune_history_images(history_inputs, purge_history_images)
            curr_obs = obs
        # Handle plain assistant content string
        content_text = response.output_text or ''
        if isinstance(content_text, str) and content_text:
            if 'TERMINATE' in content_text:
                traj.append({"type": "TERMINATE"})
                logger.info(f"#Terminate message:\n{content_text}.")
                step_no-=1
                env.step("DONE", sleep_after_execution)
                return "DONE", traj
            elif 'INFEASIBLE' in content_text:
                traj.append({"type": "INFEASIBLE"})
                logger.info(f"Stop reason (unfinished):\n{content_text}.")
                step_no-=1
                env.step("FAIL", sleep_after_execution)
                return "FAIL", traj
            else:
                if len(calls) < 1:
                    step_no-=1
                remaining_steps = max_steps - step_no
                if len(calls) < 1 or remaining_steps <= 1:
                    remind_terminate_message = ""
                    if remaining_steps <= 1:
                        remind_terminate_message = "\n\n\nThe maximum number of steps has been reached. Please check the screenshot. Return 'TERMINATE' if the task is completed, or reply with 'INFEASIBLE' if the task is impossible to complete due to environmental constraints."
                    history_inputs.append(message_formater.create_user_message(text=default_reply + remind_terminate_message))

        assert len(calls) <= 1, f"Unexpected assistant content: {content_text} \n {calls}"
    
        logger.info(f"--------------------------------CUA Step {step_no+1}--------------------------------") 
        response = call_openai_cua(client, history_inputs, cua_model, logger=logger, tts_step=tts_step, summary_info=[summary_info,curr_obs,instruction], client_password=client_password)
    traj.append({"type": "INFEASIBLE"})
    env.step("FAIL", sleep_after_execution)
    return reasoning, traj