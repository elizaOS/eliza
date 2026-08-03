"""Contract tests for clean-checkout scheduled benchmark provisioning."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from benchmarks.orchestrator import scheduled_preflight
from benchmarks.orchestrator.cli import _apply_model_profile
from benchmarks.orchestrator.runner import _effective_request
from benchmarks.orchestrator.types import RunRequest


def test_parse_benchmarks_rejects_unprovisioned_and_duplicate_ids() -> None:
    assert scheduled_preflight.parse_benchmarks("bfcl, mint") == ("bfcl", "mint")

    with pytest.raises(ValueError, match="no provisioning contract"):
        scheduled_preflight.parse_benchmarks("bfcl,unknown")
    with pytest.raises(ValueError, match="duplicates"):
        scheduled_preflight.parse_benchmarks("bfcl,bfcl")
    with pytest.raises(ValueError, match="AgentBench is diagnostic-only"):
        scheduled_preflight.parse_benchmarks("bfcl,agentbench")


def test_preflight_provisions_only_selected_external_inputs(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        scheduled_preflight, "verify_locked_dependencies", lambda: calls.append("deps")
    )
    monkeypatch.setattr(
        scheduled_preflight, "verify_scheduled_profile", lambda: calls.append("profile")
    )
    monkeypatch.setattr(
        scheduled_preflight,
        "PROVISIONERS",
        {
            "bfcl": lambda: calls.append("bfcl"),
            "tau_bench": lambda: calls.append("tau_bench"),
        },
    )

    scheduled_preflight.run_preflight(("bfcl", "mint", "tau_bench"))

    assert calls == ["deps", "profile", "bfcl", "tau_bench"]


def test_preflight_propagates_provisioning_failure(monkeypatch) -> None:
    def fail() -> None:
        raise subprocess.CalledProcessError(1, ["provision"])

    monkeypatch.setattr(scheduled_preflight, "verify_locked_dependencies", lambda: None)
    monkeypatch.setattr(scheduled_preflight, "verify_scheduled_profile", lambda: None)
    monkeypatch.setattr(scheduled_preflight, "PROVISIONERS", {"bfcl": fail})

    with pytest.raises(subprocess.CalledProcessError):
        scheduled_preflight.run_preflight(("bfcl",))


def test_action_calling_preflight_builds_and_validates_official_corpus(
    monkeypatch,
) -> None:
    commands: list[list[str]] = []

    def capture(command: list[str], **_kwargs: object) -> None:
        commands.append(command)

    monkeypatch.setattr(scheduled_preflight, "_run", capture)

    scheduled_preflight.provision_action_calling()

    assert [command[1] for command in commands[:3]] == [
        "scripts/download_datasets.py",
        "scripts/normalize.py",
        "scripts/prepare_native_tool_calling_data.py",
    ]
    assert commands[-1][-2:] == ["--expected-examples", "63"]
    assert "--count-scenarios" in commands[-1]
    assert "--expand-scenarios" in commands[-1]
    assert commands[-1][commands[-1].index("--provider") + 1] == "vllm"


def test_bfcl_preflight_resolves_pinned_scheduled_subset(tmp_path, monkeypatch) -> None:
    for filename in ("BFCL_v3_multiple.json", "BFCL_v3_parallel.json"):
        (tmp_path / filename).write_text("{}\n", encoding="utf-8")
        answer = tmp_path / "possible_answer" / filename
        answer.parent.mkdir(exist_ok=True)
        answer.write_text("{}\n", encoding="utf-8")

    calls: list[dict[str, object]] = []

    def snapshot_download(**kwargs: object) -> str:
        calls.append(kwargs)
        return str(tmp_path)

    monkeypatch.setitem(
        sys.modules,
        "huggingface_hub",
        SimpleNamespace(snapshot_download=snapshot_download),
    )

    scheduled_preflight.provision_bfcl()

    assert calls[0]["revision"] == "61fc0608cfd831fcfbbaa676ebdfef0ed963eeda"


def test_scheduled_profile_selects_complete_action_calling_workload(
    tmp_path: Path, monkeypatch
) -> None:
    profile = tmp_path / "scheduled-core.json"
    profile.write_text(
        scheduled_preflight.SCHEDULED_PROFILE.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    monkeypatch.setattr(scheduled_preflight, "SCHEDULED_PROFILE", profile)

    scheduled_preflight.verify_scheduled_profile()

    profile.write_text(
        '{"extra":{"compare_to_high_score":false,"per_benchmark":{"action-calling":'
        '{"max_examples":2,"expected_examples":63,"expand_scenarios":true}}}}',
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="complete publication workload"):
        scheduled_preflight.verify_scheduled_profile()


def test_scheduled_profile_rejects_leaderboard_comparison(
    tmp_path: Path, monkeypatch
) -> None:
    profile = tmp_path / "scheduled-core.json"
    payload = json.loads(
        scheduled_preflight.SCHEDULED_PROFILE.read_text(encoding="utf-8")
    )
    payload["extra"]["compare_to_high_score"] = True
    profile.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(scheduled_preflight, "SCHEDULED_PROFILE", profile)

    with pytest.raises(RuntimeError, match="disable full-corpus leaderboard"):
        scheduled_preflight.verify_scheduled_profile()


def test_scheduled_profile_rejects_any_agentbench_publication_slice(
    tmp_path: Path, monkeypatch
) -> None:
    profile = tmp_path / "scheduled-core.json"
    payload = json.loads(
        scheduled_preflight.SCHEDULED_PROFILE.read_text(encoding="utf-8")
    )
    payload["extra"]["per_benchmark"]["agentbench"] = {
        "env": ["os"],
        "max_tasks": 1,
        "no_docker": True,
    }
    profile.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(scheduled_preflight, "SCHEDULED_PROFILE", profile)

    with pytest.raises(RuntimeError, match="publication is quarantined"):
        scheduled_preflight.verify_scheduled_profile()


def test_scheduled_profile_replaces_action_calling_smoke_cap() -> None:
    args = SimpleNamespace(
        model_profile=str(scheduled_preflight.SCHEDULED_PROFILE),
        provider="cerebras",
        model="gemma-4-31b",
        extra=None,
    )
    _apply_model_profile(args, scheduled_preflight.REPOSITORY_ROOT / "packages")
    profile_extra = json.loads(args.extra)
    adapter = SimpleNamespace(
        id="action-calling",
        default_extra_config={"max_examples": 2, "max_new_tokens": 512},
    )

    effective = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("action-calling",),
            agent="eliza",
            provider=args.provider,
            model=args.model,
            extra_config=profile_extra,
        ),
    )

    assert effective.extra_config["max_examples"] is None
    assert effective.extra_config["expected_examples"] == 63
    assert effective.extra_config["expand_scenarios"] is True
    assert effective.extra_config["compare_to_high_score"] is False


def test_agentbench_is_not_a_scheduled_provisioner() -> None:
    assert "agentbench" not in scheduled_preflight.SCHEDULED_BENCHMARKS
    assert "agentbench" not in scheduled_preflight.PROVISIONERS


def test_agentbench_and_tau_preflight_enforce_pinned_sources(monkeypatch) -> None:
    commands: list[list[str]] = []

    def capture(command: list[str], **_kwargs: object) -> None:
        commands.append(command)

    monkeypatch.setattr(scheduled_preflight, "_run", capture)

    scheduled_preflight.provision_agentbench()
    scheduled_preflight.provision_tau_bench()

    assert [command[-1] for command in commands[:2]] == ["fetch", "verify"]
    assert commands[2][-2:] == ["-m", "elizaos_agentbench.preflight"]
    tau_contract = commands[-1][-1]
    assert scheduled_preflight.TAU_BENCH_UPSTREAM_REF in tau_contract
    assert "UPSTREAM_REF != expected" in tau_contract
