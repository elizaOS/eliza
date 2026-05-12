# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import inspect
from copy import deepcopy
from typing import Annotated, Any, Callable, Optional

from ...oai import OpenAIWrapper
from ...tools import Depends, Tool
from ...tools.dependency_injection import inject_params, on
from ..agent import Agent
from ..conversable_agent import ConversableAgent
from .context_variables import __CONTEXT_VARIABLES_PARAM_NAME__, ContextVariables
from .reply_result import ReplyResult
from .targets.transition_target import TransitionTarget

__TOOL_EXECUTOR_NAME__ = "_Group_Tool_Executor"


class GroupToolExecutor(ConversableAgent):
    """Tool executor for the group chat initiated with initiate_group_chat"""

    def __init__(self) -> None:
        super().__init__(
            name=__TOOL_EXECUTOR_NAME__,
            system_message="Tool Execution, do not use this agent directly.",
            human_input_mode="NEVER",
            code_execution_config=False,
        )

        # Store the next target from a tool call
        self._group_next_target: Optional[TransitionTarget] = None

        # Primary tool reply function for handling the tool reply and the ReplyResult and TransitionTarget returns
        self.register_reply([Agent, None], self._generate_group_tool_reply, remove_other_reply_funcs=True)

    def set_next_target(self, next_target: TransitionTarget) -> None:
        """Sets the next target to transition to, used in the determine_next_agent function."""
        self._group_next_target = next_target

    def get_next_target(self) -> TransitionTarget:
        """Gets the next target to transition to."""
        """Returns the next target to transition to, if it exists."""
        if self._group_next_target is None:
            raise ValueError(
                "No next target set. Please set a next target before calling this method. Use has_next_target() to check if a next target exists."
            )
        return self._group_next_target

    def has_next_target(self) -> bool:
        """Checks if there is a next target to transition to."""
        return self._group_next_target is not None

    def clear_next_target(self) -> None:
        """Clears the next target to transition to."""
        self._group_next_target = None

    def _modify_context_variables_param(
        self, f: Callable[..., Any], context_variables: ContextVariables
    ) -> Callable[..., Any]:
        """Modifies the context_variables parameter to use dependency injection and link it to the group context variables.

        This essentially changes:
        def some_function(some_variable: int, context_variables: ContextVariables) -> str:

        to:

        def some_function(some_variable: int, context_variables: Annotated[ContextVariables, Depends(on(self.context_variables))]) -> str:
        """
        sig = inspect.signature(f)

        # Check if context_variables parameter exists and update it if so
        if __CONTEXT_VARIABLES_PARAM_NAME__ in sig.parameters:
            new_params = []
            for name, param in sig.parameters.items():
                if name == __CONTEXT_VARIABLES_PARAM_NAME__:
                    # Replace with new annotation using Depends
                    new_param = param.replace(annotation=Annotated[ContextVariables, Depends(on(context_variables))])
                    new_params.append(new_param)
                else:
                    new_params.append(param)

            # Update signature
            new_sig = sig.replace(parameters=new_params)
            f.__signature__ = new_sig  # type: ignore[attr-defined]

        return f

    def _change_tool_context_variables_to_depends(
        self, agent: ConversableAgent, current_tool: Tool, context_variables: ContextVariables
    ) -> None:
        """Checks for the context_variables parameter in the tool and updates it to use dependency injection."""

        # If the tool has a context_variables parameter, remove the tool and reregister it without the parameter
        if __CONTEXT_VARIABLES_PARAM_NAME__ in current_tool.tool_schema["function"]["parameters"]["properties"]:
            # We'll replace the tool, so start with getting the underlying function
            tool_func = current_tool._func

            # Remove the Tool from the agent
            name = current_tool._name
            description = current_tool._description
            agent.remove_tool_for_llm(current_tool)

            # Recreate the tool without the context_variables parameter
            tool_func = self._modify_context_variables_param(current_tool._func, context_variables)
            tool_func = inject_params(tool_func)
            new_tool = ConversableAgent._create_tool_if_needed(
                func_or_tool=tool_func, name=name, description=description
            )

            # Re-register with the agent
            agent.register_for_llm()(new_tool)

    def register_agents_functions(self, agents: list[ConversableAgent], context_variables: ContextVariables) -> None:
        """Adds the functions of the agents to the group tool executor."""
        for agent in agents:
            # As we're moving towards tools and away from function maps, this may not be used
            self._function_map.update(agent._function_map)

            # Update any agent tools that have context_variables parameters to use Dependency Injection
            for tool in agent.tools:
                self._change_tool_context_variables_to_depends(agent, tool, context_variables)

            # Add all tools to the Tool Executor agent
            for tool in agent.tools:
                self.register_for_execution(serialize=False, silent_override=True)(tool)

    def _generate_group_tool_reply(
        self,
        agent: ConversableAgent,
        messages: Optional[list[dict[str, Any]]] = None,
        sender: Optional[Agent] = None,
        config: Optional[OpenAIWrapper] = None,
    ) -> tuple[bool, Optional[dict[str, Any]]]:
        """Pre-processes and generates tool call replies.

        This function:
        1. Adds context_variables back to the tool call for the function, if necessary.
        2. Generates the tool calls reply.
        3. Updates context_variables and next_agent based on the tool call response."""

        if config is None:
            config = agent  # type: ignore[assignment]
        if messages is None:
            messages = agent._oai_messages[sender]

        message = messages[-1]
        if "tool_calls" in message:
            tool_call_count = len(message["tool_calls"])

            # Loop through tool calls individually (so context can be updated after each function call)
            next_target: Optional[TransitionTarget] = None
            tool_responses_inner = []
            contents = []
            for index in range(tool_call_count):
                message_copy = deepcopy(message)

                # 1. add context_variables to the tool call arguments
                tool_call = message_copy["tool_calls"][index]

                # Ensure we are only executing the one tool at a time
                message_copy["tool_calls"] = [tool_call]

                # 2. generate tool calls reply
                _, tool_message = agent.generate_tool_calls_reply([message_copy])

                if tool_message is None:
                    raise ValueError("Tool call did not return a message")

                # 3. update context_variables and next_agent, convert content to string
                for tool_response in tool_message["tool_responses"]:
                    content = tool_response.get("content")

                    # Tool Call returns that are a target are either a ReplyResult or a TransitionTarget are the next agent
                    if isinstance(content, ReplyResult):
                        if content.context_variables and content.context_variables.to_dict() != {}:
                            agent.context_variables.update(content.context_variables.to_dict())
                        if content.target is not None:
                            next_target = content.target
                    elif isinstance(content, TransitionTarget):
                        next_target = content

                    # Serialize the content to a string
                    if content is not None:
                        tool_response["content"] = str(content)

                    tool_responses_inner.append(tool_response)
                    contents.append(str(tool_response["content"]))

            self._group_next_target = next_target  # type: ignore[attr-defined]

            # Put the tool responses and content strings back into the response message
            # Caters for multiple tool calls
            if tool_message is None:
                raise ValueError("Tool call did not return a message")

            tool_message["tool_responses"] = tool_responses_inner
            tool_message["content"] = "\n".join(contents)

            return True, tool_message
        return False, None
