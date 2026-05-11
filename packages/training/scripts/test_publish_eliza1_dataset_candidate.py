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


def chat_row() -> dict:
    return {
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
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
