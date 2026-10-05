import re
import logging
import traceback
from typing import Any, Dict, List, Mapping, Tuple, Optional

LOGGER = logging.getLogger("MINT")

from mint import agents
from mint.envs.base import BaseEnv
from mint.prompt import ToolPromptTemplate
from mint.datatypes import State, Action, StepOutput, FeedbackType
from mint.tools import Tool, get_toolset_description
from mint.tasks import Task
from mint.tools.python_tool import PythonREPL
from mint.utils.exception import ParseError


INVALID_INPUT_MESSAGE = (
    "I don't understand your input. \n"
    "If you want to execute code, please use <execute> YOUR_CODE_HERE </execute>.\n"
    "If you want to give me an answer, please use <solution> YOUR_SOLUTION_HERE </solution>.\n"
    "For example: The answer to the question is <solution> 42 </solution>. \n"
)


class GeneralEnv(BaseEnv):
    def __init__(
        self,
        task: Task,
        tool_set: List[Tool],
        feedback_config: Dict[str, Any],
        environment_config: Dict[str, Any],
    ):
        self.task: Task = task
        self.tool_set: List[Tool] = tool_set + getattr(self, "tool_set", [])

        self.state = State()
        self.config = environment_config

        # Feedback
        self.feedback_config = feedback_config
        feedback_agent_config = feedback_config["feedback_agent_config"]
        if feedback_config["pseudo_human_feedback"] in ["GT", "no_GT"]:
            self.feedback_agent: agents = getattr(
                agents, feedback_agent_config["agent_class"]
            )(feedback_agent_config)
        else:
            self.feedback_agent = None
        if self.feedback_config["pseudo_human_feedback"] == "None":
            self.feedback_type = FeedbackType.NO_FEEDBACK
        elif self.feedback_config["pseudo_human_feedback"] == "no_GT":
            self.feedback_type = FeedbackType.FEEDBACK_WO_GT
        elif self.feedback_config["pseudo_human_feedback"] == "GT":
            self.feedback_type = FeedbackType.FEEDBACK_WITH_GT
        else:
            raise ValueError(
                f"Invalid feedback type {self.feedback_config['pseudo_human_feedback']}"
            )

        self.env_outputs: List[StepOutput] = []
        LOGGER.info(
            f"{len(self.tool_set)} tools loaded: {', '.join([t.name for t in self.tool_set])}"
        )
        self.python_repl = PythonREPL(
            name_to_func_mapping={tool.name: tool.__call__ for tool in self.tool_set}
        )

    def parse_action(self, action: Action) -> Tuple[str, Dict[str, Any]]:
        """Define the parsing logic."""
        lm_output = "\n" + action.value + "\n"
        output = {}
        try:
            if not action.use_tool:
                answer = "\n".join(
                    [
                        i.strip()
                        for i in re.findall(
                            r"<solution>(.*?)</solution>", lm_output, re.DOTALL
                        )
                    ]
                )
                if answer == "":
                    raise ParseError("No answer found.")
                output["answer"] = answer
            else:
                env_input = "\n".join(
                    [
                        i.strip()
                        for i in re.findall(
                            r"<execute>(.*?)</execute>", lm_output, re.DOTALL
                        )
                    ]
                )
                if env_input == "":
                    raise ParseError("No code found.")
                output["env_input"] = env_input
        except Exception as e:
            raise ParseError(e)
        return output

    def get_feedback(self, observation: str) -> Tuple[str, FeedbackType]:
        if self.feedback_type == FeedbackType.NO_FEEDBACK:
            return ""
        elif self.feedback_type == FeedbackType.FEEDBACK_WO_GT:
            gt = None
        else:
            gt = self.task.reference

        feedback = self.feedback_agent.act(
            self.state,
            observation=observation,
            form=self.feedback_config["feedback_form"],
            gt=gt,
            task_in_context_example=self.task.in_context_example(
                use_tool=self.config["use_tools"],
                with_feedback=True,
            ),
            tool_desc=get_toolset_description(self.tool_set),
        )
        return feedback.value

    def check_task_success(self, answer: str) -> bool:
        LOGGER.info(f"STUDENT ANSWER: [{answer}]")
        LOGGER.info(f"REFERENCE ANSWER: [{self.task.reference}]")
        return self.task.success(answer)

    def log_output(self, output: StepOutput) -> None:
        if self.state.finished:
            return
        content = output.to_str()
        self.state.history.append({"role": "user", "content": content})
        self.state.latest_output = output.to_dict()
        self.state.latest_output["content"] = content

    def handle_tool_call(self, action: Action) -> str:
        """Use tool to obtain "observation."""
        try:
            parsed = self.parse_action(action)
            env_input = parsed["env_input"]
            obs = self.python_repl(env_input).strip()
            self.env_outputs.append(StepOutput(observation=obs))
            self.state.agent_action_count["use_tool"] += 1
            return obs
        except ParseError:
            self.state.agent_action_count["invalid_action"] += 1
            return INVALID_INPUT_MESSAGE
        except Exception as e:
            error_traceback = traceback.format_exc()
            return f"{error_traceback}"

    def handle_propose_solution(self, action: Action) -> Optional[str]:
        """Propose answer to check the task success.

        It might set self.state.finished = True if the task is successful.
        """
        self.state.agent_action_count["propose_solution"] += 1
        try:
            parsed = self.parse_action(action)
            task_success = self.check_task_success(parsed["answer"])
            if task_success:
                self.state.finished = True
                self.state.success = True
                self.state.terminate_reason = "task_success"
                # NOTE: should not return the function now, because we need to log the output
                # Set state.finished = True will terminate the episode
        except ParseError:
            return INVALID_INPUT_MESSAGE
        except Exception as e:
            error_traceback = traceback.format_exc()
            return f"{error_traceback}"

    def check_max_iteration(self):
        """Check if the agent has reached the max iteration limit.

        It might set self.state.finished = True if the agent has reached the max iteration limit.
        """
        if self.state.finished:
            # ignore if the episode is already finished (e.g., task success)
            return

        if (
            # propose solution > max output solution
            self.state.agent_action_count["propose_solution"]
            >= self.config["max_propose_solution"]
        ):
            self.state.finished = True
            self.state.success = False
            self.state.terminate_reason = "max_propose_steps"
        elif (
            # (propose_solution + use_tool) > max iteration limit
            sum(self.state.agent_action_count.values())
            >= self.config["max_steps"]
        ):
            self.state.finished = True
            self.state.success = False
            self.state.terminate_reason = "max_steps"

    def step(self, action: Action, loaded=None) -> State:
        assert (
            not self.state.finished
        ), "Expecting state.finished == False for env.step()."

        # Update state by logging the action
        if action.value:
            assistant_action = (
                "Assistant:\n" + action.value
                if not action.value.lstrip().startswith("Assistant:")
                else action.value
            )
            self.state.history.append(
                {"role": "assistant", "content": assistant_action + "\n"}
            )

        if action.error:
            # Check if error (usually hit the max length)
            observation = f"An error occurred. {action.error}"
            self.state.finished = True
            self.state.success = False
            self.state.error = action.error
            self.state.terminate_reason = "error"
            LOGGER.error(f"Error:\n{action.error}")
        elif action.use_tool:
            observation = self.handle_tool_call(action)
        else:
            # It might set self.state.finished = True if the task is successful.
            observation = self.handle_propose_solution(action)

        # Check if the agent has reached the max iteration limit.
        # If so, set self.state.finished = True
        # This corresponds to a no-op if the episode is already finished
        self.check_max_iteration()

        # record the turn info
        if self.config["count_down"]:
            turn_info = (
                self.config["max_steps"] - sum(self.state.agent_action_count.values()),
                self.config["max_propose_solution"]
                - self.state.agent_action_count["propose_solution"],
            )
        else:
            turn_info = None

        # Get feedback if the episode is not finished
        if loaded != None:
            feedback = loaded["feedback"]
            LOGGER.info(f"Loaded feedback: {feedback}")
        elif not self.state.finished:
            # This is the output without feedback
            # use to generate an observation for feedback agent
            tmp_output = StepOutput(
                observation=observation,
                success=self.state.success,
                turn_info=turn_info,
            )
            feedback = self.get_feedback(observation=tmp_output.to_str())
        else:
            feedback = ""

        # Log the output to state regardless of whether the episode is finished
        output = StepOutput(
            observation=observation,
            feedback=feedback,
            feedback_type=self.feedback_type,
            success=self.state.success,
            turn_info=turn_info,
        )

        self.log_output(output)
        return self.state

    def reset(self) -> State:
        use_tool: bool = self.config["use_tools"]
        if use_tool and len(self.tool_set) > 0:
            LOGGER.warning(
                (
                    "No tool is provided when use_tools is True.\n"
                    "Ignore this if you are running code generation."
                )
            )

        user_prompt = ToolPromptTemplate(use_tool=use_tool)(
            max_total_steps=self.config["max_steps"],
            max_propose_solution=self.config["max_propose_solution"],
            tool_desc=get_toolset_description(self.tool_set),
            in_context_example=self.task.in_context_example(
                use_tool=use_tool,
                with_feedback=self.feedback_type != FeedbackType.NO_FEEDBACK,
            ),
            task_prompt="Task:\n" + self.task.prompt,
        )
        self.state.history = [{"role": "user", "content": user_prompt}]
        self.state.latest_output = {"content": user_prompt}
        self.state.agent_action_count = {
            "propose_solution": 0,
            "use_tool": 0,
            "invalid_action": 0,
        }

        if use_tool:
            # reset tool set
            for tool in self.tool_set:
                tool.reset()
        return self.state
