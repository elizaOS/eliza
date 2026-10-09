import json
from mm_agents.uipath.types_utils import (
    ComputerUseAction,
    ComputerUseStep,
    SupportedActions,
    PlanActionType,
    PlanAction,
    key_maps,
    ExecutionState,
    State,
)
import mm_agents.uipath.utils as utils
from mm_agents.uipath.action_planner import ActionPlanner, PlannerOutput
from mm_agents.uipath.grounder_client import GrounderClient


class UiPathComputerUseV1(object):
    def __init__(self):
        self.planner = ActionPlanner()
        self.executor = GrounderClient()

    async def predict_request(self, request_body: dict, model_name: str) -> tuple[dict, dict]:
        previous_steps = request_body['previousSteps'] if request_body['previousSteps'] else []
        state = State(
            task=request_body["userTask"],
            image_base64=request_body["image"],
            previous_steps=[step for step in previous_steps],
        )

        execution_state = ExecutionState(model_name=model_name)
        output = await self.predict(state, execution_state, max_retries=2)
        return output

    def wrap_to_computer_use_action(self, plan_action: PlanAction, grounding_result: utils.GroundingOutput | None) -> ComputerUseAction:
        match plan_action.action_type:
            case PlanActionType.KeyPress:
                keys = plan_action.parameters["key"].split(" ")
                keys = [key.strip() for key in keys]
                keys = [key_maps.get(key, key) for key in keys]
                action = ComputerUseAction(
                    name=SupportedActions.KeyPress,
                    description=plan_action.description,
                    parameters={"keys": keys},
                )
            case PlanActionType.Wait:
                action = ComputerUseAction(
                    name=SupportedActions.Wait,
                    description=plan_action.description,
                    parameters={},
                )
            case PlanActionType.Click | PlanActionType.DoubleClick |  PlanActionType.TripleClick | PlanActionType.MouseMove | PlanActionType.RightClick:
                action_name = plan_action.action_type
                x, y = grounding_result.position
                parameters = {"position": [int(x), int(y)]}

                if plan_action.action_type == PlanActionType.DoubleClick:
                    action_name = SupportedActions.Click
                    parameters["click_type"] = "double"
                elif plan_action.action_type == PlanActionType.TripleClick:
                    action_name = SupportedActions.Click
                    parameters["click_type"] = "triple"
                elif plan_action.action_type == PlanActionType.RightClick:
                    action_name = SupportedActions.Click
                    parameters["button"] = "right"
                elif plan_action.action_type == PlanActionType.MouseMove:
                    action_name = SupportedActions.MouseMove  # different names

                assert action_name in [SupportedActions.Click, SupportedActions.MouseMove]
                action = ComputerUseAction(
                    name=action_name,
                    description=plan_action.description,
                    parameters=parameters,
                )
            case PlanActionType.Drag:
                assert grounding_result.end_position is not None, "End position must be provided for drag action"
                x, y = grounding_result.position
                x_end, y_end = grounding_result.end_position
                x, y = int(x), int(y)
                x_end, y_end = int(x_end), int(y_end)
                action = ComputerUseAction(
                    name=SupportedActions.Drag,
                    description=plan_action.description,
                    parameters={"path": [{"x": x, "y": y}, {"x": x_end, "y": y_end}]},
                )
            case PlanActionType.Scroll:
                x, y = grounding_result.position
                x, y = int(x), int(y)
                # guess the scroll direction if missing in the plan output
                if "direction" not in plan_action.parameters:
                    if "scroll up" in plan_action.description.lower():
                        scroll_direction = "up"
                    else:
                        scroll_direction = "down"
                else:
                    scroll_direction = plan_action.parameters["direction"]

                action = ComputerUseAction(
                    name=SupportedActions.Scroll, description=plan_action.description, parameters={"position": [x, y], "direction": scroll_direction}
                )

                if "distance" in plan_action.parameters:
                    match scroll_direction:
                        case "up":
                            action.parameters["offset"] = [0, plan_action.parameters["distance"]]
                        case "down":
                            action.parameters["offset"] = [0, -plan_action.parameters["distance"]]
                        case "left":
                            action.parameters["offset"] = [plan_action.parameters["distance"], 0]
                        case "right":
                            action.parameters["offset"] = [-plan_action.parameters["distance"], 0]
            case PlanActionType.Type:
                action = ComputerUseAction(
                    name=SupportedActions.TypeInto,
                    description=plan_action.description,
                    parameters={"value": plan_action.parameters["text"]},
                )

        return action

    async def predict(
        self, state: State, execution_state: ExecutionState, max_retries: int = 0, planer_output: PlannerOutput | None = None
    ) -> tuple[dict, dict]:
        execute_planning = True
        is_planning_fixed = planer_output is not None
        execution_count = 0
        execution_state.execution_info.responses = []
        while execute_planning:
            try:
                execution_count += 1
                if execution_state.execution_info.current_response is not None:
                    execution_state.execution_info.responses.append(execution_state.execution_info.current_response)
                execution_state.execution_info.current_response = utils.RawAgentResponse()
                if not is_planning_fixed:
                    planer_output = await self.planner.predict(state, execution_state)
                plan_action = planer_output.plan_action

                step = await self.process_plan_and_ground(planer_output, state, execution_state, retry_number=max_retries)
                execute_planning = False
            except utils.GroundingOutputValidationException as e:
                execution_state.execution_info.current_response.grounding_error = e
                if is_planning_fixed or execution_count > max_retries:
                    raise ValueError(f"Grounding error with fixed plan: {e.message}, element description: {e.element_description}")

        # save additional data for history
        assert step is not None
        assert step.additional_parameters is not None
        step.additional_parameters["thought"] = planer_output.thought
        step.additional_parameters["review"] = planer_output.review
        step.additional_parameters.update(planer_output.additional_sections)
        step.additional_parameters["plan_action"] = json.dumps(plan_action.to_dict())

        history_image = state.image_base64
        previous_steps_parameters = {
            "max_chat_history_messages": 1000,
            "max_chat_history_images": 1,
            "image": history_image,
        }
        agent_response = {"step": step.to_response_dict(), "previous_steps_parameters": previous_steps_parameters}

        return agent_response

    async def process_plan_and_ground(
        self, planer_output: PlannerOutput, state: State, execution_state: ExecutionState, retry_number: int = 0
    ) -> ComputerUseStep:
        plan_action = planer_output.plan_action
        action: ComputerUseAction | None = None
        step: ComputerUseStep | None = None

        match plan_action.action_type:
            case PlanActionType.ExtractData:
                # return a step with no action, just to store the extracted data
                step = ComputerUseStep(
                    description=plan_action.description,
                    actions=[],
                    additional_parameters={
                        "extracted_data": plan_action.parameters,
                    },
                    thought=planer_output.thought,
                )
            case PlanActionType.Finish:
                action = ComputerUseAction(
                    name=SupportedActions.Finish,
                    description=plan_action.description,
                    parameters=plan_action.parameters,
                )
            case (
                PlanActionType.Click
                | PlanActionType.MouseMove
                | PlanActionType.Scroll
                | PlanActionType.Drag
                | PlanActionType.DoubleClick
                | PlanActionType.TripleClick
                | PlanActionType.RightClick
            ):
                if plan_action.action_type != PlanActionType.Drag:
                    element_description = plan_action.parameters.get("element_description", None)
                    grounding_result = await self.executor.predict(
                        state.image_base64,
                        plan_action.description,
                        action=plan_action.action_type,
                        element_description=element_description
                    )
                else:
                    start_description = plan_action.parameters.get("start_description", None)
                    end_description = plan_action.parameters.get("end_description", None)
                    drag_entire_description = plan_action.description
                    drag_start_description = f"Drag Start point:{start_description}. [Full Drag Description:{drag_entire_description}]"
                    drag_end_description = f"Drag End point:{end_description}. [Full Drag Description:{drag_entire_description}]"
                    grounding_result = await self.executor.predict(state.image_base64, drag_start_description, action=plan_action.action_type)
                    grounding_result_end = await self.executor.predict(state.image_base64, drag_end_description, action=plan_action.action_type)
                    grounding_result.end_position = grounding_result_end.get_point_location()
                action = self.wrap_to_computer_use_action(plan_action, grounding_result)
            case _:
                action = self.wrap_to_computer_use_action(plan_action, grounding_result=None)
        if step is None:
            assert action is not None
            step = ComputerUseStep(
                description=plan_action.description,
                actions=[action],
                additional_parameters={},
                thought=planer_output.thought,
            )

        return step