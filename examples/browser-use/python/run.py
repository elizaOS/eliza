#!/usr/bin/env python3
"""
Browser Use Example (Python)

An autonomous ElizaOS agent that explores the web with curiosity,
focusing on understanding quantum physics and related concepts.

The agent:
- Navigates to physics education websites
- Reads and extracts information about quantum mechanics
- Explores related concepts autonomously
- Synthesizes knowledge and forms understanding

Usage:
    # With OpenAI (recommended)
    export OPENAI_API_KEY="your_key"
    python run.py

    # With Groq (faster, cheaper)
    export GROQ_API_KEY="your_key"
    python run.py --provider groq

    # Explore specific topic
    python run.py --topic "quantum entanglement"

    # Enable full autonomy
    python run.py --autonomous
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

# Add repo root to path for imports
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
EXAMPLE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "packages" / "python"))
sys.path.insert(0, str(REPO_ROOT / "plugins" / "plugin-browser" / "python"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def load_character_config() -> dict:
    """Load the shared character configuration from character.json."""
    character_file = EXAMPLE_ROOT / "character.json"
    if character_file.exists():
        with open(character_file) as f:
            return json.load(f)
    logger.warning(f"Character file not found at {character_file}, using defaults")
    return {"name": "QuantumExplorer", "topics": [], "system": "", "exploration": {}}


# Load shared character configuration
CHARACTER_CONFIG = load_character_config()
QUANTUM_TOPICS = CHARACTER_CONFIG.get("topics", [])
QUANTUM_EXPLORER_SYSTEM = CHARACTER_CONFIG.get("system", "")


def load_env() -> None:
    """Load environment variables from .env files."""
    try:
        from dotenv import load_dotenv  # type: ignore[import-not-found]
    except ImportError:
        return

    local_env = Path(__file__).parent / ".env"
    if local_env.exists():
        load_dotenv(local_env, override=False)

    root_env = REPO_ROOT / ".env"
    if root_env.exists():
        load_dotenv(root_env, override=False)


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="QuantumExplorer - Autonomous browser agent for quantum physics",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--topic",
        type=str,
        default=None,
        help="Specific topic to explore (default: random from list)",
    )
    parser.add_argument(
        "--provider",
        type=str,
        choices=["openai", "groq", "anthropic", "auto"],
        default="auto",
        help="Model provider (default: auto-detect)",
    )
    parser.add_argument(
        "--autonomous",
        action="store_true",
        help="Enable continuous autonomous exploration",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=10,
        help="Maximum exploration steps (default: 10)",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=True,
        help="Run browser in headless mode (default: True)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    return parser.parse_args()


async def create_quantum_explorer(provider: str) -> tuple[object, object]:
    """Create the QuantumExplorer agent with browser capabilities.

    Returns:
        Tuple of (runtime, browser_plugin)
    """
    # Check ElizaOS availability
    try:
        from elizaos.runtime import AgentRuntime
        from elizaos.types.agent import Character
        from elizaos.types.plugin import Plugin
    except ImportError as e:
        logger.error(f"ElizaOS not available: {e}")
        logger.error("Install with: pip install -e packages/python")
        logger.error("If protobuf version mismatch, try: pip install protobuf>=5.0")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Failed to import ElizaOS: {e}")
        logger.error("This may be a protobuf version issue.")
        logger.error("Try: pip install protobuf>=5.0")
        sys.exit(1)

    # Try to get model provider plugin
    model_plugin = None
    if provider == "auto" or provider == "groq":
        if os.environ.get("GROQ_API_KEY"):
            try:
                from elizaos_plugin_groq import GenerateTextParams, GroqClient, GroqConfig
                from elizaos.types.model import ModelType

                async def groq_handler(runtime: object, params: dict[str, object]) -> str:
                    config = GroqConfig(
                        api_key=os.environ.get("GROQ_API_KEY", ""),
                        small_model=os.environ.get("GROQ_SMALL_MODEL", "llama-3.1-8b-instant"),
                        large_model=os.environ.get("GROQ_LARGE_MODEL", "llama-3.3-70b-versatile"),
                    )
                    client = GroqClient(api_key=config.api_key, config=config)
                    prompt = str(params.get("prompt", ""))
                    system = params.get("system")
                    result = await client.generate_text_large(
                        GenerateTextParams(
                            prompt=prompt,
                            system=str(system) if system else None,
                            temperature=0.7,
                            max_tokens=2048,
                        )
                    )
                    await client.close()
                    return str(result)

                model_plugin = Plugin(
                    name="groq",
                    description="Groq model provider",
                    models={
                        str(ModelType.MODEL_TYPE_TEXT_LARGE): groq_handler,
                        str(ModelType.MODEL_TYPE_TEXT_SMALL): groq_handler,
                    },
                )
                logger.info("Using Groq model provider")
            except ImportError:
                logger.debug("Groq plugin not available")

    if model_plugin is None and (provider == "auto" or provider == "openai"):
        if os.environ.get("OPENAI_API_KEY"):
            try:
                from elizaos_plugin_openai import get_openai_plugin

                model_plugin = get_openai_plugin()
                logger.info("Using OpenAI model provider")
            except ImportError:
                logger.debug("OpenAI plugin not available")

    if model_plugin is None:
        logger.error(
            "No model provider available. "
            "Set GROQ_API_KEY or OPENAI_API_KEY environment variable."
        )
        sys.exit(1)

    # Try to get browser plugin
    browser_plugin = None
    try:
        from elizaos_browser import create_browser_plugin

        browser_plugin = create_browser_plugin()
        logger.info("Browser plugin loaded")
    except ImportError:
        logger.warning(
            "Browser plugin not available. "
            "Install with: pip install -e plugins/plugin-browser/python"
        )

    # Create character from shared config
    character = Character(
        name=CHARACTER_CONFIG.get("name", "QuantumExplorer"),
        username="quantum_explorer",
        bio=CHARACTER_CONFIG.get("bio", "A curious AI researcher fascinated by quantum physics."),
        system=QUANTUM_EXPLORER_SYSTEM,
    )

    # Create runtime
    plugins = [model_plugin]
    if browser_plugin:
        plugins.append(browser_plugin)

    runtime = AgentRuntime(
        character=character,
        plugins=plugins,
        log_level="DEBUG" if os.environ.get("DEBUG") else "INFO",
    )

    await runtime.initialize()

    return runtime, browser_plugin


async def explore_topic(
    runtime: object,
    browser_plugin: object,
    topic: str,
    max_steps: int = 5,
) -> None:
    """Explore a quantum physics topic using the browser.

    Args:
        runtime: The AgentRuntime
        browser_plugin: The browser plugin (or None)
        topic: Topic to explore
        max_steps: Maximum exploration steps
    """
    from elizaos.types.memory import Memory
    from elizaos.types.primitives import Content, as_uuid

    logger.info(f"\n{'='*60}")
    logger.info(f"🔬 Exploring: {topic}")
    logger.info(f"{'='*60}\n")

    user_id = as_uuid(str(uuid4()))
    room_id = as_uuid(str(uuid4()))

    # Initial exploration prompt from shared config
    exploration_config = CHARACTER_CONFIG.get("exploration", {})
    arxiv_base = exploration_config.get("arxiv_base_url", "https://arxiv.org/search/?searchtype=all&query=")
    arxiv_url = f"{arxiv_base}{topic.replace(' ', '+')}"
    
    prompt_template = exploration_config.get(
        "initial_prompt_template",
        "Research mission: Find NEW scientific discoveries about \"{topic}\".\n\nNavigate to: {arxiv_url}"
    )
    message_text = prompt_template.format(topic=topic, arxiv_url=arxiv_url)

    message = Memory(
        id=str(uuid4()),
        entity_id=str(user_id),
        agent_id=str(runtime.agent_id),  # type: ignore[attr-defined]
        room_id=str(room_id),
        content=Content(text=message_text, source="quantum-explorer"),
        created_at=int(time.time() * 1000),
    )

    # Process with runtime
    try:
        result = await runtime.message_service.handle_message(runtime, message)  # type: ignore[attr-defined]

        if result.response_content:
            print(f"\n📖 Agent response:\n{result.response_content.text}\n")

            # If autonomous, continue exploring research papers
            for step in range(1, max_steps):
                followup_template = exploration_config.get(
                    "followup_prompt_template",
                    "Continue your research on {topic}. Report what NEW findings you discovered."
                )
                follow_up = followup_template.format(topic=topic)

                follow_up_message = Memory(
                    id=str(uuid4()),
                    entity_id=str(user_id),
                    agent_id=str(runtime.agent_id),  # type: ignore[attr-defined]
                    room_id=str(room_id),
                    content=Content(text=follow_up, source="quantum-explorer"),
                    created_at=int(time.time() * 1000),
                )

                result = await runtime.message_service.handle_message(runtime, follow_up_message)  # type: ignore[attr-defined]

                if result.response_content:
                    print(f"\n📖 Step {step + 1}:\n{result.response_content.text}\n")

                await asyncio.sleep(1)  # Brief pause between steps

    except Exception as e:
        logger.error(f"Error during exploration: {e}")
        import traceback

        traceback.print_exc()


async def autonomous_exploration(
    runtime: object,
    browser_plugin: object,
    max_iterations: int = 10,
) -> None:
    """Run continuous autonomous exploration.

    The agent will explore quantum physics topics on its own,
    following its curiosity from one concept to another.
    """
    import random

    logger.info("\n🚀 Starting autonomous exploration mode...")
    logger.info("   The agent will explore quantum physics topics independently.\n")

    explored_topics: set[str] = set()

    for i in range(max_iterations):
        # Choose a topic not yet explored
        available = [t for t in QUANTUM_TOPICS if t not in explored_topics]
        if not available:
            available = QUANTUM_TOPICS  # Reset if all explored

        topic = random.choice(available)
        explored_topics.add(topic)

        print(f"\n{'━'*60}")
        print(f"  Iteration {i + 1}/{max_iterations}: {topic}")
        print(f"{'━'*60}")

        await explore_topic(runtime, browser_plugin, topic, max_steps=3)

        # Brief pause between topics
        await asyncio.sleep(2)

    logger.info("\n✅ Autonomous exploration complete!")
    logger.info(f"   Topics explored: {', '.join(explored_topics)}")


async def main() -> int:
    """Main entry point."""
    load_env()
    args = parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Set headless mode
    os.environ["BROWSER_HEADLESS"] = "true" if args.headless else "false"

    agent_name = CHARACTER_CONFIG.get("name", "QuantumExplorer")
    print("\n" + "="*60)
    print(f"  🔬 {agent_name} - Autonomous Browser Agent")
    print("  Exploring the mysteries of quantum physics...")
    print("="*60 + "\n")

    # Create agent
    runtime, browser_plugin = await create_quantum_explorer(args.provider)

    try:
        if args.autonomous:
            await autonomous_exploration(runtime, browser_plugin, args.max_steps)
        else:
            # Single topic exploration
            topic = args.topic or QUANTUM_TOPICS[0]
            await explore_topic(runtime, browser_plugin, topic, args.max_steps)

    finally:
        # Cleanup
        await runtime.stop()  # type: ignore[attr-defined]

    return 0


if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\n⏹ Exploration interrupted by user.")
        sys.exit(130)
