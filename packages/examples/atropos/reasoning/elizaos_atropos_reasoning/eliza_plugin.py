"""
Canonical ElizaOS integration for Atropos Reasoning Gym.

Provides:
- ATROPOS_REASONING provider with current problem + feedback
- ATROPOS_REASONING_ACTION action that stores the selected answer in context
- Character template forcing action selection with params.answer
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos.types import ActionParameterSchema, Character, Plugin, ProviderResult

from elizaos_atropos_reasoning.types import StepResult

if TYPE_CHECKING:
    from elizaos.types import Action, Provider


from elizaos_atropos_shared.canonical_eliza import (
    ContextStore,
    CaptureActionResponse,
    create_action_only_template,
    create_basic_character,
    create_capture_action_from_store,
    create_provider_from_store,
    create_simple_plugin,
    err_capture,
    ok_capture,
)


@dataclass
class ReasoningDecisionContext:
    state: StepResult
    chosen_answer: str | None = None


REASONING_STORE: ContextStore[ReasoningDecisionContext] = ContextStore()


def set_reasoning_context(ctx: ReasoningDecisionContext | None) -> None:
    REASONING_STORE.set(ctx)


def get_reasoning_context() -> ReasoningDecisionContext | None:
    return REASONING_STORE.get()


def create_reasoning_provider() -> Provider:
    def render(ctx: ReasoningDecisionContext) -> ProviderResult:
        s = ctx.state
        fb = s.feedback or ""
        fb_block = f"\n## Feedback\n{fb}\n" if fb else ""
        text = (
            "# Atropos Reasoning\n"
            f"## Problem ({s.problem.task_type.value})\n"
            f"{s.problem.question}\n"
            f"\n## Attempts\n{s.attempts}\n"
            f"{fb_block}\n"
            "Return ONLY the final answer text in params.answer.\n"
        )

        return ProviderResult(
            text=text,
            values={"hasReasoning": True},
            data={
                "task_type": s.problem.task_type.value,
                "attempts": int(s.attempts),
            },
        )

    return create_provider_from_store(
        name="ATROPOS_REASONING",
        description="Provides Atropos Reasoning problem context.",
        store=REASONING_STORE,
        render=render,
        position=-10,
    )


def create_reasoning_action() -> Action:
    def apply_param(ctx: ReasoningDecisionContext, raw: str) -> CaptureActionResponse:
        answer = raw.strip()
        if not answer:
            return err_capture("Missing answer")
        ctx.chosen_answer = answer
        return ok_capture(
            values={"answer": answer},
            data={"actionName": "ATROPOS_REASONING_ACTION"},
            text="Captured reasoning answer",
        )

    return create_capture_action_from_store(
        name="ATROPOS_REASONING_ACTION",
        description="Submit the final answer for the current problem.",
        store=REASONING_STORE,
        param_name="answer",
        schema=ActionParameterSchema(type="string"),
        apply_param=apply_param,
    )


def create_reasoning_character(name: str = "ReasoningAgent") -> Character:
    template = create_action_only_template(
        task="Solve the problem for {{agentName}}.",
        instructions=(
            "Solve the problem. Output ONLY one ElizaOS action: ATROPOS_REASONING_ACTION.\n"
            "Put the final answer in params.answer (no extra text)."
        ),
        action_name="ATROPOS_REASONING_ACTION",
        param_name="answer",
        param_placeholder="final answer",
    )

    return create_basic_character(
        name=name,
        bio=[
            "A reasoning agent that solves math/logic puzzles.",
            "Returns final answers precisely.",
        ],
        system="You solve problems and output a final answer in the required format.",
        template=template,
    )


def get_reasoning_eliza_plugin() -> Plugin:
    return create_simple_plugin(
        name="atropos-reasoning",
        description="Atropos Reasoning canonical provider/action integration.",
        providers=[create_reasoning_provider()],
        actions=[create_reasoning_action()],
    )

