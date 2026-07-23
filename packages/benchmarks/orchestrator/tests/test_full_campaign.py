"""Pins exhaustive campaign coverage, full-dataset profiles, and serial cohort dispatch."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from benchmarks.bench_cli_types import ModelSpec
from benchmarks.orchestrator import full_campaign as campaign
from benchmarks.orchestrator import runner
from benchmarks.orchestrator.types import (
    AdapterDiscovery,
    BenchmarkAdapter,
    ExecutionContext,
    RunRequest,
    ScoreSummary,
)


WORKSPACE_ROOT = Path(__file__).resolve().parents[3]


def _request(*, agent: str = "eliza", extra: dict | None = None) -> RunRequest:
    return RunRequest(
        benchmarks=(),
        agent=agent,
        provider="claude-subscription",
        model="claude-sonnet-4-6",
        extra_config=dict(extra or {}),
        force=True,
    )


def _adapter(benchmark_id: str, defaults: dict | None = None) -> BenchmarkAdapter:
    return BenchmarkAdapter(
        id=benchmark_id,
        directory=benchmark_id,
        description="test adapter",
        cwd=".",
        command_builder=lambda _ctx, _adapter: [],
        result_locator=lambda _ctx, _adapter, _root: None,
        score_extractor=lambda _path: ScoreSummary(1.0, "ratio", True),
        default_extra_config=dict(defaults or {}),
        agent_compatibility=campaign.CANONICAL_CAMPAIGN_HARNESSES,
    )


def test_manifest_exactly_covers_discovery_registry_and_directory_gaps() -> None:
    manifest = campaign.validate_full_campaign_manifest(WORKSPACE_ROOT)
    discovery = campaign.discover_adapters(WORKSPACE_ROOT)
    registry_ids = {
        entry.id for entry in campaign.get_benchmark_registry(WORKSPACE_ROOT)
    }

    adapter_ids = [entry.benchmark_id for entry in manifest.adapters]
    assert len(adapter_ids) == 59
    assert len(adapter_ids) == len(set(adapter_ids))
    assert set(adapter_ids) == set(discovery.adapters)
    assert {
        entry.benchmark_id for entry in manifest.adapters if entry.registered
    } == registry_ids
    assert len(registry_ids) == 50

    assert Counter(entry.disposition for entry in manifest.adapters) == {
        campaign.CampaignDisposition.COHORT: 25,
        campaign.CampaignDisposition.MANUAL: 18,
        campaign.CampaignDisposition.UNSUPPORTED: 5,
        campaign.CampaignDisposition.NON_AGENT: 11,
    }

    direct_directories = [entry.directory for entry in manifest.direct]
    assert len(direct_directories) == len(set(direct_directories))
    covered_adapter_directories = {
        adapter.directory for adapter in discovery.adapters.values()
    }
    gaps = set(discovery.all_directories) - covered_adapter_directories
    assert gaps <= set(direct_directories)
    assert {
        "entity-voice-bench",
        "lifeops-quality",
        "meeting-corpus-importers",
        "searchbench",
        "voice-rtt",
    } <= set(direct_directories)


def test_direct_manifest_rejects_a_declared_workload_missing_from_disk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing = replace(
        campaign.DIRECT_CAMPAIGN_ENTRIES[0],
        directory="definitely-not-a-physical-benchmark-directory",
    )
    monkeypatch.setattr(
        campaign,
        "DIRECT_CAMPAIGN_ENTRIES",
        (missing, *campaign.DIRECT_CAMPAIGN_ENTRIES[1:]),
    )

    with pytest.raises(
        campaign.FullCampaignManifestError,
        match="Direct campaign workload directories missing from disk",
    ):
        campaign.validate_full_campaign_manifest(WORKSPACE_ROOT)


def test_non_native_three_harness_workloads_are_unsupported_not_manual() -> None:
    by_id = {entry.benchmark_id: entry for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES}

    for benchmark_id in ("agentbench", "vision_language", "visualwebbench"):
        assert by_id[benchmark_id].disposition is campaign.CampaignDisposition.UNSUPPORTED
        assert by_id[benchmark_id].phases


def test_every_non_cohort_workload_has_an_explicit_disposition_and_reason() -> None:
    dispositions = {
        entry.disposition for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES
    } | {entry.disposition for entry in campaign.DIRECT_CAMPAIGN_ENTRIES}
    assert dispositions == set(campaign.CampaignDisposition)

    for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES:
        assert entry.reason.strip()
        if entry.disposition in {
            campaign.CampaignDisposition.COHORT,
            campaign.CampaignDisposition.MANUAL,
        }:
            assert entry.phases
    for entry in campaign.DIRECT_CAMPAIGN_ENTRIES:
        assert entry.reason.strip()


def test_meeting_evidence_aliases_are_not_tri_harness_agent_workloads(
    tmp_path: Path,
) -> None:
    by_id = {entry.benchmark_id: entry for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES}
    definitions = {
        entry.id: entry for entry in campaign.get_benchmark_registry(WORKSPACE_ROOT)
    }
    expected_commands: set[tuple[str, ...]] = set()
    for benchmark_id in (
        "meeting_transcription_proof",
        "meeting_voice",
        "meeting_voice_real",
        "meeting_voice_stress",
        "meeting_voice_av",
    ):
        entry = by_id[benchmark_id]
        assert entry.disposition is campaign.CampaignDisposition.NON_AGENT
        assert entry.phases == ()
        assert "ignores the selected harness and model" in entry.reason
        definition = definitions[benchmark_id]
        commands = {
            tuple(
                definition.build_command(
                    tmp_path,
                    ModelSpec(provider=provider, model=model),
                    {"lane": "real_product", "manifest": "/evidence/meeting.json"},
                )
            )
            for provider, model in (
                ("openai", "eliza"),
                ("anthropic", "hermes"),
                ("openrouter", "openclaw"),
            )
        }
        assert len(commands) == 1
        expected_commands.update(commands)
    assert len(expected_commands) == 1


def test_full_phases_contain_no_smoke_mock_demo_or_sample_profiles() -> None:
    for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES:
        for phase in entry.phases:
            assert campaign._full_config_error(phase.extra_config) is None

    by_id = {entry.benchmark_id: entry for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES}
    assert by_id["lifeops_bench"].phases[0].extra_config["suite"] == "full"
    assert by_id["webshop"].phases[0].extra_config["profile"] == "full"
    assert by_id["openclaw_bench"].phases[0].extra_config == {
        "mode": "execution",
        "all": True,
    }
    assert by_id["adhdbench"].phases[0].extra_config["mode"] == "full"
    assert by_id["realm"].phases[0].extra_config == {
        "full_dataset": True,
        "timeout": 60000,
        "expand_scenarios": True,
    }
    assert "limit" not in by_id["gsm8k"].phases[0].extra_config
    assert "max_examples" not in by_id["bfcl"].phases[0].extra_config
    assert "max_tasks" not in by_id["tau_bench"].phases[0].extra_config

    clawbench = by_id["clawbench"]
    assert len(clawbench.phases) == 55
    assert len({phase.name for phase in clawbench.phases}) == 55
    assert clawbench.phases[0].name == "inbox_triage"
    assert clawbench.phases[-1].name == "client_escalation--edge-handoff"

    vision = by_id["vision_language"]
    assert [(phase.name, phase.extra_config["samples"]) for phase in vision.phases] == [
        ("textvqa", 5000),
        ("docvqa", 5349),
        ("chartqa", 2500),
        ("screenspot", 1272),
        ("osworld", 369),
    ]

    mind2web = by_id["mind2web"]
    assert [phase.name for phase in mind2web.phases] == [
        "test_task",
        "test_website",
        "test_domain",
    ]
    assert [phase.extra_config["expected_tasks"] for phase in mind2web.phases] == [
        252,
        177,
        912,
    ]
    assert all(
        phase.extra_config["ranker"] == "real"
        and phase.extra_config["ranker_top_k"] == 50
        and phase.extra_config["expected_scenarios"]
        == phase.extra_config["expected_tasks"] * 11
        for phase in mind2web.phases
    )

    trust = by_id["trust"]
    assert trust.phases[0].extra_config == {"expand_scenarios": True}


def test_full_profile_replaces_adapter_defaults_and_hides_internal_flag() -> None:
    adapter = _adapter(
        "alpha",
        {
            "limit": 2,
            "quick": True,
            "mock": True,
            "categories": ["tiny"],
        },
    )
    effective = runner._effective_request(
        adapter,
        _request(
            extra={
                "_replace_adapter_defaults": True,
                "campaign_profile": campaign.FULL_CAMPAIGN_PROFILE,
                "max_tokens": 2048,
            }
        ),
    )

    assert effective.extra_config == {
        "campaign_profile": campaign.FULL_CAMPAIGN_PROFILE,
        "max_tokens": 2048,
        "agent": "eliza",
        "harness": "eliza",
    }
    assert "_replace_adapter_defaults" not in effective.extra_config


def test_subscription_provider_alias_is_command_only() -> None:
    request = _request()

    command_request = runner._request_for_command_builder(request)

    assert command_request.provider == "openai"
    assert request.provider == "claude-subscription"
    assert command_request.model == request.model


def test_every_runnable_phase_drops_unmentioned_smoke_defaults() -> None:
    discovery = campaign.discover_adapters(WORKSPACE_ROOT)
    for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES:
        if entry.disposition not in {
            campaign.CampaignDisposition.COHORT,
            campaign.CampaignDisposition.MANUAL,
        }:
            continue
        adapter = discovery.adapters[entry.benchmark_id]
        for phase in entry.phases:
            phase_request = campaign._phase_request(
                request=_request(),
                entry=entry,
                phase=phase,
                overrides={key: f"/staged/{key}" for key in phase.required_overrides},
            )
            effective = runner._effective_request(adapter, phase_request)
            assert "_replace_adapter_defaults" not in effective.extra_config
            for key in adapter.default_extra_config:
                if (
                    key in {"agent", "harness"}
                    or key in phase.extra_config
                    or key in phase.model_config_keys
                ):
                    continue
                if key in effective.extra_config:
                    assert (
                        effective.extra_config[key] != adapter.default_extra_config[key]
                    ), (
                        entry.benchmark_id,
                        phase.name,
                        key,
                        effective.extra_config,
                    )


def test_every_runnable_phase_builds_a_real_full_command(tmp_path: Path) -> None:
    discovery = campaign.discover_adapters(WORKSPACE_ROOT)
    forbidden_tokens = {
        "--mock",
        "--sample",
        "--use-sample-tasks",
        "--quick",
        "--dry-run",
        "--no-docker",
        "--no-exec",
        "--demo",
    }
    for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES:
        if entry.disposition not in {
            campaign.CampaignDisposition.COHORT,
            campaign.CampaignDisposition.MANUAL,
        }:
            continue
        adapter = discovery.adapters[entry.benchmark_id]
        for phase in entry.phases:
            for harness in campaign.CANONICAL_CAMPAIGN_HARNESSES:
                phase_request = campaign._phase_request(
                    request=_request(agent=harness),
                    entry=entry,
                    phase=phase,
                    overrides={
                        key: str(tmp_path / key) for key in phase.required_overrides
                    },
                )
                effective = runner._effective_request(adapter, phase_request)
                command_request = runner._request_for_command_builder(effective)
                ctx = ExecutionContext(
                    workspace_root=WORKSPACE_ROOT,
                    benchmarks_root=WORKSPACE_ROOT / "benchmarks",
                    output_root=tmp_path,
                    run_root=tmp_path,
                    request=command_request,
                    run_group_id="full-command-audit",
                    env={},
                    repo_meta={},
                )

                command = adapter.command_builder(ctx, adapter)

                assert not (set(command) & forbidden_tokens), (
                    entry.benchmark_id,
                    phase.name,
                    harness,
                    command,
                )
                assert "claude-subscription" not in command
                assert not any(
                    token in {"--mode=simulate", "--mode=scripted", "--mode=heuristic"}
                    for token in command
                )
                for index, token in enumerate(command[:-1]):
                    if token == "--mode":
                        assert command[index + 1] not in {
                            "simulate",
                            "scripted",
                            "heuristic",
                        }
                if phase.extra_config.get("expand_scenarios") is True:
                    assert "--expand-scenarios" in command, (
                        entry.benchmark_id,
                        phase.name,
                        harness,
                        command,
                    )


def test_canonical_full_profile_reaches_bfcl_and_configbench_builders(
    tmp_path: Path,
) -> None:
    discovery = campaign.discover_adapters(WORKSPACE_ROOT)
    entries = {
        entry.benchmark_id: entry for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES
    }

    commands: dict[str, list[str]] = {}
    for benchmark_id in ("bfcl", "configbench"):
        entry = entries[benchmark_id]
        phase_request = campaign._phase_request(
            request=_request(agent="hermes"),
            entry=entry,
            phase=entry.phases[0],
            overrides={},
        )
        adapter = discovery.adapters[benchmark_id]
        effective = runner._effective_request(adapter, phase_request)
        command_request = runner._request_for_command_builder(effective)
        ctx = ExecutionContext(
            workspace_root=WORKSPACE_ROOT,
            benchmarks_root=WORKSPACE_ROOT / "benchmarks",
            output_root=tmp_path / benchmark_id,
            run_root=tmp_path,
            request=command_request,
            run_group_id="canonical-full-profile",
            env={},
            repo_meta={},
        )
        commands[benchmark_id] = adapter.command_builder(ctx, adapter)
        assert effective.extra_config["campaign_profile"] == campaign.FULL_CAMPAIGN_PROFILE

    assert "--full" in commands["bfcl"]
    assert "--expand-scenarios" in commands["bfcl"]
    assert not ({"--sample", "--categories", "--max-per-category"} & set(commands["bfcl"]))
    assert commands["configbench"][commands["configbench"].index("--harness") + 1] == "hermes"
    assert "--limit" not in commands["configbench"]


def test_full_campaign_normalizes_queue_aware_harness_timeouts() -> None:
    entry = next(
        item for item in campaign.ADAPTER_CAMPAIGN_ENTRIES if item.benchmark_id == "bfcl"
    )

    normalized = campaign._phase_request(
        request=_request(extra={"openclaw_timeout_s": 2400}),
        entry=entry,
        phase=entry.phases[0],
        overrides={},
    )

    assert {
        normalized.extra_config[key]
        for key in (
            "eliza_bench_http_timeout_s",
            "hermes_timeout_s",
            "openclaw_timeout_s",
        )
    } == {2400.0}
    assert normalized.extra_config["campaign_silent_timeout_s"] == 3600.0

    with pytest.raises(
        campaign.FullCampaignSelectionError,
        match="harness HTTP timeouts must be equal",
    ):
        campaign._phase_request(
            request=_request(
                extra={"openclaw_timeout_s": 1800, "hermes_timeout_s": 1200}
            ),
            entry=entry,
            phase=entry.phases[0],
            overrides={},
        )


def test_full_campaign_dispatches_benchmarks_serially_through_cohorts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    selected = ("orchestrator_lifecycle", "action-calling")
    adapters = {benchmark_id: _adapter(benchmark_id) for benchmark_id in selected}
    monkeypatch.setattr(
        campaign,
        "validate_full_campaign_manifest",
        lambda _workspace: campaign.FULL_CAMPAIGN_MANIFEST,
    )
    monkeypatch.setattr(
        campaign,
        "discover_adapters",
        lambda _workspace: AdapterDiscovery(
            adapters=adapters,
            all_directories=tuple(adapters),
        ),
    )

    calls: list[tuple[str, tuple[str, ...], dict]] = []

    def fake_run_benchmark_cohorts(**kwargs):
        request = kwargs["request"]
        calls.append(
            (
                request.benchmarks[0],
                kwargs["harnesses"],
                dict(request.extra_config),
            )
        )
        return [
            SimpleNamespace(
                benchmark_id=request.benchmarks[0],
                unsupported_harnesses=(),
                outcomes=(),
            )
        ]

    monkeypatch.setattr(campaign, "run_benchmark_cohorts", fake_run_benchmark_cohorts)

    result = campaign.run_full_campaign(
        workspace_root=WORKSPACE_ROOT,
        request=_request(),
        benchmark_ids=selected,
    )

    assert [benchmark_id for benchmark_id, _harnesses, _extra in calls] == list(
        selected
    )
    assert all(
        harnesses == campaign.CANONICAL_CAMPAIGN_HARNESSES
        for _benchmark_id, harnesses, _extra in calls
    )
    assert all(
        extra["_replace_adapter_defaults"] is True
        and extra["campaign_profile"] == campaign.FULL_CAMPAIGN_PROFILE
        for _benchmark_id, _harnesses, extra in calls
    )
    assert result.completed_phases == (
        "orchestrator_lifecycle/full",
        "action-calling/full",
    )


def test_manual_and_unsupported_entries_fail_closed_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        campaign,
        "validate_full_campaign_manifest",
        lambda _workspace: campaign.FULL_CAMPAIGN_MANIFEST,
    )
    adapters = {
        "social_alpha": _adapter("social_alpha"),
        "experience": _adapter("experience"),
    }
    monkeypatch.setattr(
        campaign,
        "discover_adapters",
        lambda _workspace: AdapterDiscovery(adapters=adapters, all_directories=()),
    )
    monkeypatch.setattr(
        campaign,
        "run_benchmark_cohorts",
        lambda **_kwargs: pytest.fail("selection should fail before dispatch"),
    )

    with pytest.raises(campaign.FullCampaignSelectionError, match="social_alpha is manual"):
        campaign.run_full_campaign(
            workspace_root=WORKSPACE_ROOT,
            request=_request(),
            benchmark_ids=("social_alpha",),
        )
    with pytest.raises(
        campaign.FullCampaignSelectionError,
        match="requires manual override.*data_dir",
    ):
        campaign.run_full_campaign(
            workspace_root=WORKSPACE_ROOT,
            request=_request(),
            benchmark_ids=("social_alpha",),
            allow_manual=True,
        )
    with pytest.raises(
        campaign.FullCampaignSelectionError,
        match="cannot publish a three-harness cohort.*unsupported",
    ):
        campaign.run_full_campaign(
            workspace_root=WORKSPACE_ROOT,
            request=_request(),
            benchmark_ids=("experience",),
        )


def test_request_cannot_reintroduce_sample_truncation() -> None:
    entry = next(
        item
        for item in campaign.ADAPTER_CAMPAIGN_ENTRIES
        if item.benchmark_id == "bfcl"
    )
    with pytest.raises(
        campaign.FullCampaignSelectionError,
        match="Dataset-shaping request extras are forbidden",
    ):
        campaign._phase_request(
            request=_request(extra={"max_tasks": 1}),
            entry=entry,
            phase=entry.phases[0],
            overrides={},
        )

    with pytest.raises(
        campaign.FullCampaignSelectionError,
        match="per_benchmark request extras are forbidden",
    ):
        campaign._phase_request(
            request=_request(extra={"per_benchmark": {"bfcl": {"sample": 1}}}),
            entry=entry,
            phase=entry.phases[0],
            overrides={},
        )

    with pytest.raises(
        campaign.FullCampaignSelectionError,
        match="manual overrides may not change dataset shape",
    ):
        campaign._phase_request(
            request=_request(),
            entry=entry,
            phase=entry.phases[0],
            overrides={"limit": 1},
        )

    with pytest.raises(
        campaign.FullCampaignSelectionError,
        match="undeclared request keys: max_turns",
    ):
        campaign._phase_request(
            request=_request(extra={"max_turns": 1}),
            entry=entry,
            phase=entry.phases[0],
            overrides={},
        )


def test_full_campaign_pins_medium_reasoning_for_every_phase() -> None:
    entry = next(
        item
        for item in campaign.ADAPTER_CAMPAIGN_ENTRIES
        if item.benchmark_id == "bfcl"
    )

    default_request = campaign._phase_request(
        request=_request(),
        entry=entry,
        phase=entry.phases[0],
        overrides={},
    )
    explicit_request = campaign._phase_request(
        request=_request(extra={"reasoning_effort": " medium "}),
        entry=entry,
        phase=entry.phases[0],
        overrides={},
    )

    assert default_request.extra_config["reasoning_effort"] == "medium"
    assert explicit_request.extra_config["reasoning_effort"] == "medium"

    with pytest.raises(
        campaign.FullCampaignSelectionError,
        match="fixes reasoning_effort=medium",
    ):
        campaign._phase_request(
            request=_request(extra={"reasoning_effort": "high"}),
            entry=entry,
            phase=entry.phases[0],
            overrides={},
        )


def test_cli_selects_a_canary_without_running_live_models(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    captured: dict = {}

    def fake_run_full_campaign(**kwargs):
        captured.update(kwargs)
        return campaign.FullCampaignRun(
            cohorts=(),
            completed_phases=("orchestrator_lifecycle/full",),
            unscheduled_entries=(),
        )

    monkeypatch.setattr(campaign, "run_full_campaign", fake_run_full_campaign)

    exit_code = campaign.main(
        [
            "--model",
            "claude-sonnet-4-6",
            "--benchmarks",
            "orchestrator_lifecycle",
            "--force",
        ]
    )

    assert exit_code == 0
    assert captured["benchmark_ids"] == ("orchestrator_lifecycle",)
    assert captured["request"].provider == "claude-subscription"
    assert captured["request"].force is True
    assert json.loads(capsys.readouterr().out)["completed_phases"] == [
        "orchestrator_lifecycle/full"
    ]
