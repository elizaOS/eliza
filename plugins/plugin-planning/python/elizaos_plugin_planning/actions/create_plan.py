from __future__ import annotations

import uuid
from dataclasses import dataclass
from elizaos_plugin_planning.actions.analyze_input import ActionExample


@dataclass
class CreatePlanAction:
    @property
    def name(self) -> str:
        return "CREATE_PLAN"

    @property
    def similes(self) -> list[str]:
        return ["PLAN_PROJECT", "GENERATE_PLAN", "MAKE_PLAN", "PROJECT_PLAN"]

    @property
    def description(self) -> str:
        return "Creates a comprehensive project plan with multiple phases and tasks"

    def _is_plan_request(self, text: str) -> bool:
        lower = text.lower()
        return any(
            word in lower for word in ["plan", "project", "comprehensive", "organize", "strategy"]
        )

    async def validate(self, message_text: str) -> bool:
        return self._is_plan_request(message_text)

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        plan_id = str(uuid.uuid4())

        return {
            "action": "CREATE_PLAN",
            "planId": plan_id,
            "name": "Comprehensive Project Plan",
            "phases": [
                {
                    "id": "phase_1",
                    "name": "Setup and Infrastructure",
                    "tasks": ["Repository Setup"],
                },
                {
                    "id": "phase_2",
                    "name": "Research and Knowledge",
                    "tasks": ["Research Best Practices", "Process Knowledge"],
                },
                {
                    "id": "phase_3",
                    "name": "Task Management",
                    "tasks": ["Create Initial Tasks"],
                },
            ],
            "totalPhases": 3,
            "totalTasks": 4,
            "executionStrategy": "sequential",
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="I need to launch a new open-source project. Please create a comprehensive plan.",
                output="I've created a comprehensive 3-phase project plan for your open-source launch.",
            ),
        ]
