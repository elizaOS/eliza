"""Incomplete live operations must never certify simulated state."""

import asyncio

import pytest

from gauntlet.harness.state_initializer import (
    EnvironmentInitError,
    PoolConfig,
    StateInitializer,
)
from gauntlet.harness.validators import validate_transaction


@pytest.mark.parametrize("task", ["swap", "transfer", "unknown"])
@pytest.mark.parametrize("transaction", [b"", b"garbage"])
def test_unsupported_transactions_fail_closed(task, transaction):
    valid, reason = validate_transaction(transaction, task, {"amount": -1})
    assert not valid
    assert reason


def test_live_environment_fails_before_returning_unverified_state():
    with pytest.raises(EnvironmentInitError, match="Live Surfpool"):
        asyncio.run(StateInitializer().initialize_environment(0, [], [], []))


def test_mock_seed_zero_reproduces_pool_addresses():
    async def initialize():
        initializer = StateInitializer(mock_mode=True)
        return await initializer.initialize_environment(
            0, [], [], [PoolConfig("orca_whirlpool", "a", "b", 100, 1.0)]
        )

    assert [str(p) for p in asyncio.run(initialize()).pools] == [
        str(p) for p in asyncio.run(initialize()).pools
    ]
