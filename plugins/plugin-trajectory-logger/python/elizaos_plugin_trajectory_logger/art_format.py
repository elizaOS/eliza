from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_trajectory_logger.types import (
    ARTTrajectory,
    ChatMessage,
    JsonValue,
    Trajectory,
    TrajectoryGroup,
    TrajectoryStep,
)


def to_art_messages(trajectory: Trajectory) -> list[ChatMessage]:
    messages: list[ChatMessage] = []

    system_message = _build_system_message(trajectory)
    if system_message is not None:
        messages.append(system_message)

    for step in trajectory.steps:
        user_content = _build_user_message(step)
        if user_content:
            messages.append(ChatMessage(role="user", content=user_content))

        assistant_content = _build_assistant_message(step)
        if assistant_content:
            messages.append(ChatMessage(role="assistant", content=assistant_content))

    return messages


def _build_system_message(trajectory: Trajectory) -> ChatMessage | None:
    if trajectory.steps and trajectory.steps[0].llm_calls:
        system_prompt = trajectory.steps[0].llm_calls[0].system_prompt
        if system_prompt:
            return ChatMessage(role="system", content=system_prompt)

    agent_name = str(trajectory.metadata.get("agentName") or "Agent")
    goal = str(trajectory.metadata.get("goalDescription") or "make good decisions")

    return ChatMessage(
        role="system",
        content=f"You are {agent_name}, an autonomous agent. Your goal is to {goal}.",
    )


def _build_user_message(step: TrajectoryStep) -> str | None:
    for call in step.llm_calls:
        if call.purpose == "action" and call.user_prompt:
            return call.user_prompt

    parts: list[str] = []
    parts.append("Current state:")
    parts.append(f"- Balance: ${step.environment_state.agent_balance}")
    parts.append(f"- P&L: ${step.environment_state.agent_pnl}")
    parts.append(f"- Open Positions: {step.environment_state.open_positions}")

    for provider in step.provider_accesses:
        parts.append(f"\n{provider.provider_name} data:")
        parts.append(str(provider.data))

    parts.append("\nWhat action should you take?")
    return "\n".join(parts)


def _build_assistant_message(step: TrajectoryStep) -> str | None:
    for call in step.llm_calls:
        if call.purpose == "action" and call.response:
            return call.response

    action = step.action
    parts: list[str] = [f"I will {action.action_type}."]
    if action.reasoning:
        parts.append(f"Reasoning: {action.reasoning}")
    parts.append(f"Parameters: {action.parameters}")
    return "\n".join(parts)


def to_art_trajectory(trajectory: Trajectory) -> ARTTrajectory:
    metadata: dict[str, JsonValue] = {
        "trajectoryId": trajectory.trajectory_id,
        "agentId": trajectory.agent_id,
        "scenarioId": trajectory.scenario_id,
        "groupIndex": trajectory.group_index,
        "metrics": trajectory.metrics.model_dump(mode="json"),
        # Preserve any caller-provided metadata for training/analysis.
        # We keep it namespaced to avoid colliding with reserved ART keys above.
        "extra": trajectory.metadata,
    }

    return ARTTrajectory(
        messages=to_art_messages(trajectory),
        reward=trajectory.total_reward,
        metadata=metadata,
        metrics=_filter_numeric_metrics(trajectory.metrics.model_dump(mode="json")),
    )


def _filter_numeric_metrics(metrics: dict[str, JsonValue]) -> dict[str, float]:
    numeric: dict[str, float] = {}
    for k, v in metrics.items():
        if isinstance(v, (int, float)):
            numeric[k] = float(v)
    return numeric


def group_trajectories(trajectories: list[Trajectory]) -> list[TrajectoryGroup]:
    groups: dict[str, list[Trajectory]] = {}
    for t in trajectories:
        scenario = t.scenario_id or "default"
        groups.setdefault(scenario, []).append(t)

    out: list[TrajectoryGroup] = []
    for idx, (scenario_id, trajs) in enumerate(groups.items()):
        out.append(
            TrajectoryGroup(
                group_id=f"group-{idx}",
                scenario_id=scenario_id,
                trajectories=trajs,
                shared_prefix=extract_shared_prefix(trajs),
                created_at=_now_ms(),
            )
        )
    return out


def extract_shared_prefix(trajectories: list[Trajectory]) -> list[ChatMessage]:
    if not trajectories:
        return []

    all_messages = [to_art_messages(t) for t in trajectories]
    if not all_messages or not all_messages[0]:
        return []

    first = all_messages[0]
    shared: list[ChatMessage] = []

    for i, message in enumerate(first):
        if all(i < len(msgs) and msgs[i] == message for msgs in all_messages):
            shared.append(message)
        else:
            break

    return shared


def remove_shared_prefix(
    messages: list[ChatMessage], shared_prefix: list[ChatMessage]
) -> list[ChatMessage]:
    return messages[len(shared_prefix) :]


@dataclass(frozen=True)
class RulerPayload:
    shared_prefix: list[ChatMessage]
    suffixes: list[list[ChatMessage]]
    metadata: list[dict[str, JsonValue]]


def prepare_for_ruler(group: TrajectoryGroup) -> RulerPayload:
    art_trajs = [to_art_trajectory(t) for t in group.trajectories]
    shared = group.shared_prefix or extract_shared_prefix(group.trajectories)

    return RulerPayload(
        shared_prefix=shared,
        suffixes=[remove_shared_prefix(t.messages, shared) for t in art_trajs],
        metadata=[t.metadata for t in art_trajs],
    )


def validate_art_compatibility(trajectory: Trajectory) -> tuple[bool, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if not trajectory.steps:
        errors.append("Trajectory has no steps")

    for idx, step in enumerate(trajectory.steps):
        if not step.llm_calls:
            errors.append(f"Step {idx} has no LLM calls - can't extract messages")
        for call in step.llm_calls:
            if not call.user_prompt or len(call.user_prompt) < 10:
                warnings.append(f"Step {idx} has very short user prompt")
            if not call.response or len(call.response) < 5:
                warnings.append(f"Step {idx} has very short response")

    if trajectory.total_reward is None:
        errors.append("Trajectory has no valid reward")

    art = to_art_trajectory(trajectory)
    if len(art.messages) < 2:
        warnings.append("Trajectory converts to very few messages (< 2)")

    return (len(errors) == 0, errors, warnings)


def _now_ms() -> int:
    return int(__import__("time").time() * 1000)
