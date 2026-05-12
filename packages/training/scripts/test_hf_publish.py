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
    assert len(train_src) == 1, f"expected one of train.jsonl|train_final.jsonl, got {names}"
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


def test_hf_load_preflight_accepts_matching_candidate_splits(
    publish_dataset, tmp_path
):
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
    allowed_subs = {"action_examples", "action_pairs", "core_prompts"}
    for f in spec.files:
        rel = f.relative_to(ROOT)
        # data/synthesized/<sub>/<file>.jsonl
        assert len(rel.parts) >= 4, rel
        assert rel.parts[0] == "data" and rel.parts[1] == "synthesized"
        assert rel.parts[2] in allowed_subs, f"unexpected synthesized subdir: {rel.parts[2]}"
        assert f.suffix == ".jsonl"


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

    files = publish_pipeline._collect_top_level_docs() + publish_pipeline._walk_scripts()
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
        rc = publish_pipeline._print_dry_run(files, "elizaos/eliza-1-pipeline")
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
    rc = publish_pipeline.publish(fake_files, "elizaos/eliza-1-pipeline", public=True)
    assert rc == 1


def test_pipeline_card_mentions_companion_repos(publish_pipeline):
    card = publish_pipeline.build_pipeline_card("elizaos/eliza-1-pipeline")
    assert "elizaos/eliza-1-training" in card
    assert "elizaos/eliza-1-pipeline" in card
    assert "uv sync --extra train" in card
    # Vast bootstrap instructions present
    assert "hf download" in card


def test_dataset_card_includes_license(publish_dataset):
    spec = publish_dataset._spec_training()
    assert "license: cc-by-4.0" in spec.card.lower()
    assert "manifest.json" in spec.card
    assert "eliza-1-0_8b" in spec.card
    assert "eliza-1-2b" in spec.card
    assert "0.8B-27B" in spec.card
    stale_small_tier = "eliza-1-0_" + "6b"
    stale_mobile_tier = "eliza-1-1_" + "7b"
    assert stale_small_tier not in spec.card
    assert stale_mobile_tier not in spec.card

    sb = publish_dataset._spec_scambench()
    assert "cc-by-sa-4.0" in sb.card.lower()

    syn = publish_dataset._spec_synthesized()
    assert "cc-by-4.0" in syn.card.lower()
    assert "claude" in syn.card.lower()


# ---------------------------------------------------------------------------
# elizaos publisher (publish_eliza1_model.py)
# ---------------------------------------------------------------------------


@pytest.fixture
def publish_eliza1():
    return _load("publish_eliza1_model", SCRIPTS / "publish_eliza1_model.py")


def _make_fused_gguf(path: Path) -> None:
    """Write a tiny file that carries the required fused-kernel markers.

    The publisher only scans the first 4 MB and the trailing 1 MB for
    the marker strings; a few KB is enough to drive the validation path
    in tests without producing an actual llama.cpp-loadable GGUF.
    """
    path.write_bytes(
        b"GGUF\x03\x00\x00\x00"
        + b"\x00" * 64
        + b"tensor_type: q4_polar block_type qjl1_256\n"
        + b"\x00" * 1024,
    )


def _make_stock_gguf(path: Path) -> None:
    path.write_bytes(
        b"GGUF\x03\x00\x00\x00"
        + b"\x00" * 64
        + b"tensor_type: q4_K_M block_type q4_k\n"
        + b"\x00" * 1024,
    )


def _make_eliza1_bundle(model_dir: Path, *, fused: bool, kind: str = "eliza-1-optimized") -> None:
    model_dir.mkdir(parents=True, exist_ok=True)
    gguf = model_dir / f"{model_dir.name}.gguf"
    (_make_fused_gguf if fused else _make_stock_gguf)(gguf)
    manifest = {
        "version": 1,
        "kind": kind,
        "modelId": "qwen3.5-4b",
        "base": {
            "name": "qwen3.5-4b",
            "displayName": "Qwen3.5 4B",
            "params": "4B",
            "tokenizerFamily": "qwen3",
            "contextLength": 131072,
        },
        "gguf": {
            "file": gguf.name,
            "sha256": None,
            "sizeBytes": 0,
            "quant": "Q4_POLAR + QJL1_256 K + TBQ4_0 V",
        },
        "optimization": {
            "weights": "Q4_POLAR",
            "kvK": "QJL1_256",
            "kvV": "TBQ4_0",
            "speculativeDecode": "DFlash",
            "kernels": ["q4_polar", "qjl1_256", "tbq3_0", "tbq4_0", "dflash"],
            "requiresFork": "elizaOS/llama.cpp@v1.0.0-eliza",
        },
        "pipeline": {
            "publishedAt": "2026-05-10T00:00:00Z",
            "trainedFrom": "Qwen/Qwen3.5-4B",
            "trainingPipeline": "elizaos/eliza-1-pipeline",
            "buildScript": "packages/training/scripts/publish_eliza1_model.py",
        },
    }
    import json as _json
    (model_dir / "manifest.json").write_text(_json.dumps(manifest, indent=2))
    (model_dir / "README.md").write_text("# placeholder\n")


def test_eliza1_dry_run_accepts_fused_gguf(publish_eliza1, tmp_path, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)
    bundle = tmp_path / "qwen3.5-4b-optimized"
    _make_eliza1_bundle(bundle, fused=True)

    rc = publish_eliza1.main([
        "--model-dir", str(bundle),
        "--repo-id", "elizaos/qwen3.5-4b-optimized",
        "--dry-run",
    ])
    assert rc == 0


def test_eliza1_refuses_stock_gguf(publish_eliza1, tmp_path, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    bundle = tmp_path / "qwen3.5-4b-optimized"
    _make_eliza1_bundle(bundle, fused=False)

    with pytest.raises(SystemExit) as excinfo:
        publish_eliza1.main([
            "--model-dir", str(bundle),
            "--repo-id", "elizaos/qwen3.5-4b-optimized",
            "--dry-run",
        ])
    msg = str(excinfo.value)
    assert "q4_polar" in msg.lower() or "qjl1_256" in msg.lower()


def test_eliza1_refuses_non_elizaos_org(publish_eliza1, tmp_path):
    bundle = tmp_path / "qwen3.5-4b-optimized"
    _make_eliza1_bundle(bundle, fused=True)

    with pytest.raises(SystemExit) as excinfo:
        publish_eliza1.main([
            "--model-dir", str(bundle),
            "--repo-id", "someoneelse/qwen3.5-4b",
            "--dry-run",
        ])
    assert "elizaos" in str(excinfo.value)


def test_eliza1_refuses_zero_byte_gguf(publish_eliza1, tmp_path):
    bundle = tmp_path / "qwen3.5-4b-optimized"
    bundle.mkdir()
    (bundle / "qwen3.5-4b-optimized.gguf").touch()  # zero bytes
    (bundle / "manifest.json").write_text('{"version":1,"kind":"eliza-1-optimized","modelId":"x","base":{},"gguf":{},"optimization":{}}')
    (bundle / "README.md").write_text("# x")

    with pytest.raises(SystemExit) as excinfo:
        publish_eliza1.main([
            "--model-dir", str(bundle),
            "--repo-id", "elizaos/qwen3.5-4b-optimized",
            "--dry-run",
        ])
    assert "zero bytes" in str(excinfo.value)


def test_eliza1_publish_writes_published_sidecar(publish_eliza1, tmp_path, monkeypatch):
    """End-to-end: HfApi mocked, publisher writes published.json idempotency
    sidecar with the canonical resolve URL + sha256."""
    monkeypatch.setenv("HF_TOKEN", "hf_fake_token")
    bundle = tmp_path / "qwen3.5-4b-optimized"
    _make_eliza1_bundle(bundle, fused=True)

    fake_api = MagicMock()
    fake_api.repo_info.return_value = SimpleNamespace(siblings=[])

    with patch("huggingface_hub.HfApi", return_value=fake_api):
        rc = publish_eliza1.main([
            "--model-dir", str(bundle),
            "--repo-id", "elizaos/qwen3.5-4b-optimized",
        ])
    assert rc == 0

    sidecar = bundle / "published.json"
    assert sidecar.exists(), "published.json was not written"
    import json as _json
    data = _json.loads(sidecar.read_text())
    assert data["repoId"] == "elizaos/qwen3.5-4b-optimized"
    assert data["resolveUrl"].startswith(
        "https://huggingface.co/elizaos/qwen3.5-4b-optimized/resolve/main/"
    )
    assert data["ggufFile"] == "qwen3.5-4b-optimized.gguf"
    assert isinstance(data["sha256"], str) and len(data["sha256"]) == 64
    assert data["sizeBytes"] > 0

    # Atomic commit path: README + manifest + GGUF in one create_commit().
    assert fake_api.create_commit.call_count == 1
    ops = fake_api.create_commit.call_args.kwargs["operations"]
    op_paths = sorted(op.path_in_repo for op in ops)
    assert op_paths == [
        "README.md",
        "manifest.json",
        "qwen3.5-4b-optimized.gguf",
    ]


def test_eliza1_publish_skips_when_remote_sha_matches(publish_eliza1, tmp_path, monkeypatch):
    """If the remote LFS pointer's sha256 matches the local GGUF, the GGUF
    upload is skipped and only README + manifest get refreshed."""
    monkeypatch.setenv("HF_TOKEN", "hf_fake_token")
    bundle = tmp_path / "qwen3.5-4b-optimized"
    _make_eliza1_bundle(bundle, fused=True)
    gguf_path = bundle / "qwen3.5-4b-optimized.gguf"
    expected_sha = publish_eliza1._sha256_file(gguf_path)

    sibling = SimpleNamespace(
        rfilename="qwen3.5-4b-optimized.gguf",
        lfs={"sha256": expected_sha},
    )
    fake_api = MagicMock()
    fake_api.repo_info.side_effect = [
        SimpleNamespace(siblings=[sibling]),  # existence probe
        SimpleNamespace(siblings=[sibling]),  # _remote_sha256 probe
    ]

    with patch("huggingface_hub.HfApi", return_value=fake_api):
        rc = publish_eliza1.main([
            "--model-dir", str(bundle),
            "--repo-id", "elizaos/qwen3.5-4b-optimized",
        ])
    assert rc == 0

    ops = fake_api.create_commit.call_args.kwargs["operations"]
    op_paths = sorted(op.path_in_repo for op in ops)
    # GGUF is NOT in the operations list — sha matched.
    assert op_paths == ["README.md", "manifest.json"]


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
            id="qwen3.5-4b-optimized",
            hf_repo="elizaos/qwen3.5-4b-optimized",
            gguf_file="qwen3.5-4b-optimized.gguf",
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
    assert e["id"] == "qwen3.5-4b-optimized"
    assert e["hfRepo"] == "elizaos/qwen3.5-4b-optimized"
    assert e["sha256"] == "a" * 64
    assert e["sizeBytes"] == 1234567
    assert e["bundleManifestFile"] == "eliza-1.manifest.json"
    assert e["bundleManifestSha256"] == "b" * 64
    assert e["bundleSizeBytes"] == 2345678
    assert e["manifest"]["kind"] == "eliza-1-optimized"


def test_sync_catalog_selects_manifest_text_file(sync_catalog):
    manifest = {
        "files": {
            "text": [
                {"path": "text/eliza-1-9b-32k.gguf", "sha256": "a" * 64, "ctx": 32768},
                {"path": "text/eliza-1-9b-64k.gguf", "sha256": "b" * 64, "ctx": 65536},
            ],
            "dflash": [{"path": "dflash/drafter-9b.gguf", "sha256": "c" * 64}],
        },
    }
    file_index = {
        "text/eliza-1-9b-32k.gguf": ("a" * 64, 100),
        "text/eliza-1-9b-64k.gguf": ("b" * 64, 200),
        "dflash/drafter-9b.gguf": ("c" * 64, 50),
    }

    selected = sync_catalog._primary_text_file_from_manifest(
        manifest,
        file_index,
        "elizaos/eliza-1-9b",
    )
    bundle_size = sync_catalog._bundle_size_from_manifest(manifest, file_index)

    assert selected == ("text/eliza-1-9b-64k.gguf", "b" * 64, 200)
    assert bundle_size == 350
