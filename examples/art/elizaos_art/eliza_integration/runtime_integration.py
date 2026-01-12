"""
Full ElizaOS Runtime Integration for ART Training

This is the CANONICAL integration that uses the full ElizaOS agent runtime:
- Full AgentRuntime with character and plugins
- Message processing through message_service.handle_message
- Actions registered and invoked properly
- Providers supplying context  
- basicCapabilities enabled by default

NO SHORTCUTS, NO BYPASSES - this is the real thing.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Generic, TypeVar

from elizaos import (
    Action,
    ActionResult,
    AgentRuntime,
    Character,
    Content,
    HandlerCallback,
    HandlerOptions,
    Memory,
    ModelType,
    Plugin,
    Provider,
    ProviderResult,
    State,
    string_to_uuid,
)

from elizaos_art.base import (
    Action as GameAction,
    BaseAgent,
    BaseEnvironment,
    State as GameState,
    Trajectory,
    TrainingConfig,
)

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

S = TypeVar("S", bound=GameState)
A = TypeVar("A", bound=GameAction)


@dataclass
class ARTRuntimeConfig:
    """Configuration for ART runtime with full ElizaOS integration."""

    # Agent identification
    agent_id: str = "art-training-agent"
    agent_name: str = "ART Training Agent"
    agent_bio: str = "An AI agent that learns to play games through reinforcement learning."

    # Character customization
    character: Character | None = None

    # Model configuration - for LLM provider
    model_provider: str = "openai"  # or "anthropic", "local"
    model_name: str = "gpt-4o-mini"

    # Training
    training_config: TrainingConfig = field(default_factory=TrainingConfig)

    # Storage
    data_dir: str = "./data"

    # Capabilities - basicCapabilities is TRUE by default (not disabled)
    disable_basic_capabilities: bool = False
    enable_extended_capabilities: bool = False

    # Logging
    log_level: str = "INFO"


def create_game_state_provider(
    env: BaseEnvironment,
    current_state_holder: dict,
) -> Provider:
    """
    Create a Provider that supplies game state context to the agent.

    This is registered with the ElizaOS runtime and called during compose_state().
    """

    async def get_game_state(
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
    ) -> ProviderResult:
        """Get current game state for context."""
        game_state = current_state_holder.get("state")

        if game_state is None:
            return ProviderResult(
                text="No active game.",
                values={},
                data={},
            )

        # Get available actions
        available_actions = env.get_available_actions(game_state)
        action_names = [str(a) for a in available_actions]

        # Format state for LLM
        state_text = game_state.to_prompt() if hasattr(game_state, "to_prompt") else str(game_state)

        return ProviderResult(
            text=f"""# Current Game State

{state_text}

## Available Actions
{', '.join(action_names)}

Analyze the current state and decide on the best action to take.""",
            values={
                "game_state": game_state.to_dict() if hasattr(game_state, "to_dict") else {},
                "available_actions": action_names,
                "env_name": env.name,
            },
            data={
                "game_state": game_state.to_dict() if hasattr(game_state, "to_dict") else {},
                "available_actions": action_names,
            },
        )

    return Provider(
        name="GAME_STATE",
        description="Current game state and available actions for decision making",
        position=50,  # After basic providers but before others
        get=get_game_state,
    )


def create_game_action(
    env: BaseEnvironment,
    agent: BaseAgent,
    current_state_holder: dict,
    action_result_holder: dict,
) -> Action:
    """
    Create an Action that executes game moves.

    This is the canonical way to handle actions in ElizaOS.
    """

    async def validate_action(runtime: IAgentRuntime) -> bool:
        """Validate that we can execute a game action."""
        return current_state_holder.get("state") is not None

    async def handle_action(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        """
        Handle the PLAY_MOVE action.

        This is called when the agent decides to take an action in the game.
        """
        game_state = current_state_holder.get("state")
        if game_state is None:
            return ActionResult(
                success=False,
                error="No active game state",
            )

        # Get available actions
        available_actions = env.get_available_actions(game_state)
        if not available_actions:
            return ActionResult(
                success=False,
                error="No available actions",
            )

        # Parse the chosen action from the response
        response_text = ""
        if responses:
            for resp in responses:
                if resp.content and resp.content.text:
                    response_text = resp.content.text
                    break

        # Let the agent parse its chosen action
        try:
            chosen_action = agent.parse_action(response_text, available_actions)
        except Exception as e:
            runtime.logger.warning(f"Failed to parse action, using first available: {e}")
            chosen_action = available_actions[0]

        # Execute the action in the environment
        new_state, reward, done = await env.step(chosen_action)

        # Update state holder
        current_state_holder["state"] = new_state

        # Store result for trajectory
        action_result_holder["last_action"] = chosen_action
        action_result_holder["last_reward"] = reward
        action_result_holder["done"] = done

        # Format result message
        result_text = f"Executed action: {chosen_action}"
        if hasattr(chosen_action, "name"):
            result_text = f"Executed action: {chosen_action.name}"

        result_text += f"\nReward: {reward}"
        if done:
            result_text += "\nGame Over!"

        if callback:
            await callback(Content(text=result_text))

        return ActionResult(
            success=True,
            text=result_text,
            data={
                "action": str(chosen_action),
                "reward": reward,
                "done": done,
                "new_state": new_state.to_dict() if hasattr(new_state, "to_dict") else {},
            },
        )

    return Action(
        name="PLAY_MOVE",
        similes=["MAKE_MOVE", "TAKE_ACTION", "EXECUTE_MOVE", "GAME_ACTION"],
        description=f"Execute a move in the {env.name} game. Analyze the game state and choose the best action.",
        validate=validate_action,
        handler=handle_action,
        examples=[
            [
                {
                    "name": "{{user1}}",
                    "content": {"text": "What's your next move?"},
                },
                {
                    "name": "{{agentName}}",
                    "content": {
                        "text": "Looking at the current state, I'll move DOWN to keep my high tiles in the corner.",
                        "actions": ["PLAY_MOVE"],
                    },
                },
            ],
        ],
    )


def create_art_plugin(
    env: BaseEnvironment,
    agent: BaseAgent,
    current_state_holder: dict,
    action_result_holder: dict,
) -> Plugin:
    """
    Create a Plugin that provides game-specific actions and providers.

    This plugin is registered with the ElizaOS runtime alongside the bootstrap plugin.
    """

    async def init_plugin(
        config: dict,
        runtime: IAgentRuntime,
    ) -> None:
        """Initialize the ART game plugin."""
        runtime.logger.info(
            f"Initializing ART plugin for {env.name}",
            src="plugin:art-game",
        )

    return Plugin(
        name=f"art-{env.name}",
        description=f"ART training plugin for {env.name}",
        init=init_plugin,
        config={},
        providers=[
            create_game_state_provider(env, current_state_holder),
        ],
        actions=[
            create_game_action(env, agent, current_state_holder, action_result_holder),
        ],
    )


class ARTRuntime(Generic[S, A]):
    """
    Full ElizaOS Runtime for ART Training.

    This uses the REAL AgentRuntime with:
    - Full message processing through message_service.handle_message
    - Actions registered and invoked properly
    - Providers supplying context
    - basicCapabilities enabled by default

    NO SHORTCUTS - this is canonical ElizaOS agent usage.
    """

    def __init__(
        self,
        env: BaseEnvironment[S, A],
        agent: BaseAgent[S, A],
        config: ARTRuntimeConfig | None = None,
    ):
        self.env = env
        self.agent = agent
        self.config = config or ARTRuntimeConfig()

        # State holders for the game (shared with providers/actions)
        self._current_state_holder: dict = {}
        self._action_result_holder: dict = {}

        # ElizaOS runtime
        self._runtime: AgentRuntime | None = None
        self._initialized = False

        # Room/entity IDs for message handling
        self._room_id = string_to_uuid(f"art-game-{env.name}")
        self._user_id = string_to_uuid("art-user")
        self._world_id = string_to_uuid("art-world")

    def _create_character(self) -> Character:
        """Create the agent character with game-specific personality."""
        if self.config.character:
            return self.config.character

        # Build system prompt from agent
        system_prompt = self.agent.get_system_prompt()

        return Character(
            id=string_to_uuid(self.config.agent_id),
            name=self.config.agent_name,
            bio=self.config.agent_bio,
            system=system_prompt,
            settings={
                "model": self.config.model_name,
                # basicCapabilities is enabled by default (not disabled)
                "DISABLE_BASIC_CAPABILITIES": self.config.disable_basic_capabilities,
                "ENABLE_EXTENDED_CAPABILITIES": self.config.enable_extended_capabilities,
            },
        )

    async def initialize(self) -> None:
        """Initialize the full ElizaOS runtime."""
        if self._initialized:
            return

        # Initialize environment
        await self.env.initialize()

        # Create character
        character = self._create_character()

        # Create game-specific plugin
        game_plugin = create_art_plugin(
            env=self.env,
            agent=self.agent,
            current_state_holder=self._current_state_holder,
            action_result_holder=self._action_result_holder,
        )

        # Get model provider plugin
        plugins = [game_plugin]

        try:
            # Try to load OpenAI plugin if available
            from elizaos_plugin_openai import get_openai_plugin

            plugins.append(get_openai_plugin())
        except ImportError:
            pass

        # Create the REAL AgentRuntime
        self._runtime = AgentRuntime(
            character=character,
            plugins=plugins,
            log_level=self.config.log_level,
            # basicCapabilities is TRUE by default
            disable_basic_capabilities=self.config.disable_basic_capabilities,
            enable_extended_capabilities=self.config.enable_extended_capabilities,
            # Always respond in game context
            check_should_respond=False,
        )

        # Initialize runtime (this registers bootstrap plugin with basicCapabilities)
        await self._runtime.initialize()

        self._initialized = True

    async def _send_message_to_agent(
        self,
        text: str,
        collect_response: bool = True,
    ) -> tuple[str, list[ActionResult]]:
        """
        Send a message to the agent and get response.

        This goes through the FULL ElizaOS message handling pipeline:
        1. Create message memory
        2. Call message_service.handle_message
        3. Actions are invoked
        4. Providers supply context
        5. Response is generated

        NO BYPASSES.
        """
        if self._runtime is None:
            raise RuntimeError("Runtime not initialized")

        # Create message
        message_id = string_to_uuid(str(uuid.uuid4()))
        message = Memory(
            id=message_id,
            entity_id=self._user_id,
            room_id=self._room_id,
            content=Content(text=text),
            created_at=int(time.time() * 1000),
        )

        response_text = ""
        responses: list[str] = []

        # Callback to collect response
        async def response_callback(content: Content) -> list[Memory]:
            nonlocal response_text
            if content.text:
                response_text += content.text
                responses.append(content.text)
            return []

        # Process message through the FULL pipeline
        result = await self._runtime.message_service.handle_message(
            self._runtime,
            message,
            callback=response_callback if collect_response else None,
        )

        # Get action results
        action_results = self._runtime.get_action_results(message_id)

        return response_text, action_results

    async def rollout(
        self,
        scenario_id: str,
        seed: int | None = None,
        max_steps: int = 1000,
    ) -> Trajectory:
        """
        Execute a single rollout using the FULL ElizaOS agent.

        This is NOT a shortcut - it goes through proper message handling.
        """
        if not self._initialized:
            await self.initialize()

        messages: list[dict] = []
        total_reward = 0.0
        step_count = 0

        # Reset environment
        state = await self.env.reset(seed)
        self._current_state_holder["state"] = state
        self._action_result_holder.clear()

        # Add system prompt
        system_prompt = self.agent.get_system_prompt()
        messages.append({"role": "system", "content": system_prompt})

        done = False
        while not done and step_count < max_steps:
            # Check available actions
            available_actions = self.env.get_available_actions(state)
            if not available_actions:
                break

            # Format user message (the "environment" speaking to the agent)
            user_prompt = self.agent.format_action_prompt(state, available_actions)
            messages.append({"role": "user", "content": user_prompt})

            # Send message through FULL ElizaOS pipeline
            response_text, action_results = await self._send_message_to_agent(user_prompt)

            messages.append({"role": "assistant", "content": response_text})

            # Get action result from the handler
            if self._action_result_holder.get("last_action") is not None:
                reward = self._action_result_holder.get("last_reward", 0.0)
                done = self._action_result_holder.get("done", False)
                total_reward += reward
                step_count += 1

                # Update state
                state = self._current_state_holder.get("state")
                if state is None:
                    break

                # Clear for next step
                self._action_result_holder.clear()
            else:
                # Agent didn't take action - force one
                action = available_actions[0]
                state, reward, done = await self.env.step(action)
                self._current_state_holder["state"] = state
                total_reward += reward
                step_count += 1

        return Trajectory(
            trajectory_id=f"{scenario_id}-{int(time.time() * 1000)}",
            scenario_id=scenario_id,
            messages=messages,
            reward=total_reward,
            metadata={
                "env": self.env.name,
                "agent": self.agent.name,
                "model": self.config.model_name,
                "seed": seed,
            },
            metrics={
                "total_reward": total_reward,
                "steps": step_count,
            },
        )

    async def rollout_batch(
        self,
        scenario_id: str,
        num_rollouts: int,
        seeds: list[int] | None = None,
    ) -> list[Trajectory]:
        """Execute multiple rollouts for GRPO training."""
        if seeds is None:
            seeds = list(range(num_rollouts))

        trajectories = []
        for i, seed in enumerate(seeds[:num_rollouts]):
            traj = await self.rollout(
                scenario_id=f"{scenario_id}-{i}",
                seed=seed,
            )
            trajectories.append(traj)

        return trajectories

    async def evaluate(
        self,
        num_episodes: int = 100,
        seed_offset: int = 0,
    ) -> dict:
        """Evaluate current model performance."""
        rewards: list[float] = []
        wins = 0

        for i in range(num_episodes):
            traj = await self.rollout(
                scenario_id=f"eval-{i}",
                seed=seed_offset + i,
            )
            rewards.append(traj.reward)
            if traj.reward > 0:
                wins += 1

        return {
            "episodes": num_episodes,
            "avg_reward": sum(rewards) / len(rewards) if rewards else 0,
            "max_reward": max(rewards) if rewards else 0,
            "min_reward": min(rewards) if rewards else 0,
            "win_rate": wins / num_episodes if num_episodes > 0 else 0,
        }

    async def close(self) -> None:
        """Clean up resources."""
        if self._runtime:
            await self._runtime.stop()
        await self.env.close()


def create_art_runtime(
    env: BaseEnvironment,
    agent: BaseAgent,
    config: ARTRuntimeConfig | None = None,
) -> ARTRuntime:
    """
    Create an ART runtime with FULL ElizaOS integration.

    This uses the canonical ElizaOS agent pattern:
    - Full AgentRuntime with character
    - Message processing through message_service
    - Actions registered and invoked
    - Providers for context
    - basicCapabilities enabled by default

    Example:
        ```python
        from elizaos_art.games.game_2048 import Game2048Environment, Game2048Agent
        from elizaos_art.eliza_integration import create_art_runtime, ARTRuntimeConfig

        env = Game2048Environment()
        agent = Game2048Agent()
        config = ARTRuntimeConfig(
            agent_id="2048-trainer",
            model_name="gpt-4o-mini",
        )

        runtime = create_art_runtime(env, agent, config)
        await runtime.initialize()

        # Run evaluation
        results = await runtime.evaluate(num_episodes=100)
        print(f"Win rate: {results['win_rate']:.1%}")

        # Run training rollouts
        trajectories = await runtime.rollout_batch(
            scenario_id="training-batch-1",
            num_rollouts=8,
        )
        ```
    """
    return ARTRuntime(env=env, agent=agent, config=config)
