from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.eagle3 import capture_features, prepare_distill_dataset, train_eagle3_drafter


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_prepare_synthetic_writes_dataset_and_manifest(tmp_path: Path) -> None:
    out_dir = tmp_path / "dataset"

    code = prepare_distill_dataset.main(
        [
            "--tier",
            "0_8b",
            "--synthetic-smoke",
            "--synthetic-samples",
            "3",
            "--out-dir",
            str(out_dir),
        ]
    )

    assert code == 0
    records_path = out_dir / "eagle3_distill.jsonl"
    manifest_path = out_dir / "dataset.manifest.json"
    assert records_path.exists()
    assert manifest_path.exists()
    records = [
        json.loads(line)
        for line in records_path.read_text(encoding="utf-8").splitlines()
    ]
    manifest = _read_json(manifest_path)
    assert len(records) == 3
    assert records[0]["id"] == "eagle3-synthetic-0_8b-00000"
    assert manifest["kind"] == "eagle3-distill-dataset"
    assert manifest["pipeline"] == "eagle3"
    assert manifest["stage"] == "prepare-distill-dataset"
    assert manifest["synthetic"] is True
    assert manifest["dryRun"] is False
    assert manifest["examples"] == 3
    assert manifest["records"]["path"] == str(records_path)


def test_capture_synthetic_writes_feature_index_and_manifest(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "dataset"
    features_dir = tmp_path / "features"
    assert (
        prepare_distill_dataset.main(
            [
                "--tier",
                "0_8b",
                "--synthetic-smoke",
                "--synthetic-samples",
                "2",
                "--out-dir",
                str(dataset_dir),
            ]
        )
        == 0
    )

    code = capture_features.main(
        [
            "--tier",
            "0_8b",
            "--synthetic-smoke",
            "--dataset",
            str(dataset_dir / "eagle3_distill.jsonl"),
            "--out-dir",
            str(features_dir),
        ]
    )

    assert code == 0
    feature_index_path = features_dir / "features.index.jsonl"
    manifest = _read_json(features_dir / "features.manifest.json")
    feature_rows = [
        json.loads(line)
        for line in feature_index_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(feature_rows) == 2
    assert feature_rows[0]["feature_file"] is None
    assert manifest["kind"] == "eagle3-feature-capture"
    assert manifest["dataset"]["examples"] == 2
    assert manifest["featureIndex"]["path"] == str(feature_index_path)


def test_train_synthetic_writes_manifest_config_but_no_gguf(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "dataset"
    features_dir = tmp_path / "features"
    train_dir = tmp_path / "train"
    assert (
        prepare_distill_dataset.main(
            [
                "--tier",
                "0_8b",
                "--synthetic-smoke",
                "--out-dir",
                str(dataset_dir),
            ]
        )
        == 0
    )
    assert (
        capture_features.main(
            [
                "--tier",
                "0_8b",
                "--synthetic-smoke",
                "--dataset",
                str(dataset_dir / "eagle3_distill.jsonl"),
                "--out-dir",
                str(features_dir),
            ]
        )
        == 0
    )

    code = train_eagle3_drafter.main(
        [
            "--tier",
            "0_8b",
            "--synthetic-smoke",
            "--features-manifest",
            str(features_dir / "features.manifest.json"),
            "--out-dir",
            str(train_dir),
        ]
    )

    assert code == 0
    manifest = _read_json(train_dir / "eagle3-drafter.manifest.json")
    assert manifest["kind"] == "eagle3-drafter-training"
    assert manifest["synthetic"] is True
    assert manifest["artifacts"]["config"].endswith("eagle3-drafter.config.json")
    assert manifest["artifacts"]["pytorchModel"] is None
    assert manifest["artifacts"]["nativeGguf"] is None
    assert _read_json(Path(manifest["artifacts"]["config"]))["syntheticFixture"] is True
    assert not list(train_dir.glob("*.gguf"))


def test_train_real_path_writes_pytorch_artifact(tmp_path: Path) -> None:
    torch = pytest.importorskip("torch")
    features_dir = tmp_path / "features"
    tensor_dir = features_dir / "features"
    tensor_dir.mkdir(parents=True)
    feature_file = tensor_dir / "row-0.pt"
    torch.save(
        {
            "hidden": torch.randn(3, 4),
            "logits": torch.randn(3, 8),
            "labels": torch.tensor([2, 3], dtype=torch.long),
        },
        feature_file,
    )
    feature_index = features_dir / "features.index.jsonl"
    feature_index.write_text(
        json.dumps(
            {
                "id": "row-0",
                "feature_file": str(feature_file),
                "hidden_state_shape": [3, 4],
                "logits_shape": [3, 8],
                "labels_shape": [2],
                "synthetic": False,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    features_manifest = features_dir / "features.manifest.json"
    features_manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "eagle3-feature-capture",
                "pipeline": "eagle3",
                "stage": "capture-features",
                "tier": "0_8b",
                "dataset": {"examples": 1},
                "featureIndex": {"path": str(feature_index)},
            }
        ),
        encoding="utf-8",
    )

    train_dir = tmp_path / "train"
    code = train_eagle3_drafter.main(
        [
            "--tier",
            "0_8b",
            "--features-manifest",
            str(features_manifest),
            "--out-dir",
            str(train_dir),
            "--epochs",
            "1",
            "--grad-accum",
            "1",
        ]
    )

    assert code == 0
    manifest = _read_json(train_dir / "eagle3-drafter.manifest.json")
    assert Path(manifest["artifacts"]["pytorchModel"]).is_file()
    assert _read_json(Path(manifest["artifacts"]["config"]))["trainable"] is True
    assert manifest["nativeGgufConversion"]["available"] is False


def test_prepare_real_path_requires_transformers_after_input_validation(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    target = tmp_path / "target"
    target.mkdir()
    source = tmp_path / "source.jsonl"
    source.write_text('{"prompt":"hello","response":"world"}\n', encoding="utf-8")
    monkeypatch.setattr(prepare_distill_dataset, "require_module", lambda *_args: None)

    code = prepare_distill_dataset.main(
        [
            "--tier",
            "0_8b",
            "--target-checkpoint",
            str(target),
            "--source-jsonl",
            str(source),
            "--out-dir",
            str(tmp_path / "out"),
        ]
    )

    assert code == 4
    assert "required" not in caplog.text


def test_train_native_gguf_conversion_requires_converter(tmp_path: Path) -> None:
    torch = pytest.importorskip("torch")
    features_dir = tmp_path / "features"
    feature_file = tmp_path / "row-0.pt"
    torch.save(
        {
            "hidden": torch.randn(2, 4),
            "logits": torch.randn(2, 8),
            "labels": torch.tensor([1], dtype=torch.long),
        },
        feature_file,
    )
    feature_index = features_dir / "features.index.jsonl"
    feature_index.parent.mkdir(parents=True)
    feature_index.write_text(
        json.dumps({"id": "row-0", "feature_file": str(feature_file)}) + "\n",
        encoding="utf-8",
    )
    features_manifest = tmp_path / "features.manifest.json"
    features_manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "eagle3-feature-capture",
                "pipeline": "eagle3",
                "stage": "capture-features",
                "tier": "0_8b",
                "dataset": {"examples": 1},
                "featureIndex": {"path": str(feature_index)},
            }
        ),
        encoding="utf-8",
    )

    code = train_eagle3_drafter.main(
        [
            "--tier",
            "0_8b",
            "--features-manifest",
            str(features_manifest),
            "--out-dir",
            str(tmp_path / "train"),
            "--convert-native-gguf",
        ]
    )

    assert code == 2
    assert not list((tmp_path / "train").glob("*.gguf"))
