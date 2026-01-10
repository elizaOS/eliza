"""
Classic ELIZA Pattern Matching Plugin.

Implements Joseph Weizenbaum's original 1966 ELIZA algorithm.
"""

from __future__ import annotations

import random
import re
from typing import Any

from elizaos_plugin_eliza_classic.types import ElizaConfig, ElizaPattern, ElizaRule

# ============================================================================
# ELIZA Pattern Database
# ============================================================================

ELIZA_PATTERNS: list[ElizaPattern] = [
    ElizaPattern(
        keyword="sorry",
        weight=1,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "Please don't apologize.",
                    "Apologies are not necessary.",
                    "What feelings do you have when you apologize?",
                    "I've told you that apologies are not required.",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="remember",
        weight=5,
        rules=[
            ElizaRule(
                pattern=re.compile(r"do you remember (.*)", re.IGNORECASE),
                responses=[
                    "Did you think I would forget $1?",
                    "Why do you think I should recall $1 now?",
                    "What about $1?",
                    "You mentioned $1.",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"i remember (.*)", re.IGNORECASE),
                responses=[
                    "Do you often think of $1?",
                    "Does thinking of $1 bring anything else to mind?",
                    "What else do you remember?",
                    "Why do you remember $1 just now?",
                    "What in the present situation reminds you of $1?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="if",
        weight=3,
        rules=[
            ElizaRule(
                pattern=re.compile(r"if (.*)", re.IGNORECASE),
                responses=[
                    "Do you think it's likely that $1?",
                    "Do you wish that $1?",
                    "What do you know about $1?",
                    "Really, if $1?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="dream",
        weight=3,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "What does that dream suggest to you?",
                    "Do you dream often?",
                    "What persons appear in your dreams?",
                    "Do you believe that dreams have something to do with your problems?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="hello",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "How do you do. Please state your problem.",
                    "Hi. What seems to be your problem?",
                    "Hello. Tell me what's on your mind.",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="hi",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "How do you do. Please state your problem.",
                    "Hi there. What brings you here today?",
                    "Hello. Tell me what's on your mind.",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="computer",
        weight=50,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "Do computers worry you?",
                    "Why do you mention computers?",
                    "What do you think machines have to do with your problem?",
                    "Don't you think computers can help people?",
                    "What about machines worries you?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="am",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r"am i (.*)", re.IGNORECASE),
                responses=[
                    "Do you believe you are $1?",
                    "Would you want to be $1?",
                    "Do you wish I would tell you you are $1?",
                    "What would it mean if you were $1?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"i am (.*)", re.IGNORECASE),
                responses=[
                    "Is it because you are $1 that you came to me?",
                    "How long have you been $1?",
                    "How do you feel about being $1?",
                    "Do you enjoy being $1?",
                    "Do you believe it is normal to be $1?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="i",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r"i (?:desire|want|need) (.*)", re.IGNORECASE),
                responses=[
                    "What would it mean to you if you got $1?",
                    "Why do you want $1?",
                    "Suppose you got $1 soon?",
                    "What if you never got $1?",
                    "What would getting $1 mean to you?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"i am (?:sad|depressed|unhappy|sick)", re.IGNORECASE),
                responses=[
                    "I am sorry to hear that you are feeling that way.",
                    "Do you think coming here will help you?",
                    "I'm sure it's not pleasant to feel that way.",
                    "Can you explain what made you feel this way?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"i am (?:happy|elated|glad|joyful)", re.IGNORECASE),
                responses=[
                    "How have I helped you to feel this way?",
                    "What makes you feel this way just now?",
                    "Can you explain why you are suddenly feeling this way?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"i (?:believe|think) (.*)", re.IGNORECASE),
                responses=[
                    "Do you really think so?",
                    "But you are not sure?",
                    "Do you really doubt that?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"i (?:feel|felt) (.*)", re.IGNORECASE),
                responses=[
                    "Tell me more about such feelings.",
                    "Do you often feel $1?",
                    "Do you enjoy feeling $1?",
                    "Of what does feeling $1 remind you?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"i can'?t (.*)", re.IGNORECASE),
                responses=[
                    "How do you know that you can't $1?",
                    "Have you tried?",
                    "Perhaps you could $1 now.",
                    "Do you really want to be able to $1?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"i don'?t (.*)", re.IGNORECASE),
                responses=[
                    "Don't you really $1?",
                    "Why don't you $1?",
                    "Do you wish to be able to $1?",
                    "Does that trouble you?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="you",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r"you are (.*)", re.IGNORECASE),
                responses=[
                    "What makes you think I am $1?",
                    "Does it please you to believe I am $1?",
                    "Do you sometimes wish you were $1?",
                    "Perhaps you would like to be $1.",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"you (.*) me", re.IGNORECASE),
                responses=[
                    "Why do you think I $1 you?",
                    "You like to think I $1 you -- don't you?",
                    "What makes you think I $1 you?",
                    "Really, I $1 you?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="my",
        weight=2,
        rules=[
            ElizaRule(
                pattern=re.compile(
                    r"my (?:mother|mom|father|dad|sister|brother|wife|husband|children|child)",
                    re.IGNORECASE,
                ),
                responses=[
                    "Tell me more about your family.",
                    "Who else in your family concerns you?",
                    "What else comes to mind when you think of your family?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"my (.*)", re.IGNORECASE),
                responses=[
                    "Your $1?",
                    "Why do you say your $1?",
                    "Does that suggest anything else which belongs to you?",
                    "Is it important to you that your $1?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="yes",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "You seem quite positive.",
                    "You are sure.",
                    "I see.",
                    "I understand.",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="no",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "Are you saying 'no' just to be negative?",
                    "You are being a bit negative.",
                    "Why not?",
                    "Why 'no'?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="why",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r"why don'?t you (.*)", re.IGNORECASE),
                responses=[
                    "Do you believe I don't $1?",
                    "Perhaps I will $1 in good time.",
                    "Should you $1 yourself?",
                    "You want me to $1?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r"why can'?t i (.*)", re.IGNORECASE),
                responses=[
                    "Do you think you should be able to $1?",
                    "Do you want to be able to $1?",
                    "Do you believe this will help you to $1?",
                    "Have you any idea why you can't $1?",
                ],
            ),
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "Why do you ask?",
                    "Does that question interest you?",
                    "What is it you really want to know?",
                    "Are such questions much on your mind?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="what",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "Why do you ask?",
                    "Does that question interest you?",
                    "What is it you really want to know?",
                    "Are such questions much on your mind?",
                    "What answer would please you most?",
                    "What do you think?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="because",
        weight=0,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "Is that the real reason?",
                    "Don't any other reasons come to mind?",
                    "Does that reason seem to explain anything else?",
                    "What other reasons might there be?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="everyone",
        weight=2,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "Really, everyone?",
                    "Surely not everyone.",
                    "Can you think of anyone in particular?",
                    "Who, for example?",
                ],
            ),
        ],
    ),
    ElizaPattern(
        keyword="always",
        weight=1,
        rules=[
            ElizaRule(
                pattern=re.compile(r".*", re.IGNORECASE),
                responses=[
                    "Can you think of a specific example?",
                    "When?",
                    "What incident are you thinking of?",
                    "Really, always?",
                ],
            ),
        ],
    ),
]

DEFAULT_RESPONSES: list[str] = [
    "Very interesting.",
    "I am not sure I understand you fully.",
    "What does that suggest to you?",
    "Please continue.",
    "Go on.",
    "Do you feel strongly about discussing such things?",
    "Tell me more.",
    "That is quite interesting.",
    "Can you elaborate on that?",
    "Why do you say that?",
    "I see.",
    "What does that mean to you?",
    "How does that make you feel?",
    "Let's explore that further.",
    "Interesting. Please go on.",
]

# Pronoun reflections
REFLECTIONS: dict[str, str] = {
    "am": "are",
    "was": "were",
    "i": "you",
    "i'd": "you would",
    "i've": "you have",
    "i'll": "you will",
    "my": "your",
    "are": "am",
    "you've": "I have",
    "you'll": "I will",
    "your": "my",
    "yours": "mine",
    "you": "me",
    "me": "you",
    "myself": "yourself",
    "yourself": "myself",
    "i'm": "you are",
}


def reflect(text: str) -> str:
    """
    Reflect pronouns in text (I → you, my → your, etc.).

    Args:
        text: The text to reflect.

    Returns:
        The text with reflected pronouns.
    """
    words = text.lower().split()
    reflected = [REFLECTIONS.get(word, word) for word in words]
    return " ".join(reflected)


def generate_response(
    input_text: str,
    patterns: list[ElizaPattern] | None = None,
    default_responses: list[str] | None = None,
    response_history: list[str] | None = None,
    max_history: int = 10,
) -> str:
    """
    Generate an ELIZA response for the given input.

    Args:
        input_text: The user's input text.
        patterns: Custom patterns (defaults to ELIZA_PATTERNS).
        default_responses: Custom default responses.
        response_history: List to track used responses for variety.
        max_history: Maximum size of response history.

    Returns:
        The ELIZA response.
    """
    if patterns is None:
        patterns = ELIZA_PATTERNS
    if default_responses is None:
        default_responses = DEFAULT_RESPONSES
    if response_history is None:
        response_history = []

    normalized_input = input_text.lower().strip()

    if not normalized_input:
        return "I didn't catch that. Could you please repeat?"

    # Find all matching patterns
    matches: list[tuple[ElizaPattern, ElizaRule, re.Match[str]]] = []

    for pattern in patterns:
        if pattern.keyword in normalized_input:
            for rule in pattern.rules:
                match = rule.pattern.search(normalized_input)
                if match:
                    matches.append((pattern, rule, match))

    if matches:
        # Sort by weight (higher weight = higher priority)
        matches.sort(key=lambda x: x[0].weight, reverse=True)
        best_pattern, best_rule, match = matches[0]

        # Select a response, avoiding recent ones
        available = [r for r in best_rule.responses if r not in response_history]
        pool = available if available else best_rule.responses
        response = random.choice(pool)

        # Track history
        response_history.append(response)
        if len(response_history) > max_history:
            response_history.pop(0)

        # Substitute captured groups
        for i in range(1, len(match.groups()) + 1):
            group = match.group(i)
            if group:
                reflected = reflect(group)
                response = response.replace(f"${i}", reflected)

        # Clean up remaining placeholders
        response = re.sub(r"\$\d+", "that", response)

        return response

    # No pattern matched, use default response
    available = [r for r in default_responses if r not in response_history]
    pool = available if available else default_responses
    response = random.choice(pool)

    response_history.append(response)
    if len(response_history) > max_history:
        response_history.pop(0)

    return response


def get_greeting() -> str:
    """Get the initial ELIZA greeting message."""
    return "Hello. I am ELIZA, a Rogerian psychotherapist simulation. How are you feeling today?"


class ElizaClassicPlugin:
    """
    Classic ELIZA pattern matching plugin for elizaOS.

    Provides a testable chat response interface without requiring an LLM.
    """

    def __init__(self, config: ElizaConfig | None = None) -> None:
        """
        Initialize the ELIZA Classic plugin.

        Args:
            config: Optional configuration for the plugin.
        """
        self._config = config or ElizaConfig()
        self._response_history: list[str] = []
        self._patterns = ELIZA_PATTERNS + self._config.custom_patterns
        self._default_responses = (
            self._config.custom_default_responses
            if self._config.custom_default_responses
            else DEFAULT_RESPONSES
        )

    def generate_response(self, input_text: str) -> str:
        """
        Generate an ELIZA response for the given input.

        Args:
            input_text: The user's input text.

        Returns:
            The ELIZA response.
        """
        return generate_response(
            input_text,
            patterns=self._patterns,
            default_responses=self._default_responses,
            response_history=self._response_history,
            max_history=self._config.max_history_size,
        )

    def get_greeting(self) -> str:
        """Get the initial ELIZA greeting message."""
        return get_greeting()

    def reset_history(self) -> None:
        """Clear the response history."""
        self._response_history.clear()


# ============================================================================
# elizaOS Plugin (for use with AgentRuntime)
# ============================================================================


def create_eliza_classic_elizaos_plugin() -> Any:
    """
    Create an elizaOS-compatible plugin for ELIZA Classic.

    This creates a proper elizaOS Plugin that can be passed to AgentRuntime.
    The plugin registers model handlers for TEXT_LARGE and TEXT_SMALL.

    Returns:
        An elizaOS Plugin instance.
    """
    try:
        from elizaos import Plugin
        from elizaos.types.model import ModelType
        from elizaos.types.runtime import IAgentRuntime
    except ImportError:
        raise ImportError(
            "elizaos package required for plugin creation. "
            "Install with: pip install elizaos"
        )

    plugin_instance = ElizaClassicPlugin()

    async def text_large_handler(
        runtime: IAgentRuntime, params: dict[str, Any]
    ) -> str:
        prompt = params.get("prompt", "")
        # Extract user message if formatted
        match = re.search(r"(?:User|Human|You):\s*(.+?)(?:\n|$)", prompt, re.IGNORECASE)
        input_text = match.group(1) if match else prompt
        return plugin_instance.generate_response(input_text)

    async def text_small_handler(
        runtime: IAgentRuntime, params: dict[str, Any]
    ) -> str:
        return await text_large_handler(runtime, params)

    return Plugin(
        name="eliza-classic",
        description="Classic ELIZA pattern matching - no LLM required",
        models={
            ModelType.TEXT_LARGE.value: text_large_handler,
            ModelType.TEXT_SMALL.value: text_small_handler,
        },
    )


# Lazy plugin singleton
_eliza_plugin_instance: Any | None = None


def get_eliza_classic_plugin() -> Any:
    """Get the singleton elizaOS ELIZA Classic plugin instance."""
    global _eliza_plugin_instance
    if _eliza_plugin_instance is None:
        _eliza_plugin_instance = create_eliza_classic_elizaos_plugin()
    return _eliza_plugin_instance




