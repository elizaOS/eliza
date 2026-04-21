from functools import partial
import logging
from typing import Dict, List, Tuple

from mm_agents.os_symphony.agents.memoryer_agent import ReflectionMemoryAgent
from mm_agents.os_symphony.agents.os_aci import OSACI
from mm_agents.os_symphony.core.module import BaseModule
from mm_agents.os_symphony.memory.procedural_memory import PROCEDURAL_MEMORY
from mm_agents.os_symphony.utils.common_utils import (
    call_llm_formatted,
    extract_coords_from_action_dict,
    parse_action_from_string,
    parse_code_from_string,
    create_pyautogui_code,
)
from mm_agents.os_symphony.utils.formatters import (
    SINGLE_ACTION_FORMATTER,
    CODE_VALID_FORMATTER,
)


logger = logging.getLogger("desktopenv.agent")


class Worker(BaseModule):
    def __init__(
        self,
        engine_params_for_orchestrator: Dict,
        engine_params_for_memoryer: Dict,
        os_aci: OSACI,
        platform: str,
        client_password: str,
        max_trajectory_length: int = 8,
        enable_reflection: bool = True,
    ):
        """
        Worker receives the main task and generates actions, without the need of hierarchical planning
        Args:
            worker_engine_params: Dict
                Parameters for the worker agent
            os_aci: Agent
                The grounding agent to use
            platform: str
                OS platform the agent runs on (darwin, linux, windows)
            max_trajectory_length: int
                The amount of images turns to keep
            enable_reflection: bool
                Whether to enable reflection
        """
        super().__init__(platform=platform)
        self.client_password = client_password

        self.temperature = engine_params_for_orchestrator.get("temperature", 0.0)
        self.tool_config = engine_params_for_orchestrator.get("tool_config", "")
        self.use_thinking = engine_params_for_orchestrator.get("model", "") in [
            "claude-opus-4-20250514",
            "claude-sonnet-4-20250514",
            "claude-3-7-sonnet-20250219",
            "claude-sonnet-4-5-20250929",
        ]
        self.engine_params_for_orchestrator = engine_params_for_orchestrator
        self.engine_params_for_memoryer = engine_params_for_memoryer
        self.os_aci: OSACI = os_aci

        self.max_trajectory_length = max_trajectory_length if not self.engine_params_for_orchestrator.get("keep_first_image", False) else max_trajectory_length - 1
        self.enable_reflection = enable_reflection
        self.reset()

    def reset(self):
        # set_cell_values only occurs in linux; meanwhile there is no fail option in the other benchmarks
        if self.platform in ["windows", "macos"]:
            skipped_actions = ["set_cell_values", "fail"]
        else:
            skipped_actions = []

        # Hide code agent action entirely if no env/controller is available
        if not getattr(self.os_aci, "env", None) or not getattr(
            getattr(self.os_aci, "env", None), "controller", None
        ):
            skipped_actions.append("call_code_agent")

        self.orchestrator_sys_prompt = PROCEDURAL_MEMORY.construct_simple_worker_procedural_memory(
            agent_class=type(self.os_aci), 
            skipped_actions=skipped_actions,
            tool_config=self.tool_config,
            platform=self.platform
        ).replace("CURRENT_OS", self.platform).replace("CLIENT_PASSWORD", self.client_password)

        # Worker contains orchestrator and reflection agent
        self.orchestrator_agent = self._create_agent(
            engine_params=self.engine_params_for_orchestrator, 
            system_prompt=self.orchestrator_sys_prompt

        )
        self.memoryer_agent = ReflectionMemoryAgent(self.engine_params_for_memoryer)

        self.instruction = None
        self.turn_count = 0
        self.worker_history = []
        self.coords_history = []

        # For loop detection
        self.action_dict_history = []

    def flush_messages(self):
        """Flush messages based on the model's context limits.

        This method ensures that the agent's message history does not exceed the maximum trajectory length.

        Side Effects:
            - Modifies the messages of generator, reflection, and bon_judge agents to fit within the context limits.
        """
        engine_type = self.engine_params_for_orchestrator.get("engine_type", "")

        # Flush strategy for long-context models: keep all text, only keep latest images
        if engine_type in ["anthropic", "openai", "gemini", "vllm"]:
            max_images = self.max_trajectory_length
            # for agent in [self.generator_agent, self.reflection_agent]:
            for agent in [self.orchestrator_agent]:
                if agent is None:
                    continue
                # keep latest k images
                img_count = 0
                stop_idx = 1 if self.engine_params_for_orchestrator.get("keep_first_image", False) else -1
                for i in range(len(agent.messages) - 1, stop_idx, -1):
                    # for j in range(len(agent.messages[i]["content"])):
                    for j in range(len(agent.messages[i]["content"]) - 1, -1, -1):
                        if "image" in agent.messages[i]["content"][j].get("type", ""):
                            img_count += 1
                            if img_count > max_images:
                                del agent.messages[i]["content"][j]

        # Flush strategy for non-long-context models: drop full turns
        else:
            # generator msgs are alternating [user, assistant], so 2 per round
            if len(self.orchestrator_agent.messages) > 2 * self.max_trajectory_length + 1:
                self.orchestrator_agent.messages.pop(1)
                self.orchestrator_agent.messages.pop(1)


    def generate_next_action(self, instruction: str, obs: Dict, is_last_step: bool) -> Tuple[Dict, List]:
        """
        Predict the next action(s) based on the current observation.
        """
        print("=" * 30, f"Turn {self.turn_count + 1}", "=" * 30)
        
        print("=" * 10)
        print(instruction)
        print("=" * 10)
            
        self.os_aci.assign_screenshot(obs)
        self.os_aci.set_task_instruction(instruction)


        generator_message = (
            ""
            if self.turn_count > 0
            else "The initial screen is provided. No action has been taken yet."
        )

        
        # Load the task into the system prompt
        if is_last_step:
            # Eager mode: must decide done / fail
            prompt_with_instructions = PROCEDURAL_MEMORY.construct_eager_mode_procedural_memory(agent_class=type(self.os_aci)).replace(
                "TASK_DESCRIPTION", instruction
            ).replace(
                "CURRENT_OS", self.platform
            )
            print(f'Eager Mode Started, Instruction: {prompt_with_instructions}')
            self.orchestrator_agent.add_system_prompt(prompt_with_instructions)
            generator_message += "Note: 'EAGER MODE' is enabled. You must determine whether the task is done or fail in this step!!!"
        else:
            tutorials = ""
            for idx, t in enumerate(self.os_aci.tutorials, start=1):
                tutorials += f"### Tutorial {idx}:\n {t}\n"

            prompt_with_instructions = self.orchestrator_sys_prompt.replace(
                "TASK_DESCRIPTION", instruction
            ).replace(
                "TUTORIAL_PLACEHOLDER", tutorials
            )

            self.orchestrator_agent.add_system_prompt(prompt_with_instructions)
        
        # print(self.orchestrator_agent.system_prompt)

        ### Reflection Part
        reflection_info = {}
        if self.enable_reflection:
            # set instruction to memory agent
            self.memoryer_agent.add_instruction(instruction)
            reflection = None
            # Differentiate the operation mode of last step
            last_code_summary = ""
            mode = "gui"
            if (
                hasattr(self.os_aci, "last_code_agent_result")
                and self.os_aci.last_code_agent_result is not None
            ):
                # If code agent is called last step, we use its execution result as step behavior. 
                code_result = self.os_aci.last_code_agent_result
                mode = "code"
                last_code_summary += f"Subtask Instruction: {code_result['task_instruction']}\nSteps Completed: {code_result['steps_executed']}\nCompletion Reason: {code_result['completion_reason']}\nExec Summary: {code_result['summary']}\n"
            
            if (
                hasattr(self.os_aci, "last_search_agent_result")
                and self.os_aci.last_search_agent_result is not None
            ):
                mode = "search"
            # retrieve reflection!!!
            reflection_info = self.memoryer_agent.get_reflection(
                cur_obs=obs, 
                # only use the string after "(next action)" in orchestrator's output
                generator_output=parse_action_from_string(self.worker_history[-1]) if self.turn_count != 0 else "", 
                coordinates=self.coords_history[-1] if self.turn_count != 0 else [],
                mode=mode,
                code_exec_summary=last_code_summary,
                action_dict=self.action_dict_history[-1] if self.turn_count != 0 else {}
            )
            reflection = reflection_info['reflection']
            logger.info(f'[Reflection]: {reflection}')
            if reflection:
                generator_message += f"REFLECTION: You MUST use this reflection on the latest action:\n{reflection}\n"
            else:
                generator_message += "You should go on with your plan.\n"
        else: 
            generator_message += "You should go on with your plan.\n"


        # Add code agent result from previous step if available (from full task or subtask execution)
        if (
            hasattr(self.os_aci, "last_code_agent_result")
            and self.os_aci.last_code_agent_result is not None
        ):
            code_result = self.os_aci.last_code_agent_result
            generator_message += f"\nCODE AGENT RESULT:\n"
            generator_message += (
                f"Task/Subtask Instruction: {code_result['task_instruction']}\n"
            )
            generator_message += f"Steps Completed: {code_result['steps_executed']}\n"
            generator_message += f"Max Steps: {code_result['budget']}\n"
            generator_message += (
                f"Completion Reason: {code_result['completion_reason']}\n"
            )
            generator_message += f"Summary: {code_result['summary']}\n"
            generator_message += "\n"
            # Reset the code agent result after adding it to context
            self.os_aci.last_code_agent_result = None

        if (
            hasattr(self.os_aci, "last_search_agent_result")
            and self.os_aci.last_search_agent_result is not None
        ):
            # Retrieve the result dictionary
            search_result = self.os_aci.last_search_agent_result

            # Add a clear, distinct header for this section in the prompt
            generator_message += f"\nSEARCH AGENT RESULT:\n"
            
            # Add contextual metadata from the search task
            generator_message += f"Search Query: {search_result['query']}\n"
            generator_message += f"Search Completion Reason: {search_result['completion_reason']}\n"
            generator_message += "Search Result: "
            # Add the most important part: the tutorial found by the agent.
            # This is given a prominent sub-header so the LLM knows to pay close attention.
            if search_result["completion_reason"] == "DONE":
                generator_message += f'Search is completed, the tutorial it found has been already added to your system prompt.\n'
            elif search_result["completion_reason"] == "FAIL":
                generator_message += f"Search is fail, the failure reason or the hint is as follow: {search_result['final_answer']}\n"
        
            
            # CRITICAL: Reset the search agent result after adding it to the context.
            # This prevents it from being added to the prompt again in the next turn.
            self.os_aci.last_search_agent_result = None


        # Finalize the generator message
        self.orchestrator_agent.add_message(
            generator_message, image_content=obs["screenshot"], role="user", put_text_last=True
        )

        # Generate the plan and next action
        format_checkers = [
            SINGLE_ACTION_FORMATTER,
            partial(CODE_VALID_FORMATTER, self.tool_config),
        ]
        plan = call_llm_formatted(
            self.orchestrator_agent,
            format_checkers,
            temperature=self.engine_params_for_orchestrator.get("temperture", 0.1),
            use_thinking=self.use_thinking,
        )
        self.worker_history.append(plan)
        self.orchestrator_agent.add_message(plan, role="assistant")
        logger.info("PLAN:\n %s", plan)

        # Extract the next action from the plan
        # 此时的plan code e.g. agent.click('xxxxx', 1)
        plan_code = parse_code_from_string(plan)
        action_dict, coordinates = None, None
        try:
            assert plan_code, "Plan code should not be empty"
            # exec_code e.g. import pyautogui; pyautogui.click(1, 2);
            exec_code, action_dict = create_pyautogui_code(self.os_aci, plan_code, obs)
            coordinates = extract_coords_from_action_dict(action_dict)
        except Exception as e:
            logger.error(
                f"Could not evaluate the following plan code:\n{plan_code}\nError: {e}"
            )
            exec_code, action_dict = self.os_aci.wait(
                1.333
            )  # Skip a turn if the code cannot be evaluated

        self.action_dict_history.append(action_dict)

        executor_info = {
            "refined_instruction": self.instruction,
            "plan": plan,
            "plan_code": plan_code,
            "exec_code": exec_code,
            "coordinates": coordinates,
            "reflection": reflection_info,
            "code_agent_output": (
                self.os_aci.last_code_agent_result
                if hasattr(self.os_aci, "last_code_agent_result")
                and self.os_aci.last_code_agent_result is not None
                else None
            ),
            "search_agent_output": (
                self.os_aci.last_search_agent_result
                if hasattr(self.os_aci, "last_search_agent_result")
                and self.os_aci.last_search_agent_result is not None
                else None
            )
        }
        self.turn_count += 1
        self.coords_history.append(coordinates)
        self.flush_messages()
        return executor_info, [exec_code]
