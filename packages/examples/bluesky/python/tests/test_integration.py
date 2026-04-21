"""Integration tests for the Bluesky agent.

Run with: pytest --live
"""

from __future__ import annotations

import os
import pytest


@pytest.mark.live
class TestBlueSkyClientIntegration:
    """Live integration tests for the BlueSky client."""

    @pytest.fixture(autouse=True)
    def check_credentials(self):
        """Ensure credentials are available."""
        if not os.environ.get("BLUESKY_HANDLE") or not os.environ.get("BLUESKY_PASSWORD"):
            pytest.skip("BLUESKY_HANDLE and BLUESKY_PASSWORD required")

    @pytest.mark.asyncio
    async def test_authenticate(self):
        """Should authenticate with Bluesky."""
        from elizaos_plugin_bluesky import BlueSkyClient, BlueSkyConfig

        config = BlueSkyConfig.from_env()
        config = BlueSkyConfig(
            handle=config.handle,
            password=config.password,
            service=config.service,
            dry_run=True,  # Don't post during tests
        )

        async with BlueSkyClient(config) as client:
            session = await client.authenticate()

            assert session.did is not None
            assert session.handle == os.environ.get("BLUESKY_HANDLE")

    @pytest.mark.asyncio
    async def test_fetch_timeline(self):
        """Should fetch timeline."""
        from elizaos_plugin_bluesky import BlueSkyClient, BlueSkyConfig
        from elizaos_plugin_bluesky.types import TimelineRequest

        config = BlueSkyConfig.from_env()
        config = BlueSkyConfig(
            handle=config.handle,
            password=config.password,
            dry_run=True,
        )

        async with BlueSkyClient(config) as client:
            await client.authenticate()
            timeline = await client.get_timeline(TimelineRequest(limit=5))

            assert timeline.feed is not None
            assert isinstance(timeline.feed, list)

    @pytest.mark.asyncio
    async def test_fetch_notifications(self):
        """Should fetch notifications."""
        from elizaos_plugin_bluesky import BlueSkyClient, BlueSkyConfig

        config = BlueSkyConfig.from_env()
        config = BlueSkyConfig(
            handle=config.handle,
            password=config.password,
            dry_run=True,
        )

        async with BlueSkyClient(config) as client:
            await client.authenticate()
            result = await client.get_notifications(10)

            assert result.notifications is not None
            assert isinstance(result.notifications, list)

    @pytest.mark.asyncio
    async def test_dry_run_post(self):
        """Should simulate post creation in dry run mode."""
        from elizaos_plugin_bluesky import (
            BlueSkyClient,
            BlueSkyConfig,
            CreatePostRequest,
            CreatePostContent,
        )

        config = BlueSkyConfig.from_env()
        config = BlueSkyConfig(
            handle=config.handle,
            password=config.password,
            dry_run=True,  # Important: don't actually post
        )

        async with BlueSkyClient(config) as client:
            await client.authenticate()

            request = CreatePostRequest(
                content=CreatePostContent(text="Test post from integration test")
            )
            post = await client.send_post(request)

            # In dry run mode, returns a mock post
            assert "mock" in post.uri.lower() or post.uri.startswith("at://")

    @pytest.mark.asyncio
    async def test_fetch_profile(self):
        """Should fetch own profile."""
        from elizaos_plugin_bluesky import BlueSkyClient, BlueSkyConfig

        handle = os.environ.get("BLUESKY_HANDLE", "")
        config = BlueSkyConfig.from_env()
        config = BlueSkyConfig(
            handle=config.handle,
            password=config.password,
            dry_run=True,
        )

        async with BlueSkyClient(config) as client:
            await client.authenticate()
            profile = await client.get_profile(handle)

            assert profile.handle == handle
            assert profile.did is not None


class TestAgentIntegration:
    """Integration tests for the full agent."""

    def test_character_import(self):
        """Should import character configuration."""
        from character import character

        assert character.name == "BlueSkyBot"
        assert character.bio is not None

    def test_handlers_import(self):
        """Should import handler functions."""
        from handlers import handle_mention_received, handle_create_post

        assert callable(handle_mention_received)
        assert callable(handle_create_post)
