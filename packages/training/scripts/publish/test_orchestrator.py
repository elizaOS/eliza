"""Tests for the Eliza-1 publish orchestrator.

Coverage map (matches the brief):

- (a) dry-run on a fixture bundle dir succeeds
- (b) missing license file fails (EXIT_MISSING_FILE)
- (c) failing eval gate causes orchestrator to exit non-zero (EXIT_EVAL_GATE_FAIL)
- (d) failing kernel verification fails (EXIT_KERNEL_VERIFY_FAIL)
- (e) manifest with red gate not flagged ``defaultEligible: true``
- (f) tags are emitted in dry-run mode (printed, not actually executed)
"""

from __future__ import annotations

import io
import json
import logging
import sys
from pathlib import Path
from typing import Any

import pytest

# Ensure the `scripts/` parent (training/) is importable as ``scripts``.
_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.publish.orchestrator import (  # noqa: E402
    EXIT_EVAL_GATE_FAIL,
    EXIT_KERNEL_VERIFY_FAIL,
    EXIT_MISSING_FILE,
    EXIT_OK,
    PublishContext,
    run,
)


# ---------------------------------------------------------------------------
# Fixture builder
# ---------------------------------------------------------------------------


def _write(p: Path, content: str | bytes) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, str):
        p.write_text(content)
    else:
        p.write_bytes(content)
    return p


def _passing_eval_blob(tier: str = "desktop-9b") -> dict[str, Any]:
    """Eval blob whose results pass every desktop-9b gate.

    Carries both ``thirty_turn_ok`` and ``e2e_loop_ok`` because
    AGENTS.md §6 declares them as independent contract gates. The
    orchestrator now refuses to silently alias one to the other.
    """
    return {
        "tier": tier,
        "results": {
            "text_eval": 0.71,
            "voice_rtf": 0.32,
            "asr_wer": 0.05,
            "first_token_latency_ms": 145,
            "first_audio_latency_ms": 280,
            "barge_in_cancel_ms": 55,
            "thirty_turn_ok": True,
            "e2e_loop_ok": True,
            "dflash_acceptance": 0.71,
        },
    }


def _build_fixture_bundle(
    tmp_path: Path,
    tier: str = "desktop-9b",
    *,
    eval_blob: dict[str, Any] | None = None,
    skip_license: str | None = None,
) -> Path:
    bundle = tmp_path / f"bundle-{tier}"

    # Weight files — content irrelevant; sha256 is the contract.
    _write(bundle / "text" / f"eliza-1-{tier}-64k.gguf", b"\x00text-64k\x00")
    _write(bundle / "tts" / "omnivoice-1.7b.gguf", b"\x00tts\x00")
    _write(
        bundle / "tts" / "omnivoice-tokenizer-1.7b.gguf", b"\x00tts-tok\x00"
    )
    _write(bundle / "asr" / "asr.gguf", b"\x00asr\x00")
    _write(bundle / "vision" / f"mmproj-{tier}.gguf", b"\x00mmproj\x00")
    _write(bundle / "dflash" / f"drafter-{tier}.gguf", b"\x00drafter\x00")
    _write(
        bundle / "dflash" / "target-meta.json",
        json.dumps({"acceptance_window": 4}),
    )
    _write(bundle / "cache" / "voice-preset-default.bin", b"\x00cache\x00")

    # Licenses.
    license_names = (
        "LICENSE.text",
        "LICENSE.voice",
        "LICENSE.dflash",
        "LICENSE.eliza-1",
    )
    for name in license_names:
        if name == skip_license:
            continue
        _write(bundle / "licenses" / name, f"{name} blob\n")

    # Evals — aggregate.json (gates input) + per-backend verify reports.
    blob = eval_blob if eval_blob is not None else _passing_eval_blob(tier)
    _write(
        bundle / "evals" / "aggregate.json",
        json.dumps(blob, indent=2),
    )
    _write(
        bundle / "evals" / "vulkan_verify.json",
        json.dumps(
            {
                "backend": "vulkan",
                "status": "pass",
                "atCommit": "deadbee",
                "report": "vulkan_verify.txt",
            }
        ),
    )
    _write(
        bundle / "evals" / "cuda_verify.json",
        json.dumps(
            {
                "backend": "cuda",
                "status": "pass",
                "atCommit": "deadbee",
                "report": "cuda_verify.txt",
            }
        ),
    )

    # Optional sidecars.
    _write(
        bundle / "lineage.json",
        json.dumps(
            {
                "text": {"base": "eliza-1-desktop", "license": "apache-2.0"},
                "voice": {"base": "omnivoice-1.7b", "license": "apache-2.0"},
                "drafter": {
                    "base": "dflash-9b-drafter",
                    "license": "apache-2.0",
                },
            }
        ),
    )
    _write(
        bundle / "ram_budget.json",
        json.dumps({"min": 7000, "recommended": 9500}),
    )
    _write(bundle / "VERSION", "1.0.0\n")

    return bundle


def _metal_report(tmp_path: Path, status: str = "pass") -> Path:
    p = tmp_path / "metal_verify.json"
    p.write_text(
        json.dumps(
            {
                "backend": "metal",
                "status": status,
                "atCommit": "cafef00",
                "report": "metal_verify.txt",
            }
        )
    )
    return p


def _ctx(
    tier: str,
    bundle: Path,
    *,
    metal: Path | None = None,
    dry_run: bool = True,
    training_root: Path | None = None,
) -> PublishContext:
    return PublishContext(
        tier=tier,
        bundle_dir=bundle,
        dry_run=dry_run,
        metal_verification=metal,
        repo_id=f"elizaos/eliza-1-{tier}",
        public=False,
        training_repo_root=training_root or _TRAINING_ROOT,
        template_path=(
            Path(__file__).resolve().parent / "templates" / "README.md.j2"
        ),
    )


# ---------------------------------------------------------------------------
# (a) Dry-run happy path
# ---------------------------------------------------------------------------


def test_dry_run_succeeds_on_fixture(tmp_path: Path, caplog) -> None:
    bundle = _build_fixture_bundle(tmp_path)
    metal = _metal_report(tmp_path)

    with caplog.at_level(logging.INFO, logger="publish.orchestrator"):
        rc = run(_ctx("desktop-9b", bundle, metal=metal, dry_run=True))

    assert rc == EXIT_OK

    # Manifest written + valid.
    manifest_path = bundle / "eliza-1.manifest.json"
    assert manifest_path.is_file()
    manifest = json.loads(manifest_path.read_text())
    assert manifest["tier"] == "desktop-9b"
    assert manifest["defaultEligible"] is True

    # README written + non-empty.
    readme = bundle / "README.md"
    assert readme.is_file()
    text = readme.read_text()
    assert "Eliza-1 desktop-9b" in text
    assert "Q" + "wen" not in text
    assert "L" + "lama" not in text

    # Manifest preview was printed in dry-run.
    log_text = caplog.text
    assert "manifest preview" in log_text


# ---------------------------------------------------------------------------
# (b) Missing license fails
# ---------------------------------------------------------------------------


def test_missing_license_fails(tmp_path: Path) -> None:
    bundle = _build_fixture_bundle(tmp_path, skip_license="LICENSE.dflash")
    metal = _metal_report(tmp_path)
    rc = run(_ctx("desktop-9b", bundle, metal=metal, dry_run=True))
    assert rc == EXIT_MISSING_FILE


# ---------------------------------------------------------------------------
# (c) Failing eval gate
# ---------------------------------------------------------------------------


def test_failing_eval_gate_blocks_publish(tmp_path: Path) -> None:
    blob = _passing_eval_blob()
    blob["results"]["text_eval"] = 0.10  # below 0.55 threshold
    bundle = _build_fixture_bundle(tmp_path, eval_blob=blob)
    metal = _metal_report(tmp_path)

    rc = run(_ctx("desktop-9b", bundle, metal=metal, dry_run=True))
    assert rc == EXIT_EVAL_GATE_FAIL

    # Manifest must NOT have been written when eval gate fails.
    assert not (bundle / "eliza-1.manifest.json").is_file()


# ---------------------------------------------------------------------------
# (d) Failing kernel verification
# ---------------------------------------------------------------------------


def test_failing_kernel_verification_blocks_publish(tmp_path: Path) -> None:
    bundle = _build_fixture_bundle(tmp_path)

    # Stomp the recorded vulkan report with a fail status.
    (bundle / "evals" / "vulkan_verify.json").write_text(
        json.dumps(
            {
                "backend": "vulkan",
                "status": "fail",
                "atCommit": "deadbee",
                "report": "vulkan_verify.txt",
            }
        )
    )
    metal = _metal_report(tmp_path)

    rc = run(_ctx("desktop-9b", bundle, metal=metal, dry_run=True))
    assert rc == EXIT_KERNEL_VERIFY_FAIL


def test_metal_required_but_missing_fails(tmp_path: Path) -> None:
    """Tier supports metal; without --metal-verification the run aborts."""
    bundle = _build_fixture_bundle(tmp_path)
    rc = run(_ctx("desktop-9b", bundle, metal=None, dry_run=True))
    assert rc == EXIT_KERNEL_VERIFY_FAIL


# ---------------------------------------------------------------------------
# (e) Red gate ⇒ defaultEligible cannot be true
# ---------------------------------------------------------------------------


def test_red_gate_prevents_default_eligible(tmp_path: Path) -> None:
    """A red gate inside the manifest builder forces defaultEligible=false.

    We exercise this directly via ``assemble_manifest`` so the test
    fails on the *manifest* contract independently of stage 3 raising.
    """
    from scripts.publish.orchestrator import (  # noqa: PLC0415
        assemble_manifest,
        validate_bundle_layout,
    )
    from benchmarks.eliza1_gates import apply_gates  # noqa: PLC0415
    from scripts.manifest.eliza1_manifest import (  # noqa: PLC0415
        Eliza1ManifestError,
        KernelVerification,
    )

    blob = _passing_eval_blob()
    blob["results"]["voice_rtf"] = 5.0  # blow the <=0.4 gate
    bundle = _build_fixture_bundle(tmp_path, eval_blob=blob)
    metal = _metal_report(tmp_path)
    ctx = _ctx("desktop-9b", bundle, metal=metal, dry_run=True)
    layout = validate_bundle_layout(ctx)

    backends = {
        "metal": KernelVerification(
            status="pass", at_commit="x", report="metal_verify.txt"
        ),
        "vulkan": KernelVerification(
            status="pass", at_commit="x", report="vulkan_verify.txt"
        ),
        "cuda": KernelVerification(
            status="pass", at_commit="x", report="cuda_verify.txt"
        ),
        "cpu": KernelVerification(
            status="pass", at_commit="x", report="reference-test"
        ),
    }
    report = apply_gates(blob)
    assert not report.passed

    # The manifest module's validator refuses to emit a self-consistent
    # manifest with red eval data — so assemble_manifest must raise. The
    # contract guarantees: "defaultEligible: true requires all required
    # kernels, supported backends, and evals to pass."
    with pytest.raises(Exception):
        assemble_manifest(
            ctx,
            layout=layout,
            backends=backends,
            gate_report=report,
            eval_blob=blob,
            version="1.0.0",
        )


# ---------------------------------------------------------------------------
# (f) Tag is emitted in dry-run (printed, not executed)
# ---------------------------------------------------------------------------


def test_dry_run_tag_is_printed_not_executed(
    tmp_path: Path, caplog
) -> None:
    bundle = _build_fixture_bundle(tmp_path)
    metal = _metal_report(tmp_path)

    with caplog.at_level(logging.INFO, logger="publish.orchestrator"):
        rc = run(_ctx("desktop-9b", bundle, metal=metal, dry_run=True))

    assert rc == EXIT_OK
    # The dry-run tag log line names the tag explicitly.
    assert "dry-run: would run `git tag -a eliza-1-desktop-9b-v1.0.0" in caplog.text


# ---------------------------------------------------------------------------
# CLI smoke — --help should not crash and should mention the choice set.
# ---------------------------------------------------------------------------


def test_missing_e2e_loop_ok_blocks_publish_without_opt_in(
    tmp_path: Path, monkeypatch
) -> None:
    """The orchestrator refuses to silently alias e2e_loop_ok ← thirty_turn_ok.

    AGENTS.md §6 declares the two manifest fields as independent
    contract gates; without the explicit ``ELIZA_PUBLISH_ALLOW_GATE_ALIAS``
    opt-in, a missing ``e2e_loop_ok`` is publish-blocking.
    """
    blob = _passing_eval_blob()
    blob["results"].pop("e2e_loop_ok")
    bundle = _build_fixture_bundle(tmp_path, eval_blob=blob)
    metal = _metal_report(tmp_path)
    monkeypatch.delenv("ELIZA_PUBLISH_ALLOW_GATE_ALIAS", raising=False)

    rc = run(_ctx("desktop-9b", bundle, metal=metal, dry_run=True))
    assert rc == EXIT_EVAL_GATE_FAIL
    assert not (bundle / "eliza-1.manifest.json").is_file()


def test_alias_opt_in_allows_publish_with_warning(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    """With the opt-in env var, e2e_loop_ok aliases thirty_turn_ok and warns."""
    blob = _passing_eval_blob()
    blob["results"].pop("e2e_loop_ok")
    bundle = _build_fixture_bundle(tmp_path, eval_blob=blob)
    metal = _metal_report(tmp_path)
    monkeypatch.setenv("ELIZA_PUBLISH_ALLOW_GATE_ALIAS", "1")

    with caplog.at_level(logging.WARNING, logger="publish.orchestrator"):
        rc = run(_ctx("desktop-9b", bundle, metal=metal, dry_run=True))

    assert rc == EXIT_OK
    assert "aliasing results.e2e_loop_ok" in caplog.text
    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    assert manifest["evals"]["e2eLoopOk"] is True
    assert manifest["evals"]["thirtyTurnOk"] is True


def test_cli_help(monkeypatch, capsys) -> None:
    from scripts.publish.orchestrator import main  # noqa: PLC0415

    with pytest.raises(SystemExit) as excinfo:
        main(["--help"])
    assert excinfo.value.code == 0
    captured = capsys.readouterr()
    assert "--tier" in captured.out
    assert "desktop-9b" in captured.out
