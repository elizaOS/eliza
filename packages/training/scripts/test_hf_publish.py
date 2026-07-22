"""Pytest suite for the HF publishing scripts.

Mocks `huggingface_hub.HfApi` and asserts the publishers compute the right
file lists and call `upload_file` with the right args. Also verifies the
`--dry-run` paths print the expected files + total bytes without touching
the network.

Run::

    cd training && pytest -xvs scripts/test_hf_publish.py
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"


def _load(name: str, path: Path):
    """Import a script as a module without polluting the global namespace."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def publish_dataset():
    return _load("publish_dataset_to_hf", SCRIPTS / "publish_dataset_to_hf.py")


@pytest.fixture
def publish_pipeline():
    return _load("publish_pipeline_to_hf", SCRIPTS / "publish_pipeline_to_hf.py")


@pytest.fixture
def publish_all_finetuned():
    return _load("publish_all_finetuned", SCRIPTS / "publish_all_finetuned.py")


# ---------------------------------------------------------------------------
# Allowlist correctness
# ---------------------------------------------------------------------------


def test_training_spec_uses_only_active_split(publish_dataset):
    """The 'training' bundle must NOT include WIP files. The active train
    file is either ``train.jsonl`` (canonical) or ``train_final.jsonl``
    (legacy fallback honored when the older filename still exists on disk
    — see scripts/publish_dataset_to_hf.py:_spec_training)."""
    spec = publish_dataset._spec_training()
    names = {p.name for p in spec.files}
    train_src = names & {"train.jsonl", "train_final.jsonl"}
    assert (
        len(train_src) == 1
    ), f"expected one of train.jsonl|train_final.jsonl, got {names}"
    val_src = names & {"val.jsonl", "validation.jsonl"}
    manifest_src = names & {"manifest.json", "manifest_final.json"}
    assert len(val_src) == 1
    assert "test.jsonl" in names
    assert len(manifest_src) == 1
    # Explicit denylist — historical/WIP files that must never be in the spec.
    forbidden = {"train_v8.jsonl", "train_rewritten.review.jsonl"}
    assert names.isdisjoint(forbidden)
    # path_in_repo strips the "_final" suffix so consumers see clean names.
    final = spec.files[0]
    assert spec.path_in_repo[final] == "train.jsonl"
    manifest = spec.files[3]
    assert spec.path_in_repo[manifest] == "manifest.json"


def test_training_spec_can_publish_candidate_as_root_splits(publish_dataset, tmp_path):
    candidate = tmp_path / "lifeops-candidate"
    data = candidate / "data"
    data.mkdir(parents=True)
    for name in ("train.jsonl", "validation.jsonl", "test.jsonl"):
        (data / name).write_text('{"messages":[{"role":"user","content":"hi"}]}\n')
    (candidate / "manifest.json").write_text("{}")

    spec = publish_dataset._spec_training_from_dir(candidate)

    by_target = {target: path.name for path, target in spec.path_in_repo.items()}
    assert by_target == {
        "train.jsonl": "train.jsonl",
        "val.jsonl": "validation.jsonl",
        "test.jsonl": "test.jsonl",
        "manifest.json": "manifest.json",
    }


def test_hf_load_preflight_accepts_matching_candidate_splits(publish_dataset, tmp_path):
    pytest.importorskip("datasets")
    candidate = tmp_path / "lifeops-candidate"
    data = candidate / "data"
    data.mkdir(parents=True)
    row = '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"ok"}]}\n'
    for name in ("train.jsonl", "validation.jsonl", "test.jsonl"):
        (data / name).write_text(row)
    (candidate / "manifest.json").write_text("{}")

    assert publish_dataset.validate_hf_loadable(
        publish_dataset._spec_training_from_dir(candidate)
    )


def test_training_spec_exports_native_rows_to_hf_safe_jsonl(publish_dataset, tmp_path):
    candidate = tmp_path / "native-candidate"
    data = candidate / "data"
    data.mkdir(parents=True)
    native = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "request": {"messages": [{"role": "user", "content": "hi"}], "tools": []},
        "response": {"text": "hello", "toolCalls": []},
        "metadata": {"source_dataset": "unit", "split": "train"},
    }
    for name in ("train.jsonl", "validation.jsonl", "test.jsonl"):
        (data / name).write_text(publish_dataset._json_dumps(native) + "\n")
    (candidate / "manifest.json").write_text('{"schemaVersion":"eliza1.dataset_candidate.v1"}')

    spec = publish_dataset._spec_training_from_dir(candidate)
    by_target = {target: path for path, target in spec.path_in_repo.items()}
    exported_train = by_target["train.jsonl"]

    assert exported_train != data / "train.jsonl"
    assert "data/train-00000-of-00001.parquet" in by_target
    assert by_target["data/train-00000-of-00001.parquet"].is_file()
    row = __import__("json").loads(exported_train.read_text().splitlines()[0])
    assert row["schema"] == "eliza.eliza1_hf_training_row.v1"
    assert row["assistant_text"] == "hello"
    assert isinstance(row["request_json"], str)
    assert isinstance(row["native_json"], str)
    assert publish_dataset.validate_hf_loadable(spec)


def test_publish_all_ignores_retired_eliza1_optimized_bundle(
    publish_all_finetuned, tmp_path
):
    checkpoints = tmp_path / "checkpoints"
    run = checkpoints / "eliza-1-2b-apollo-123"
    retired = run / "eliza1-optimized"
    final = run / "final"
    retired.mkdir(parents=True)
    final.mkdir()

    entry = SimpleNamespace(eliza_short_name="eliza-1-2b")

    assert (
        publish_all_finetuned._find_bundle_dir(checkpoints, "gemma4-e2b", entry)
        == final
    )


def test_hf_load_preflight_rejects_split_feature_drift(publish_dataset, tmp_path):
    pytest.importorskip("datasets")
    candidate = tmp_path / "lifeops-candidate"
    data = candidate / "data"
    data.mkdir(parents=True)
    (data / "train.jsonl").write_text('{"messages":[{"role":"user","content":"hi"}]}\n')
    (data / "validation.jsonl").write_text('{"messages":"bad"}\n')
    (data / "test.jsonl").write_text('{"messages":[{"role":"user","content":"hi"}]}\n')
    (candidate / "manifest.json").write_text("{}")

    assert not publish_dataset.validate_hf_loadable(
        publish_dataset._spec_training_from_dir(candidate)
    )


def test_hf_load_preflight_rejects_empty_test_split(publish_dataset, tmp_path):
    pytest.importorskip("datasets")
    candidate = tmp_path / "lifeops-candidate"
    data = candidate / "data"
    data.mkdir(parents=True)
    row = '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"ok"}]}\n'
    (data / "train.jsonl").write_text(row)
    (data / "validation.jsonl").write_text(row)
    (data / "test.jsonl").write_text("")
    (candidate / "manifest.json").write_text("{}")

    assert not publish_dataset.validate_hf_loadable(
        publish_dataset._spec_training_from_dir(candidate)
    )


def test_scambench_spec_only_includes_scambench(publish_dataset):
    spec = publish_dataset._spec_scambench()
    # All files must live under data/normalized/ or data/synthesized/scambench/
    for f in spec.files:
        rel = str(f.relative_to(ROOT))
        assert rel.startswith("data/normalized/scambench") or rel.startswith(
            "data/synthesized/scambench/"
        ), f"unexpected scambench file: {rel}"


def test_synthesized_spec_only_small_subdirs(publish_dataset):
    spec = publish_dataset._spec_synthesized()
    allowed_subs = {
        "action_examples",
        "action_pairs",
        "core_prompts",
        "evaluators",
        "phase3",
    }
    for f in spec.files:
        rel = f.relative_to(ROOT)
        # data/synthesized/<sub>/<file>.jsonl
        assert len(rel.parts) >= 4, rel
        assert rel.parts[0] == "data" and rel.parts[1] == "synthesized"
        assert (
            rel.parts[2] in allowed_subs
        ), f"unexpected synthesized subdir: {rel.parts[2]}"
        assert f.suffix == ".jsonl"


def test_combined_spec_includes_all_consolidated_paths(publish_dataset):
    spec = publish_dataset._spec_combined()
    targets = set(spec.path_in_repo.values())
    assert {"train.jsonl", "val.jsonl", "test.jsonl", "manifest.json"} <= targets
    if (ROOT / "data" / "synthesized" / "evaluators").exists():
        assert any(t.startswith("synthesized/evaluators/") for t in targets)
    if (ROOT / "data" / "synthesized" / "phase3").exists():
        assert any(t.startswith("synthesized/phase3/") for t in targets)
    assert "sft/0_6b/UPLOAD_MANIFEST.json" in targets


def test_abliteration_spec_is_pointer_only(publish_dataset):
    spec = publish_dataset._spec_abliteration()
    assert spec.is_pointer_only is True
    assert spec.files == ()
    assert "mlabonne/harmless_alpaca" in spec.card


# ---------------------------------------------------------------------------
# Dry-run: prints planned uploads + total bytes, no auth.
# ---------------------------------------------------------------------------


def test_dataset_dry_run_lists_files_and_bytes(publish_dataset, caplog, monkeypatch):
    # No HF_TOKEN — dry-run must still succeed.
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)

    spec = publish_dataset._spec_training()
    if not all(f.exists() for f in spec.files):
        pytest.skip("training data files not present in this checkout")

    with caplog.at_level(logging.INFO, logger="publish_dataset"):
        rc = publish_dataset._print_dry_run(spec, "elizaos/eliza-1-training")
    assert rc == 0
    log_text = "\n".join(r.getMessage() for r in caplog.records)
    assert "dry-run" in log_text
    assert "train.jsonl" in log_text
    assert "val.jsonl" in log_text
    assert "test.jsonl" in log_text
    assert "manifest.json" in log_text
    assert "total payload" in log_text


def test_pipeline_dry_run_lists_scripts_and_docs(publish_pipeline, caplog, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)

    files = (
        publish_pipeline._collect_top_level_docs() + publish_pipeline._walk_scripts()
    )
    assert files, "pipeline file collection returned nothing"
    paths = {f.path_in_repo for f in files}
    # core trainer files must be present
    assert "scripts/train_vast.sh" in paths
    assert "scripts/training/model_registry.py" in paths
    assert "pyproject.toml" in paths
    # exclusions
    assert not any(p.endswith(".pyc") for p in paths)
    assert not any("__pycache__" in p for p in paths)
    assert not any(p == ".vast_instance_id" for p in paths)

    with caplog.at_level(logging.INFO, logger="publish_pipeline"):
        rc = publish_pipeline._print_dry_run(files, "elizaos/eliza-1-training")
    assert rc == 0
    log_text = "\n".join(r.getMessage() for r in caplog.records)
    assert "would upload" in log_text


# ---------------------------------------------------------------------------
# Real-publish path: HfApi is mocked end-to-end.
# ---------------------------------------------------------------------------


def _fake_repo_info_factory(siblings=None):
    siblings = siblings or []
    return SimpleNamespace(siblings=siblings)


def test_dataset_publish_uploads_files_with_commit_messages(
    publish_dataset, monkeypatch, tmp_path
):
    """Verify the publish path issues a single create_commit() with all files
    plus README in one CommitOperationAdd batch, carrying a commit_message
    and repo_type='dataset'. The module switched from per-file upload_file
    calls to atomic create_commit so partial uploads can't ship broken
    bundles — see scripts/publish_dataset_to_hf.py:publish."""
    monkeypatch.setenv("HF_TOKEN", "hf_fake_token")

    f1 = tmp_path / "train.jsonl"
    f1.write_text('{"messages":[{"role":"user","content":"hi"}]}\n')
    f2 = tmp_path / "manifest.json"
    f2.write_text("{}")

    spec = publish_dataset.DatasetSpec(
        name="training",
        files=(f1, f2),
        path_in_repo={f1: "train.jsonl", f2: "manifest.json"},
        card="# fake card\n",
    )

    fake_api = MagicMock()
    fake_api.repo_info.return_value = _fake_repo_info_factory()

    with patch("huggingface_hub.HfApi", return_value=fake_api):
        rc = publish_dataset.publish(spec, "elizaos/eliza-1-training", public=True)

    assert rc == 0
    fake_api.create_repo.assert_not_called()

    # Atomic commit path: exactly one create_commit() with README + every spec file.
    assert fake_api.create_commit.call_count == 1
    commit_call = fake_api.create_commit.call_args
    ops = commit_call.kwargs["operations"]
    op_paths = [op.path_in_repo for op in ops]
    assert "README.md" in op_paths
    assert "train.jsonl" in op_paths
    assert "manifest.json" in op_paths
    assert commit_call.kwargs.get("commit_message"), "missing commit_message"
    assert commit_call.kwargs.get("repo_type") == "dataset"


def test_dataset_publish_rejects_smoke_training_manifest(
    publish_dataset, monkeypatch, tmp_path
):
    monkeypatch.setenv("HF_TOKEN", "hf_fake_token")

    train = tmp_path / "train.jsonl"
    train.write_text('{"messages":[{"role":"user","content":"hi"}]}\n')
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        '{"schema":"eliza.eliza1_smoke_corpus_manifest.v2","purpose":"smoke only"}'
    )
    spec = publish_dataset.DatasetSpec(
        name="training",
        files=(train, manifest),
        path_in_repo={train: "train.jsonl", manifest: "manifest.json"},
        card="# fake card\n",
    )

    rc = publish_dataset.publish(spec, "elizaos/eliza-1-training", public=True)

    assert rc == 2


def test_dataset_publish_rejects_removed_tier_in_card(
    publish_dataset, monkeypatch, tmp_path
):
    monkeypatch.setenv("HF_TOKEN", "hf_fake_token")

    train = tmp_path / "train.jsonl"
    train.write_text('{"messages":[{"role":"user","content":"hi"}]}\n')
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"schema":"eliza.eliza1_training_manifest.v1"}')
    spec = publish_dataset.DatasetSpec(
        name="training",
        files=(train, manifest),
        path_in_repo={train: "train.jsonl", manifest: "manifest.json"},
        card="tiers: 0.8B, 27B-1M\n",
    )

    rc = publish_dataset.publish(spec, "elizaos/eliza-1-training", public=True)

    assert rc == 2


def test_dataset_publish_skips_when_token_missing(publish_dataset, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)

    spec = publish_dataset._spec_abliteration()  # cheap; pointer-only
    rc = publish_dataset.publish(spec, "elizaos/eliza-1-abliteration", public=True)
    assert rc == 1


def test_dataset_publish_skips_files_with_matching_sha(
    publish_dataset, monkeypatch, tmp_path
):
    monkeypatch.setenv("HF_TOKEN", "hf_fake_token")

    f1 = tmp_path / "train.jsonl"
    f1.write_text("hello\n")
    spec = publish_dataset.DatasetSpec(
        name="training",
        files=(f1,),
        path_in_repo={f1: "train.jsonl"},
        card="# c\n",
    )

    expected_sha = publish_dataset._sha256_file(f1)

    # Mock repo_info: first call (existence check) succeeds; subsequent call
    # (from _remote_sha256) returns siblings with the matching SHA.
    fake_api = MagicMock()
    sibling = SimpleNamespace(
        rfilename="train.jsonl",
        lfs={"sha256": expected_sha},
    )
    fake_api.repo_info.side_effect = [
        SimpleNamespace(siblings=[sibling]),  # exists
        SimpleNamespace(siblings=[sibling]),  # _remote_sha256 query
    ]

    with patch("huggingface_hub.HfApi", return_value=fake_api):
        rc = publish_dataset.publish(spec, "elizaos/eliza-1-training", public=True)
    assert rc == 0

    # Atomic commit path: README ships, train.jsonl is skipped because its
    # SHA matched the remote LFS pointer.
    assert fake_api.create_commit.call_count == 1
    ops = fake_api.create_commit.call_args.kwargs["operations"]
    op_paths = [op.path_in_repo for op in ops]
    assert op_paths == ["README.md"]


def test_pipeline_publish_excludes_pycache(publish_pipeline, monkeypatch):
    """Even after walking, no __pycache__ entries leak into the upload set."""
    files = publish_pipeline._walk_scripts()
    for f in files:
        assert "__pycache__" not in f.path_in_repo
        assert not f.path_in_repo.endswith(".pyc")


def test_pipeline_publish_token_required(publish_pipeline, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)

    fake_files = [
        publish_pipeline.PipelineFile(
            src=Path(__file__),  # any real file
            path_in_repo="scripts/test_hf_publish.py",
        )
    ]
    rc = publish_pipeline.publish(fake_files, "elizaos/eliza-1-training", public=True)
    assert rc == 1


def test_pipeline_card_mentions_companion_repos(publish_pipeline):
    card = publish_pipeline.build_pipeline_card("elizaos/eliza-1-training")
    assert "elizaos/eliza-1-training" in card
    assert "elizaos/eliza-1-training" in card
    assert "uv sync --extra train" in card
    # Vast bootstrap instructions present
    assert "hf download" in card
    assert "  - gemma\n" in card
    assert "  - qwen\n" not in card


def test_dataset_card_includes_license(publish_dataset):
    spec = publish_dataset._spec_training()
    assert "license: cc-by-4.0" in spec.card.lower()
    assert "manifest.json" in spec.card
    assert "eliza-1-2b" in spec.card
    assert "eliza-1-4b" in spec.card
    assert "eliza-1-9b" in spec.card
    assert "eliza-1-27b" in spec.card
    assert "eliza-1-27b-256k" in spec.card
    assert "2B-27B" in spec.card
    stale_small_tier = "eliza-1-0_" + "6b"
    stale_qwen_small_tier = "eliza-1-0_" + "8b"
    stale_mobile_tier = "eliza-1-1_" + "7b"
    stale_long_context_tier = "27B-" + "1M"
    assert stale_small_tier not in spec.card
    assert stale_qwen_small_tier not in spec.card
    assert stale_mobile_tier not in spec.card
    assert stale_long_context_tier not in spec.card

    sb = publish_dataset._spec_scambench()
    assert "cc-by-sa-4.0" in sb.card.lower()

    syn = publish_dataset._spec_synthesized()
    assert "cc-by-4.0" in syn.card.lower()
    assert "claude" in syn.card.lower()


# ---------------------------------------------------------------------------
# unified eliza-1 publisher dispatcher (publish/publish_model.py)
# ---------------------------------------------------------------------------


@pytest.fixture
def publish_model():
    return _load("publish_model", SCRIPTS / "publish" / "publish_model.py")


def test_publish_model_dispatches_bundle_mode(publish_model, monkeypatch):
    calls = []
    monkeypatch.setattr(publish_model, "_run", lambda cmd: calls.append(cmd) or 0)

    rc = publish_model.main(["--mode", "bundle", "--tier", "2b"])

    assert rc == 0
    assert calls == [
        [
            sys.executable,
            "-m",
            "scripts.publish.orchestrator",
            "--tier",
            "2b",
        ]
    ]


def test_publish_model_dispatches_tier_mode(publish_model, monkeypatch):
    calls = []
    monkeypatch.setattr(publish_model, "_run", lambda cmd: calls.append(cmd) or 0)

    rc = publish_model.main(["--mode", "tier", "--tier", "2b"])

    assert rc == 0
    assert calls == [
        [
            sys.executable,
            "-m",
            "scripts.publish.publish_eliza1_model_repo",
            "--tier",
            "2b",
        ]
    ]


def test_publish_model_rejects_retired_optimized_mode(publish_model):
    with pytest.raises(SystemExit):
        publish_model.main(["--mode", "optimized"])


# ---------------------------------------------------------------------------
# elizaos catalog sync (sync_catalog_from_hf.py)
# ---------------------------------------------------------------------------


@pytest.fixture
def sync_catalog():
    return _load("sync_catalog_from_hf", SCRIPTS / "sync_catalog_from_hf.py")


def test_sync_catalog_writes_diff(sync_catalog, tmp_path, monkeypatch):
    """The diff format is { version, generatedAt, org, entries[] }."""
    out = tmp_path / "diff.json"
    entries = [
        sync_catalog.CatalogEntry(
            id="gemma4-e4b-optimized",
            hf_repo="elizaos/eliza-1",
            gguf_file="gemma4-e4b-optimized.gguf",
            sha256="a" * 64,
            size_bytes=1234567,
            manifest={"version": 1, "kind": "eliza-1-optimized"},
            bundle_manifest_file="eliza-1.manifest.json",
            bundle_manifest_sha256="b" * 64,
            bundle_size_bytes=2345678,
        ),
    ]
    sync_catalog.write_diff(entries, out, org="elizaos")
    import json as _json

    payload = _json.loads(out.read_text())
    assert payload["version"] == 1
    assert payload["org"] == "elizaos"
    assert len(payload["entries"]) == 1
    e = payload["entries"][0]
    assert e["id"] == "gemma4-e4b-optimized"
    assert e["hfRepo"] == "elizaos/eliza-1"
    assert e["sha256"] == "a" * 64
    assert e["sizeBytes"] == 1234567
    assert e["bundleManifestFile"] == "eliza-1.manifest.json"
    assert e["bundleManifestSha256"] == "b" * 64
    assert e["bundleSizeBytes"] == 2345678
    assert e["manifest"]["kind"] == "eliza-1-optimized"


def test_sync_catalog_main_defaults_to_elizaos(sync_catalog, tmp_path, monkeypatch):
    out = tmp_path / "diff.json"
    calls: dict[str, object] = {}

    def fake_collect_entries(**kwargs):
        calls["collect"] = kwargs
        return []

    def fake_write_diff(entries, out_path, *, org):
        calls["write"] = {"entries": entries, "out_path": out_path, "org": org}

    monkeypatch.setattr(sync_catalog, "collect_entries", fake_collect_entries)
    monkeypatch.setattr(sync_catalog, "write_diff", fake_write_diff)

    rc = sync_catalog.main(["--out", str(out)])

    assert rc == 0
    assert calls["collect"] == {
        "org": "elizaos",
        "filter_prefix": "eliza-1-",
        "filter_suffix": None,
    }
    assert calls["write"] == {"entries": [], "out_path": out, "org": "elizaos"}


def test_sync_catalog_selects_manifest_text_file(sync_catalog):
    manifest = {
        "files": {
            "text": [
                {"path": "text/eliza-1-4b-32k.gguf", "sha256": "a" * 64, "ctx": 32768},
                {"path": "text/eliza-1-4b-64k.gguf", "sha256": "b" * 64, "ctx": 65536},
            ],
            "mtp": [{"path": "mtp/drafter-4b.gguf", "sha256": "c" * 64}],
        },
    }
    file_index = {
        "text/eliza-1-4b-32k.gguf": ("a" * 64, 100),
        "text/eliza-1-4b-64k.gguf": ("b" * 64, 200),
        "mtp/drafter-4b.gguf": ("c" * 64, 50),
    }

    selected = sync_catalog._primary_text_file_from_manifest(
        manifest,
        file_index,
        "elizaos/eliza-1-4b",
    )
    bundle_size = sync_catalog._bundle_size_from_manifest(manifest, file_index)

    assert selected == ("text/eliza-1-4b-64k.gguf", "b" * 64, 200)
    assert bundle_size == 350


def test_sync_catalog_selects_single_repo_bundle_paths(sync_catalog):
    manifest = {
        "id": "eliza-1-9b",
        "files": {
            "text": [
                {"path": "text/eliza-1-9b-64k.gguf", "sha256": "d" * 64, "ctx": 65536},
            ],
            "mtp": [{"path": "mtp/drafter-9b.gguf", "sha256": "e" * 64}],
        },
    }
    file_index = {
        "bundles/9b/text/eliza-1-9b-64k.gguf": ("d" * 64, 900),
        "bundles/9b/mtp/drafter-9b.gguf": ("e" * 64, 90),
    }

    selected = sync_catalog._primary_text_file_from_manifest(
        manifest,
        file_index,
        "elizaos/eliza-1",
        "bundles/9b",
    )
    bundle_size = sync_catalog._bundle_size_from_manifest(
        manifest,
        file_index,
        "bundles/9b",
    )

    assert selected == ("text/eliza-1-9b-64k.gguf", "d" * 64, 900)
    assert bundle_size == 990
