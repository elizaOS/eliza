from typing import Dict, List, Optional, Tuple

import time
from pathlib import Path
import uuid

import copy
import json
from mm_agents.mobileagent_v3.mobile_agent_modules import (
    InfoPool,
    Manager,
    Executor,
    Grounding,
    Reflector
)

import dataclasses
from dataclasses import dataclass, field, asdict

@dataclasses.dataclass()
class JSONAction:
    action_type: Optional[str] = None
    action_code: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    text: Optional[str] = None
    clear: Optional[int] = None
    time: Optional[int] = None
    value: Optional[float] = None
    key_list: Optional[list] = None


def convert_xy(x, y):
    x_ = x * 1920 / 1932
    y_ = y * 1080 / 1092
    return x_, y_


def convert_fc_action_to_json_action_grounding(
        dummy_action, grounding_model, image_list, grounding_info=""
): # -> json_action.JSONAction:

        action_json = json.loads(dummy_action)
        action_type = action_json['action']
        
        x = None
        y = None
        text = None
        clear=None
        value=None
        time=None
        key_list = None
        action_code = ""

        if 'element_description' in action_json:
            [x, y], grounding_messages = grounding_model.predict(grounding_info+action_json['element_description'], image_list)
        elif "element1_description" in action_json:
            [x1, y1], grounding_messages1 = grounding_model.predict(grounding_info+action_json['element1_description'], image_list)
            [x2, y2], grounding_messages2 = grounding_model.predict(grounding_info+action_json['element2_description'], image_list)
            grounding_messages = [grounding_messages1, grounding_messages2]
        else:
            grounding_messages = None

        if action_type == 'click':
            x, y = convert_xy(x, y)
            action_code = f"import pyautogui; pyautogui.click(x={x}, y={y})"
        elif action_type == 'double_click':
            x, y = convert_xy(x, y)
            action_code = f"import pyautogui; pyautogui.doubleClick(x={x}, y={y})"
        elif action_type == 'right_click':
            x, y = convert_xy(x, y)
            action_code = f"import pyautogui; pyautogui.rightClick(x={x}, y={y})"
        elif action_type == 'type':
            x, y = convert_xy(x, y)
            text = action_json['text']
            if "\n" in text and "\\n" not in text:
                text = text.replace("\n", "\\n")
            clear = action_json['clear']
            enter = action_json['enter']
            action_code = f"import pyautogui; pyautogui.click(x={x}, y={y}); " 
            if clear > 0:
                action_code += "pyautogui.hotkey('ctrl', 'a'); pyautogui.press('delete'); "
            action_code += f"pyautogui.typewrite('{text}', interval=1.0)"
            if enter > 0:
                action_code += "; pyautogui.press('enter')"
        elif action_type == 'hotkey':
            key_list = action_json['keys']
            key_list_str = "'" + "', '".join(key_list) + "'"
            action_code = f"import pyautogui; pyautogui.hotkey({key_list_str})"
        elif action_type == 'scroll':
            x, y = convert_xy(x, y)
            value = action_json['value']
            action_code = f"import pyautogui; pyautogui.moveTo({x}, {y}); pyautogui.scroll({value})"
        elif action_type == 'wait':
            time = action_json['time']
            action_code = f"import time; time.sleep({time})"
        elif action_type == 'done':
            action_type = 'done'
            action_code = "DONE"
        
        elif action_type == 'drag':
            x1, y1 = convert_xy(x1, y1)
            x2, y2 = convert_xy(x2, y2)
            action_code = f"import pyautogui; "
            action_code += f"pyautogui.moveTo({x1}, {y1}); "
            action_code += f"pyautogui.dragTo({x2}, {y2}, duration=1.); pyautogui.mouseUp(); "
        
        return JSONAction(
                    action_type=action_type,
                    x=x,
                    y=y,
                    text=text,
                    clear=clear,
                    value=value,
                    time=time,
                    key_list=key_list,
                    action_code=action_code
                ), grounding_messages


def convert_fc_action_to_json_action(
        dummy_action
): # -> json_action.JSONAction:
 
        action_json = json.loads(dummy_action)
        action_type = action_json['action']
        
        x = None
        y = None
        text = None
        clear=None
        value=None
        time=None
        key_list = None
        action_code = ""

        if action_type == 'click':
            x, y = action_json['coordinate'][0], action_json['coordinate'][1]
            x, y = convert_xy(x, y)
            action_code = f"import pyautogui; pyautogui.click(x={x}, y={y})"
        elif action_type == 'double_click':
            x, y = action_json['coordinate'][0], action_json['coordinate'][1]
            x, y = convert_xy(x, y)
            action_code = f"import pyautogui; pyautogui.doubleClick(x={x}, y={y})"
        elif action_type == 'right_click':
            x, y = action_json['coordinate'][0], action_json['coordinate'][1]
            x, y = convert_xy(x, y)
            action_code = f"import pyautogui; pyautogui.rightClick(x={x}, y={y})"
        elif action_type == 'type':
            x, y = action_json['coordinate'][0], action_json['coordinate'][1]
            x, y = convert_xy(x, y)
            text = action_json['text']
            if "\n" in text and "\\n" not in text:
                text = text.replace("\n", "\\n")
            clear = action_json['clear']
            enter = action_json['enter']
            action_code = f"import pyautogui; pyautogui.click(x={x}, y={y}); " 
            if clear > 0:
                action_code += "pyautogui.hotkey('ctrl', 'a'); pyautogui.press('delete'); "
            action_code += f"pyautogui.typewrite('{text}', interval=1.0)"
            if enter > 0:
                action_code += "; pyautogui.press('enter')"
        elif action_type == 'hotkey':
            key_list = action_json['keys']
            key_list_str = "'" + "', '".join(key_list) + "'"
            action_code = f"import pyautogui; pyautogui.hotkey({key_list_str})"
        elif action_type == 'scroll':
            x, y = action_json['coordinate'][0], action_json['coordinate'][1]
            x, y = convert_xy(x, y)
            value = action_json['value']
            action_code = f"import pyautogui; pyautogui.moveTo({x}, {y}); pyautogui.scroll({value})"
        elif action_type == 'wait':
            time = action_json['time']
            action_code = f"import time; time.sleep({time})"
        elif action_type == 'done':
            action_type = 'done'
            action_code = "DONE"
        
        elif action_type == 'drag':
            x1, y1 = action_json['coordinate'][0], action_json['coordinate'][1]
            x1, y1 = convert_xy(x1, y1)
            x2, y2 = action_json['coordinate2'][0], action_json['coordinate2'][1]
            x2, y2 = convert_xy(x2, y2)
            action_code = f"import pyautogui; "
            action_code += f"pyautogui.moveTo({x1}, {y1}); "
            action_code += f"pyautogui.dragTo({x2}, {y2}, duration=1.); pyautogui.mouseUp(); "
        
        return JSONAction(
                    action_type=action_type,
                    x=x,
                    y=y,
                    text=text,
                    clear=clear,
                    value=value,
                    time=time,
                    key_list=key_list,
                    action_code=action_code
                )


INIT_TIPS = '''
General:
- If you see the "can't update chrome" popup, click the nearby X to close the prompt. Be sure not to click the "reinstall chrome" button.
- If you want to perform scroll action, 5 or -5 is an appropriate choice for `value` parameter.
- My computer's password is 'osworld-public-evaluation', feel free to use it when you need sudo rights.

Chrome:
- If the Chrome browser page is not maximized, you can use the alt+f10 shortcut to maximize the window, thereby displaying more information.
- If you cannot find the element you want to click on the current webpage, you can use the search function provided by the webpage (usually a search box or a magnifying glass icon), or directly search with appropriate keywords in the Google search engine.
'''

from datetime import datetime
import os


class MobileAgentV3:
    def __init__(
            self,
            manager_engine_params: Dict,
            operator_engine_params: Dict,
            reflector_engine_params: Dict,
            grounding_enging_params: Dict,
            wait_after_action_seconds: float = 3.0
    ):
        self.manager_engine_params = manager_engine_params
        self.operator_engine_params = operator_engine_params
        self.reflector_engine_params = reflector_engine_params
        self.grounding_enging_params = grounding_enging_params

        self.wait_after_action_seconds = wait_after_action_seconds
        
        # init info pool
        self.info_pool = InfoPool(
            additional_knowledge=copy.deepcopy(INIT_TIPS),
            err_to_manager_thresh=2
        )
        
        now = datetime.now()
        time_str = now.strftime("%Y%m%d_%H%M%S")


    def reset(self):
        self.info_pool = InfoPool(
            additional_knowledge=copy.deepcopy(INIT_TIPS),
            err_to_manager_thresh=2
        )

        now = datetime.now()
        time_str = now.strftime("%Y%m%d_%H%M%S")
        

    def step(self, instruction: str, env, args):
        ## init agents ## 
        manager = Manager(self.manager_engine_params)
        executor = Executor(self.operator_engine_params)
        reflector = Reflector(self.reflector_engine_params)
        
        global_state = {}
            
        message_manager, message_operator, message_reflector = None, None, None
        
        self.info_pool.instruction = instruction
        step_idx = len(self.info_pool.action_history)

        print('----------step ' + str(step_idx + 1))

        observation = env._get_obs()
        before_screenshot = observation['screenshot']

        self.info_pool.width = 1920
        self.info_pool.height = 1080

        ## check error escalation
        self.info_pool.error_flag_plan = False
        err_to_manager_thresh = self.info_pool.err_to_manager_thresh
        if len(self.info_pool.action_outcomes) >= err_to_manager_thresh:
            # check if the last err_to_manager_thresh actions are all errors
            latest_outcomes = self.info_pool.action_outcomes[-err_to_manager_thresh:]
            count = 0
            for outcome in latest_outcomes:
                if outcome in ["B", "C"]:
                    count += 1
            if count == err_to_manager_thresh:
                self.info_pool.error_flag_plan = True

        skip_manager = False
        ## if previous action is invalid, skip the manager and try again first ##
        if not self.info_pool.error_flag_plan and len(self.info_pool.action_history) > 0:
            if self.info_pool.action_history[-1]['action'] == 'invalid':
                skip_manager = True
            
        if not skip_manager:
            print("\n### Manager ... ###\n")

            rag_info = ""
            if args.enable_rag > 0:
                rag_dict = json.load(open(args.rag_path, 'r'))
                rag_info = rag_dict[instruction]

            guide = ""
            if args.guide_path != "":
                guide_dict = json.load(open(args.guide_path, 'r'))
                if instruction in guide_dict:
                    guide = guide_dict[instruction]

            planning_start_time = time.time()
            prompt_planning = manager.get_prompt(self.info_pool, args, rag_info, guide)
            output_planning, message_manager = manager.predict(prompt_planning, [before_screenshot])
            
            global_state['manager'] = {
                'name': 'manager',
                'messages': message_manager,
                'response': output_planning
            }
            
            parsed_result_planning = manager.parse_response(output_planning)
            self.info_pool.plan = parsed_result_planning['plan']
            self.info_pool.current_subgoal = parsed_result_planning['current_subgoal']
            planning_end_time = time.time()

            print('\n\nPlan: ' + self.info_pool.plan)
            print('Current subgoal: ' + self.info_pool.current_subgoal)
            print('Planning thought: ' + parsed_result_planning['thought'], "\n")

        ## if stopping by planner ##
        if "Finished" in self.info_pool.current_subgoal.strip():
            self.info_pool.finish_thought = parsed_result_planning['thought']
            action_thought = "Finished by planner"
            action_object_str = "{\"action\": \"done\"}"
            action_description = "Finished by planner"
        
        else:
            print("\n### Operator ... ###\n")
            action_decision_start_time = time.time()
            prompt_action = executor.get_prompt(self.info_pool, args.grounding_stage)
            output_action, message_operator = executor.predict(prompt_action, [before_screenshot])

            parsed_result_action = executor.parse_response(output_action)
            action_thought, action_object_str, action_description = parsed_result_action['thought'], parsed_result_action['action'], parsed_result_action['description']
            action_decision_end_time = time.time()

            action_object_str = action_object_str.split('```json')[-1].split('```')[0]
            self.info_pool.last_action_thought = action_thought
            self.info_pool.last_summary = action_description

            # If the output is not in the right format, add it to step summary which
            # will be passed to next step and return.
            if (not action_thought) or (not action_object_str):
                print('Action prompt output is not in the correct format.')
                self.info_pool.last_action = {"action": "invalid"}
                self.info_pool.action_history.append({"action": "invalid"})
                self.info_pool.summary_history.append(action_description)
                self.info_pool.action_outcomes.append("C") # no change
                self.info_pool.error_descriptions.append("invalid action format, do nothing.")
                return global_state, None, False, None, False
        
        print('\n\nThought: ' + action_thought)
        print('Action: ' + action_object_str)
        print('Action description: ' + action_description, '\n\n')

        format_action_object_str = action_object_str

        operator_response = f'''### Thought ###
{action_thought}

### Action ###
{format_action_object_str}

### Description ###
{action_description}'''
        global_state['operator'] = {
            'name': 'operator',
            'messages': message_operator,
            'response': operator_response
        }

        try:
            if args.grounding_stage > 0:
                grouding_model = Grounding(self.grounding_enging_params)
                if args.grounding_info_level == 0:
                    converted_action, grounding_messages = convert_fc_action_to_json_action_grounding(action_object_str, grouding_model, [before_screenshot])
                elif args.grounding_info_level == 1:
                    grounding_info = "Thought: " + action_thought + "\nElement description: "
                    converted_action, grounding_messages = convert_fc_action_to_json_action_grounding(action_object_str, grouding_model, [before_screenshot], grounding_info)
                if grounding_messages is not None:
                    global_state['grounding'] = {
                        'name': 'grounding',
                        'messages': grounding_messages,
                    }
            else:
                converted_action = convert_fc_action_to_json_action(action_object_str)

        except Exception as e:
            print('Failed to convert the output to a valid action.')
            print(str(e))
            self.info_pool.last_action = {"action": "invalid"}
            self.info_pool.action_history.append({"action": "invalid"})
            self.info_pool.summary_history.append(action_description)
            self.info_pool.action_outcomes.append("C") # no change
            self.info_pool.error_descriptions.append("invalid action format, do nothing.")
            return global_state, action_object_str, False, None, False

        if converted_action.action_type == 'done':
            outcome = "A"
            error_description = "None"

            self.info_pool.last_action = json.loads(action_object_str)
            self.info_pool.action_history.append(json.loads(action_object_str))
            self.info_pool.summary_history.append(action_description)
            self.info_pool.action_outcomes.append(outcome) # no change
            self.info_pool.error_descriptions.append(error_description)
            return global_state, converted_action.action_code, True, None, True
            
        try:
            if len(self.info_pool.action_history) >= args.max_trajectory_length-1:
                converted_action.action_code = 'FAIL'
            obs, env_reward, env_done, env_info = env.step(converted_action.action_code, self.wait_after_action_seconds)

        except Exception as e:
            print('Failed to execute action.')
            print(str(e))
            self.info_pool.last_action = json.loads({"action": "invalid"})
            self.info_pool.action_history.append({"action": "invalid"})
            self.info_pool.summary_history.append(action_description)
            self.info_pool.action_outcomes.append("C") # no change
            self.info_pool.error_descriptions.append(f"Failed to execute the action: {converted_action}")
            return global_state, converted_action.action_code, False, None, False

        print("Done action execution.\n")
        self.info_pool.last_action = json.loads(action_object_str)

        after_screenshot = obs['screenshot']

        print("\n### Reflector ... ###\n")
        if converted_action.action_type != 'answer':
            action_reflection_start_time = time.time()
            prompt_action_reflect = reflector.get_prompt(self.info_pool)
            output_action_reflect, message_reflector = reflector.predict(prompt_action_reflect, [before_screenshot, after_screenshot])

            global_state['reflector'] = {
                'name': 'reflector',
                'messages': message_reflector,
                'response': output_action_reflect
            }
            
            parsed_result_action_reflect = reflector.parse_response(output_action_reflect)
            outcome, error_description, progress_status = (
                    parsed_result_action_reflect['outcome'], 
                    parsed_result_action_reflect['error_description'], 
                    parsed_result_action_reflect['progress_status']
            )
            action_reflection_end_time = time.time()

            if "A" in outcome: # Successful. The result of the last action meets the expectation.
                action_outcome = "A"
            elif "B" in outcome: # Failed. The last action results in a wrong page. I need to return to the previous state.
                action_outcome = "B"
            elif "C" in outcome: # Failed. The last action produces no changes.
                action_outcome = "C"
            else:
                raise ValueError("Invalid outcome:", outcome)
        
        print('\n\nAction reflection outcome: ' + action_outcome)
        print('Action reflection error description: ' + error_description)
        print('Action reflection progress status: ' + progress_status, "\n")

        self.info_pool.action_history.append(json.loads(action_object_str))
        self.info_pool.summary_history.append(action_description)
        self.info_pool.action_outcomes.append(action_outcome)
        self.info_pool.error_descriptions.append(error_description)
        self.info_pool.progress_status = progress_status
        self.info_pool.progress_status_history.append(progress_status)

        return global_state, converted_action.action_code, True, env_reward, env_done
