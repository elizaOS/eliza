# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import copy
from functools import partial
from types import MethodType
from typing import TYPE_CHECKING, Any, Callable, Optional, Union

from ..agent import Agent
from ..groupchat import GroupChat, GroupChatManager
from .context_variables import ContextVariables
from .group_tool_executor import GroupToolExecutor
from .targets.group_manager_target import GroupManagerTarget
from .targets.transition_target import (
    AgentNameTarget,
    AgentTarget,
    TransitionTarget,
)

if TYPE_CHECKING:
    from ..conversable_agent import ConversableAgent

# Utility functions for group chat preparation and management
# These are extracted from multi_agent_chat.py to avoid circular imports


def update_conditional_functions(agent: "ConversableAgent", messages: list[dict[str, Any]]) -> None:
    """Updates the agent's functions based on the OnCondition's available condition.

    All functions are removed and then added back if they are available
    """
    for on_condition in agent.handoffs.llm_conditions:
        is_available = on_condition.available.is_available(agent, messages) if on_condition.available else True

        # Remove it from their tools
        for tool in agent.tools:
            if tool.name == on_condition.llm_function_name:
                agent.remove_tool_for_llm(tool)
                break

        # then add the function if it is available, so that the function signature is updated
        if is_available:
            agent._add_single_function(
                _create_on_condition_handoff_function(on_condition.target),
                on_condition.llm_function_name,
                on_condition.condition.get_prompt(agent, messages),
            )


def establish_group_agent(agent: "ConversableAgent") -> None:
    """Establish the group agent with the group-related attributes and hooks. Not for the tool executor.

    Args:
        agent ("ConversableAgent"): The agent to establish as a group agent.
    """

    def _group_agent_str(self: "ConversableAgent") -> str:
        """Customise the __str__ method to show the agent name for transition messages."""
        return f"Group agent --> {self.name}"

    # Register the hook to update agent state (except tool executor)
    agent.register_hook("update_agent_state", update_conditional_functions)

    # Register a reply function to run Python function-based OnContextConditions before any other reply function
    agent.register_reply(trigger=([Agent, None]), reply_func=_run_oncontextconditions, position=0)

    agent._get_display_name = MethodType(_group_agent_str, agent)  # type: ignore[method-assign]

    # Mark this agent as established as a group agent
    agent._group_is_established = True  # type: ignore[attr-defined]


def link_agents_to_group_manager(agents: list[Agent], group_chat_manager: Agent) -> None:
    """Link all agents to the GroupChatManager so they can access the underlying GroupChat and other agents.

    This is primarily used so that agents can get to the tool executor to help set the next agent.

    Does not link the Tool Executor agent.
    """
    for agent in agents:
        agent._group_manager = group_chat_manager  # type: ignore[attr-defined]


def _evaluate_after_works_conditions(
    agent: "ConversableAgent",
    groupchat: GroupChat,
    user_agent: Optional["ConversableAgent"],
) -> Optional[Union[Agent, str]]:
    """Evaluate after_works context conditions for an agent.

    Args:
        agent: The agent to evaluate after_works conditions for
        groupchat: The current group chat
        user_agent: Optional user proxy agent

    Returns:
        The resolved speaker selection result if a condition matches, None otherwise
    """
    if not hasattr(agent, "handoffs") or not agent.handoffs.after_works:  # type: ignore[attr-defined]
        return None

    for after_work_condition in agent.handoffs.after_works:  # type: ignore[attr-defined]
        # Check if condition is available
        is_available = (
            after_work_condition.available.is_available(agent, groupchat.messages)
            if after_work_condition.available
            else True
        )

        # Evaluate the condition (None condition means always true)
        if is_available and (
            after_work_condition.condition is None or after_work_condition.condition.evaluate(agent.context_variables)
        ):
            # Condition matched, resolve and return
            return after_work_condition.target.resolve(
                groupchat,
                agent,
                user_agent,
            ).get_speaker_selection_result(groupchat)

    return None


def _run_oncontextconditions(
    agent: "ConversableAgent",
    messages: Optional[list[dict[str, Any]]] = None,
    sender: Optional[Agent] = None,
    config: Optional[Any] = None,
) -> tuple[bool, Optional[Union[str, dict[str, Any]]]]:
    """Run OnContextConditions for an agent before any other reply function."""
    for on_condition in agent.handoffs.context_conditions:  # type: ignore[attr-defined]
        is_available = (
            on_condition.available.is_available(agent, messages if messages else []) if on_condition.available else True
        )

        if is_available and (
            on_condition.condition is None or on_condition.condition.evaluate(agent.context_variables)
        ):
            # Condition has been met, we'll set the Tool Executor's next target
            # attribute and that will be picked up on the next iteration when
            # _determine_next_agent is called
            for agent in agent._group_manager.groupchat.agents:  # type: ignore[attr-defined]
                if isinstance(agent, GroupToolExecutor):
                    agent.set_next_target(on_condition.target)
                    break

            transfer_name = on_condition.target.display_name()

            return True, "[Handing off to " + transfer_name + "]"

    return False, None


def _create_on_condition_handoff_function(target: TransitionTarget) -> Callable[[], TransitionTarget]:
    """Creates a function that will be used by the tool call reply function when the condition is met.

    Args:
        target (TransitionTarget): The target to transfer to.

    Returns:
        Callable: The transfer function.
    """

    def transfer_to_target() -> TransitionTarget:
        return target

    return transfer_to_target


def create_on_condition_handoff_functions(agent: "ConversableAgent") -> None:
    """Creates the functions for the OnConditions so that the current tool handling works.

    Args:
        agent ("ConversableAgent"): The agent to create the functions for.
    """
    # Populate the function names for the handoffs
    agent.handoffs.set_llm_function_names()

    # Create a function for each OnCondition
    for on_condition in agent.handoffs.llm_conditions:
        # Create a function that will be called when the condition is met
        agent._add_single_function(
            _create_on_condition_handoff_function(on_condition.target),
            on_condition.llm_function_name,
            on_condition.condition.get_prompt(agent, []),
        )


def ensure_handoff_agents_in_group(agents: list["ConversableAgent"]) -> None:
    """Ensure the agents in handoffs are in the group chat."""
    agent_names = [agent.name for agent in agents]
    for agent in agents:
        for llm_conditions in agent.handoffs.llm_conditions:
            if (
                isinstance(llm_conditions.target, (AgentTarget, AgentNameTarget))
                and llm_conditions.target.agent_name not in agent_names
            ):
                raise ValueError("Agent in OnCondition Hand-offs must be in the agents list")
        for context_conditions in agent.handoffs.context_conditions:
            if (
                isinstance(context_conditions.target, (AgentTarget, AgentNameTarget))
                and context_conditions.target.agent_name not in agent_names
            ):
                raise ValueError("Agent in OnContextCondition Hand-offs must be in the agents list")
        # Check after_works targets
        for after_work_condition in agent.handoffs.after_works:
            if (
                isinstance(after_work_condition.target, (AgentTarget, AgentNameTarget))
                and after_work_condition.target.agent_name not in agent_names
            ):
                raise ValueError("Agent in after work target Hand-offs must be in the agents list")


def prepare_exclude_transit_messages(agents: list["ConversableAgent"]) -> None:
    """Preparation for excluding transit messages by getting all tool names and registering a hook on agents to remove those messages."""
    # get all transit functions names
    to_be_removed: list[str] = []
    for agent in agents:
        for on_condition in agent.handoffs.llm_conditions:
            if on_condition.llm_function_name:
                to_be_removed.append(on_condition.llm_function_name)
            else:
                raise ValueError("OnCondition must have a function name")

    remove_function = make_remove_function(to_be_removed)

    # register hook to remove transit messages for group agents
    for agent in agents:
        agent.register_hook("process_all_messages_before_reply", remove_function)


def prepare_group_agents(
    agents: list["ConversableAgent"],
    context_variables: ContextVariables,
    exclude_transit_message: bool = True,
) -> tuple[GroupToolExecutor, list["ConversableAgent"]]:
    """Validates agents, create the tool executor, wrap necessary targets in agents.

    Args:
        agents (list["ConversableAgent"]): List of all agents in the conversation.
        context_variables (ContextVariables): Context variables to assign to all agents.
        exclude_transit_message (bool): Whether to exclude transit messages from the agents.

    Returns:
        "ConversableAgent": The tool executor agent.
        list["ConversableAgent"]: List of wrapped agents.
    """
    # Initialise all agents as group agents
    for agent in agents:
        if not hasattr(agent, "_group_is_established"):
            establish_group_agent(agent)

    # Ensure all agents in hand-off after-works are in the passed in agents list
    ensure_handoff_agents_in_group(agents)

    # Create Tool Executor for the group
    tool_execution = GroupToolExecutor()

    # Wrap handoff targets in agents that need to be wrapped
    wrapped_chat_agents: list["ConversableAgent"] = []
    for agent in agents:
        wrap_agent_handoff_targets(agent, wrapped_chat_agents)

    # Create the functions for the OnConditions so that the current tool handling works
    for agent in agents:
        create_on_condition_handoff_functions(agent)

    # Register all the agents' functions with the tool executor and
    # use dependency injection for the context variables parameter
    # Update tool execution agent with all the functions from all the agents
    tool_execution.register_agents_functions(agents + wrapped_chat_agents, context_variables)

    if exclude_transit_message:
        prepare_exclude_transit_messages(agents)

    return tool_execution, wrapped_chat_agents


def wrap_agent_handoff_targets(agent: "ConversableAgent", wrapped_agent_list: list["ConversableAgent"]) -> None:
    """Wrap handoff targets in agents that need to be wrapped to be part of the group chat.

    Example is NestedChatTarget.

    Args:
        agent ("ConversableAgent"): The agent to wrap the handoff targets for.
        wrapped_agent_list (list["ConversableAgent"]): List of wrapped chat agents that will be appended to.
    """
    # Wrap OnCondition targets
    for i, handoff_oncondition_requiring_wrapping in enumerate(agent.handoffs.get_llm_conditions_requiring_wrapping()):
        # Create wrapper agent
        wrapper_agent = handoff_oncondition_requiring_wrapping.target.create_wrapper_agent(parent_agent=agent, index=i)
        wrapped_agent_list.append(wrapper_agent)

        # Change this handoff target to point to the newly created agent
        handoff_oncondition_requiring_wrapping.target = AgentTarget(wrapper_agent)

    for i, handoff_oncontextcondition_requiring_wrapping in enumerate(
        agent.handoffs.get_context_conditions_requiring_wrapping()
    ):
        # Create wrapper agent
        wrapper_agent = handoff_oncontextcondition_requiring_wrapping.target.create_wrapper_agent(
            parent_agent=agent, index=i
        )
        wrapped_agent_list.append(wrapper_agent)

        # Change this handoff target to point to the newly created agent
        handoff_oncontextcondition_requiring_wrapping.target = AgentTarget(wrapper_agent)


def process_initial_messages(
    messages: Union[list[dict[str, Any]], str],
    user_agent: Optional["ConversableAgent"],
    agents: list["ConversableAgent"],
    wrapped_agents: list["ConversableAgent"],
) -> tuple[list[dict[str, Any]], Optional["ConversableAgent"], list[str], list[Agent]]:
    """Process initial messages, validating agent names against messages, and determining the last agent to speak.

    Args:
        messages: Initial messages to process.
        user_agent: Optional user proxy agent passed in to a_/initiate_group_chat.
        agents: Agents in the group.
        wrapped_agents: List of wrapped agents.

    Returns:
        list[dict[str, Any]]: Processed message(s).
        Agent: Last agent to speak.
        list[str]: List of agent names.
        list[Agent]: List of temporary user proxy agents to add to GroupChat.
    """
    from ..conversable_agent import ConversableAgent  # NEED SOLUTION

    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]

    group_agent_names = [agent.name for agent in agents + wrapped_agents]

    # If there's only one message and there's no identified group agent
    # Start with a user proxy agent, creating one if they haven't passed one in
    last_agent: Optional[ConversableAgent]
    temp_user_proxy: Optional[ConversableAgent] = None
    temp_user_list: list[Agent] = []
    if len(messages) == 1 and "name" not in messages[0] and not user_agent:
        temp_user_proxy = ConversableAgent(name="_User", code_execution_config=False, human_input_mode="ALWAYS")
        last_agent = temp_user_proxy
        temp_user_list.append(temp_user_proxy)
    else:
        last_message = messages[0]
        if "name" in last_message:
            if last_message["name"] in group_agent_names:
                last_agent = next(agent for agent in agents + wrapped_agents if agent.name == last_message["name"])  # type: ignore[assignment]
            elif user_agent and last_message["name"] == user_agent.name:
                last_agent = user_agent
            else:
                raise ValueError(f"Invalid group agent name in last message: {last_message['name']}")
        else:
            last_agent = user_agent if user_agent else temp_user_proxy

    return messages, last_agent, group_agent_names, temp_user_list


def setup_context_variables(
    tool_execution: "ConversableAgent",
    agents: list["ConversableAgent"],
    manager: GroupChatManager,
    user_agent: Optional["ConversableAgent"],
    context_variables: ContextVariables,
) -> None:
    """Assign a common context_variables reference to all agents in the group, including the tool executor, group chat manager, and user proxy agent.

    Args:
        tool_execution: The tool execution agent.
        agents: List of all agents in the conversation.
        manager: GroupChatManager instance.
        user_agent: Optional user proxy agent.
        context_variables: Context variables to assign to all agents.
    """
    for agent in agents + [tool_execution] + [manager] + ([user_agent] if user_agent else []):
        agent.context_variables = context_variables


def cleanup_temp_user_messages(chat_result: Any) -> None:
    """Remove temporary user proxy agent name from messages before returning.

    Args:
        chat_result: ChatResult instance.
    """
    for message in chat_result.chat_history:
        if "name" in message and message["name"] == "_User":
            del message["name"]


def get_last_agent_speaker(
    groupchat: GroupChat, group_agent_names: list[str], tool_executor: GroupToolExecutor
) -> Agent:
    """Get the last group agent from the group chat messages. Not including the tool executor."""
    last_group_speaker = None
    for message in reversed(groupchat.messages):
        if "name" in message and message["name"] in group_agent_names and message["name"] != tool_executor.name:
            agent = groupchat.agent_by_name(name=message["name"])
            if agent:
                last_group_speaker = agent
                break
    if last_group_speaker is None:
        raise ValueError("No group agent found in the message history")

    return last_group_speaker


def determine_next_agent(
    last_speaker: "ConversableAgent",
    groupchat: GroupChat,
    initial_agent: "ConversableAgent",
    use_initial_agent: bool,
    tool_executor: GroupToolExecutor,
    group_agent_names: list[str],
    user_agent: Optional["ConversableAgent"],
    group_after_work: TransitionTarget,
) -> Optional[Union[Agent, str]]:
    """Determine the next agent in the conversation.

    Args:
        last_speaker ("ConversableAgent"): The last agent to speak.
        groupchat (GroupChat): GroupChat instance.
        initial_agent ("ConversableAgent"): The initial agent in the conversation.
        use_initial_agent (bool): Whether to use the initial agent straight away.
        tool_executor ("ConversableAgent"): The tool execution agent.
        group_agent_names (list[str]): List of agent names.
        user_agent (UserProxyAgent): Optional user proxy agent.
        group_after_work (TransitionTarget): Group-level Transition option when an agent doesn't select the next agent.

    Returns:
        Optional[Union[Agent, str]]: The next agent or speaker selection method.
    """

    # Logic for determining the next target (anything based on Transition Target: an agent, wrapped agent, TerminateTarget, StayTarget, RevertToUserTarget, GroupManagerTarget, etc.
    # 1. If it's the first response -> initial agent
    # 2. If the last message is a tool call -> tool execution agent
    # 3. If the Tool Executor has determined a next target (e.g. ReplyResult specified target) -> transition to tool reply target
    # 4. If the user last spoke -> return to the previous agent
    # NOW "AFTER WORK":
    # 5. Get the After Work condition (if the agent doesn't have one, get the group-level one)
    # 6. Resolve and return the After Work condition -> agent / wrapped agent / TerminateTarget / StayTarget / RevertToUserTarget / GroupManagerTarget / etc.

    # 1. If it's the first response, return the initial agent
    if use_initial_agent:
        return initial_agent

    # 2. If the last message is a tool call, return the tool execution agent
    if "tool_calls" in groupchat.messages[-1]:
        return tool_executor

    # 3. If the Tool Executor has determined a next target, return that
    if tool_executor.has_next_target():
        next_agent = tool_executor.get_next_target()
        tool_executor.clear_next_target()

        if next_agent.can_resolve_for_speaker_selection():
            return next_agent.resolve(groupchat, last_speaker, user_agent).get_speaker_selection_result(groupchat)
        else:
            raise ValueError(
                "Tool Executor next target must be a valid TransitionTarget that can resolve for speaker selection."
            )

    # get the last group agent
    last_agent_speaker = get_last_agent_speaker(groupchat, group_agent_names, tool_executor)

    # If we are returning from a tool execution, return to the last agent that spoke
    if groupchat.messages[-1]["role"] == "tool":
        return last_agent_speaker

    # If the user last spoke, return to the agent prior to them (if they don't have an after work, otherwise it's treated like any other agent)
    if user_agent and last_speaker == user_agent:
        if not user_agent.handoffs.after_works:
            return last_agent_speaker
        else:
            last_agent_speaker = user_agent

    # AFTER WORK:

    # First, try to evaluate after_works context conditions
    after_works_result = _evaluate_after_works_conditions(
        last_agent_speaker,  # type: ignore[arg-type]
        groupchat,
        user_agent,
    )
    if after_works_result is not None:
        return after_works_result

    # If no after_works conditions matched, use the group-level after_work
    # Resolve the next agent, termination, or speaker selection method
    resolved_speaker_selection_result = group_after_work.resolve(
        groupchat,
        last_agent_speaker,  # type: ignore[arg-type]
        user_agent,
    ).get_speaker_selection_result(groupchat)

    return resolved_speaker_selection_result


def create_group_transition(
    initial_agent: "ConversableAgent",
    tool_execution: GroupToolExecutor,
    group_agent_names: list[str],
    user_agent: Optional["ConversableAgent"],
    group_after_work: TransitionTarget,
) -> Callable[["ConversableAgent", GroupChat], Optional[Union[Agent, str]]]:
    """Creates a transition function for group chat with enclosed state for the use_initial_agent.

    Args:
        initial_agent ("ConversableAgent"): The first agent to speak
        tool_execution (GroupToolExecutor): The tool execution agent
        group_agent_names (list[str]): List of all agent names
        user_agent (UserProxyAgent): Optional user proxy agent
        group_after_work (TransitionTarget): Group-level after work

    Returns:
        Callable[["ConversableAgent", GroupChat], Optional[Union[Agent, str]]]: The transition function
    """
    # Create enclosed state, this will be set once per creation so will only be True on the first execution
    # of group_transition
    state = {"use_initial_agent": True}

    def group_transition(last_speaker: "ConversableAgent", groupchat: GroupChat) -> Optional[Union[Agent, str]]:
        result = determine_next_agent(
            last_speaker=last_speaker,
            groupchat=groupchat,
            initial_agent=initial_agent,
            use_initial_agent=state["use_initial_agent"],
            tool_executor=tool_execution,
            group_agent_names=group_agent_names,
            user_agent=user_agent,
            group_after_work=group_after_work,
        )
        state["use_initial_agent"] = False
        return result

    return group_transition


def create_group_manager(
    groupchat: GroupChat,
    group_manager_args: Optional[dict[str, Any]],
    agents: list["ConversableAgent"],
    group_after_work: TransitionTarget,
) -> GroupChatManager:
    """Create a GroupChatManager for the group chat utilising any arguments passed in and ensure an LLM Config exists if needed

    Args:
        groupchat (GroupChat): The groupchat.
        group_manager_args (dict[str, Any]): Group manager arguments to create the GroupChatManager.
        agents (list["ConversableAgent"]): List of agents in the group to check handoffs and after work.
        group_after_work (TransitionTarget): Group-level after work to check.

    Returns:
        GroupChatManager: GroupChatManager instance.
    """
    manager_args = (group_manager_args or {}).copy()
    if "groupchat" in manager_args:
        raise ValueError("'groupchat' cannot be specified in group_manager_args as it is set by initiate_group_chat")
    manager = GroupChatManager(groupchat, **manager_args)

    # Ensure that our manager has an LLM Config if we have any GroupManagerTarget targets used
    if manager.llm_config is False:
        has_group_manager_target = False

        if isinstance(group_after_work, GroupManagerTarget):
            # Check group after work
            has_group_manager_target = True
        else:
            # Check agent hand-offs and after work
            for agent in agents:
                if (
                    len(agent.handoffs.get_context_conditions_by_target_type(GroupManagerTarget)) > 0
                    or len(agent.handoffs.get_llm_conditions_by_target_type(GroupManagerTarget)) > 0
                    or any(isinstance(aw.target, GroupManagerTarget) for aw in agent.handoffs.after_works)
                ):
                    has_group_manager_target = True
                    break

        if has_group_manager_target:
            raise ValueError(
                "The group manager doesn't have an LLM Config and it is required for any targets or after works using a GroupManagerTarget. Use the 'llm_config' in the group_manager_args parameter to specify the LLM Config for the group manager."
            )

    return manager


def make_remove_function(tool_msgs_to_remove: list[str]) -> Callable[[list[dict[str, Any]]], list[dict[str, Any]]]:
    """Create a function to remove messages with tool calls from the messages list.

    The returned function can be registered as a hook to "process_all_messages_before_reply"" to remove messages with tool calls.
    """

    def remove_messages(messages: list[dict[str, Any]], tool_msgs_to_remove: list[str]) -> list[dict[str, Any]]:
        copied = copy.deepcopy(messages)
        new_messages = []
        removed_tool_ids = []
        for message in copied:
            # remove tool calls
            if message.get("tool_calls") is not None:
                filtered_tool_calls = []
                for tool_call in message["tool_calls"]:
                    if tool_call.get("function") is not None and tool_call["function"]["name"] in tool_msgs_to_remove:
                        # remove
                        removed_tool_ids.append(tool_call["id"])
                    else:
                        filtered_tool_calls.append(tool_call)
                if len(filtered_tool_calls) > 0:
                    message["tool_calls"] = filtered_tool_calls
                else:
                    del message["tool_calls"]
                    if (
                        message.get("content") is None
                        or message.get("content") == ""
                        or message.get("content") == "None"
                    ):
                        continue  # if no tool call and no content, skip this message
                    # else: keep the message with tool_calls removed
            # remove corresponding tool responses
            elif message.get("tool_responses") is not None:
                filtered_tool_responses = []
                for tool_response in message["tool_responses"]:
                    if tool_response["tool_call_id"] not in removed_tool_ids:
                        filtered_tool_responses.append(tool_response)

                if len(filtered_tool_responses) > 0:
                    message["tool_responses"] = filtered_tool_responses
                else:
                    continue

            new_messages.append(message)

        return new_messages

    return partial(remove_messages, tool_msgs_to_remove=tool_msgs_to_remove)
