from __future__ import annotations

from datetime import datetime
from typing import Protocol
from uuid import UUID

from elizaos.types import Action, ActionResult, Plugin, Provider, ProviderResult

from elizaos_plugin_goals.actions.cancel_goal import CancelGoalAction
from elizaos_plugin_goals.actions.complete_goal import CompleteGoalAction
from elizaos_plugin_goals.actions.confirm_goal import ConfirmGoalAction
from elizaos_plugin_goals.actions.create_goal import CreateGoalAction
from elizaos_plugin_goals.actions.update_goal import UpdateGoalAction
from elizaos_plugin_goals.providers.goals import GoalsProvider
from elizaos_plugin_goals.types import (
    CreateGoalParams,
    Goal,
    GoalFilters,
    GoalOwnerType,
    UpdateGoalParams,
)


class TaskRuntime(Protocol):
    agent_id: str

    async def use_model(self, model_type: str, params: dict[str, object]) -> str: ...

    async def create_task(self, task: dict[str, object]) -> UUID: ...

    async def get_tasks(self, params: dict[str, object]) -> list[object]: ...

    async def get_task(self, id: UUID) -> object | None: ...

    async def update_task(self, id: UUID, task: dict[str, object]) -> None: ...

    async def delete_task(self, id: UUID) -> None: ...


class TaskBackedGoalService:
    """
    Goals stored as tasks (persisted when plugin-sql is enabled).

    This uses the core task CRUD surface exposed by the python runtime + plugin-sql adapter.
    """

    def __init__(self, runtime: TaskRuntime) -> None:
        self._runtime = runtime

    @staticmethod
    def _task_to_goal(task: object) -> Goal | None:
        if not isinstance(task, dict):
            return None

        raw_id = task.get("id")
        if not isinstance(raw_id, str):
            return None

        name = task.get("name")
        if not isinstance(name, str):
            return None

        metadata_obj = task.get("metadata")
        metadata: dict[str, object] = metadata_obj if isinstance(metadata_obj, dict) else {}

        agent_id = metadata.get("agentId")
        owner_type_raw = metadata.get("ownerType")
        owner_id = metadata.get("ownerId")

        if not isinstance(agent_id, str) or not isinstance(owner_id, str):
            return None

        owner_type = (
            GoalOwnerType(owner_type_raw)
            if isinstance(owner_type_raw, str) and owner_type_raw in ("agent", "entity")
            else GoalOwnerType.ENTITY
        )

        created_at_ms = task.get("createdAt")
        updated_at_ms = task.get("updatedAt")
        created_at = (
            datetime.utcfromtimestamp(created_at_ms / 1000)
            if isinstance(created_at_ms, int)
            else datetime.utcnow()
        )
        updated_at = (
            datetime.utcfromtimestamp(updated_at_ms / 1000)
            if isinstance(updated_at_ms, int)
            else datetime.utcnow()
        )

        is_completed = bool(task.get("status") == "completed")

        completed_at: datetime | None = None
        completed_at_raw = metadata.get("completedAt")
        if isinstance(completed_at_raw, str):
            try:
                completed_at = datetime.fromisoformat(completed_at_raw)
            except ValueError:
                completed_at = None

        tags_obj = task.get("tags")
        tags = [t for t in tags_obj if isinstance(t, str)] if isinstance(tags_obj, list) else []

        return Goal(
            id=raw_id,
            agent_id=agent_id,
            owner_type=owner_type,
            owner_id=owner_id,
            name=name,
            description=task.get("description")
            if isinstance(task.get("description"), str)
            else None,
            is_completed=is_completed,
            completed_at=completed_at,
            created_at=created_at,
            updated_at=updated_at,
            metadata=metadata,
            tags=tags,
        )

    async def create_goal(self, params: CreateGoalParams) -> str | None:
        task: dict[str, object] = {
            "name": params.name,
            "description": params.description,
            # Indexing tag for get_tasks overlap filter
            "tags": list({"GOAL", *(params.tags or [])}),
            "status": "pending",
            # Use task entityId as the goal owner for simple filtering.
            "entityId": params.owner_id,
            "metadata": {
                **(params.metadata or {}),
                "agentId": params.agent_id,
                "ownerType": params.owner_type.value,
                "ownerId": params.owner_id,
                "completedAt": None,
            },
        }
        goal_id = await self._runtime.create_task(task)
        return str(goal_id)

    async def get_goals(self, filters: GoalFilters | None = None) -> list[Goal]:
        params: dict[str, object] = {"tags": ["GOAL"]}
        if filters:
            if filters.owner_id:
                params["entityId"] = filters.owner_id
            if filters.tags:
                params["tags"] = list({"GOAL", *filters.tags})

        tasks = await self._runtime.get_tasks(params)
        goals: list[Goal] = []
        for t in tasks:
            goal = self._task_to_goal(t)
            if not goal:
                continue
            if filters and filters.owner_type and goal.owner_type != filters.owner_type:
                continue
            if (
                filters
                and filters.is_completed is not None
                and goal.is_completed != filters.is_completed
            ):
                continue
            goals.append(goal)
        goals.sort(key=lambda g: g.created_at)
        return goals

    async def count_goals(
        self, owner_type: GoalOwnerType, owner_id: str, is_completed: bool | None = None
    ) -> int:
        filters = GoalFilters(owner_type=owner_type, owner_id=owner_id, is_completed=is_completed)
        goals = await self.get_goals(filters)
        return len(goals)

    async def update_goal(self, goal_id: str, updates: UpdateGoalParams) -> bool:
        try:
            goal_uuid = UUID(goal_id)
        except ValueError:
            return False

        existing_task = await self._runtime.get_task(goal_uuid)
        existing_goal = self._task_to_goal(existing_task) if existing_task is not None else None
        if not existing_goal:
            return False

        status = "completed" if updates.is_completed is True else "pending"

        new_metadata: dict[str, object] = dict(existing_goal.metadata or {})
        if updates.metadata is not None:
            new_metadata = dict(updates.metadata)
        if updates.completed_at is not None:
            new_metadata["completedAt"] = updates.completed_at.isoformat()

        patch: dict[str, object] = {
            "name": updates.name if updates.name is not None else existing_goal.name,
            "description": updates.description
            if updates.description is not None
            else existing_goal.description,
            "status": status,
            "tags": updates.tags if updates.tags is not None else existing_goal.tags,
            "metadata": new_metadata,
        }
        await self._runtime.update_task(goal_uuid, patch)
        return True

    async def delete_goal(self, goal_id: str) -> bool:
        try:
            goal_uuid = UUID(goal_id)
        except ValueError:
            return False
        await self._runtime.delete_task(goal_uuid)
        return True


def _memory_to_message_dict(message: object) -> dict[str, object]:
    # The goal action implementations operate on a JS-like dict message shape.
    # We build the minimum fields they access.
    content_text = ""
    if hasattr(message, "content") and message.content is not None:
        content = message.content
        if hasattr(content, "text") and isinstance(content.text, str):
            content_text = content.text

    entity_id = getattr(message, "entity_id", "")
    room_id = getattr(message, "room_id", "")
    return {
        "entityId": str(entity_id) if entity_id else "",
        "roomId": str(room_id) if room_id else "",
        "content": {"text": content_text},
    }


async def _validate_with_action(
    action_obj: object, runtime: TaskRuntime, message: object, state: object | None
) -> bool:
    msg = _memory_to_message_dict(message)
    st: dict[str, object] | None = None
    if state is not None and hasattr(state, "model_dump"):
        dumped = state.model_dump(by_alias=True)
        st = dumped if isinstance(dumped, dict) else None
    if hasattr(action_obj, "validate"):
        # Some action validate methods accept (runtime, message) and others accept
        # (runtime, message, state). Detect parameter count to avoid TypeError.
        import inspect

        validate_fn = action_obj.validate
        try:
            param_len = len(inspect.signature(validate_fn).parameters)
        except (TypeError, ValueError):
            param_len = 0

        if param_len >= 3:
            return bool(await validate_fn(runtime, msg, st))
        return bool(await validate_fn(runtime, msg))
    return True


async def _handle_with_action(
    action_obj: object,
    runtime: TaskRuntime,
    message: object,
    state: object | None,
) -> ActionResult | None:
    msg = _memory_to_message_dict(message)
    st: dict[str, object] | None = None
    if state is not None and hasattr(state, "model_dump"):
        dumped = state.model_dump(by_alias=True)
        st = dumped if isinstance(dumped, dict) else None

    goal_service = TaskBackedGoalService(runtime)

    if hasattr(action_obj, "handler"):
        res = await action_obj.handler(runtime, msg, st, goal_service)
        if hasattr(res, "success"):
            return ActionResult(
                success=bool(res.success),
                text=getattr(res, "text", None),
                error=getattr(res, "error", None),
                data=getattr(res, "data", None),
            )
    return None


async def goals_provider_get(
    runtime: TaskRuntime, message: object, state: object
) -> ProviderResult:
    msg = _memory_to_message_dict(message)
    st: dict[str, object] = {}
    if hasattr(state, "model_dump"):
        dumped = state.model_dump(by_alias=True)
        if isinstance(dumped, dict):
            st = dumped

    provider = GoalsProvider()
    goal_service = TaskBackedGoalService(runtime)
    result = await provider.get(runtime, msg, st, goal_service)
    return ProviderResult(text=result.text, data=result.data, values=result.values)


async def init_goals_plugin(
    config: dict[str, str | int | float | bool | None], runtime: TaskRuntime
) -> None:
    _ = config, runtime


goals_plugin = Plugin(
    name="@elizaos/plugin-goals",
    description="Goal management and tracking for elizaOS agents (python runtime)",
    init=init_goals_plugin,
    actions=[
        Action(
            name=CreateGoalAction.name,
            description=CreateGoalAction.description,
            similes=CreateGoalAction.similes,
            examples=[
                [{"name": ex.name, "content": ex.content} for ex in example]
                for example in CreateGoalAction.examples
            ],
            validate=lambda runtime, message, state: _validate_with_action(
                CreateGoalAction(), runtime, message, state
            ),
            handler=lambda runtime,
            message,
            state,
            options,
            callback,
            responses: _handle_with_action(CreateGoalAction(), runtime, message, state),
        ),
        Action(
            name=ConfirmGoalAction.name,
            description=ConfirmGoalAction.description,
            similes=ConfirmGoalAction.similes,
            examples=[
                [{"name": ex.name, "content": ex.content} for ex in example]
                for example in ConfirmGoalAction.examples
            ],
            validate=lambda runtime, message, state: _validate_with_action(
                ConfirmGoalAction(), runtime, message, state
            ),
            handler=lambda runtime,
            message,
            state,
            options,
            callback,
            responses: _handle_with_action(ConfirmGoalAction(), runtime, message, state),
        ),
        Action(
            name=UpdateGoalAction.name,
            description=UpdateGoalAction.description,
            similes=UpdateGoalAction.similes,
            examples=[
                [{"name": ex.name, "content": ex.content} for ex in example]
                for example in UpdateGoalAction.examples
            ],
            validate=lambda runtime, message, state: _validate_with_action(
                UpdateGoalAction(), runtime, message, state
            ),
            handler=lambda runtime,
            message,
            state,
            options,
            callback,
            responses: _handle_with_action(UpdateGoalAction(), runtime, message, state),
        ),
        Action(
            name=CompleteGoalAction.name,
            description=CompleteGoalAction.description,
            similes=CompleteGoalAction.similes,
            examples=[
                [{"name": ex.name, "content": ex.content} for ex in example]
                for example in CompleteGoalAction.examples
            ],
            validate=lambda runtime, message, state: _validate_with_action(
                CompleteGoalAction(), runtime, message, state
            ),
            handler=lambda runtime,
            message,
            state,
            options,
            callback,
            responses: _handle_with_action(CompleteGoalAction(), runtime, message, state),
        ),
        Action(
            name=CancelGoalAction.name,
            description=CancelGoalAction.description,
            similes=CancelGoalAction.similes,
            examples=[
                [{"name": ex.name, "content": ex.content} for ex in example]
                for example in CancelGoalAction.examples
            ],
            validate=lambda runtime, message, state: _validate_with_action(
                CancelGoalAction(), runtime, message, state
            ),
            handler=lambda runtime,
            message,
            state,
            options,
            callback,
            responses: _handle_with_action(CancelGoalAction(), runtime, message, state),
        ),
    ],
    providers=[
        Provider(
            name=GoalsProvider.name,
            description=GoalsProvider.description,
            get=goals_provider_get,
        )
    ],
)
