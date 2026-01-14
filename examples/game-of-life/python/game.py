#!/usr/bin/env python3
"""
elizaOS Agentic Game of Life (Python)

This example is intentionally "no LLM": decisions are produced by a custom
ModelType.TEXT_LARGE/TEXT_SMALL handler that returns deterministic XML.

IMPORTANT: each tick is processed through the full Eliza pipeline:
    result = await runtime.message_service.handle_message(runtime, message)

so there’s no bypassing (actions run via runtime.process_actions()).
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from dataclasses import dataclass

from elizaos import ChannelType, Character, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos.types.components import Action, ActionResult, HandlerOptions
from elizaos.types.model import ModelType
from elizaos.types.plugin import Plugin
from elizaos.types.primitives import UUID, as_uuid, string_to_uuid
from elizaos.types.state import State

# ============================================================================
# SIM CONFIG + WORLD STATE
# ============================================================================


CONFIG = {
    "WORLD_WIDTH": 24,
    "WORLD_HEIGHT": 14,
    "STARTING_ENERGY": 60.0,
    "MOVE_COST": 1.5,
    "FOOD_ENERGY": 18.0,
    "FOOD_SPAWN_RATE": 0.06,
    "MAX_FOOD": 50,
    "MAX_TICKS": 120,
}

SIM_ROOM_ID: UUID = string_to_uuid("game-of-life")
ENV_ENTITY_ID: UUID = string_to_uuid("game-of-life-environment")


@dataclass
class Position:
    x: int
    y: int


@dataclass
class AgentState:
    position: Position
    energy: float
    vision: int


# Global simulation state shared by the example (environment)
food: dict[str, Position] = {}
agents: dict[UUID, AgentState] = {}


def pos_key(x: int, y: int) -> str:
    return f"{x},{y}"


def wrap(v: int, max_v: int) -> int:
    return ((v % max_v) + max_v) % max_v


def dist(a: Position, b: Position) -> float:
    dx = min(abs(a.x - b.x), CONFIG["WORLD_WIDTH"] - abs(a.x - b.x))
    dy = min(abs(a.y - b.y), CONFIG["WORLD_HEIGHT"] - abs(a.y - b.y))
    return (dx * dx + dy * dy) ** 0.5


def spawn_food() -> None:
    if len(food) >= int(CONFIG["MAX_FOOD"]):
        return
    cells = int(CONFIG["WORLD_WIDTH"] * CONFIG["WORLD_HEIGHT"])
    spawns = max(1, int(cells * float(CONFIG["FOOD_SPAWN_RATE"])))
    for _ in range(spawns):
        x = random.randint(0, int(CONFIG["WORLD_WIDTH"]) - 1)
        y = random.randint(0, int(CONFIG["WORLD_HEIGHT"]) - 1)
        key = pos_key(x, y)
        if key not in food:
            food[key] = Position(x, y)


def render_tick(tick: int) -> str:
    grid: list[list[str]] = [
        ["·" for _ in range(int(CONFIG["WORLD_WIDTH"]))] for _ in range(int(CONFIG["WORLD_HEIGHT"]))
    ]
    for p in food.values():
        grid[p.y][p.x] = "🌱"
    for a in agents.values():
        grid[a.position.y][a.position.x] = "●"

    lines = ["".join(row) for row in grid]
    return (
        "\n".join(lines)
        + f"\n\nTick={tick}  Agents={len(agents)}  Food={len(food)}\n"
    )


# ============================================================================
# ACTIONS (mutate environment)
# ============================================================================


async def _always_validate(
    _runtime: AgentRuntime,
    _message: Memory,
    _state: State | None,
) -> bool:
    return True


async def eat_handler(
    runtime: AgentRuntime,
    _message: Memory,
    _state: State | None,
    _options: HandlerOptions | None,
    _callback: object | None,
    _responses: list[Memory] | None,
) -> ActionResult | None:
    st = agents.get(runtime.agent_id)
    if st is None:
        return ActionResult(success=False, text="No agent state")
    key = pos_key(st.position.x, st.position.y)
    if key in food:
        del food[key]
        st.energy += float(CONFIG["FOOD_ENERGY"])
        return ActionResult(success=True, text="EAT")
    return ActionResult(success=False, text="No food here")


async def move_toward_food_handler(
    runtime: AgentRuntime,
    _message: Memory,
    _state: State | None,
    _options: HandlerOptions | None,
    _callback: object | None,
    _responses: list[Memory] | None,
) -> ActionResult | None:
    st = agents.get(runtime.agent_id)
    if st is None:
        return ActionResult(success=False, text="No agent state")

    nearest: Position | None = None
    nearest_d = 1e9
    for p in food.values():
        d = dist(st.position, p)
        if d <= float(st.vision) and d < nearest_d:
            nearest = p
            nearest_d = d

    if nearest is None:
        return ActionResult(success=False, text="No visible food")

    dx = nearest.x - st.position.x
    dy = nearest.y - st.position.y
    if abs(dx) > int(CONFIG["WORLD_WIDTH"]) // 2:
        dx = -1 if dx > 0 else 1
    if abs(dy) > int(CONFIG["WORLD_HEIGHT"]) // 2:
        dy = -1 if dy > 0 else 1

    st.position.x = wrap(st.position.x + (1 if dx > 0 else -1 if dx < 0 else 0), int(CONFIG["WORLD_WIDTH"]))
    st.position.y = wrap(st.position.y + (1 if dy > 0 else -1 if dy < 0 else 0), int(CONFIG["WORLD_HEIGHT"]))
    st.energy -= float(CONFIG["MOVE_COST"])
    return ActionResult(success=True, text="MOVE_TOWARD_FOOD")


async def wander_handler(
    runtime: AgentRuntime,
    _message: Memory,
    _state: State | None,
    _options: HandlerOptions | None,
    _callback: object | None,
    _responses: list[Memory] | None,
) -> ActionResult | None:
    st = agents.get(runtime.agent_id)
    if st is None:
        return ActionResult(success=False, text="No agent state")
    st.position.x = wrap(st.position.x + random.choice([-1, 0, 1]), int(CONFIG["WORLD_WIDTH"]))
    st.position.y = wrap(st.position.y + random.choice([-1, 0, 1]), int(CONFIG["WORLD_HEIGHT"]))
    st.energy -= float(CONFIG["MOVE_COST"]) * 0.5
    return ActionResult(success=True, text="WANDER")


eat_action = Action(
    name="EAT",
    description="Eat food at current position",
    similes=["CONSUME", "FEED"],
    validate=_always_validate,
    handler=eat_handler,
)

move_toward_food_action = Action(
    name="MOVE_TOWARD_FOOD",
    description="Move one step toward nearest visible food",
    similes=["SEEK_FOOD", "FORAGE"],
    validate=_always_validate,
    handler=move_toward_food_handler,
)

wander_action = Action(
    name="WANDER",
    description="Move randomly when nothing else is attractive",
    similes=["ROAM", "EXPLORE"],
    validate=_always_validate,
    handler=wander_handler,
)


# ============================================================================
# RULE-BASED MODEL HANDLER (returns XML for DefaultMessageService)
# ============================================================================


def _escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _decision_xml(action_name: str, thought: str) -> str:
    return (
        f"<thought>{_escape_xml(thought)}</thought>"
        f"<actions>{_escape_xml(action_name)}</actions>"
        f"<text>{_escape_xml(action_name)}</text>"
    )


def _extract_env(prompt: str) -> dict[str, str]:
    # Environment message is included verbatim somewhere in the prompt via recent messages.
    # We recover simple KEY=VALUE lines for determinism (no JSON parsing).
    out: dict[str, str] = {}
    for line in prompt.splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip().upper()
        v = v.strip()
        if not k:
            continue
        if k in {"TICK", "POS", "ENERGY", "VISION", "FOOD_COUNT"}:
            out[k] = v
    return out


async def decision_model_handler(runtime: AgentRuntime, params: dict[str, object]) -> str:
    prompt = params.get("prompt")
    prompt_str = str(prompt) if prompt is not None else ""

    st = agents.get(runtime.agent_id)
    if st is None:
        return _decision_xml("WANDER", "No agent state; defaulting to wander.")

    env = _extract_env(prompt_str)

    # Rule priority:
    # 1) If standing on food -> EAT
    if pos_key(st.position.x, st.position.y) in food:
        return _decision_xml("EAT", "Food is underfoot; eat now.")

    # 2) If any visible food -> MOVE_TOWARD_FOOD
    for p in food.values():
        if dist(st.position, p) <= float(st.vision):
            thought = f"Visible food detected (food_count={env.get('FOOD_COUNT','?')}); moving toward it."
            return _decision_xml("MOVE_TOWARD_FOOD", thought)

    # 3) Default -> WANDER
    thought = f"No food visible; wandering. env_tick={env.get('TICK','?')}"
    return _decision_xml("WANDER", thought)


game_of_life_plugin = Plugin(
    name="game-of-life",
    description="Rule-based actions + model handler for a tiny Game-of-Life world",
    actions=[eat_action, move_toward_food_action, wander_action],
    models={
        ModelType.TEXT_LARGE.value: decision_model_handler,
        ModelType.TEXT_SMALL.value: decision_model_handler,
    },
)


# ============================================================================
# MAIN SIM
# ============================================================================


async def main() -> None:
    character = Character(
        name="LifeAgent",
        bio="A tiny agent living in a grid world.",
        system="You are a survival agent in a grid world. Choose one action.",
        settings={"CHECK_SHOULD_RESPOND": True},
    )

    runtime = AgentRuntime(character=character, plugins=[game_of_life_plugin])

    await runtime.initialize()

    # Create a single agent state bound to this runtime.
    agents[runtime.agent_id] = AgentState(
        position=Position(
            x=random.randint(0, int(CONFIG["WORLD_WIDTH"]) - 1),
            y=random.randint(0, int(CONFIG["WORLD_HEIGHT"]) - 1),
        ),
        energy=float(CONFIG["STARTING_ENERGY"]),
        vision=4,
    )

    # Seed some food
    for _ in range(10):
        spawn_food()

    print(
        "\n╔══════════════════════════════════════════════════════════════╗\n"
        "║              ELIZAOS AGENTIC GAME OF LIFE (PY)              ║\n"
        "╠══════════════════════════════════════════════════════════════╣\n"
        "║  Each tick: runtime.message_service.handle_message(...)      ║\n"
        "║  Decision: custom TEXT_LARGE handler (no LLM)                ║\n"
        "║  Action execution: runtime.process_actions()                 ║\n"
        "╚══════════════════════════════════════════════════════════════╝\n"
    )

    verbose = "--verbose" in __import__("sys").argv

    try:
        for tick in range(1, int(CONFIG["MAX_TICKS"]) + 1):
            spawn_food()

            st = agents[runtime.agent_id]
            env_text = "\n".join(
                [
                    f"TICK={tick}",
                    f"POS={st.position.x},{st.position.y}",
                    f"ENERGY={int(st.energy)}",
                    f"VISION={st.vision}",
                    f"FOOD_COUNT={len(food)}",
                ]
            )

            message = Memory(
                id=as_uuid(str(uuid.uuid4())),
                entity_id=ENV_ENTITY_ID,
                room_id=SIM_ROOM_ID,
                content=Content(
                    text=env_text,
                    source="simulation",
                    channel_type=ChannelType.DM.value,
                ),
            )

            # Canonical pipeline: message_service.handle_message -> use_model -> process_actions
            result = await runtime.message_service.handle_message(runtime, message)

            if verbose and message.id is not None:
                actions = result.response_content.actions if result.response_content else None
                thought = result.response_content.thought if result.response_content else None
                executed = runtime.get_action_results(message.id)
                executed_names = []
                for r in executed:
                    name = r.data.get("actionName") if r.data else None
                    if isinstance(name, str):
                        executed_names.append(name)
                print(
                    f"[tick={tick}] decision={actions} executed={executed_names} thought={(thought or '')[:80]}"
                )

            # Decay + death (simple)
            st.energy -= 0.25
            if st.energy <= 0:
                print("\n💀 Agent died (energy depleted).")
                break

            print("\x1b[2J\x1b[H" + render_tick(tick))
            await asyncio.sleep(0.08)

    finally:
        await runtime.stop()


if __name__ == "__main__":
    asyncio.run(main())

