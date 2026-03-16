from dataclasses import dataclass, field
from typing import Protocol

from elizaos_plugin_goals.prompts import (
    build_check_similarity_prompt,
    build_extract_goal_prompt,
)
from elizaos_plugin_goals.types import (
    CreateGoalParams,
    ExtractedGoalInfo,
    Goal,
    GoalFilters,
    GoalOwnerType,
    SimilarityCheckResult,
)


class RuntimeProtocol(Protocol):
    agent_id: str

    async def use_model(self, model_type: str, params: dict[str, object]) -> str: ...

    async def compose_state(
        self, message: dict[str, object], providers: list[str]
    ) -> dict[str, object]: ...


class GoalServiceProtocol(Protocol):
    async def create_goal(self, params: CreateGoalParams) -> str | None: ...

    async def get_goals(self, filters: GoalFilters | None = None) -> list[Goal]: ...

    async def count_goals(
        self, owner_type: GoalOwnerType, owner_id: str, is_completed: bool | None = None
    ) -> int: ...


@dataclass
class ActionResult:
    success: bool
    text: str | None = None
    error: str | None = None
    data: dict[str, object] = field(default_factory=dict)


@dataclass
class ActionExample:
    name: str
    content: dict[str, object]


class CreateGoalAction:
    name = "CREATE_GOAL"
    similes = ["ADD_GOAL", "NEW_GOAL", "SET_GOAL", "TRACK_GOAL"]
    description = "Creates a new long-term achievable goal for the agent or a user."
    examples: list[list[ActionExample]] = [
        [
            ActionExample(
                name="{{name1}}",
                content={"text": "I want to set a goal to learn French fluently"},
            ),
            ActionExample(
                name="{{name2}}",
                content={
                    "text": '✅ New goal created: "Learn French fluently"',
                    "actions": ["CREATE_GOAL_SUCCESS"],
                },
            ),
        ],
        [
            ActionExample(
                name="{{name1}}",
                content={"text": "Add a goal for me to run a marathon"},
            ),
            ActionExample(
                name="{{name2}}",
                content={
                    "text": '✅ New goal created: "Run a marathon"',
                    "actions": ["CREATE_GOAL_SUCCESS"],
                },
            ),
        ],
    ]

    async def validate(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
    ) -> bool:
        return True

    async def _extract_goal_info(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        message_history: str,
    ) -> ExtractedGoalInfo | None:
        text = str(
            message.get("content", {}).get("text", "")
            if isinstance(message.get("content"), dict)
            else ""
        )
        prompt = build_extract_goal_prompt(text, message_history)
        result = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

        import re

        name_match = re.search(r"<name>(.*?)</name>", result, re.DOTALL)
        desc_match = re.search(r"<description>(.*?)</description>", result, re.DOTALL)
        owner_match = re.search(r"<ownerType>(.*?)</ownerType>", result, re.DOTALL)

        if not name_match:
            return None

        name = name_match.group(1).strip()
        if not name:
            return None

        description = desc_match.group(1).strip() if desc_match else None
        owner_type_str = owner_match.group(1).strip() if owner_match else "entity"
        owner_type = GoalOwnerType.AGENT if owner_type_str == "agent" else GoalOwnerType.ENTITY

        return ExtractedGoalInfo(
            name=name,
            description=description,
            owner_type=owner_type,
        )

    async def _check_similar_goal(
        self,
        runtime: RuntimeProtocol,
        new_goal: ExtractedGoalInfo,
        existing_goals: list[Goal],
    ) -> SimilarityCheckResult:
        if not existing_goals:
            return SimilarityCheckResult(has_similar=False, confidence=0)

        goals_data = [
            {"name": g.name, "description": g.description or "No description"}
            for g in existing_goals
        ]

        prompt = build_check_similarity_prompt(
            new_goal.name,
            new_goal.description,
            goals_data,
        )

        result = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})

        import re

        has_similar_match = re.search(r"<hasSimilar>(.*?)</hasSimilar>", result)
        similar_name_match = re.search(r"<similarGoalName>(.*?)</similarGoalName>", result)
        confidence_match = re.search(r"<confidence>(.*?)</confidence>", result)

        has_similar = has_similar_match and has_similar_match.group(1).strip().lower() == "true"
        similar_name = similar_name_match.group(1).strip() if similar_name_match else None
        confidence = int(confidence_match.group(1).strip()) if confidence_match else 0

        return SimilarityCheckResult(
            has_similar=has_similar,
            similar_goal_name=similar_name,
            confidence=confidence,
        )

    async def handler(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        state: dict[str, object] | None,
        goal_service: GoalServiceProtocol,
    ) -> ActionResult:
        try:
            message_history = ""
            if state and "data" in state:
                messages = state["data"].get("messages", [])
                if isinstance(messages, list):
                    message_history = "\n".join(
                        str(m.get("content", {}).get("text", ""))
                        for m in messages
                        if isinstance(m, dict)
                    )

            goal_info = await self._extract_goal_info(runtime, message, message_history)

            if not goal_info:
                return ActionResult(
                    success=False,
                    text="I couldn't understand what goal you want to create. Could you please provide a clear goal description?",
                    error="Could not understand goal description",
                )

            entity_id = str(message.get("entityId", ""))
            owner_id = (
                runtime.agent_id if goal_info.owner_type == GoalOwnerType.AGENT else entity_id
            )
            active_goal_count = await goal_service.count_goals(
                goal_info.owner_type,
                owner_id,
                False,
            )

            if active_goal_count >= 10:
                owner_text = "agent" if goal_info.owner_type == GoalOwnerType.AGENT else "user"
                return ActionResult(
                    success=False,
                    text=f"Cannot add new goal: The {owner_text} already has 10 active goals, which is the maximum allowed. Please complete or remove some existing goals first.",
                    error="Goal limit reached",
                )

            existing_goals = await goal_service.get_goals(
                GoalFilters(
                    owner_type=goal_info.owner_type,
                    owner_id=owner_id,
                    is_completed=False,
                )
            )

            similarity_check = await self._check_similar_goal(runtime, goal_info, existing_goals)

            if similarity_check.has_similar and similarity_check.confidence > 70:
                return ActionResult(
                    success=False,
                    text=f'It looks like there\'s already a similar goal: "{similarity_check.similar_goal_name}". Are you sure you want to add this as a separate goal?',
                    error="Similar goal exists",
                )

            tags = ["GOAL"]
            if goal_info.owner_type == GoalOwnerType.AGENT:
                tags.append("agent-goal")
            else:
                tags.append("entity-goal")

            created_goal_id = await goal_service.create_goal(
                CreateGoalParams(
                    agent_id=runtime.agent_id,
                    owner_type=goal_info.owner_type,
                    owner_id=owner_id,
                    name=goal_info.name,
                    description=goal_info.description or goal_info.name,
                    tags=tags,
                )
            )

            if not created_goal_id:
                return ActionResult(
                    success=False,
                    text="I encountered an error while creating your goal. Please try again.",
                    error="Failed to create goal",
                )

            success_message = f'✅ New goal created: "{goal_info.name}"'

            if active_goal_count >= 4:
                success_message += f"\n\n⚠️ You now have {active_goal_count + 1} active goals. Consider focusing on completing some of these before adding more."

            return ActionResult(
                success=True,
                text=success_message,
                data={"goal_id": created_goal_id},
            )

        except Exception as e:
            return ActionResult(
                success=False,
                text="I encountered an error while creating your goal. Please try again.",
                error=str(e),
            )
