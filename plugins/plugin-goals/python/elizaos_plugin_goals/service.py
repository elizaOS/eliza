"""Goal data service for managing goals."""

import logging
from datetime import datetime
from typing import Protocol

from elizaos_plugin_goals.types import (
    CreateGoalParams,
    Goal,
    GoalFilters,
    GoalOwnerType,
    UpdateGoalParams,
)

logger = logging.getLogger(__name__)


class DatabaseProtocol(Protocol):
    """Protocol for database operations."""

    async def execute(self, query: str, params: dict[str, object] | None = None) -> list[dict[str, object]]:
        """Execute a query and return results."""
        ...

    async def execute_one(self, query: str, params: dict[str, object] | None = None) -> dict[str, object] | None:
        """Execute a query and return a single result."""
        ...


class GoalDataService:
    """Service for managing goal data.

    This service provides CRUD operations for goals,
    including tag management and filtering capabilities.
    """

    def __init__(self, db: DatabaseProtocol) -> None:
        """Initialize the goal data service.

        Args:
            db: Database instance for executing queries
        """
        self.db = db

    async def create_goal(self, params: CreateGoalParams) -> str | None:
        """Create a new goal.

        Args:
            params: Goal creation parameters

        Returns:
            The created goal ID, or None if creation failed
        """
        try:
            import uuid

            goal_id = str(uuid.uuid4())
            now = datetime.now()

            # Insert goal
            await self.db.execute(
                """
                INSERT INTO goals (id, agent_id, owner_type, owner_id, name, description, metadata, created_at, updated_at)
                VALUES (:id, :agent_id, :owner_type, :owner_id, :name, :description, :metadata, :created_at, :updated_at)
                """,
                {
                    "id": goal_id,
                    "agent_id": params.agent_id,
                    "owner_type": params.owner_type.value,
                    "owner_id": params.owner_id,
                    "name": params.name,
                    "description": params.description,
                    "metadata": params.metadata,
                    "created_at": now,
                    "updated_at": now,
                },
            )

            # Insert tags
            if params.tags:
                for tag in params.tags:
                    tag_id = str(uuid.uuid4())
                    await self.db.execute(
                        """
                        INSERT INTO goal_tags (id, goal_id, tag, created_at)
                        VALUES (:id, :goal_id, :tag, :created_at)
                        """,
                        {
                            "id": tag_id,
                            "goal_id": goal_id,
                            "tag": tag,
                            "created_at": now,
                        },
                    )

            return goal_id

        except Exception as e:
            logger.exception("Error creating goal: %s", e)
            raise

    async def get_goal(self, goal_id: str) -> Goal | None:
        """Get a goal by ID.

        Args:
            goal_id: The goal ID

        Returns:
            The goal, or None if not found
        """
        try:
            result = await self.db.execute_one(
                "SELECT * FROM goals WHERE id = :id",
                {"id": goal_id},
            )

            if not result:
                return None

            # Get tags
            tags_result = await self.db.execute(
                "SELECT tag FROM goal_tags WHERE goal_id = :goal_id",
                {"goal_id": goal_id},
            )
            tags = [str(row["tag"]) for row in tags_result]

            return Goal(
                id=str(result["id"]),
                agent_id=str(result["agent_id"]),
                owner_type=GoalOwnerType(str(result["owner_type"])),
                owner_id=str(result["owner_id"]),
                name=str(result["name"]),
                description=str(result["description"]) if result.get("description") else None,
                is_completed=bool(result.get("is_completed", False)),
                completed_at=result.get("completed_at"),  # type: ignore[arg-type]
                created_at=result["created_at"],  # type: ignore[arg-type]
                updated_at=result["updated_at"],  # type: ignore[arg-type]
                metadata=dict(result.get("metadata", {})),  # type: ignore[arg-type]
                tags=tags,
            )

        except Exception as e:
            logger.exception("Error getting goal: %s", e)
            raise

    async def get_goals(self, filters: GoalFilters | None = None) -> list[Goal]:
        """Get goals with optional filters.

        Args:
            filters: Optional filters to apply

        Returns:
            List of matching goals
        """
        try:
            conditions: list[str] = []
            params: dict[str, object] = {}

            if filters:
                if filters.owner_type:
                    conditions.append("owner_type = :owner_type")
                    params["owner_type"] = filters.owner_type.value
                if filters.owner_id:
                    conditions.append("owner_id = :owner_id")
                    params["owner_id"] = filters.owner_id
                if filters.is_completed is not None:
                    conditions.append("is_completed = :is_completed")
                    params["is_completed"] = filters.is_completed

            where_clause = " AND ".join(conditions) if conditions else "1=1"
            query = f"SELECT * FROM goals WHERE {where_clause} ORDER BY created_at ASC"

            results = await self.db.execute(query, params)

            goals: list[Goal] = []
            for result in results:
                goal_id = str(result["id"])

                # Get tags
                tags_result = await self.db.execute(
                    "SELECT tag FROM goal_tags WHERE goal_id = :goal_id",
                    {"goal_id": goal_id},
                )
                tags = [str(row["tag"]) for row in tags_result]

                # Filter by tags if specified
                if filters and filters.tags:
                    if not any(tag in tags for tag in filters.tags):
                        continue

                goals.append(
                    Goal(
                        id=goal_id,
                        agent_id=str(result["agent_id"]),
                        owner_type=GoalOwnerType(str(result["owner_type"])),
                        owner_id=str(result["owner_id"]),
                        name=str(result["name"]),
                        description=str(result["description"]) if result.get("description") else None,
                        is_completed=bool(result.get("is_completed", False)),
                        completed_at=result.get("completed_at"),  # type: ignore[arg-type]
                        created_at=result["created_at"],  # type: ignore[arg-type]
                        updated_at=result["updated_at"],  # type: ignore[arg-type]
                        metadata=dict(result.get("metadata", {})),  # type: ignore[arg-type]
                        tags=tags,
                    )
                )

            return goals

        except Exception as e:
            logger.exception("Error getting goals: %s", e)
            raise

    async def update_goal(self, goal_id: str, updates: UpdateGoalParams) -> bool:
        """Update a goal.

        Args:
            goal_id: The goal ID
            updates: Fields to update

        Returns:
            True if update succeeded
        """
        try:
            set_clauses: list[str] = ["updated_at = :updated_at"]
            params: dict[str, object] = {"id": goal_id, "updated_at": datetime.now()}

            if updates.name is not None:
                set_clauses.append("name = :name")
                params["name"] = updates.name
            if updates.description is not None:
                set_clauses.append("description = :description")
                params["description"] = updates.description
            if updates.is_completed is not None:
                set_clauses.append("is_completed = :is_completed")
                params["is_completed"] = updates.is_completed
            if updates.completed_at is not None:
                set_clauses.append("completed_at = :completed_at")
                params["completed_at"] = updates.completed_at
            if updates.metadata is not None:
                set_clauses.append("metadata = :metadata")
                params["metadata"] = updates.metadata

            set_clause = ", ".join(set_clauses)
            await self.db.execute(
                f"UPDATE goals SET {set_clause} WHERE id = :id",
                params,
            )

            # Update tags if specified
            if updates.tags is not None:
                import uuid

                # Delete existing tags
                await self.db.execute(
                    "DELETE FROM goal_tags WHERE goal_id = :goal_id",
                    {"goal_id": goal_id},
                )

                # Insert new tags
                now = datetime.now()
                for tag in updates.tags:
                    tag_id = str(uuid.uuid4())
                    await self.db.execute(
                        """
                        INSERT INTO goal_tags (id, goal_id, tag, created_at)
                        VALUES (:id, :goal_id, :tag, :created_at)
                        """,
                        {
                            "id": tag_id,
                            "goal_id": goal_id,
                            "tag": tag,
                            "created_at": now,
                        },
                    )

            return True

        except Exception as e:
            logger.exception("Error updating goal: %s", e)
            raise

    async def delete_goal(self, goal_id: str) -> bool:
        """Delete a goal.

        Args:
            goal_id: The goal ID

        Returns:
            True if deletion succeeded
        """
        try:
            await self.db.execute(
                "DELETE FROM goals WHERE id = :id",
                {"id": goal_id},
            )
            return True

        except Exception as e:
            logger.exception("Error deleting goal: %s", e)
            raise

    async def get_uncompleted_goals(
        self,
        owner_type: GoalOwnerType | None = None,
        owner_id: str | None = None,
    ) -> list[Goal]:
        """Get uncompleted goals.

        Args:
            owner_type: Optional owner type filter
            owner_id: Optional owner ID filter

        Returns:
            List of uncompleted goals
        """
        return await self.get_goals(
            GoalFilters(
                owner_type=owner_type,
                owner_id=owner_id,
                is_completed=False,
            )
        )

    async def get_completed_goals(
        self,
        owner_type: GoalOwnerType | None = None,
        owner_id: str | None = None,
    ) -> list[Goal]:
        """Get completed goals.

        Args:
            owner_type: Optional owner type filter
            owner_id: Optional owner ID filter

        Returns:
            List of completed goals
        """
        return await self.get_goals(
            GoalFilters(
                owner_type=owner_type,
                owner_id=owner_id,
                is_completed=True,
            )
        )

    async def count_goals(
        self,
        owner_type: GoalOwnerType,
        owner_id: str,
        is_completed: bool | None = None,
    ) -> int:
        """Count goals with filters.

        Args:
            owner_type: Owner type filter
            owner_id: Owner ID filter
            is_completed: Optional completion status filter

        Returns:
            Number of matching goals
        """
        goals = await self.get_goals(
            GoalFilters(
                owner_type=owner_type,
                owner_id=owner_id,
                is_completed=is_completed,
            )
        )
        return len(goals)
