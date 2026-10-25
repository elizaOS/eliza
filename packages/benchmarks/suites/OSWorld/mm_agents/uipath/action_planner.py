import datetime
import json
import time
from collections import OrderedDict
from copy import deepcopy

import mm_agents.uipath.llm_client as llm_client
from mm_agents.uipath.types_utils import (
    PlanAction,
    ExecutionState,
    State,
    PlanActionType,
)
from mm_agents.uipath.action_planner_prompt_builder import (
    ComputerUseAgentInterface,
    PlanerCoTSectionsType,
    user_command_template_chat,
    user_task_info_template,
)
from mm_agents.uipath.utils import ValidationException, parse_message_json, ExecutionInfo
from mm_agents.uipath.memory import ShortTermMemoryManager

    
class PlannerOutput(object):
    def __init__(self, plan_action: PlanAction, additional_sections: dict[str, str]):
        self.plan_action = plan_action
        self.thought = additional_sections["thought"]
        self.review = additional_sections["review"]
        self.additional_sections = {key: value for key, value in additional_sections.items() if key not in ["review", "thought"]}


class ActionPlanner(object):
    def __init__(self):
        self.number_history_steps_with_images = 2
        self.computer_use_agent_interface = ComputerUseAgentInterface()
        self.short_term_memory_manager = ShortTermMemoryManager()

    def build_message_output_format_info(self) -> str:
        output_dict = OrderedDict({})
        cot_sections: dict[str, dict] = self.computer_use_agent_interface.get_planner_cot_sections()
        for _, value in cot_sections.items():
            display = value["display"]
            description = value["description"]
            output_dict[display] = description

        output_dict["action"] = "<The action to perform in JSON format as specified in the system message>"

        return json.dumps(output_dict, indent=4, ensure_ascii=False)

    def get_step_content(self, step: dict, following_step: dict | None) -> tuple[str, str]:
        content_dict = OrderedDict({})
        observation_dict = OrderedDict({})

        observation_dict["Performed actions"] = deepcopy(step["actions"])

        def remove_unused_fields(action: list[dict], keys: list[str]):
            for act in action:
                for key in keys:
                    if key in act:
                        del act[key]
        remove_unused_fields(observation_dict["Performed actions"], ["id", "result", "execution_error_message", "detected_items", "description"])

        if "extracted_data" in step["additional_parameters"]:  # if the step was an extraction step add the dummy extraction action
            extraction_action = {
                "type": PlanActionType.ExtractData,
                "description": step["description"],
                "status": "data extracted",
            }
            observation_dict["Performed actions"] = [extraction_action]

        if following_step:
            observation_dict["Observation"] = following_step["additional_parameters"].get("review", None)

        cot_sections = self.computer_use_agent_interface.get_planner_cot_sections()
        for key, value in cot_sections.items():
            if key not in [PlanerCoTSectionsType.Review, PlanerCoTSectionsType.Memory]:
                param_value = step["additional_parameters"].get(key, None)
                display_name = value["display"]
                content_dict[display_name] = param_value
        content_dict["action"] = json.loads(step["additional_parameters"]["plan_action"])

        content_dict = json.dumps(content_dict, indent=4, ensure_ascii=False)
        observation_dict = json.dumps(observation_dict, indent=4, ensure_ascii=False)
        return content_dict, observation_dict

    def build_messages_chat(self, state: State, execution_state: ExecutionState) -> list[dict]:
        execution_info = execution_state.execution_info
        messages = []
        system_message = {
            "role": "system",
            "content": self.computer_use_agent_interface.get_system_prompt(),
        }

        messages.append(system_message)

        start_index = max(0, len(state.previous_steps) - self.number_history_steps_with_images)
        end_index = len(state.previous_steps)

        images_dict = {index: state.previous_steps[index]["image"] for index in range(start_index, end_index)}

        # Don't set it for the first iteration as the history is empty anyway
        user_messages = state.task
        if end_index == 0:
            user_task_with_ref_imgs = ""
            user_messages = [{"type": "text", "text": state.task}]
        else:
            user_task_with_ref_imgs = state.task
            user_messages = [{"type": "text", "text": "Recall the task again:"}, {"type": "text", "text": state.task}]

        user_task_info_message = {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": user_task_info_template.format(
                        task=user_task_with_ref_imgs,
                        current_date=datetime.datetime.now().strftime("%Y-%m-%d"),
                    ),
                }
            ],
        }
        messages.append(user_task_info_message)

        for index in range(0, end_index):
            step = state.previous_steps[index]

            if index >= start_index:
                image = images_dict.get(index, None)

                assert image is not None and len(image) > 0, "Step image is empty"
                user_image_message = {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image}"}},
                    ],
                }
                messages.append(user_image_message)

            assistant_message_text, user_observation = self.get_step_content(
                step, state.previous_steps[index + 1] if index < end_index - 1 else None
            )

            assistant_message = {
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": assistant_message_text,
                    },
                ],
            }
            messages.append(assistant_message)

            user_message_reply = {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": user_observation,
                    },
                ],
            }
            messages.append(user_message_reply)

        memory = json.loads(state.previous_steps[-1]["additional_parameters"].get("memory", "{}")) if len(state.previous_steps) > 0 else {}
        memory_str = json.dumps(memory, indent=4, ensure_ascii=False) if len(memory) > 0 else "No memory."

        last_user_message = {
            "role": "user",
            "content": user_messages
            + [
                {
                    "type": "text",
                    "text": "Current screenshot:",
                },
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{state.image_base64}"}},
                {
                    "type": "text",
                    "text": user_command_template_chat.format(
                        execution_info_message=self.build_execution_info_message(execution_info),
                        json_output_format=self.build_message_output_format_info(),
                        memory=memory_str,
                    ),
                },
            ],
        }

        messages.append(last_user_message)

        for raw_response in execution_info.responses:
            if raw_response.grounding_error is not None:
                ai_message = {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "text",
                            "text": raw_response.raw_planning_prediction,
                        }
                    ],
                }

                messages.append(ai_message)

                user_message = {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": f"Grounder model error detected. Could not identify the element with description: '{raw_response.grounding_error.element_description}', error {raw_response.grounding_error.message}. Possible reasons:the description is not precise enough for the grounder or the element is not visible on the screenshot. If providing a new description does not work, try to complete the action through another path than using that specific button (either by changing the element to be clicked or providing another action such as a hotkey if any exist).",
                        }
                    ],
                }
                messages.append(user_message)
        return messages

    def extract_response(self, response_content: str) -> tuple[PlanAction, dict[str, str]]:
        additional_sections = OrderedDict({})
        response_json = parse_message_json(response_content)
        cot_sections = self.computer_use_agent_interface.get_planner_cot_sections()
        cot_sections_lst = list(cot_sections.keys())

        for section in cot_sections_lst:
            section_display = cot_sections[section]["display"]
            if section_display not in response_json:
                raise ValidationException(f"Invalid response format, '{section_display}' key not found: {response_content}")
            additional_sections[section] = response_json.get(section_display)

        if "action" not in response_json:
            raise ValidationException(f"Invalid response format, 'action' key not found: {response_content}")

        action_dict = response_json["action"]

        plan_action = PlanAction.from_dict(ActionPlanner.correct_action_type(action_dict))

        if plan_action is None:
            raise ValidationException(f"Invalid action format: {response_content}")

        if plan_action.action_type == PlanActionType.Drag:
            self.computer_use_agent_interface.validate_action(plan_action)

        return plan_action, additional_sections

    def build_execution_info_message(self, execution_info: ExecutionInfo) -> str:
        execution_info_message = ""
        if execution_info.planner_action_review is not None:
            action_description = execution_info.planner_action_review["action_description"]
            error_message = execution_info.planner_action_review["error_message"]
            execution_info_message = f"You predicted this action: '{action_description}' but it is not valid because: {error_message}. If the target element is not visible/fully visible on the screenshot, scroll first to make the target element visible. If the target element is not correct, change the action description with more precise element description using nearby context."
        elif execution_info.responses and len(execution_info.responses) > 0 and execution_info.responses[-1].grounding_error is not None:
            grounding_error = execution_info.responses[-1].grounding_error
            error_message = str(grounding_error)
            execution_info_message = f"The predicted is not valid because of this {error_message}. If the target element is not visible/fully visible on the screenshot, scroll first to make the target element visible. If the target element is not correct, change the action description with more precise element description using nearby context."
        return execution_info_message

    @staticmethod
    def correct_action_type(response_json: dict) -> dict:
        action_type = response_json.get("type", "").lower()
        if action_type in ("press", "key_press", "press_key"):
            response_json["type"] = "key_press"
        elif action_type in ("mouse_move", "move_mouse"):
            response_json["type"] = "move_mouse"
        elif action_type in ("type_text", "type_into", "type"):
            response_json["type"] = "type"
        elif "scroll" in action_type:
            response_json["type"] = "scroll"
        elif "wait" in action_type:
            response_json["type"] = "wait"
        return response_json

    async def predict(self, state: State, execution_state: ExecutionState) -> PlannerOutput:
        messages = self.build_messages_chat(state, execution_state)
        llm_messages = [message for message in messages]
        repeat_count = 3
        response_content = ""
        plan_action = None
        additional_sections = {}
        while repeat_count > 0:
            try:
                payload = {
                    "model": execution_state.model_name,
                    "messages": llm_messages,
                    "max_completion_tokens": 5000,
                    "reasoning_effort": "medium",
                }
                response_content = llm_client.send_messages(payload)
                if response_content is None or len(response_content.strip()) == 0:
                    raise ValidationException("Planner response is None or empty")

                plan_action, additional_sections = self.extract_response(str(response_content))
                llm_memory_response = additional_sections.get("memory", None)
                memory_operations = self.short_term_memory_manager.extract_memory_operations(llm_memory_response)

                execution_state.execution_info.current_response.raw_planning_prediction = response_content
                break
            except ValidationException as e:
                repeat_count -= 1
                ai_message = {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "text",
                            "text": response_content,
                        },
                    ],
                }
                error_message = {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": f"{e.message}. Please try again and output a valid response in the correct format.",
                        },
                    ],
                }

                llm_messages = messages + [ai_message, error_message]

                if repeat_count == 0:
                    raise ValueError(f"Invalid planner response format: {response_content}")
        if plan_action is None:
            raise ValueError("Planner response is not valid")
        planner_output = PlannerOutput(
            plan_action=plan_action,
            additional_sections=additional_sections,
        )
        updated_memory = await self.short_term_memory_manager.get_updated_memory(
            state, memory_operations, execution_state=execution_state
        )
        planner_output.additional_sections["memory"] = json.dumps(updated_memory, indent=4, ensure_ascii=False)
        return planner_output