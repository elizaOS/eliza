import enum
from dataclasses import dataclass
from typing import List, Dict, Any, Optional, Tuple
from collections import defaultdict


@dataclass(frozen=True)
class Action:
    value: str  # LM returned string for now
    use_tool: bool  # if use_tool == False -> propose answer
    error: Optional[str] = None


class State:
    """This should contains everything needed to continue the conversation.

    For example, the history of the conversation, the current task (success/failure) at each step, etc.
    """

    def __init__(
        self,
        history: List[Dict[str, Any]] = None,
        finished: bool = False,
        success: bool = False,
        latest_output: Dict[str, Any] = None,
        agent_action_count: Dict[str, int] = None,
        terminate_reason: str = None,
    ):
        self.history: List[Dict[str, Any]] = history
        self.finished: bool = finished
        self.success: bool = success
        self.latest_output: Dict[str, Any] = latest_output
        self.agent_action_count: Dict[str, int] = agent_action_count
        self.token_counter: Dict[str, int] = defaultdict(int)
        self.terminate_reason: str = terminate_reason
        self.error: Optional[str] = None

    @property
    def empty(self):
        return len(self.history) == 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "history": self.history,
            "finished": self.finished,
            "success": self.success,
            "latest_output": self.latest_output,
            "agent_action_count": self.agent_action_count,
            "token_counter": dict(self.token_counter),
            "terminate_reason": self.terminate_reason,
            "error": self.error,
        }


class FeedbackType(enum.Enum):
    FEEDBACK_WITH_GT = "feedback_with_gt"
    FEEDBACK_WO_GT = "feedback_wo_gt"
    NO_FEEDBACK = "no_feedback"


class StepOutput:
    def __init__(
        self,
        observation: str = None,
        feedback: str = "",
        feedback_type: FeedbackType = FeedbackType.NO_FEEDBACK,
        success: bool = False,
        extra: Dict[str, Any] = None,
        turn_info: Tuple[int, int] = None,
    ):
        self.observation: str = observation
        self.feedback: str = feedback
        self.feedback_type: FeedbackType = feedback_type
        self.success: bool = success
        self.extra: Dict[str, Any] = extra
        self.turn_info = turn_info

    def __repr__(self) -> str:
        return self.observation

    def to_str(self) -> str:
        output = "Observation:\n"
        if self.observation is not None:
            output += self.observation + "\n"
        else:
            if self.success == False:
                output += "Your answer is wrong.\n"

        if self.turn_info != None:
            n_steps_left, n_propose_solution_left = self.turn_info
            output += "You have {} steps left and {} chances to propose solution left.\n".format(
                n_steps_left, n_propose_solution_left
            )
            if n_steps_left <= 1:
                output += "You should take the last step to propose a solution.\n"

        if self.feedback_type != FeedbackType.NO_FEEDBACK and self.feedback != "":
            # output += (
            #     f"\nYour {action_type} is commented by an expert "
            #     f"{'without' if self.feedback_type == FeedbackType.FEEDBACK_WO_GT else 'with'}"
            #     " access to the correct answer.\nExpert feedback:\n"
            # )
            # Maybe we don't want to tell the model whether the expert has acces to GT
            output += "\nExpert feedback:\n" + self.feedback + "\n"

        return output

    def to_dict(self) -> Dict[str, Any]:
        return {
            "observation": self.observation,
            "feedback": self.feedback,
            "feedback_type": self.feedback_type.value,
            "success": self.success,
        }
