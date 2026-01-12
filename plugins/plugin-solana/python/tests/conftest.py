"""Pytest configuration and fixtures."""

import os

import pytest

DEVNET_RPC = "https://api.devnet.solana.com"
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


@pytest.fixture
def devnet_rpc() -> str:
    return os.getenv("SOLANA_RPC_URL", DEVNET_RPC)


@pytest.fixture
def sol_mint() -> str:
    return SOL_MINT


@pytest.fixture
def usdc_mint() -> str:
    return USDC_MINT


@pytest.fixture
def test_pubkey() -> str:
    return "11111111111111111111111111111111"
