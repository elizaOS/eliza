from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent


def _load():
    path = SCRIPTS / "publish_eliza1_dataset_candidate.py"
    spec = importlib.util.spec_from_file_location("publish_eliza1_dataset_candidate", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["publish_eliza1_dataset_candidate"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def publisher():
    return _load()


def native_row(call_id: str) -> dict:
    return {
        "format": "eliza_native_v1",
        "schemaVersion": 1,
        "boundary": "vercel_ai_sdk.generateText",
        "callId": call_id,
        "request": {"messages": [{"role": "user", "content": "hello"}]},
        "response": {"text": "hi"},
        "metadata": {"task_type": "reply", "source_dataset": "unit"},
        "provider": "dev-provider",
    }


def native_repair_row(call_id: str) -> dict:
    row = native_row(call_id)
    row["metadata"] = {
        **row["metadata"],
        "split": "repair_eval",
        "quality": {"success": False, "requiresRepair": True, "rating": "repair"},
    }
    return row


def chat_row() -> dict:
    return {
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
    }


def public_eliza_record_row(metadata_split: str = "train") -> dict:
    return {
        "roomName": "unit-room",
        "agentId": "agent",
        "memoryEntries": [
            {
                "role": "user",
                "speaker": "user",
                "content": "previous turn",
                "channel": "dm",
            }
        ],
        "currentMessage": {
            "role": "user",
            "speaker": "user",
            "content": "hello",
            "channel": "dm",
        },
        "expectedResponse": "hi",
        "availableActions": ["REPLY"],
        "metadata": {
            "task_type": "agent_trace",
            "source_dataset": "agent-trove",
            "license": "unknown",
            "split": metadata_split,
        },
    }


def eliza1_trajectory_record(split: str, *, success: bool = True) -> dict:
    rating = "gold" if success else "repair"
    return {
        "schema": "eliza.eliza1_trajectory_record.v1",
        "id": f"{split}-record-0001",
        "split": split,
        "task": "lifeops_trajectory_turn",
        "target": {
            "modelFamily": "qwen",
            "baseModel": "Qwen3.5/3.6",
            "sftFormat": "messages",
            "chatTemplate": "chatml",
        },
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ],
        "tools": [],
        "actions": [],
        "quality": {
            "success": success,
            "score": 1.0 if success else 0.0,
            "weight": 1.0 if success else 0.0,
            "rating": rating,
            "requiresRepair": not success,
            "reasons": [],
        },
        "source": {
            "kind": "eliza_native_v1",
            "dataset": "unit",
            "path": "unit.jsonl",
            "rowIndex": 0,
            "sourceId": "source-1",
            "trajectoryId": "traj-1",
            "scenarioId": None,
            "turnIndex": None,
            "format": "eliza_native_v1",
        },
        "metadata": {},
    }


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def make_native_splits(tmp_path: Path) -> tuple[Path, Path, Path]:
    train = tmp_path / "train.jsonl"
    validation = tmp_path / "validation.jsonl"
    test = tmp_path / "test.jsonl"
    write_jsonl(train, [native_row("train-1")])
    write_jsonl(validation, [native_row("validation-1")])
    write_jsonl(test, [native_row("test-1")])
    return train, validation, test


def privacy_attestation(*, source_kind: str = "user_export", version: int = 1) -> dict:
    return {
        "schema": "eliza.privacy_filter_attestation.v1",
        "version": version,
        "sourceKind": source_kind,
        "source": {"kind": source_kind, "realUserExport": source_kind == "user_export"},
        "privacy": {
            "reviewed": True,
            "realUserExport": source_kind == "user_export",
            "attestationType": "privacy_filter",
        },
        "passed": True,
        "strict": True,
        "input_count": 3,
        "output_count": 3,
        "redaction_count": 2,
        "backend_skipped_too_long": 0,
        "gate": {
            "passed": True,
            "strict": True,
            "sourceKind": source_kind,
            "input_count": 3,
            "output_count": 3,
            "redaction_count": 2,
            "invalid_json": 0,
            "backend_failures": 0,
            "backend_skipped_too_long": 0,
            "residual_findings": {"count": 0},
            "residual_findings_count": 0,
        },
        "artifacts": {
            "redacted_jsonl": {"path": "redacted.jsonl", "sha256": "a" * 64, "rows": 3},
            "ledger_jsonl": {
                "path": "ledger.jsonl",
                "sha256": "b" * 64,
                "entries": 2,
                "raw_sensitive_values": False,
            },
            "stats_json": {"path": "stats.json", "sha256": "c" * 64},
        },
    }


def test_plan_refuses_mixed_split_schemas(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    write_jsonl(validation, [chat_row()])

    with pytest.raises(publisher.CandidateError, match="mixed split schemas"):
        publisher.build_plan(
            candidate_id="unit-candidate",
            train=train,
            validation=validation,
            test=test,
            source_kind="synthetic",
            privacy_reviewed=False,
            candidate_root=tmp_path / "candidates",
            generated_at="2026-05-11T00:00:00Z",
        )


def test_plan_refuses_mixed_schema_inside_one_file(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    write_jsonl(train, [native_row("train-1"), chat_row()])

    with pytest.raises(publisher.CandidateError, match="mixed schemas inside one split"):
        publisher.build_plan(
            candidate_id="unit-candidate",
            train=train,
            validation=validation,
            test=test,
            source_kind="synthetic",
            privacy_reviewed=False,
            candidate_root=tmp_path / "candidates",
            generated_at="2026-05-11T00:00:00Z",
        )


def test_plan_accepts_trainable_eliza1_trajectory_record_splits(publisher, tmp_path):
    train = tmp_path / "train.jsonl"
    validation = tmp_path / "validation.jsonl"
    test = tmp_path / "test.jsonl"
    write_jsonl(train, [eliza1_trajectory_record("train")])
    write_jsonl(validation, [eliza1_trajectory_record("val")])
    write_jsonl(test, [eliza1_trajectory_record("test")])

    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="synthetic",
        privacy_reviewed=False,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )

    assert plan.dataset_schema == "eliza.eliza1_trajectory_record.v1"
    assert plan.manifest["contract"]["trainLocalReady"] is True


def test_plan_accepts_public_eliza1_training_shape_with_source_split_labels(
    publisher, tmp_path
):
    train = tmp_path / "train.jsonl"
    validation = tmp_path / "validation.jsonl"
    test = tmp_path / "test.jsonl"
    write_jsonl(train, [public_eliza_record_row("train")])
    write_jsonl(validation, [public_eliza_record_row("train")])
    write_jsonl(test, [public_eliza_record_row("train")])

    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="public",
        privacy_reviewed=False,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )

    assert plan.dataset_schema == "eliza_record_v1"
    compatibility = plan.manifest["contract"]["publicDatasetCompatibility"]
    assert compatibility["repoId"] == "elizaos/eliza-1-training"
    assert compatibility["compatible"] is True
    assert compatibility["columns"] == [
        "roomName",
        "agentId",
        "memoryEntries",
        "currentMessage",
        "expectedResponse",
        "availableActions",
        "metadata",
    ]
    assert plan.manifest["contract"]["trainLocalReady"] is True


def test_plan_refuses_chat_messages_without_final_assistant(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    write_jsonl(
        train,
        [{"messages": [{"role": "user", "content": "hello"}]}],
    )

    with pytest.raises(publisher.CandidateError, match="final message must be assistant"):
        publisher.build_plan(
            candidate_id="unit-candidate",
            train=train,
            validation=validation,
            test=test,
            source_kind="synthetic",
            privacy_reviewed=False,
            candidate_root=tmp_path / "candidates",
            generated_at="2026-05-11T00:00:00Z",
        )


def test_plan_refuses_repair_eval_in_trainable_split(publisher, tmp_path):
    train = tmp_path / "train.jsonl"
    validation = tmp_path / "validation.jsonl"
    test = tmp_path / "test.jsonl"
    write_jsonl(train, [eliza1_trajectory_record("repair_eval", success=False)])
    write_jsonl(validation, [eliza1_trajectory_record("val")])
    write_jsonl(test, [eliza1_trajectory_record("test")])

    with pytest.raises(publisher.CandidateError, match="auxiliary trajectory/repair"):
        publisher.build_plan(
            candidate_id="unit-candidate",
            train=train,
            validation=validation,
            test=test,
            source_kind="synthetic",
            privacy_reviewed=False,
            candidate_root=tmp_path / "candidates",
            generated_at="2026-05-11T00:00:00Z",
        )


def test_plan_refuses_native_repair_record_in_trainable_split(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    write_jsonl(train, [native_repair_row("repair-1")])

    with pytest.raises(publisher.CandidateError, match="auxiliary trajectory/repair"):
        publisher.build_plan(
            candidate_id="unit-candidate",
            train=train,
            validation=validation,
            test=test,
            source_kind="synthetic",
            privacy_reviewed=False,
            candidate_root=tmp_path / "candidates",
            generated_at="2026-05-11T00:00:00Z",
        )


def test_dry_run_main_writes_nothing(publisher, tmp_path, monkeypatch, capsys):
    train, validation, test = make_native_splits(tmp_path)
    candidate_root = tmp_path / "candidates"
    monkeypatch.setattr(publisher, "DEFAULT_CANDIDATE_ROOT", candidate_root)

    rc = publisher.main(
        [
            "--candidate-id",
            "unit-candidate",
            "--source-kind",
            "synthetic",
            "--train",
            str(train),
            "--validation",
            str(validation),
            "--test",
            str(test),
        ]
    )

    assert rc == 0
    assert "dry-run" in capsys.readouterr().out
    assert not candidate_root.exists()


def test_push_preflight_refuses_without_writing_candidate_files(
    publisher, tmp_path, monkeypatch
):
    train, validation, test = make_native_splits(tmp_path)
    candidate_root = tmp_path / "candidates"
    monkeypatch.setattr(publisher, "DEFAULT_CANDIDATE_ROOT", candidate_root)

    rc = publisher.main(
        [
            "--candidate-id",
            "unit-candidate",
            "--source-kind",
            "synthetic",
            "--train",
            str(train),
            "--validation",
            str(validation),
            "--test",
            str(test),
            "--write",
            "--push",
        ]
    )

    assert rc == 2
    assert not candidate_root.exists()


def test_write_outputs_only_candidate_files(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="synthetic",
        privacy_reviewed=False,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )

    publisher.write_candidate(plan)

    paths = {
        path.relative_to(plan.candidate_dir).as_posix()
        for path in plan.candidate_dir.rglob("*")
        if path.is_file()
    }
    assert paths == {
        "README.md",
        "manifest.json",
        "data/train.jsonl",
        "data/validation.jsonl",
        "data/test.jsonl",
    }
    manifest = json.loads((plan.candidate_dir / "manifest.json").read_text())
    assert manifest["datasetSchema"] == "eliza_native_v1"
    assert manifest["contract"]["trainingReadySchema"] == "eliza_native_v1"
    assert manifest["contract"]["trainLocalReady"] is True
    assert manifest["contract"]["publicDatasetCompatibility"]["compatible"] is False
    assert manifest["contract"]["devProvidersPinned"] is False
    assert manifest["contract"]["opus47"] == "prepared_not_run"


def test_user_export_write_requires_privacy_review(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="user_export",
        privacy_reviewed=False,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )

    with pytest.raises(publisher.CandidateError, match="without --privacy-reviewed"):
        publisher.write_candidate(plan)


def test_source_manifest_hands_off_user_export_privacy_review(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    source_manifest = tmp_path / "source-manifest.json"
    source_manifest.write_text(
        json.dumps({"sourceKind": "user_export", "privacy": {"reviewed": True}}),
        encoding="utf-8",
    )

    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="user_export",
        privacy_reviewed=False,
        source_manifest=source_manifest,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )
    publisher.write_candidate(plan)

    manifest = json.loads((plan.candidate_dir / "manifest.json").read_text())
    assert manifest["privacy"]["reviewed"] is True
    assert manifest["privacy"]["attestationSource"] == "source_manifest"
    assert manifest["sourceManifest"]["sha256"] == publisher._sha256_file(source_manifest)
    assert manifest["sourceManifest"]["realUserExport"] is True
    assert manifest["sourceManifest"]["path"] == "source-manifest.json"
    assert manifest["sourceManifest"]["pathRef"].startswith("sha256:")
    assert manifest["sourceManifest"]["privacy"]["reviewed"] is True
    assert str(tmp_path) not in json.dumps(manifest["sourceManifest"])


def test_privacy_filter_attestation_hands_off_user_export_review(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    source_manifest = tmp_path / "privacy-attestation.json"
    source_manifest.write_text(
        json.dumps(privacy_attestation()),
        encoding="utf-8",
    )

    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="user_export",
        privacy_reviewed=False,
        source_manifest=source_manifest,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )
    publisher.write_candidate(plan)

    manifest = json.loads((plan.candidate_dir / "manifest.json").read_text())
    assert manifest["privacy"]["reviewed"] is True
    assert manifest["privacy"]["attestationSource"] == "source_manifest"
    assert manifest["sourceManifest"]["version"] == 1
    assert manifest["sourceManifest"]["sourceKind"] == "user_export"
    assert manifest["sourceManifest"]["realUserExport"] is True
    assert manifest["sourceManifest"]["privacy"]["attestationVersion"] == 1
    assert manifest["sourceManifest"]["privacy"]["artifacts"]["ledger_jsonl"] == {
        "sha256": "b" * 64,
        "entries": 2,
        "raw_sensitive_values": False,
    }


def test_privacy_filter_attestation_requires_v1_gate_schema(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    source_manifest = tmp_path / "privacy-attestation.json"
    bad_attestation = privacy_attestation(version=2)
    source_manifest.write_text(json.dumps(bad_attestation), encoding="utf-8")

    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="user_export",
        privacy_reviewed=False,
        source_manifest=source_manifest,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )

    assert plan.privacy_reviewed is False
    with pytest.raises(publisher.CandidateError, match="without --privacy-reviewed"):
        publisher.write_candidate(plan)


def test_non_user_attestation_does_not_review_user_export(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    source_manifest = tmp_path / "privacy-attestation.json"
    source_manifest.write_text(
        json.dumps(privacy_attestation(source_kind="synthetic")),
        encoding="utf-8",
    )

    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="user_export",
        privacy_reviewed=False,
        source_manifest=source_manifest,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )

    assert plan.privacy_reviewed is False
    assert plan.manifest["privacy"]["attestationSource"] is None
    with pytest.raises(publisher.CandidateError, match="without --privacy-reviewed"):
        publisher.write_candidate(plan)


def test_privacy_filter_attestation_blocks_source_kind_downgrade(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    source_manifest = tmp_path / "privacy-attestation.json"
    source_manifest.write_text(json.dumps(privacy_attestation()), encoding="utf-8")

    with pytest.raises(publisher.CandidateError, match="source manifest marks"):
        publisher.build_plan(
            candidate_id="unit-candidate",
            train=train,
            validation=validation,
            test=test,
            source_kind="synthetic",
            privacy_reviewed=False,
            source_manifest=source_manifest,
            candidate_root=tmp_path / "candidates",
            generated_at="2026-05-11T00:00:00Z",
        )


def test_split_record_user_export_marker_blocks_downgrade(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    row = native_row("train-1")
    row["metadata"]["sourceKind"] = "user_export"
    write_jsonl(train, [row])

    with pytest.raises(publisher.CandidateError, match="split records mark"):
        publisher.build_plan(
            candidate_id="unit-candidate",
            train=train,
            validation=validation,
            test=test,
            source_kind="synthetic",
            privacy_reviewed=False,
            candidate_root=tmp_path / "candidates",
            generated_at="2026-05-11T00:00:00Z",
        )

    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="user_export",
        privacy_reviewed=True,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )
    assert plan.manifest["splits"]["train"]["realUserExport"] is True
    assert plan.manifest["privacy"]["realUserExport"] is True


def test_source_manifest_user_export_requires_privacy_attestation(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    source_manifest = tmp_path / "source-manifest.json"
    source_manifest.write_text(
        json.dumps({"sourceKind": "user_export", "privacy": {"reviewed": False}}),
        encoding="utf-8",
    )

    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="user_export",
        privacy_reviewed=False,
        source_manifest=source_manifest,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )

    with pytest.raises(publisher.CandidateError, match="without --privacy-reviewed"):
        publisher.write_candidate(plan)


def test_source_manifest_user_export_blocks_source_kind_downgrade(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    source_manifest = tmp_path / "source-manifest.json"
    source_manifest.write_text(
        json.dumps({"sourceKind": "user_export", "privacy": {"reviewed": True}}),
        encoding="utf-8",
    )

    with pytest.raises(publisher.CandidateError, match="source manifest marks"):
        publisher.build_plan(
            candidate_id="unit-candidate",
            train=train,
            validation=validation,
            test=test,
            source_kind="synthetic",
            privacy_reviewed=False,
            source_manifest=source_manifest,
            candidate_root=tmp_path / "candidates",
            generated_at="2026-05-11T00:00:00Z",
        )


def test_write_allows_restaging_from_candidate_files(publisher, tmp_path):
    train, validation, test = make_native_splits(tmp_path)
    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="synthetic",
        privacy_reviewed=False,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )
    publisher.write_candidate(plan)

    restage = publisher.build_plan(
        candidate_id="unit-candidate",
        train=plan.candidate_dir / "data/train.jsonl",
        validation=plan.candidate_dir / "data/validation.jsonl",
        test=plan.candidate_dir / "data/test.jsonl",
        source_kind="synthetic",
        privacy_reviewed=False,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )

    publisher.write_candidate(restage)
    assert (plan.candidate_dir / "README.md").exists()


def test_user_export_push_requires_extra_opt_in(publisher, tmp_path, monkeypatch):
    train, validation, test = make_native_splits(tmp_path)
    plan = publisher.build_plan(
        candidate_id="unit-candidate",
        train=train,
        validation=validation,
        test=test,
        source_kind="user_export",
        privacy_reviewed=True,
        candidate_root=tmp_path / "candidates",
        generated_at="2026-05-11T00:00:00Z",
    )
    publisher.write_candidate(plan)
    monkeypatch.setenv("HF_TOKEN", "hf_fake")

    with pytest.raises(publisher.CandidateError, match="without --allow-user-export-push"):
        publisher.push_candidate(
            plan,
            allow_hf_push=True,
            allow_user_export_push=False,
            public=False,
        )
