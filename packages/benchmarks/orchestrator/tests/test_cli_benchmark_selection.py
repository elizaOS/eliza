"""Covers benchmark selection forms used by operators and scheduled runs."""

from __future__ import annotations

import pytest

from benchmarks.orchestrator import cli

ADAPTERS = {"bfcl": object(), "mint": object(), "tau_bench": object()}


def _run_args(argv: list[str]):
    return cli.build_parser().parse_args(["run", *argv])


def test_comma_joined_single_token_splits() -> None:
    args = _run_args(["--benchmarks", "bfcl,mint,tau_bench"])
    request = cli._build_request(args, ADAPTERS)
    assert request.benchmarks == ("bfcl", "mint", "tau_bench")


def test_space_separated_tokens_still_work() -> None:
    args = _run_args(["--benchmarks", "bfcl", "mint"])
    request = cli._build_request(args, ADAPTERS)
    assert request.benchmarks == ("bfcl", "mint")


def test_mixed_tokens_split_dedupe_and_strip() -> None:
    args = _run_args(["--benchmarks", "bfcl, mint", "tau_bench,bfcl"])
    request = cli._build_request(args, ADAPTERS)
    assert request.benchmarks == ("bfcl", "mint", "tau_bench")


def test_all_flag_ignores_benchmarks_selection() -> None:
    args = _run_args(["--all", "--benchmarks", "mint"])
    request = cli._build_request(args, ADAPTERS)
    assert request.benchmarks == ("bfcl", "mint", "tau_bench")


def test_empty_selection_rejected() -> None:
    args = _run_args(["--benchmarks", ",", " "])
    with pytest.raises(SystemExit):
        cli._build_request(args, ADAPTERS)
