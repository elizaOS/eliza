"""
Tests for the main Bootstrap Plugin.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from elizaos_plugin_bootstrap import bootstrap_plugin
from elizaos_plugin_bootstrap.actions import ALL_ACTIONS
from elizaos_plugin_bootstrap.providers import ALL_PROVIDERS
from elizaos_plugin_bootstrap.evaluators import ALL_EVALUATORS


class TestBootstrapPlugin:
    """Tests for the main bootstrap plugin."""

    def test_plugin_name(self) -> None:
        """Test that plugin has correct name."""
        assert bootstrap_plugin.name == "@elizaos/plugin-bootstrap"

    def test_plugin_has_description(self) -> None:
        """Test that plugin has a description."""
        assert bootstrap_plugin.description is not None
        assert len(bootstrap_plugin.description) > 0

    def test_plugin_has_actions(self) -> None:
        """Test that plugin has actions registered."""
        assert bootstrap_plugin.actions is not None
        assert len(bootstrap_plugin.actions) > 0
        assert len(bootstrap_plugin.actions) == len(ALL_ACTIONS)

    def test_plugin_has_providers(self) -> None:
        """Test that plugin has providers registered."""
        assert bootstrap_plugin.providers is not None
        assert len(bootstrap_plugin.providers) > 0
        assert len(bootstrap_plugin.providers) == len(ALL_PROVIDERS)

    def test_plugin_has_evaluators(self) -> None:
        """Test that plugin has evaluators registered."""
        assert bootstrap_plugin.evaluators is not None
        assert len(bootstrap_plugin.evaluators) > 0
        assert len(bootstrap_plugin.evaluators) == len(ALL_EVALUATORS)

    def test_all_actions_have_names(self) -> None:
        """Test that all actions have names."""
        for action in ALL_ACTIONS:
            assert action.name is not None
            assert len(action.name) > 0

    def test_all_providers_have_names(self) -> None:
        """Test that all providers have names."""
        for provider in ALL_PROVIDERS:
            assert provider.name is not None
            assert len(provider.name) > 0

    def test_all_evaluators_have_names(self) -> None:
        """Test that all evaluators have names."""
        for evaluator in ALL_EVALUATORS:
            assert evaluator.name is not None
            assert len(evaluator.name) > 0

    @pytest.mark.asyncio
    async def test_plugin_init(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test that plugin initializes correctly."""
        await bootstrap_plugin.init({}, mock_runtime)

        # Verify services were registered
        assert mock_runtime.register_service.called

