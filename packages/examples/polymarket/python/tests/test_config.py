from __future__ import annotations

import pytest

from polymarket_demo import _normalize_private_key, _load_private_key, _has_creds


def test_normalize_private_key_adds_prefix() -> None:
    raw = "11" * 32
    assert _normalize_private_key(raw) == f"0x{raw}"


def test_normalize_private_key_rejects_bad() -> None:
    with pytest.raises(ValueError):
        _normalize_private_key("0x1234")


def test_load_private_key_requires_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EVM_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("POLYMARKET_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("WALLET_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("PRIVATE_KEY", raising=False)
    with pytest.raises(ValueError):
        _load_private_key()


def test_has_creds_false_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLOB_API_KEY", raising=False)
    monkeypatch.delenv("CLOB_API_SECRET", raising=False)
    monkeypatch.delenv("CLOB_API_PASSPHRASE", raising=False)
    monkeypatch.delenv("CLOB_SECRET", raising=False)
    monkeypatch.delenv("CLOB_PASS_PHRASE", raising=False)
    assert _has_creds() is False


def test_wallet_derivation_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    key = "0x" + "11" * 32
    monkeypatch.setenv("EVM_PRIVATE_KEY", key)
    monkeypatch.setenv("POLYMARKET_PRIVATE_KEY", key)
    from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
    from elizaos_plugin_polymarket.providers.clob import ClobClientProvider

    evm = EVMWalletProvider(key)
    poly = ClobClientProvider()
    assert evm.address.lower() == poly.get_wallet_address().lower()

