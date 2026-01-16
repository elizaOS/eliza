"""
Atropos integration for elizaOS TextWorld.

This module provides the bridge between elizaOS TextWorld gameplay and
the Atropos RL training framework. It handles:
- Trajectory collection during gameplay
- Tokenization with proper mask boundaries
- Formatting for Atropos ScoredDataItem/ScoredDataGroup
- Offline data generation
- BaseEnv implementation for live training

## Design Decisions

### Why Incremental Tokenization?

The naive approach to creating training masks is to tokenize the full conversation,
then search for assistant responses as substrings. This is BROKEN because:
1. Tokenizers don't preserve word boundaries (e.g., "take key" might tokenize
   differently when preceded by different text)
2. Special tokens (BOS, EOS, role markers) get inserted unpredictably
3. Chat templates add formatting that changes token boundaries

Instead, we tokenize incrementally: for each message, we tokenize the conversation
up to that point, then up to and including that message. The difference gives us
the exact tokens for that message, allowing precise mask assignment.

### Why ScoredDataGroup for GRPO?

GRPO (Group Relative Policy Optimization) compares multiple completions from the
same prompt to compute relative advantages. A single trajectory is useless for GRPO -
you need a GROUP of trajectories from the same starting state (same seed) to compare
which approaches worked better. The `format_group()` method handles this by bundling
multiple trajectories into the nested list format Atropos expects.

### Why Lazy Tokenizer Loading?

Tokenizers are expensive to load (~1-2 seconds, ~500MB memory for large models).
We use lazy loading via @property because:
1. Construction is fast - no I/O during __init__
2. The tokenizer is only loaded when actually needed
3. It stays loaded for reuse across multiple trajectories

### Why a Factory for BaseEnv?

The `create_atropos_env_class()` factory pattern exists because:
1. atroposlib is an optional dependency - importing it at module level would break
   users who just want offline data generation
2. The class definition itself references atroposlib types, so even defining
   the class requires the import to succeed
3. This pattern is common in ML frameworks (see: gym.make, transformers pipelines)
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from elizaos_atropos_textworld.types import (
    Turn,
    Trajectory,
    GameState,
    EpisodeResult,
)
from elizaos_atropos_textworld.environment import TextWorldEnvironment
from elizaos_atropos_textworld.agent import (
    ElizaOSAgent,
    create_heuristic_policy,
)

if TYPE_CHECKING:
    from transformers import PreTrainedTokenizer

logger = logging.getLogger(__name__)


# =============================================================================
# Configuration
# =============================================================================


class AtroposConfig:
    """
    Configuration for Atropos integration.
    
    This config controls both gameplay (game_type, difficulty) and training
    data formatting (tokenizer, max_tokens, scoring weights). We bundle these
    together because they're always used together - you can't generate training
    data without knowing both how to play and how to format the output.
    """

    def __init__(
        self,
        tokenizer_name: str = "meta-llama/Llama-3.2-3B-Instruct",
        game_type: str = "treasure_hunt",
        difficulty: str = "medium",
        max_tokens: int = 4096,
        use_elizaos: bool = True,
        win_bonus: float = 0.3,
        efficiency_weight: float = 0.2,
        trust_remote_code: bool = False,
    ):
        """
        Initialize Atropos configuration.

        Args:
            tokenizer_name: HuggingFace tokenizer to use for tokenization.
                MUST match the model you'll train - mismatched tokenizers produce
                garbage because different tokenizers map text to different token IDs.
            game_type: Type of TextWorld game (treasure_hunt, cooking, etc.)
            difficulty: Game difficulty (easy, medium, hard)
            max_tokens: Maximum token length for trajectories. Longer games get
                truncated. 4096 is a safe default for most models, but Llama-3.2
                supports 128k if needed. Truncation loses late-game context.
            use_elizaos: Whether to use elizaOS agent (True) or heuristic (False).
                Heuristic is faster (no API calls) but produces lower-quality data.
                Use heuristic for baselines and testing.
            win_bonus: Bonus score (0.0-1.0) added for winning the game.
                This incentivizes completion over partial progress. 0.3 means
                a won game with 70% item collection scores the same as a lost
                game with 100% collection.
            efficiency_weight: Weight (0.0-1.0) for step efficiency in scoring.
                Higher values reward faster solutions. 0.2 means using 50% of
                allowed steps adds 0.1 to score. Set to 0 if you don't care
                about solution length.
            trust_remote_code: Whether to allow loading tokenizers with custom code.
                SECURITY WARNING: When True, arbitrary Python code from model
                repositories can execute on your machine. Only enable for trusted
                models (e.g., official Llama, Mistral). Default False for security.
        """
        self.tokenizer_name = tokenizer_name
        self.game_type = game_type
        self.difficulty = difficulty
        self.max_tokens = max_tokens
        self.use_elizaos = use_elizaos
        self.win_bonus = win_bonus
        self.efficiency_weight = efficiency_weight
        self.trust_remote_code = trust_remote_code


# =============================================================================
# Trajectory Collection
# =============================================================================


class TrajectoryCollector:
    """
    Collects gameplay turns into trajectories for RL training.
    
    WHY THIS EXISTS:
    RL training requires trajectories: sequences of (state, action, reward).
    For language model training, we format this as a conversation where:
    - system: Sets up the task (appears once at start)
    - user: Represents the environment/game state (what the model sees)
    - assistant: Represents the model's actions (what we want to learn)
    
    This conversation format lets us use standard chat model training.
    The masks (computed later in AtroposFormatter) mark which tokens
    the model should learn to predict (assistant) vs. just read (user/system).
    
    WHY STATEFUL (start/observe/act/finish):
    We could pass all data to a single function, but the stateful API
    matches how games actually play out - you don't know the final outcome
    until the game ends. This also catches bugs: if you forget to call
    observe() before act(), the trajectory would be malformed.
    """

    # System prompt sets expectations for the model. We keep it short because:
    # 1. It's repeated in every trajectory (token cost)
    # 2. The model learns task-specific behavior from the training signal
    # 3. Overly detailed prompts can confuse small models
    SYSTEM_PROMPT = """You are playing a text adventure game.
Goal: Explore rooms, open containers, collect all treasures.
Respond with exactly one command from the available options."""

    def __init__(self):
        """Initialize the trajectory collector."""
        self._current: Trajectory | None = None

    def start(self, seed: int, agent_type: str) -> None:
        """
        Start recording a new trajectory.
        
        WHY SEED MATTERS:
        Seeds enable reproducibility. For GRPO, we play the SAME game (same seed)
        multiple times and compare outcomes. Without seeds, we'd be comparing
        apples to oranges.

        Args:
            seed: Game seed for reproducibility
            agent_type: Type of agent (elizaos, heuristic, etc.) - stored for analysis
        """
        self._current = Trajectory(seed=seed, agent_type=agent_type)
        self._current.turns.append(
            Turn(role="system", content=self.SYSTEM_PROMPT)
        )

    def observe(self, state: GameState) -> None:
        """
        Record a game state observation as a user message.
        
        WHY USER ROLE:
        In chat models, "user" represents external input the model must respond to.
        The game state IS external input - it's what the environment tells us.
        This maps naturally to the chat paradigm.
        
        WHY SET max_steps HERE:
        The game's step limit is known from the first observation. We capture it
        early so efficiency calculations are correct even if finish() isn't called
        (e.g., during debugging or if an exception occurs mid-game).

        Args:
            state: Current game state
        """
        if self._current is None:
            raise RuntimeError("Must call start() before observe()")
        
        # Capture max_steps from the first observation
        # WHY: Ensures trajectory has correct step limit for efficiency scoring
        # even before finish() is called
        if self._current.max_steps == 100:  # Still at default
            self._current.max_steps = state.max_steps
        
        content = self._format_state(state)
        self._current.turns.append(Turn(role="user", content=content))

    def act(self, action: str) -> None:
        """
        Record an action as an assistant message.
        
        WHY ASSISTANT ROLE:
        The model learns to predict assistant messages. By making actions
        assistant messages, we train the model to output valid game commands.
        The masks will mark these tokens for loss computation.

        Args:
            action: The action taken
        """
        if self._current is None:
            raise RuntimeError("Must call start() before act()")
        self._current.turns.append(Turn(role="assistant", content=action))

    def finish(self, result: EpisodeResult) -> Trajectory:
        """
        Finalize the trajectory with episode results.
        
        WHY NORMALIZE SCORE:
        Raw scores vary by game (some have max_score=3, others max_score=10).
        Normalizing to 0-1 makes scores comparable across different games
        and lets us apply consistent win_bonus/efficiency adjustments.

        Args:
            result: Episode result containing score, won status, etc.

        Returns:
            The completed trajectory
        """
        if self._current is None:
            raise RuntimeError("Must call start() before finish()")

        # Normalize to 0-1 range for cross-game comparability
        self._current.final_score = result.score / max(result.max_score, 1)
        self._current.won = result.won
        self._current.steps = result.steps
        self._current.max_steps = result.max_steps  # For accurate efficiency calculation
        trajectory = self._current
        self._current = None
        return trajectory

    def _format_state(self, state: GameState) -> str:
        """
        Format game state as a user message.
        
        WHY THIS FORMAT:
        We include: description (what you see), inventory (what you have),
        score/steps (progress), and available commands (what you can do).
        
        We limit commands to 20 because:
        1. Some games have 50+ commands - that's too many tokens
        2. The most useful commands are usually listed first
        3. Training should focus on common actions, not edge cases
        """
        cmds = state.admissible_commands[:20]  # Limit to avoid token explosion
        return f"""{state.description}

{state.inventory_str}
Score: {state.score}/{state.max_score} | Step {state.steps}/{state.max_steps}

Available: {", ".join(cmds)}"""


# =============================================================================
# Atropos Formatting
# =============================================================================


class AtroposFormatter:
    """
    Formats trajectories for Atropos training.
    
    WHY THIS CLASS EXISTS:
    Atropos expects data in a specific format (ScoredDataItem/ScoredDataGroup).
    This class handles the complex tokenization logic and scoring that bridges
    our game trajectories to Atropos's expected input format.
    
    The key challenge is MASK CREATION. In GRPO/PPO training, we only want to
    compute loss on the model's outputs (assistant messages), not on the context
    (system/user messages). Masks mark which tokens to train on (1) vs. ignore (0).
    """

    def __init__(self, config: AtroposConfig):
        """
        Initialize the formatter.

        Args:
            config: Atropos configuration (contains tokenizer name, scoring params)
        """
        self.config = config
        self._tokenizer: "PreTrainedTokenizer | None" = None
        self._has_chat_template: bool = False

    @property
    def tokenizer(self) -> "PreTrainedTokenizer":
        """
        Lazy-load the tokenizer.
        
        WHY LAZY LOADING:
        Tokenizers take 1-2 seconds to load and use ~500MB memory for large models.
        Lazy loading means we only pay this cost when actually formatting data,
        not at construction time. This is important for:
        1. Fast test setup (tests that don't format data skip the load)
        2. CLI help commands (--help shouldn't load a tokenizer)
        3. Error messages (config errors appear before slow loading)
        """
        if self._tokenizer is None:
            from transformers import AutoTokenizer

            # SECURITY: trust_remote_code allows arbitrary code execution from model repos
            # Only enable for trusted models; see config.trust_remote_code docstring
            if self.config.trust_remote_code:
                logger.warning(
                    f"Loading tokenizer {self.config.tokenizer_name} with trust_remote_code=True. "
                    f"This allows arbitrary code execution from the model repository. "
                    f"Only use this with trusted models."
                )

            self._tokenizer = AutoTokenizer.from_pretrained(
                self.config.tokenizer_name,
                trust_remote_code=self.config.trust_remote_code,
            )
            # Check if tokenizer supports chat templates (Llama, Mistral do; GPT-2 doesn't)
            self._has_chat_template = (
                hasattr(self._tokenizer, "chat_template")
                and self._tokenizer.chat_template is not None
            )
            logger.info(
                f"Loaded tokenizer {self.config.tokenizer_name}, "
                f"has_chat_template={self._has_chat_template}"
            )
        return self._tokenizer

    def format_trajectory(self, traj: Trajectory) -> dict[str, Any]:
        """
        Convert a trajectory to Atropos ScoredDataItem format.
        
        WHY THIS OUTPUT FORMAT:
        Atropos's ScoredDataItem has specific fields:
        - tokens: The tokenized sequence (what the model sees)
        - masks: Which tokens to compute loss on (1=train, 0=ignore)
        - scores: The reward signal for GRPO (higher = better trajectory)
        - messages: Original text for debugging/analysis
        - overrides: Metadata that persists through training

        Args:
            traj: Trajectory to format

        Returns:
            Dictionary in ScoredDataItem format
        """
        messages = [{"role": t.role, "content": t.content} for t in traj.turns]
        tokens, masks = self._tokenize_with_masks(messages)

        # Truncate if too long. We truncate from the END because:
        # 1. System prompt (start) is critical for task understanding
        # 2. Early game states establish context
        # 3. Late-game is often repetitive (wandering, retrying)
        # Note: This loses information about how the game ended, which is a tradeoff.
        if len(tokens) > self.config.max_tokens:
            original_len = len(tokens)
            tokens = tokens[: self.config.max_tokens]
            masks = masks[: self.config.max_tokens]
            logger.warning(
                f"Truncated trajectory from {original_len} to {self.config.max_tokens} tokens"
            )

        return {
            "tokens": tokens,
            "masks": masks,
            "scores": self._score(traj),
            "messages": messages,  # Keep original for debugging
            "advantages": None,  # Computed by Atropos during training
            "ref_logprobs": None,  # Computed by Atropos during training
            "group_overrides": None,  # For group-level settings
            "overrides": {
                "agent": traj.agent_type,  # Track which agent generated this
                "seed": traj.seed,  # For reproducibility analysis
                "won": traj.won,  # For filtering/analysis
            },
            "images": None,  # TextWorld is text-only
        }

    def format_group(self, trajectories: list[Trajectory]) -> dict[str, Any]:
        """
        Format multiple trajectories as ScoredDataGroup.
        
        WHY GROUPS MATTER FOR GRPO:
        GRPO computes "relative advantages" - how much better one completion is
        than others from the same prompt. For this, we need MULTIPLE trajectories
        from the SAME starting state (same seed). The group format bundles these
        together so Atropos can compare them.
        
        Example: If seed=42 produces trajectories with scores [0.8, 0.5, 0.3],
        GRPO learns that the 0.8 trajectory's actions were better than the others.

        Args:
            trajectories: List of trajectories from same starting state

        Returns:
            Dictionary in ScoredDataGroup format (lists of lists)
        """
        items = [self.format_trajectory(t) for t in trajectories]
        # ScoredDataGroup wraps everything in lists (one per trajectory)
        return {
            "tokens": [i["tokens"] for i in items],
            "masks": [i["masks"] for i in items],
            "scores": [i["scores"] for i in items],
            "messages": [i["messages"] for i in items],
            "advantages": None,
            "ref_logprobs": None,
            "group_overrides": None,
            "overrides": [i["overrides"] for i in items],
            "images": None,
        }

    def _tokenize_with_masks(
        self, messages: list[dict]
    ) -> tuple[list[int], list[int]]:
        """
        Tokenize messages with correct mask boundaries.
        
        WHY THIS IS THE HARDEST PART:
        Getting masks right is crucial. Wrong masks = training on wrong tokens.
        The naive approach (tokenize everything, find substrings) FAILS because
        tokenization is context-dependent. "take key" tokenizes differently
        depending on what comes before it.

        Args:
            messages: List of message dicts with role and content

        Returns:
            Tuple of (tokens, masks) where masks[i]=1 means tokens[i] is assistant
        """
        if self._has_chat_template:
            return self._tokenize_with_template(messages)
        return self._tokenize_simple(messages)

    def _tokenize_with_template(
        self, messages: list[dict]
    ) -> tuple[list[int], list[int]]:
        """
        Tokenize using chat template for proper boundaries.
        
        WHY INCREMENTAL TOKENIZATION:
        Chat templates (like Llama's) add special formatting around messages:
        <|begin_of_text|><|start_header_id|>user<|end_header_id|>...
        
        We can't predict exactly where message boundaries fall in the token sequence.
        Instead, we:
        1. Tokenize messages [0..i-1] -> get prefix_tokens
        2. Tokenize messages [0..i] -> get full_tokens  
        3. The difference (full - prefix) is exactly message i's tokens
        
        This is O(n²) in messages but n is small (~100 turns max) so it's fine.
        """
        tokens: list[int] = []
        masks: list[int] = []

        for i, msg in enumerate(messages):
            # Tokenize conversation up to (but not including) this message
            prefix = messages[:i]
            with_msg = messages[: i + 1]

            if prefix:
                prefix_text = self.tokenizer.apply_chat_template(
                    prefix, tokenize=False, add_generation_prompt=False
                )
                prefix_tokens = self.tokenizer.encode(
                    prefix_text, add_special_tokens=False
                )
            else:
                prefix_tokens = []

            # Tokenize conversation including this message
            full_text = self.tokenizer.apply_chat_template(
                with_msg, tokenize=False, add_generation_prompt=False
            )
            full_tokens = self.tokenizer.encode(
                full_text, add_special_tokens=False
            )

            # The difference is exactly this message's tokens
            new_tokens = full_tokens[len(prefix_tokens) :]
            # Only train on assistant tokens (the model's outputs)
            mask_val = 1 if msg["role"] == "assistant" else 0

            tokens.extend(new_tokens)
            masks.extend([mask_val] * len(new_tokens))

        return tokens, masks

    def _tokenize_simple(
        self, messages: list[dict]
    ) -> tuple[list[int], list[int]]:
        """
        Fallback tokenization without chat template.
        
        WHY WE NEED A FALLBACK:
        Not all tokenizers have chat templates (GPT-2, older models).
        For these, we use a simple format that mimics chat structure.
        
        This format (<|role|>\ncontent\n) is simple and unambiguous.
        It's not as good as a proper chat template but works for testing
        and older models.
        """
        tokens: list[int] = []
        masks: list[int] = []

        for msg in messages:
            # Simple format: role marker, newline, content, newline
            text = f"<|{msg['role']}|>\n{msg['content']}\n"
            msg_tokens = self.tokenizer.encode(text, add_special_tokens=False)
            mask_val = 1 if msg["role"] == "assistant" else 0

            tokens.extend(msg_tokens)
            masks.extend([mask_val] * len(msg_tokens))

        return tokens, masks

    def _score(self, traj: Trajectory) -> float:
        """
        Calculate GRPO score for a trajectory.
        
        WHY THIS SCORING FUNCTION:
        GRPO needs a scalar reward to compare trajectories. We combine:
        
        1. final_score (0-1): How many objectives were completed
           - This is the primary signal: did you collect the treasures?
        
        2. win_bonus (0.3 default): Extra reward for finishing
           - Without this, a trajectory that collected 9/10 items but didn't
             "win" would score the same as one that collected 9/10 and won
           - We want to incentivize COMPLETION, not just progress
        
        3. efficiency (0.2 weight default): Reward for fewer steps
           - Without this, a 100-step win equals a 10-step win
           - We want the model to learn EFFICIENT solutions
           - efficiency = 1 - (steps_used / max_steps)
        
        The weights (0.3, 0.2) are tunable. Current values mean:
        - Collecting items matters most
        - Winning adds meaningful bonus
        - Efficiency is a tiebreaker

        Args:
            traj: Trajectory to score

        Returns:
            Score between 0.0 and 1.0 (clamped)
        """
        score = traj.final_score  # Base: how much did we accomplish?

        if traj.won:
            score += self.config.win_bonus  # Bonus for finishing

        # Efficiency: 1.0 if used 0 steps, 0.0 if used all steps
        efficiency = 1.0 - (traj.steps / max(traj.max_steps, 1))
        score += efficiency * self.config.efficiency_weight

        # Clamp to [0, 1] for consistency
        return max(0.0, min(1.0, score))


# =============================================================================
# Offline Data Generation
# =============================================================================


async def generate_training_data(
    num_episodes: int,
    config: AtroposConfig | None = None,
    output_path: str | None = None,
    verbose: bool = False,
) -> list[dict]:
    """
    Generate Atropos training data from elizaOS gameplay.
    
    WHY OFFLINE GENERATION:
    This function generates training data WITHOUT running Atropos. This is useful for:
    1. Debugging: You can inspect the data before expensive training
    2. Pre-generation: Generate data overnight, train during the day
    3. Sharing: Generate once, share dataset with others
    4. Reproducibility: Exact data can be version-controlled
    
    For live training (where Atropos generates data as it trains), use
    create_atropos_env_class() instead.

    Args:
        num_episodes: Number of episodes to generate. More = better training
            but slower generation. 100 for testing, 1000+ for real training.
        config: Atropos configuration (uses defaults if None)
        output_path: Path to save JSONL output (optional). JSONL format is
            one JSON object per line - easy to stream and append.
        verbose: Whether to print progress (recommended for long runs)

    Returns:
        List of formatted trajectories (also saved to output_path if provided)
    """
    config = config or AtroposConfig()

    # Initialize environment once and reuse (creating games is expensive)
    env = TextWorldEnvironment(
        game_type=config.game_type,
        difficulty=config.difficulty,
    )
    await env.initialize()

    collector = TrajectoryCollector()
    formatter = AtroposFormatter(config)

    # Initialize agent if using elizaOS (otherwise use heuristics)
    # We create it once and reuse - AgentRuntime init is expensive
    agent: ElizaOSAgent | None = None
    if config.use_elizaos:
        agent = ElizaOSAgent()
        await agent.initialize()

    trajectories: list[dict] = []
    agent_type = "elizaos" if config.use_elizaos else "heuristic"

    try:
        for ep in range(num_episodes):
            # Use episode number as seed for reproducibility
            # This means episode 42 will always generate the same game
            collector.start(seed=ep, agent_type=agent_type)
            state = await env.reset(seed=ep)

            # Main game loop: observe -> decide -> act -> repeat
            while not state.game_over:
                collector.observe(state)

                if agent:
                    action = await agent.decide(state)
                else:
                    action = await create_heuristic_policy(state)

                collector.act(action)
                result = await env.step(action)
                state = result.state

            # Game ended - finalize and format the trajectory
            traj = collector.finish(env.get_episode_result())
            formatted = formatter.format_trajectory(traj)
            trajectories.append(formatted)

            if verbose:
                status = "WON" if traj.won else "lost"
                print(
                    f"  {ep + 1}/{num_episodes}: {status} | "
                    f"score={formatted['scores']:.2f} | "
                    f"tokens={len(formatted['tokens'])}"
                )

        # Save to JSONL if path provided
        # JSONL = one JSON per line, easy to stream/append
        if output_path:
            with open(output_path, "w") as f:
                for t in trajectories:
                    f.write(json.dumps(t) + "\n")
            print(f"Saved {len(trajectories)} trajectories to {output_path}")

        return trajectories

    finally:
        # Always cleanup, even on error (prevents resource leaks)
        if agent:
            await agent.cleanup()
        await env.close()


# =============================================================================
# BaseEnv Implementation (for live training)
# =============================================================================


def create_atropos_env_class():
    """
    Factory to create BaseEnv subclass for live Atropos training.
    
    WHY A FACTORY FUNCTION:
    This is a factory (function that returns a class) rather than a direct class
    definition because:
    
    1. OPTIONAL DEPENDENCY: atroposlib is not required for offline data generation.
       If we defined TextWorldAtroposEnv at module level, importing this module
       would fail when atroposlib isn't installed. The factory delays the import
       until you actually need it.
    
    2. COMMON PATTERN: This is standard in ML frameworks. Compare:
       - gym.make("CartPole-v1") - factory function
       - transformers.pipeline("sentiment-analysis") - factory function
       - This pattern lets you list capabilities without loading everything
    
    WHY BaseEnv:
    Atropos's BaseEnv is an abstract class that defines how environments interact
    with the training loop. By implementing BaseEnv, we can:
    - Run as an Atropos server (env feeds data to training workers)
    - Support live training (generate data as training proceeds)
    - Integrate with Atropos's GRPO implementation

    Returns:
        TextWorldAtroposEnv class (not instance - call .cli() to run)

    Example:
        >>> EnvClass = create_atropos_env_class()
        >>> EnvClass.cli()  # Starts Atropos server
    """
    # These imports only happen when you call this function
    from atroposlib.envs.base import BaseEnv, BaseEnvConfig
    from pydantic import Field

    class TextWorldAtroposConfig(BaseEnvConfig):
        """
        Configuration for TextWorld Atropos environment.
        
        Extends BaseEnvConfig (which has tokenizer_name, group_size, etc.)
        with TextWorld-specific settings.
        """
        game_type: str = Field(default="treasure_hunt")
        difficulty: str = Field(default="medium")
        use_elizaos: bool = Field(default=True)
        win_bonus: float = Field(default=0.3)
        efficiency_weight: float = Field(default=0.2)

    class TextWorldAtroposEnv(BaseEnv):
        """
        Atropos BaseEnv for elizaOS TextWorld training.
        
        This class implements Atropos's BaseEnv interface:
        - setup(): Initialize resources (called once at start)
        - get_next_item(): Return next prompt/seed (called repeatedly)
        - collect_trajectories(): Generate training data (called for each item)
        - cleanup(): Release resources (called at end)
        
        WHY REUSE RESOURCES:
        We create the environment, agent, and formatter in setup() and reuse them.
        Creating an AgentRuntime takes ~1 second, and we generate thousands of
        trajectories - recreating per-trajectory would be way too slow.
        """

        name = "elizaos-textworld"  # Identifies this env to Atropos
        env_config_cls = TextWorldAtroposConfig

        def __init__(self, config, server_configs, **kwargs):
            super().__init__(config, server_configs, **kwargs)
            # These are initialized in setup(), not here
            # WHY: __init__ should be fast; setup() does the slow stuff
            self.env: TextWorldEnvironment | None = None
            self.agent: ElizaOSAgent | None = None
            self.collector = TrajectoryCollector()
            self.formatter: AtroposFormatter | None = None
            self._seed = 0

        async def setup(self):
            """
            Initialize environment and agent.
            
            Called once when the Atropos server starts.
            All expensive operations (loading models, creating connections) go here.
            """
            self.env = TextWorldEnvironment(
                game_type=self.config.game_type,
                difficulty=self.config.difficulty,
            )
            await self.env.initialize()

            atropos_config = AtroposConfig(
                tokenizer_name=self.config.tokenizer_name,
                use_elizaos=self.config.use_elizaos,
                win_bonus=self.config.win_bonus,
                efficiency_weight=self.config.efficiency_weight,
            )
            self.formatter = AtroposFormatter(atropos_config)

            if self.config.use_elizaos:
                self.agent = ElizaOSAgent()
                await self.agent.initialize()

            logger.info(
                f"TextWorldAtroposEnv setup complete: "
                f"game_type={self.config.game_type}, "
                f"use_elizaos={self.config.use_elizaos}"
            )

        async def get_next_item(self):
            """
            Return next game seed.
            
            WHY SEQUENTIAL SEEDS:
            We increment seed for each item. This ensures:
            1. Different games for variety in training
            2. Reproducibility (same run = same seeds)
            3. Simple implementation (no random state to manage)
            
            For GRPO, the seed is reused for all trajectories in a group.
            """
            self._seed += 1
            return {"seed": self._seed}

        async def collect_trajectories(self, item):
            """
            Generate group_size trajectories for GRPO.
            
            WHY SAME SEED, MULTIPLE TRAJECTORIES:
            GRPO needs to compare different solutions to the SAME problem.
            By using the same seed, we get the same starting game state.
            The LLM's stochastic outputs (temperature > 0) produce different
            action sequences, leading to different outcomes.
            
            GRPO then computes: "trajectory A scored 0.8, trajectory B scored 0.5,
            so A's actions were relatively better". This relative comparison is
            more stable than absolute rewards.
            
            Returns:
                (ScoredDataGroup, []) - group of trajectories and empty stats list
            """
            trajectories: list[Trajectory] = []
            agent_type = "elizaos" if self.config.use_elizaos else "heuristic"

            # Generate group_size trajectories from same starting state
            for _ in range(self.config.group_size):
                self.collector.start(seed=item["seed"], agent_type=agent_type)
                # Same seed = same game = same starting state
                state = await self.env.reset(seed=item["seed"])

                while not state.game_over:
                    self.collector.observe(state)

                    if self.agent:
                        # LLM temperature > 0 means different outputs each time
                        action = await self.agent.decide(state)
                    else:
                        # Heuristic is deterministic - all trajectories identical
                        # (useful for testing, not for training)
                        action = await create_heuristic_policy(state)

                    self.collector.act(action)
                    result = await self.env.step(action)
                    state = result.state

                traj = self.collector.finish(self.env.get_episode_result())
                trajectories.append(traj)

            # Return as ScoredDataGroup (Atropos expects this format)
            return self.formatter.format_group(trajectories), []

        async def cleanup(self):
            """
            Cleanup resources.
            
            Called when Atropos server shuts down.
            Important to release LLM connections and game resources.
            """
            if self.agent:
                await self.agent.cleanup()
            if self.env:
                await self.env.close()
            logger.info("TextWorldAtroposEnv cleanup complete")

    return TextWorldAtroposEnv
