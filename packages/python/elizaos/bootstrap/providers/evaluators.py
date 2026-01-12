from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_evaluators(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    evaluator_info: list[dict[str, str]] = []

    for evaluator in runtime.evaluators:
        evaluator_info.append(
            {
                "name": evaluator.name,
                "description": getattr(evaluator, "description", "No description"),
            }
        )

    if not evaluator_info:
        return ProviderResult(
            text="No evaluators available.",
            values={"evaluatorCount": 0},
            data={"evaluators": []},
        )

    formatted_evaluators = "\n".join(f"- {e['name']}: {e['description']}" for e in evaluator_info)

    text = f"# Available Evaluators\n{formatted_evaluators}"

    return ProviderResult(
        text=text,
        values={
            "evaluatorCount": len(evaluator_info),
            "evaluatorNames": [e["name"] for e in evaluator_info],
        },
        data={
            "evaluators": evaluator_info,
        },
    )


evaluators_provider = Provider(
    name="EVALUATORS",
    description="Available evaluators for assessing agent behavior",
    get=get_evaluators,
    dynamic=False,
)
