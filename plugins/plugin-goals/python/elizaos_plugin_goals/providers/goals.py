from dataclasses import dataclass, field
from typing import Protocol

from elizaos_plugin_goals.types import Goal, GoalFilters, GoalOwnerType


class RuntimeProtocol(Protocol):
    agent_id: str


class GoalServiceProtocol(Protocol):
    async def get_goals(self, filters: GoalFilters | None = None) -> list[Goal]: ...


@dataclass
class ProviderResult:
    text: str
    data: dict[str, object] = field(default_factory=dict)
    values: dict[str, str] = field(default_factory=dict)


class GoalsProvider:
    name = "GOALS"
    description = "Provides information about active goals and recent achievements"

    async def get(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        state: dict[str, object],
        goal_service: GoalServiceProtocol,
    ) -> ProviderResult:
        try:
            entity_id = str(message.get("entityId", "")) if message else ""
            owner_type = GoalOwnerType.AGENT
            owner_id = runtime.agent_id

            if entity_id and entity_id != runtime.agent_id:
                owner_type = GoalOwnerType.ENTITY
                owner_id = entity_id

            # Get active goals
            active_goals = await goal_service.get_goals(
                GoalFilters(
                    owner_type=owner_type,
                    owner_id=owner_id,
                    is_completed=False,
                )
            )

            completed_goals = await goal_service.get_goals(
                GoalFilters(
                    owner_type=owner_type,
                    owner_id=owner_id,
                    is_completed=True,
                )
            )

            recent_completed = sorted(
                completed_goals,
                key=lambda g: g.completed_at.timestamp() if g.completed_at else 0,
                reverse=True,
            )[:5]

            output = ""

            if active_goals:
                output += "## Active Goals\n"
                for goal in active_goals:
                    tags = f" [{', '.join(goal.tags)}]" if goal.tags else ""
                    output += f"- {goal.name}{tags}"
                    if goal.description:
                        output += f" - {goal.description}"
                    output += "\n"
                output += "\n"

            if recent_completed:
                output += "## Recently Completed Goals\n"
                for goal in recent_completed:
                    completed_date = (
                        goal.completed_at.strftime("%Y-%m-%d")
                        if goal.completed_at
                        else "Unknown date"
                    )
                    output += f"- {goal.name} (completed {completed_date})\n"
                output += "\n"

            total_active = len(active_goals)
            total_completed = len(completed_goals)

            output += "## Summary\n"
            output += f"- Active goals: {total_active}\n"
            output += f"- Completed goals: {total_completed}\n"

            if not active_goals and not completed_goals:
                output = (
                    "No goals have been set yet. Consider creating some goals to track progress!"
                )

            return ProviderResult(
                text=output.strip(),
                data={
                    "activeGoalCount": total_active,
                    "completedGoalCount": total_completed,
                },
                values={
                    "activeGoalCount": str(total_active),
                    "completedGoalCount": str(total_completed),
                },
            )

        except Exception:
            return ProviderResult(
                text="Unable to retrieve goals information at this time.",
                data={},
                values={},
            )
