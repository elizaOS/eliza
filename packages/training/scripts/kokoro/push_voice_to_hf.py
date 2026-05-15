#!/usr/bin/env python3
"""Push a packaged Kokoro voice release to a HuggingFace repo.

Sibling to `publish_custom_kokoro_voice.sh` (which stages a release-dir into
a per-tier Eliza-1 bundle on local disk). This script handles the OTHER half
of the publish path: uploading the same release-dir to a HuggingFace repo
under the `elizalabs/eliza-1-voice-kokoro-<voice>-vNN` naming convention.

The release-dir is the output of `package_voice_for_release.py`:

    <release-dir>/<voice_name>/
    ├── voice.bin
    ├── kokoro.onnx
    ├── voice-preset.json
    ├── eval.json                # gate report + optional `comparison` block
    ├── manifest-fragment.json
    └── README.md                # auto-generated model card

The publish flow enforces two gates by default:

  1. `eval.json.gateResult.passed` must be true.
  2. When `eval.json.comparison` is present (i.e. the eval run was
     invoked with `--baseline-eval`), `comparison.beatsBaseline` must
     also be true.

Both gates can be bypassed with `--allow-gate-fail "<justification>"` per
AGENTS.md §6 — but the script logs the override loudly and records it in
the model-card preamble.

The HF push is `private=True` by default. Per the R12 license inventory
the sam source corpus has no upstream LICENSE and is a derivative of
*Her* (2013); the first push of any sam-derived voice MUST stay
private until the user explicitly OKs a public release. Pass
`--public` to override (this script does not infer from voice name).

Usage:

    python3 push_voice_to_hf.py \\
        --release-dir /tmp/kokoro-runs/same/release/af_same \\
        --hf-repo elizalabs/eliza-1-voice-kokoro-same-v01

    # Dry run — exercises every gate + assembles the upload plan but does
    # not call the HF API.
    python3 push_voice_to_hf.py \\
        --release-dir /tmp/kokoro-runs/same/release/af_same \\
        --hf-repo elizalabs/eliza-1-voice-kokoro-same-v01 \\
        --dry-run
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.push_voice_to_hf")

# Files `package_voice_for_release.py` is expected to emit. Match the layout
# documented in that script's docstring (and verified by its tests).
REQUIRED_ARTIFACTS: tuple[str, ...] = (
    "voice.bin",
    "kokoro.onnx",
    "voice-preset.json",
    "manifest-fragment.json",
    "eval.json",
)


def _sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _load_eval(release_dir: Path) -> dict[str, Any]:
    path = release_dir / "eval.json"
    if not path.is_file():
        raise FileNotFoundError(f"eval.json missing in release dir: {release_dir}")
    return json.loads(path.read_text(encoding="utf-8"))


def _enforce_gates(
    eval_report: dict[str, Any],
    *,
    allow_gate_fail: str | None,
    require_comparison: bool,
) -> None:
    """Apply the absolute + baseline-comparison gates. Raise on block."""
    gate_result = eval_report.get("gateResult") or {}
    passed = bool(gate_result.get("passed"))
    comparison = eval_report.get("comparison")
    beats = None if comparison is None else bool(comparison.get("beatsBaseline"))

    if require_comparison and comparison is None:
        msg = (
            "publish requires a baseline comparison (`comparison` block missing). "
            "Re-run eval_kokoro.py with --baseline-eval pointed at af_bella eval.json."
        )
        if allow_gate_fail:
            log.warning("OVERRIDE: %s — justification: %s", msg, allow_gate_fail)
        else:
            raise SystemExit(msg)

    if not passed or beats is False:
        per_metric = gate_result.get("perMetric", {})
        msg = (
            f"publish blocked: gateResult.passed={passed}, "
            f"comparison.beatsBaseline={beats}, perMetric={per_metric}"
        )
        if allow_gate_fail:
            log.warning("OVERRIDE: %s — justification: %s", msg, allow_gate_fail)
        else:
            raise SystemExit(msg)


def _ensure_artifacts(release_dir: Path) -> None:
    missing = [name for name in REQUIRED_ARTIFACTS if not (release_dir / name).is_file()]
    if missing:
        raise SystemExit(
            f"release dir {release_dir} is missing required artifacts: {missing}. "
            "Run `python3 packages/training/scripts/kokoro/package_voice_for_release.py "
            "--run-dir ... --release-dir ...` first."
        )


def _model_card(
    *,
    release_dir: Path,
    hf_repo: str,
    eval_report: dict[str, Any],
    voice_preset: dict[str, Any],
    private: bool,
    allow_gate_fail: str | None,
) -> str:
    metrics = eval_report.get("metrics", {})
    gate = eval_report.get("gateResult", {})
    comparison = eval_report.get("comparison")
    voice_name = voice_preset.get("voiceId") or "unknown"
    display = voice_preset.get("displayName") or voice_name
    base = voice_preset.get("engine", {}).get("baseModel", "hexgrad/Kokoro-82M")
    tags = voice_preset.get("tags", [])
    lang = voice_preset.get("lang", "a")

    lines = [
        "---",
        "language: en",
        "library_name: kokoro",
        f"base_model: {base}",
        "license: apache-2.0",
        "tags:",
        "- text-to-speech",
        "- kokoro",
        "- eliza-1",
        "- voice-clone",
    ]
    if "sam" in voice_name.lower() or "sam" in [t.lower() for t in tags]:
        lines.append("- research-only")
    lines.extend(
        [
            "---",
            "",
            f"# {hf_repo}",
            "",
            f"Kokoro voice pack — `{voice_name}` ({display}).",
            "",
            f"- **Base model**: [`{base}`](https://huggingface.co/{base}) (Apache-2.0)",
            f"- **Voice lang**: `{lang}` (see `voice-preset.json` for the full envelope).",
            f"- **Tags**: {', '.join(tags) if tags else '(none)'}",
            f"- **First publish**: {datetime.now(timezone.utc).isoformat()}",
            f"- **Visibility**: {'private' if private else 'public'}",
            "",
        ]
    )
    if "sam" in voice_name.lower():
        lines.extend(
            [
                "## License & data provenance",
                "",
                "This voice pack derives from the `sam` clips in",
                "[`lalalune/ai_voices`](https://github.com/lalalune/ai_voices). The upstream",
                "README states the corpus is *for fun and research only* — there is no",
                "LICENSE file. The sam voice itself is a derivative of the 2013 film",
                "*Her* (Warner Bros). This artifact is therefore distributed for",
                "**non-commercial research and personal use only**. Do not redistribute the",
                "raw audio. The fine-tuned voice embedding + ONNX delta are published here",
                "as derivative works with attribution; commercial use requires explicit",
                "rights clearance from the upstream rights holders.",
                "",
                "Model weights (the Kokoro-82M base) remain Apache-2.0; the research-only",
                "constraint above is on the **voice pack** as a whole, not the upstream base.",
                "",
            ]
        )
    lines.extend(
        [
            "## Eval",
            "",
            f"- UTMOS: {metrics.get('utmos', 'n/a')}",
            f"- WER:   {metrics.get('wer', 'n/a')}",
            f"- SpkSim:{metrics.get('speaker_similarity', 'n/a')}",
            f"- RTF:   {metrics.get('rtf', 'n/a')}",
            f"- Gates passed: {gate.get('passed')}",
        ]
    )
    if comparison is not None:
        lines.extend(
            [
                "",
                "### Comparison against baseline",
                "",
                f"- Baseline: `{comparison.get('baselineVoiceName')}` "
                f"(`{comparison.get('baselinePath')}`)",
                f"- UTMOS Δ:  {comparison.get('utmosDelta')}",
                f"- WER Δ:    {comparison.get('werDelta')}",
                f"- SpkSim Δ: {comparison.get('speakerSimDelta')} "
                f"(threshold: ≥ +{comparison.get('speakerSimBeatThreshold')})",
                f"- RTF Δ:    {comparison.get('rtfDelta')}",
                f"- Beats baseline: {comparison.get('beatsBaseline')}",
            ]
        )
    if allow_gate_fail:
        lines.extend(
            [
                "",
                "## Gate override",
                "",
                "This release was published with `--allow-gate-fail`. Justification:",
                "",
                f"> {allow_gate_fail}",
            ]
        )
    lines.extend(
        [
            "",
            "## Runtime integration",
            "",
            "1. Place `voice.bin` at `<bundle>/tts/kokoro/voices/<voice>.bin` in any",
            "   Eliza-1 per-tier bundle.",
            f"2. Register `{voice_name}` in",
            "   `plugins/plugin-local-inference/src/services/voice/kokoro/voice-presets.ts`",
            "   using the fields in `voice-preset.json`.",
            "3. Optional: set `ELIZA_KOKORO_DEFAULT_VOICE_ID` to make this the default",
            "   voice on a bundle.",
            "",
        ]
    )
    return "\n".join(lines) + "\n"


def _build_upload_plan(release_dir: Path) -> list[dict[str, Any]]:
    plan = []
    for name in REQUIRED_ARTIFACTS:
        path = release_dir / name
        plan.append(
            {
                "path": str(path),
                "remote": name,
                "sizeBytes": path.stat().st_size,
                "sha256": _sha256_file(path),
            }
        )
    return plan


def _push(
    *,
    release_dir: Path,
    hf_repo: str,
    private: bool,
    model_card: str,
    dry_run: bool,
) -> dict[str, Any]:
    """Drive the HF API. In dry-run mode, return a plan without calling the API."""
    plan = _build_upload_plan(release_dir)
    plan.append(
        {
            "path": "<rendered>",
            "remote": "README.md",
            "sizeBytes": len(model_card.encode("utf-8")),
            "sha256": hashlib.sha256(model_card.encode("utf-8")).hexdigest(),
        }
    )

    if dry_run:
        log.info("dry-run: would upload %d files to %s (private=%s)", len(plan), hf_repo, private)
        return {
            "kind": "kokoro-voice-hf-push-plan",
            "schemaVersion": 1,
            "dryRun": True,
            "hfRepo": hf_repo,
            "private": private,
            "files": plan,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }

    try:
        from huggingface_hub import HfApi  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "huggingface_hub is required for non-dry-run push. Install via "
            "`pip install -r packages/training/scripts/kokoro/requirements.txt` "
            "(huggingface_hub ships transitively with the training extra)."
        ) from exc

    api = HfApi()
    api.create_repo(repo_id=hf_repo, repo_type="model", exist_ok=True, private=private)

    # Render the README into the release dir so the upload uses the same
    # content the model-card preamble logs. We do NOT overwrite an existing
    # README.md from package_voice_for_release.py — that one is the
    # human-edited summary; the HF README we synthesize lives at .hf-README.md
    # for traceability and is uploaded as "README.md".
    rendered = release_dir / ".hf-README.md"
    rendered.write_text(model_card, encoding="utf-8")
    try:
        api.upload_file(
            path_or_fileobj=str(rendered),
            path_in_repo="README.md",
            repo_id=hf_repo,
            repo_type="model",
        )
        for name in REQUIRED_ARTIFACTS:
            api.upload_file(
                path_or_fileobj=str(release_dir / name),
                path_in_repo=name,
                repo_id=hf_repo,
                repo_type="model",
            )
    finally:
        # Keep the rendered card on disk for the receipt; it is the canonical
        # record of what got pushed.
        pass

    return {
        "kind": "kokoro-voice-hf-push-receipt",
        "schemaVersion": 1,
        "dryRun": False,
        "hfRepo": hf_repo,
        "private": private,
        "files": plan,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--release-dir", type=Path, required=True)
    p.add_argument("--hf-repo", required=True)
    p.add_argument(
        "--public",
        action="store_true",
        help="Push as a public HF repo. Default is private (per the C0 license decision).",
    )
    p.add_argument(
        "--allow-gate-fail",
        default=None,
        help="Bypass the eval / baseline-comparison gate. Requires a written justification.",
    )
    p.add_argument(
        "--require-comparison",
        action="store_true",
        help=(
            "Refuse to publish when `eval.json.comparison` is missing. Default off — "
            "the absolute gates alone are enough for non-derivative voices."
        ),
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Assemble the upload plan + render the model card without touching the HF API.",
    )
    p.add_argument(
        "--receipt",
        type=Path,
        default=None,
        help="Optional path to write the push receipt JSON (defaults to <release-dir>/hf-receipt.json).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    release_dir = Path(args.release_dir).resolve()
    if not release_dir.is_dir():
        log.error("release dir does not exist: %s", release_dir)
        return 2
    _ensure_artifacts(release_dir)
    eval_report = _load_eval(release_dir)
    _enforce_gates(
        eval_report,
        allow_gate_fail=args.allow_gate_fail,
        require_comparison=args.require_comparison,
    )
    voice_preset = json.loads((release_dir / "voice-preset.json").read_text(encoding="utf-8"))
    model_card = _model_card(
        release_dir=release_dir,
        hf_repo=args.hf_repo,
        eval_report=eval_report,
        voice_preset=voice_preset,
        private=not args.public,
        allow_gate_fail=args.allow_gate_fail,
    )
    receipt = _push(
        release_dir=release_dir,
        hf_repo=args.hf_repo,
        private=not args.public,
        model_card=model_card,
        dry_run=args.dry_run,
    )
    receipt_path = Path(args.receipt) if args.receipt else release_dir / "hf-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    log.info("wrote %s", receipt_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
