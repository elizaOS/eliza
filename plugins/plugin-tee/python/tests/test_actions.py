"""Tests for TEE remote attestation action.

These tests validate the action metadata, handler error paths,
and successful attestation generation using mocks.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_tee.actions.remote_attestation import (
    REMOTE_ATTESTATION_ACTION,
    handle_remote_attestation,
)
from elizaos_plugin_tee.types import RemoteAttestationQuote


# ---------------------------------------------------------------------------
# Action metadata tests
# ---------------------------------------------------------------------------


class TestRemoteAttestationActionMetadata:
    def test_action_name(self) -> None:
        assert REMOTE_ATTESTATION_ACTION["name"] == "REMOTE_ATTESTATION"

    def test_action_has_similes(self) -> None:
        similes = REMOTE_ATTESTATION_ACTION["similes"]
        assert isinstance(similes, list)
        assert len(similes) > 0
        assert "REMOTE_ATTESTATION" in similes
        assert "TEE_ATTESTATION" in similes
        assert "PROVE_TEE" in similes

    def test_action_description_mentions_tee(self) -> None:
        desc = REMOTE_ATTESTATION_ACTION["description"]
        assert "TEE" in desc
        assert "attestation" in desc.lower()

    def test_action_has_examples(self) -> None:
        examples = REMOTE_ATTESTATION_ACTION["examples"]
        assert isinstance(examples, list)
        assert len(examples) >= 2
        # Each example should be a list of message pairs
        for example in examples:
            assert isinstance(example, list)
            assert len(example) == 2

    def test_action_examples_contain_action_name(self) -> None:
        """At least one example response should reference REMOTE_ATTESTATION."""
        examples = REMOTE_ATTESTATION_ACTION["examples"]
        found = False
        for example in examples:
            for msg in example:
                actions = msg.get("content", {}).get("actions", [])
                if "REMOTE_ATTESTATION" in actions:
                    found = True
                    break
        assert found, "No example references the REMOTE_ATTESTATION action"


# ---------------------------------------------------------------------------
# Handler error-path tests
# ---------------------------------------------------------------------------


class TestHandleRemoteAttestationErrors:
    @pytest.mark.asyncio
    async def test_returns_failure_when_tee_mode_empty(self) -> None:
        result = await handle_remote_attestation(
            tee_mode="",
            agent_id="agent-1",
            entity_id="entity-1",
            room_id="room-1",
            content="hello",
        )
        assert result["success"] is False
        assert "TEE_MODE" in result["text"]

    @pytest.mark.asyncio
    async def test_returns_failure_when_tee_mode_none(self) -> None:
        result = await handle_remote_attestation(
            tee_mode="",  # falsy
            agent_id="agent-1",
            entity_id="entity-1",
            room_id="room-1",
            content="test",
        )
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_returns_failure_on_provider_error(self) -> None:
        """When the provider raises, the handler catches and returns failure."""
        with patch(
            "elizaos_plugin_tee.actions.remote_attestation.PhalaRemoteAttestationProvider"
        ) as MockProvider:
            instance = AsyncMock()
            instance.generate_attestation.side_effect = RuntimeError("connection failed")
            instance.close = AsyncMock()
            MockProvider.return_value = instance

            result = await handle_remote_attestation(
                tee_mode="LOCAL",
                agent_id="agent-1",
                entity_id="entity-1",
                room_id="room-1",
                content="test",
            )

        assert result["success"] is False
        assert "connection failed" in result["text"]


# ---------------------------------------------------------------------------
# Handler success-path tests
# ---------------------------------------------------------------------------


class TestHandleRemoteAttestationSuccess:
    @pytest.mark.asyncio
    async def test_successful_attestation_returns_proof_url(self) -> None:
        mock_attestation = RemoteAttestationQuote(
            quote="aabbccdd",
            timestamp=1700000000000,
        )

        with (
            patch(
                "elizaos_plugin_tee.actions.remote_attestation.PhalaRemoteAttestationProvider"
            ) as MockProvider,
            patch(
                "elizaos_plugin_tee.actions.remote_attestation.upload_attestation_quote"
            ) as mock_upload,
        ):
            provider_instance = AsyncMock()
            provider_instance.generate_attestation.return_value = mock_attestation
            provider_instance.close = AsyncMock()
            MockProvider.return_value = provider_instance

            mock_upload.return_value = {"checksum": "abc123checksum"}

            result = await handle_remote_attestation(
                tee_mode="LOCAL",
                agent_id="agent-1",
                entity_id="entity-1",
                room_id="room-1",
                content="prove it",
            )

        assert result["success"] is True
        assert "https://proof.t16z.com/reports/abc123checksum" in result["text"]

    @pytest.mark.asyncio
    async def test_provider_is_closed_after_success(self) -> None:
        mock_attestation = RemoteAttestationQuote(
            quote="aabbccdd",
            timestamp=1700000000000,
        )

        with (
            patch(
                "elizaos_plugin_tee.actions.remote_attestation.PhalaRemoteAttestationProvider"
            ) as MockProvider,
            patch(
                "elizaos_plugin_tee.actions.remote_attestation.upload_attestation_quote"
            ) as mock_upload,
        ):
            provider_instance = AsyncMock()
            provider_instance.generate_attestation.return_value = mock_attestation
            provider_instance.close = AsyncMock()
            MockProvider.return_value = provider_instance

            mock_upload.return_value = {"checksum": "xyz"}

            await handle_remote_attestation(
                tee_mode="LOCAL",
                agent_id="agent-1",
                entity_id="entity-1",
                room_id="room-1",
                content="test",
            )

        provider_instance.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_provider_is_closed_even_on_error(self) -> None:
        with patch(
            "elizaos_plugin_tee.actions.remote_attestation.PhalaRemoteAttestationProvider"
        ) as MockProvider:
            provider_instance = AsyncMock()
            provider_instance.generate_attestation.side_effect = RuntimeError("boom")
            provider_instance.close = AsyncMock()
            MockProvider.return_value = provider_instance

            await handle_remote_attestation(
                tee_mode="LOCAL",
                agent_id="agent-1",
                entity_id="entity-1",
                room_id="room-1",
                content="test",
            )

        provider_instance.close.assert_awaited_once()
