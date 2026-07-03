"""Offline tests for Codex multi-account CODEX_HOME selection (#10193/#10199).

These exercise the account discovery / --accounts parsing / round-robin
iteration logic without any live model call. Homes are faked on a tmp dir in the
same layout the TS runtime materializes: ``<state>/auth/_codex-home/<id>/auth.json``.
"""

from __future__ import annotations

import pytest

from codex_adapter.accounts import (
    account_for_turn,
    codex_homes_root,
    default_state_dir,
    discover_codex_accounts,
    iter_turn_accounts,
    select_codex_accounts,
)


def _materialize(state_dir, *account_ids, authenticated=True):
    root = state_dir / "auth" / "_codex-home"
    root.mkdir(parents=True, exist_ok=True)
    for account_id in account_ids:
        home = root / account_id
        home.mkdir(parents=True, exist_ok=True)
        if authenticated:
            (home / "auth.json").write_text('{"auth_mode":"chatgpt"}', encoding="utf-8")
    return root


def test_default_state_dir_prefers_eliza_home(monkeypatch, tmp_path):
    monkeypatch.setenv("ELIZA_HOME", str(tmp_path / "home"))
    assert default_state_dir() == tmp_path / "home"


def test_default_state_dir_falls_back(monkeypatch):
    for env in ("ELIZA_HOME", "ELIZA_STATE_DIR", "ELIZA_STATE_DIR"):
        monkeypatch.delenv(env, raising=False)
    assert default_state_dir().parts[-2:] == ("state", "eliza")


def test_codex_homes_root_layout(tmp_path):
    assert codex_homes_root(tmp_path) == tmp_path / "auth" / "_codex-home"


def test_discover_empty_when_no_root(tmp_path):
    assert discover_codex_accounts(tmp_path) == []


def test_discover_sorted_accounts(tmp_path):
    _materialize(tmp_path, "acct-b", "acct-a", "acct-c")
    accounts = discover_codex_accounts(tmp_path)
    assert [a.account_id for a in accounts] == ["acct-a", "acct-b", "acct-c"]
    assert all(a.is_authenticated for a in accounts)


def test_is_authenticated_false_without_auth_json(tmp_path):
    _materialize(tmp_path, "acct-a", authenticated=False)
    accounts = discover_codex_accounts(tmp_path)
    assert accounts and accounts[0].is_authenticated is False


def test_select_all_when_spec_none(tmp_path):
    _materialize(tmp_path, "a", "b")
    selected = select_codex_accounts(None, state_dir=tmp_path)
    assert [a.account_id for a in selected] == ["a", "b"]


def test_select_count_int(tmp_path):
    _materialize(tmp_path, "a", "b", "c")
    selected = select_codex_accounts(2, state_dir=tmp_path)
    assert [a.account_id for a in selected] == ["a", "b"]


def test_select_count_str(tmp_path):
    _materialize(tmp_path, "a", "b", "c")
    selected = select_codex_accounts("2", state_dir=tmp_path)
    assert [a.account_id for a in selected] == ["a", "b"]


def test_select_explicit_ids_preserves_order(tmp_path):
    _materialize(tmp_path, "a", "b", "c")
    selected = select_codex_accounts("c,a", state_dir=tmp_path)
    assert [a.account_id for a in selected] == ["c", "a"]


def test_select_raises_when_no_accounts(tmp_path):
    with pytest.raises(ValueError, match="no Codex accounts materialized"):
        select_codex_accounts(1, state_dir=tmp_path)


def test_select_raises_when_count_exceeds_available(tmp_path):
    _materialize(tmp_path, "a")
    with pytest.raises(ValueError, match="requested 3 accounts but only 1"):
        select_codex_accounts(3, state_dir=tmp_path)


def test_select_raises_on_unknown_explicit_id(tmp_path):
    _materialize(tmp_path, "a")
    with pytest.raises(ValueError, match="not materialized"):
        select_codex_accounts("a,ghost", state_dir=tmp_path)


def test_select_count_zero_returns_empty(tmp_path):
    _materialize(tmp_path, "a")
    assert select_codex_accounts(0, state_dir=tmp_path) == []


def test_select_negative_count_raises(tmp_path):
    _materialize(tmp_path, "a")
    with pytest.raises(ValueError, match=">= 0"):
        select_codex_accounts(-1, state_dir=tmp_path)


def test_round_robin_across_turns(tmp_path):
    _materialize(tmp_path, "a", "b", "c")
    accounts = select_codex_accounts(3, state_dir=tmp_path)
    ids = [account_for_turn(accounts, i).account_id for i in range(7)]
    assert ids == ["a", "b", "c", "a", "b", "c", "a"]


def test_round_robin_single_account(tmp_path):
    _materialize(tmp_path, "solo")
    accounts = select_codex_accounts(1, state_dir=tmp_path)
    ids = [account_for_turn(accounts, i).account_id for i in range(3)]
    assert ids == ["solo", "solo", "solo"]


def test_account_for_turn_empty_raises():
    with pytest.raises(IndexError):
        account_for_turn([], 0)


def test_iter_turn_accounts(tmp_path):
    _materialize(tmp_path, "a", "b")
    accounts = select_codex_accounts(2, state_dir=tmp_path)
    ids = [a.account_id for a in iter_turn_accounts(accounts, 5)]
    assert ids == ["a", "b", "a", "b", "a"]
