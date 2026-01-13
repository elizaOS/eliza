#!/usr/bin/env python3
"""
Bluesky Agent - A full-featured AI agent running on Bluesky

This agent uses the COMPLETE elizaOS runtime pipeline:
- Full message processing through message_service.handle_message()
- State composition with all registered providers
- Action planning and execution
- Response generation via messageHandlerTemplate
- Evaluator execution
- basicCapabilities enabled by default (REPLY, IGNORE, NONE actions)

NO shortcuts, NO bypassing the pipeline - this is canonical elizaOS.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

from dotenv import load_dotenv

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Suppress noisy HTTP logging
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def load_environment() -> None:
    """Load environment variables from .env files."""
    # Try parent directory first, then current
    parent_env = Path(__file__).parent.parent / ".env"
    local_env = Path(__file__).parent / ".env"

    if parent_env.exists():
        load_dotenv(parent_env)
    if local_env.exists():
        load_dotenv(local_env, override=True)


def validate_environment() -> None:
    """Validate required environment variables."""
    required = ["BLUESKY_HANDLE", "BLUESKY_PASSWORD"]
    missing = [key for key in required if not os.getenv(key)]

    if missing:
        logger.error(f"Missing required environment variables: {', '.join(missing)}")
        logger.error("Copy env.example to .env and fill in your credentials.")
        sys.exit(1)

    # Check for model provider
    has_model_provider = os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
    if not has_model_provider:
        logger.error("No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.")
        sys.exit(1)


async def main() -> None:
    """Main entry point for the Bluesky agent."""
    print("🦋 Starting Bluesky Agent...\n")

    load_environment()
    validate_environment()

    # Import after environment is loaded
    from elizaos import string_to_uuid
    from elizaos.runtime import AgentRuntime
    from elizaos_plugin_bluesky import BlueSkyService
    from elizaos_plugin_openai import get_openai_plugin

    from character import character
    from handlers import register_bluesky_handlers

    # Get the OpenAI plugin
    openai_plugin = get_openai_plugin()

    # Create the runtime with all required plugins
    # Note: disable_basic_capabilities is False by default (provides REPLY, IGNORE, NONE actions)
    runtime = AgentRuntime(
        character=character,
        plugins=[openai_plugin],
        # These are the defaults, explicitly shown for clarity:
        disable_basic_capabilities=False,  # Keep basic actions
        enable_extended_capabilities=False,  # Extended features
    )

    # Initialize the BlueSky service
    bluesky_service = BlueSkyService.from_env()

    # Register the BlueSky service with the runtime
    if "bluesky" not in runtime.services:
        runtime.services["bluesky"] = []
    runtime.services["bluesky"].append(bluesky_service)

    # Register Bluesky event handlers
    # These handlers process notifications through the FULL elizaOS pipeline
    register_bluesky_handlers(runtime)

    # Initialize the runtime
    print("⏳ Initializing runtime...")
    await runtime.initialize()

    # Authenticate with Bluesky
    print("🔐 Authenticating with Bluesky...")
    await bluesky_service.client.authenticate()

    # Log startup info
    print(f"\n✅ Agent '{character.name}' is now running on Bluesky!")
    print(f"   Handle: {os.getenv('BLUESKY_HANDLE')}")
    print(f"   Polling interval: {os.getenv('BLUESKY_POLL_INTERVAL', '60')}s")
    print(f"   Automated posting: {os.getenv('BLUESKY_ENABLE_POSTING', 'true') != 'false'}")
    print(f"   DM processing: {os.getenv('BLUESKY_ENABLE_DMS', 'true') != 'false'}")
    print(f"   Dry run mode: {os.getenv('BLUESKY_DRY_RUN', 'false') == 'true'}")
    print("\n   Using FULL elizaOS pipeline:")
    print("   - State composition with providers")
    print("   - shouldRespond evaluation")
    print("   - Action planning & execution")
    print("   - Evaluators")
    print("\n   Press Ctrl+C to stop.\n")

    # Set up signal handlers for graceful shutdown
    shutdown_event = asyncio.Event()

    def signal_handler(sig: int, frame: object) -> None:
        logger.info(f"Received signal {sig}, initiating shutdown...")
        shutdown_event.set()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Start polling for notifications
    poll_interval = int(os.getenv("BLUESKY_POLL_INTERVAL", "60"))

    try:
        while not shutdown_event.is_set():
            try:
                # Fetch notifications
                notifications, cursor = await bluesky_service.client.get_notifications(limit=50)

                for notification in notifications:
                    if not notification.is_read:
                        # Emit event for handlers
                        await runtime.emit_event(
                            "bluesky.mention_received",
                            {
                                "runtime": runtime,
                                "source": "bluesky",
                                "notification": notification,
                            },
                        )

                # Wait before next poll
                try:
                    await asyncio.wait_for(shutdown_event.wait(), timeout=poll_interval)
                except asyncio.TimeoutError:
                    pass  # Normal timeout, continue polling

            except Exception as e:
                logger.error(f"Error during polling: {e}")
                await asyncio.sleep(poll_interval)

    finally:
        print("\n⏳ Shutting down...")
        await bluesky_service.stop()
        await runtime.stop()
        print("👋 Goodbye!")


if __name__ == "__main__":
    asyncio.run(main())
