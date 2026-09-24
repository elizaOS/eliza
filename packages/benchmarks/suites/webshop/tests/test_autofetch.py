"""Unit tests for auto-download / auto-install behavior.

These tests do NOT touch the network. They exercise the seams in
``elizaos_webshop.dataset`` and ``elizaos_webshop.environment`` that decide
whether to invoke the fetch script / `python -m spacy download`, using
mocks for the external side effects (subprocess, spacy.load, gdown).

They are intentionally independent of the heavy upstream dependencies
(``upstream/web_agent_site``, ``torch``, ``thefuzz``, ...), so they run in a
freshly-cloned repo without requiring the WebShop data to be present.
"""

from __future__ import annotations

import types
from pathlib import Path
from unittest import mock

import pytest

from elizaos_webshop.types import WebShopTask


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_spacy_singleton():
    """The spaCy loader caches in a module-level singleton; reset around each
    test so retry behavior can be exercised independently."""
    import elizaos_webshop.environment as env_mod

    env_mod._spacy_nlp_singleton = None
    env_mod._spacy_load_attempted = False
    yield
    env_mod._spacy_nlp_singleton = None
    env_mod._spacy_load_attempted = False


@pytest.fixture(autouse=True)
def _clear_optout_env(monkeypatch):
    monkeypatch.delenv("WEBSHOP_NO_AUTOFETCH", raising=False)
    yield


# ---------------------------------------------------------------------------
# spaCy auto-install
# ---------------------------------------------------------------------------


def test_edge_scenario_expansion_adds_ten_per_selected_webshop_task():
    from elizaos_webshop.dataset import count_tasks, expand_tasks, validate_tasks

    task = WebShopTask(
        task_id="webshop_000001_B000HEADPH",
        instruction="buy wireless bluetooth headphones in black",
        target_product_ids=["B000HEADPH"],
        budget=100.0,
        metadata={"upstream_goal_json": "{}"},
    )

    expanded = expand_tasks([task])

    assert count_tasks([task], include_edge_scenarios=True) == {
        "base": 1,
        "edge": 10,
        "edge_multiplier": 10,
        "total": 11,
    }
    assert len(expanded) == 11
    assert expanded[1].target_product_ids == task.target_product_ids
    assert expanded[1].metadata["base_task_id"] == task.task_id
    assert expanded[1].metadata["scenario_id"]
    validate_tasks([task], include_edge_scenarios=True)


def test_resolve_paths_requires_human_goal_manifest(tmp_path: Path):
    from elizaos_webshop.dataset import resolve_paths

    (tmp_path / "items_shuffle.json").write_text("[]", encoding="utf-8")
    (tmp_path / "items_ins_v2.json").write_text("{}", encoding="utf-8")

    assert resolve_paths(data_dir=tmp_path, profile="full") is None


def test_full_profile_goal_count_is_fixed_to_published_corpus():
    from elizaos_webshop.dataset import (
        EXPECTED_FULL_CATALOG_ENTRIES,
        EXPECTED_FULL_HUMAN_GOALS,
        EXPECTED_FULL_PRODUCTS,
        WebShopDataset,
    )

    assert EXPECTED_FULL_HUMAN_GOALS == 12_087
    assert EXPECTED_FULL_CATALOG_ENTRIES == 1_181_436
    assert EXPECTED_FULL_PRODUCTS == 1_181_430
    dataset = WebShopDataset(profile="full", split="test")
    assert dataset._expected_full_split_count() == 500
    assert WebShopDataset(profile="full", split="eval")._expected_full_split_count() == 1_000
    assert WebShopDataset(profile="full", split="train")._expected_full_split_count() == 10_587


def test_fetch_profile_rejects_corrupt_existing_file(tmp_path: Path):
    from elizaos_webshop.dataset import _load_fetch_module

    fetch_module = _load_fetch_module()
    (tmp_path / "items_human_ins.json").write_bytes(b"corrupt")

    with pytest.raises(RuntimeError, match="size mismatch"):
        fetch_module.fetch_profile("goals", data_dir=tmp_path)


def test_upstream_provenance_hashes_every_selected_file(
    tmp_path: Path, monkeypatch
):
    import hashlib

    import elizaos_webshop.dataset as dataset_module

    payloads = {
        "items_shuffle.json": b"items",
        "items_ins_v2.json": b"attributes",
        "items_human_ins.json": b"goals",
    }
    for name, payload in payloads.items():
        (tmp_path / name).write_bytes(payload)
        monkeypatch.setitem(
            dataset_module.UPSTREAM_FILE_MANIFEST,
            name,
            (len(payload), hashlib.sha256(payload).hexdigest()),
        )
    paths = dataset_module.WebShopDataPaths(
        items=tmp_path / "items_shuffle.json",
        attributes=tmp_path / "items_ins_v2.json",
        human_instructions=tmp_path / "items_human_ins.json",
    )

    provenance = dataset_module.verify_upstream_data(paths)

    assert provenance["items_sha256"] == hashlib.sha256(b"items").hexdigest()
    assert provenance["attributes_file_size"] == len(b"attributes")
    assert provenance["human_goals_source_id"] == (
        dataset_module.UPSTREAM_GDRIVE_FILE_IDS["items_human_ins.json"]
    )

    paths.items.write_bytes(b"mutated")
    with pytest.raises(ValueError, match="size mismatch"):
        dataset_module.verify_upstream_data(paths)


def test_fetch_profile_uses_checksum_pinned_mirror(
    tmp_path: Path, monkeypatch
):
    from elizaos_webshop.dataset import _load_fetch_module

    fetch_module = _load_fetch_module()
    fetch_profile = fetch_module.fetch_profile
    expected_size, expected_sha256 = fetch_module.EXPECTED_FILES["items_human_ins"]
    calls: list[str] = []

    def unavailable(_file_id: str, _dest: Path) -> None:
        raise fetch_module.PrimarySourceUnavailable("drive unavailable")

    def mirror(logical_name: str, dest: Path) -> None:
        calls.append(logical_name)
        part = dest.with_suffix(dest.suffix + ".part")
        part.write_bytes(b"mirror")

    def verify(logical_name: str, path: Path) -> None:
        assert logical_name == "items_human_ins"
        assert path.read_bytes() == b"mirror"

    monkeypatch.setitem(fetch_profile.__globals__, "_download_via_gdown", unavailable)
    monkeypatch.setitem(fetch_profile.__globals__, "_download_via_huggingface", mirror)
    monkeypatch.setitem(fetch_profile.__globals__, "_verify_file", verify)

    fetched = fetch_profile("goals", data_dir=tmp_path)

    assert calls == ["items_human_ins"]
    assert fetched == [tmp_path / "items_human_ins.json"]
    assert fetched[0].read_bytes() == b"mirror"
    assert expected_size == 5_137_548
    assert len(expected_sha256) == 64


def test_count_scenarios_exits_without_starting_benchmark(monkeypatch, capsys):
    import sys

    import elizaos_webshop.cli as cli_mod

    task = WebShopTask(
        task_id="webshop_000001_B000HEADPH",
        instruction="buy wireless bluetooth headphones in black",
        target_product_ids=["B000HEADPH"],
        budget=100.0,
        metadata={"upstream_goal_json": "{}"},
    )

    class FakeDataset:
        def __init__(self, **_kwargs):
            pass

        def load_manifest_sync(self):
            pass

        def get_tasks(self, limit=None):
            return [task][:limit]

    def fail_if_started(_coroutine):
        raise AssertionError("count mode started the benchmark")

    monkeypatch.setattr(cli_mod, "WebShopDataset", FakeDataset)
    monkeypatch.setattr(cli_mod.asyncio, "run", fail_if_started)
    monkeypatch.setattr(
        sys,
        "argv",
        ["webshop-bench", "--count-scenarios", "--expand-scenarios"],
    )

    assert cli_mod.main() == 0
    assert '"total": 11' in capsys.readouterr().out


def test_manifest_count_filters_goals_absent_from_selected_catalog(tmp_path: Path):
    import json

    from elizaos_webshop.dataset import WebShopDataset

    (tmp_path / "items_shuffle_1000.json").write_text(
        json.dumps([{"asin": "B000INSET"}]),
        encoding="utf-8",
    )
    (tmp_path / "items_ins_v2_1000.json").write_text("{}", encoding="utf-8")
    (tmp_path / "items_human_ins.json").write_text(
        json.dumps(
            {
                "B000INSET": [
                    {
                        "instruction": "buy the included item",
                        "instruction_attributes": ["included"],
                        "instruction_options": [],
                    }
                ],
                "B000OUTSET": [
                    {
                        "instruction": "buy an item outside the catalog",
                        "instruction_attributes": ["outside"],
                        "instruction_options": [],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    dataset = WebShopDataset(profile="small", split="test", data_dir=tmp_path)
    dataset.load_manifest_sync()

    assert len(dataset.tasks) == 1
    assert dataset.tasks[0].target_product_ids == ["B000INSET"]


def test_manifest_loader_uses_canonical_positional_splits(tmp_path: Path):
    import json
    import random

    from elizaos_webshop.dataset import CANONICAL_GOAL_SHUFFLE_SEED, WebShopDataset

    (tmp_path / "items_shuffle_1000.json").write_text(
        json.dumps([{"asin": "B000INSET"}]),
        encoding="utf-8",
    )
    (tmp_path / "items_ins_v2_1000.json").write_text("{}", encoding="utf-8")
    instructions = [
        {
            "instruction": f"canonical instruction {index}",
            "instruction_attributes": ["included"],
            "instruction_options": [],
        }
        for index in range(1_600)
    ]
    (tmp_path / "items_human_ins.json").write_text(
        json.dumps({"B000INSET": instructions}),
        encoding="utf-8",
    )

    test_dataset = WebShopDataset(profile="small", split="test", data_dir=tmp_path)
    test_dataset.load_manifest_sync()
    eval_dataset = WebShopDataset(profile="small", split="eval", data_dir=tmp_path)
    eval_dataset.load_manifest_sync()
    train_dataset = WebShopDataset(profile="small", split="train", data_dir=tmp_path)
    train_dataset.load_manifest_sync()

    shuffled = list(range(1_600))
    random.Random(CANONICAL_GOAL_SHUFFLE_SEED).shuffle(shuffled)

    assert len(test_dataset.tasks) == 500
    assert test_dataset.tasks[0].instruction == f"canonical instruction {shuffled[0]}"
    assert test_dataset.tasks[-1].instruction == f"canonical instruction {shuffled[499]}"
    assert len(eval_dataset.tasks) == 1_000
    assert eval_dataset.tasks[0].instruction == f"canonical instruction {shuffled[500]}"
    assert eval_dataset.tasks[-1].instruction == f"canonical instruction {shuffled[1499]}"
    assert len(train_dataset.tasks) == 100
    assert train_dataset.tasks[0].instruction == f"canonical instruction {shuffled[1500]}"


def test_full_catalog_signature_rejects_truncated_product_set(tmp_path: Path):
    import json

    from elizaos_webshop.dataset import _catalog_asins

    catalog = tmp_path / "items_shuffle.json"
    catalog.write_text(json.dumps([{"asin": "B000ONLY01"}]), encoding="utf-8")

    with pytest.raises(ValueError, match="expected 2 unique products, found 1"):
        _catalog_asins(catalog, stream=True, expected_count=2)


def test_runtime_goals_replace_count_manifest_with_exact_upstream_payload(tmp_path: Path):
    import json

    from elizaos_webshop.dataset import WebShopDataset

    dataset = WebShopDataset(profile="small", split="test", data_dir=tmp_path)
    runtime_goal = {
        "asin": "B000EXACT1",
        "instruction_text": "buy the exact item, and price lower than 40.00 dollars",
        "attributes": ["exact"],
        "price_upper": 40.0,
        "goal_options": {"color": "black"},
        "category": "test",
        "query": "exact item",
        "name": "Exact Item",
        "product_category": "Test > Exact",
        "weight": 1,
    }

    dataset.install_runtime_goals([runtime_goal], catalog_product_count=1)

    assert dataset.catalog_product_count == 1
    assert dataset.published_goal_count == 1
    assert len(dataset.tasks) == 1
    stored = json.loads(dataset.tasks[0].metadata["upstream_goal_json"])
    assert stored == runtime_goal
    assert dataset.tasks[0].budget == 40.0


def test_streaming_catalog_reader_ignores_nested_customization_asins(
    tmp_path: Path, monkeypatch
):
    import json

    import elizaos_webshop.dataset as dataset_module

    catalog = tmp_path / "items_shuffle.json"
    catalog.write_text(
        json.dumps(
            [
                {
                    "asin": "B000TOP001",
                    "customization_options": {
                        "size": [{"value": "small", "asin": "B000NEST01"}]
                    },
                },
                {"asin": "B000TOP002", "description": "x" * 80},
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(dataset_module, "_CATALOG_STREAM_CHUNK_SIZE", 17)

    asins = dataset_module._catalog_asins(catalog, stream=True, expected_count=2)

    assert asins == {"B000TOP001", "B000TOP002"}


def test_report_metadata_marks_deprecated_hf_flag_as_ignored(tmp_path: Path):
    from elizaos_webshop.runner import WebShopRunner
    from elizaos_webshop.types import WebShopConfig

    runner = WebShopRunner(
        WebShopConfig(output_dir=str(tmp_path), use_mock=True),
        use_hf=True,
        use_sample_tasks=True,
    )
    runner._env = types.SimpleNamespace(runtime_provenance={})
    report = runner._generate_report([])
    payload = runner._report_to_dict(report)

    assert payload["dataset_source"] == "sample-files"
    assert payload["hf_requested"] is True
    assert payload["use_hf"] is False


def test_spacy_autoinstall_retries_after_oserror():
    """First call OSErrors; we install; retry succeeds."""
    import elizaos_webshop.environment as env_mod

    fake_nlp = object()
    fake_spacy = types.SimpleNamespace()
    call_count = {"n": 0}

    def fake_load(model: str):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise OSError(f"[E050] Can't find model '{model}'.")
        return fake_nlp

    fake_spacy.load = fake_load

    runs: list[list[str]] = []

    def fake_run(cmd, check=False):
        runs.append(list(cmd))
        return types.SimpleNamespace(returncode=0)

    nlp = env_mod._ensure_spacy_model_available(
        model="en_core_web_sm",
        _spacy_module=fake_spacy,
        _subprocess_run=fake_run,
    )

    assert nlp is fake_nlp
    assert call_count["n"] == 2, "expected one failure and one retry"
    assert len(runs) == 1
    cmd = runs[0]
    assert cmd[1:] == ["-m", "spacy", "download", "en_core_web_sm"]


def test_spacy_autoinstall_caches_singleton():
    """A second call returns the cached object; no new subprocess call."""
    import elizaos_webshop.environment as env_mod

    fake_nlp = object()
    fake_spacy = types.SimpleNamespace(load=lambda m: fake_nlp)
    calls = {"runs": 0}

    def fake_run(cmd, check=False):
        calls["runs"] += 1
        return types.SimpleNamespace(returncode=0)

    nlp1 = env_mod._ensure_spacy_model_available(
        model="en_core_web_sm",
        _spacy_module=fake_spacy,
        _subprocess_run=fake_run,
    )
    nlp2 = env_mod._ensure_spacy_model_available(
        model="en_core_web_sm",
        _spacy_module=fake_spacy,
        _subprocess_run=fake_run,
    )

    assert nlp1 is nlp2 is fake_nlp
    assert calls["runs"] == 0, "model loaded first try; no install needed"


def test_spacy_autoinstall_disabled_by_env(monkeypatch):
    """With WEBSHOP_NO_AUTOFETCH=1 set, missing model raises a clear error."""
    import elizaos_webshop.environment as env_mod

    monkeypatch.setenv("WEBSHOP_NO_AUTOFETCH", "1")

    fake_spacy = types.SimpleNamespace(
        load=mock.MagicMock(side_effect=OSError("[E050] no model")),
    )
    runs: list[list[str]] = []

    def fake_run(cmd, check=False):
        runs.append(list(cmd))
        return types.SimpleNamespace(returncode=0)

    with pytest.raises(OSError) as ei:
        env_mod._ensure_spacy_model_available(
            model="en_core_web_sm",
            _spacy_module=fake_spacy,
            _subprocess_run=fake_run,
        )

    msg = str(ei.value)
    assert "WEBSHOP_NO_AUTOFETCH" in msg
    assert "python -m spacy download en_core_web_sm" in msg
    assert runs == [], "subprocess install should NOT run when opt-out is set"


def test_spacy_autoinstall_subprocess_failure_raises():
    """If `python -m spacy download` returns non-zero, we surface a clear error."""
    import elizaos_webshop.environment as env_mod

    fake_spacy = types.SimpleNamespace(
        load=mock.MagicMock(side_effect=OSError("[E050] no model")),
    )

    def fake_run(cmd, check=False):
        return types.SimpleNamespace(returncode=1)

    with pytest.raises(OSError) as ei:
        env_mod._ensure_spacy_model_available(
            model="en_core_web_sm",
            _spacy_module=fake_spacy,
            _subprocess_run=fake_run,
        )

    msg = str(ei.value)
    assert "spacy download" in msg
    assert "exit code 1" in msg


def test_dependency_stubs_require_explicit_smoke_opt_in(monkeypatch):
    import sys

    import elizaos_webshop.environment as env_mod

    module_names = (
        "spacy",
        "thefuzz",
        "thefuzz.fuzz",
    )
    for name in module_names:
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr(env_mod.importlib.util, "find_spec", lambda _name: None)
    monkeypatch.delenv("WEBSHOP_ALLOW_SPACY_STUB", raising=False)

    env_mod._install_optional_dependency_stubs()

    assert not any(name in sys.modules for name in module_names)

    monkeypatch.setenv("WEBSHOP_ALLOW_SPACY_STUB", "1")
    env_mod._install_optional_dependency_stubs()

    assert all(name in sys.modules for name in module_names)


# ---------------------------------------------------------------------------
# Data auto-fetch
# ---------------------------------------------------------------------------


def test_ensure_profile_downloaded_noop_when_files_present(tmp_path: Path):
    """If all required files already exist, no fetch is triggered."""
    import elizaos_webshop.dataset as ds_mod

    for name in ("items_shuffle_1000.json", "items_ins_v2_1000.json", "items_human_ins.json"):
        (tmp_path / name).write_text('{"ok": true}', encoding="utf-8")

    with mock.patch.object(ds_mod, "_load_fetch_module") as load_mod_mock:
        ds_mod.ensure_profile_downloaded("small", tmp_path)
        load_mod_mock.assert_not_called()


def test_ensure_profile_downloaded_invokes_fetch(tmp_path: Path):
    """Missing files trigger ``download_profile`` from fetch_data.py."""
    import elizaos_webshop.dataset as ds_mod

    fake_module = types.SimpleNamespace()
    captured: list[tuple[str, Path]] = []

    def fake_download_profile(profile: str, dest: Path):
        captured.append((profile, dest))
        # Simulate the download
        for name in ("items_shuffle_1000.json", "items_ins_v2_1000.json", "items_human_ins.json"):
            (dest / name).write_text('{"ok": true}', encoding="utf-8")
        return [dest / name for name in (
            "items_shuffle_1000.json", "items_ins_v2_1000.json", "items_human_ins.json"
        )]

    fake_module.download_profile = fake_download_profile

    with mock.patch.object(ds_mod, "_load_fetch_module", return_value=fake_module):
        ds_mod.ensure_profile_downloaded("small", tmp_path)

    assert captured == [("small", tmp_path)]
    for name in ("items_shuffle_1000.json", "items_ins_v2_1000.json", "items_human_ins.json"):
        assert (tmp_path / name).exists()


def test_ensure_profile_downloaded_opt_out_raises(monkeypatch, tmp_path: Path):
    """With WEBSHOP_NO_AUTOFETCH=1 set, missing data raises mentioning the env var."""
    import elizaos_webshop.dataset as ds_mod

    monkeypatch.setenv("WEBSHOP_NO_AUTOFETCH", "1")

    with mock.patch.object(ds_mod, "_load_fetch_module") as load_mod_mock:
        with pytest.raises(FileNotFoundError) as ei:
            ds_mod.ensure_profile_downloaded("small", tmp_path)

        load_mod_mock.assert_not_called()

    msg = str(ei.value)
    assert "WEBSHOP_NO_AUTOFETCH" in msg
    assert "scripts/fetch_data.py" in msg
    assert "--profile small" in msg


def test_load_sync_with_optout_and_no_data_raises(monkeypatch, tmp_path: Path):
    """End-to-end at the WebShopDataset.load_sync boundary: opt-out + missing
    data must raise a FileNotFoundError that mentions the opt-out env var."""
    import elizaos_webshop.dataset as ds_mod

    monkeypatch.setenv("WEBSHOP_NO_AUTOFETCH", "1")

    ds = ds_mod.WebShopDataset(
        split="test",
        profile="small",
        use_sample_tasks=False,
        data_dir=tmp_path,  # empty dir -> data is missing
    )

    with pytest.raises(FileNotFoundError) as ei:
        ds.load_sync()

    assert "WEBSHOP_NO_AUTOFETCH" in str(ei.value)


def test_load_fetch_module_has_download_profile():
    """The fetch_data.py script exposes download_profile() as a callable."""
    import elizaos_webshop.dataset as ds_mod

    mod = ds_mod._load_fetch_module()
    assert hasattr(mod, "download_profile"), "fetch_data.py must expose download_profile"
    assert callable(mod.download_profile)
    # The CLI wrapper main() should still exist for the script entry point.
    assert callable(getattr(mod, "main"))


def test_load_fetch_module_use_sample_tasks_is_noop(monkeypatch, tmp_path: Path):
    """With ``use_sample_tasks=True``, the dataset must never call into
    fetch_data even if data dir is empty (sample needs no downloads)."""
    import elizaos_webshop.dataset as ds_mod

    # Set opt-out so a *real* fetch attempt would raise loudly.
    monkeypatch.setenv("WEBSHOP_NO_AUTOFETCH", "1")

    ds_mod.WebShopDataset(
        split="test",
        profile="small",
        use_sample_tasks=True,
        data_dir=tmp_path,
    )

    # We do NOT call load_sync() here because that pulls in upstream
    # (spaCy / torch / thefuzz) and we want to keep this test light.
    # Instead, assert the function we care about is bypassed in code: the
    # sample-task code path in load_sync() never touches ensure_profile_downloaded.
    import inspect

    src = inspect.getsource(ds_mod.WebShopDataset.load_sync)
    # The opt-out branch lives below the sample-tasks early-return.
    sample_idx = src.find("use_sample_tasks")
    autofetch_idx = src.find("ensure_profile_downloaded")
    assert sample_idx != -1 and autofetch_idx != -1
    assert sample_idx < autofetch_idx, (
        "use_sample_tasks branch must be evaluated *before* the auto-fetch hook"
    )
