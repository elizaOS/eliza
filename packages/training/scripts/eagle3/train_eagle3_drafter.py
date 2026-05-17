#!/usr/bin/env python3
"""Train an EAGLE3 drafter from captured teacher features.

The trainable artifact is a small PyTorch projection head over captured target
hidden states. Native GGUF export is only recorded when a real converter path is
provided; the script does not write substitute GGUF or "not a model" files.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
from pathlib import Path
from typing import Any

from scripts.eagle3.common import (
    ACTIVE_TIERS,
    ENVIRONMENT_EXIT,
    MANIFEST_SCHEMA_VERSION,
    configure_logging,
    read_jsonl,
    require_module,
    sha256_file,
    utc_now_iso,
    validate_existing_file,
    write_json,
)

log = configure_logging("eagle3.train_eagle3_drafter")

DEFAULT_STUDENT_BASE = "Qwen/Qwen3.5-0.8B-Base"


def _load_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _build_manifest(
    *,
    args: argparse.Namespace,
    features_manifest_path: Path,
    features_manifest: dict[str, Any],
    synthetic: bool,
    dry_run: bool,
    model_path: Path | None,
    config_path: Path | None,
    native_gguf_path: Path | None,
) -> dict[str, Any]:
    return {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "kind": "eagle3-drafter-training",
        "pipeline": "eagle3",
        "stage": "train-eagle3-drafter",
        "tier": args.tier,
        "generatedAt": utc_now_iso(),
        "synthetic": synthetic,
        "dryRun": dry_run,
        "studentBase": args.student_base,
        "featuresManifest": {
            "path": str(features_manifest_path),
            "sha256": sha256_file(features_manifest_path),
            "kind": features_manifest.get("kind"),
            "examples": (features_manifest.get("dataset") or {}).get("examples"),
        },
        "hyperparameters": {
            "epochs": args.epochs,
            "batchSize": args.batch_size,
            "gradAccum": args.grad_accum,
            "lr": args.lr,
            "maxSeqLen": args.max_seq_len,
        },
        "artifacts": {
            "pytorchModel": str(model_path) if model_path else None,
            "config": str(config_path) if config_path else None,
            "nativeGguf": str(native_gguf_path) if native_gguf_path else None,
        },
        "nativeGgufConversion": {
            "requested": args.convert_native_gguf,
            "converter": args.gguf_converter,
            "available": bool(native_gguf_path),
        },
    }


def _validate_features_manifest(args: argparse.Namespace) -> tuple[Path | None, dict[str, Any] | None]:
    manifest_path = validate_existing_file(
        args.features_manifest, "--features-manifest", log
    )
    if manifest_path is None:
        return None, None
    try:
        manifest = _load_manifest(manifest_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        log.error("could not read --features-manifest %s: %s", manifest_path, exc)
        return None, None
    if manifest.get("pipeline") != "eagle3" or manifest.get("stage") != "capture-features":
        log.error(
            "--features-manifest must be an EAGLE3 capture-features manifest "
            "(got pipeline=%r stage=%r)",
            manifest.get("pipeline"),
            manifest.get("stage"),
        )
        return None, None
    if manifest.get("tier") != args.tier:
        log.error(
            "--features-manifest tier %r does not match --tier %r",
            manifest.get("tier"),
            args.tier,
        )
        return None, None
    return manifest_path, manifest


def _write_manifest_only(args: argparse.Namespace, *, synthetic: bool, dry_run: bool) -> int:
    features_manifest_path, features_manifest = _validate_features_manifest(args)
    if features_manifest_path is None or features_manifest is None:
        return 2
    out_dir = Path(args.out_dir)
    config_path = out_dir / "eagle3-drafter.config.json"
    write_json(
        config_path,
        {
            "kind": "eagle3-drafter-config",
            "tier": args.tier,
            "studentBase": args.student_base,
            "syntheticFixture": synthetic,
            "trainable": False,
        },
    )
    manifest = _build_manifest(
        args=args,
        features_manifest_path=features_manifest_path,
        features_manifest=features_manifest,
        synthetic=synthetic,
        dry_run=dry_run,
        model_path=None,
        config_path=config_path,
        native_gguf_path=None,
    )
    write_json(out_dir / "eagle3-drafter.manifest.json", manifest)
    log.info("wrote EAGLE3 manifest/config without model weights")
    return 0


def _run_real(args: argparse.Namespace) -> int:
    features_manifest_path, features_manifest = _validate_features_manifest(args)
    if features_manifest_path is None or features_manifest is None:
        return 2
    torch = require_module("torch", "torch", log)
    if torch is None:
        return ENVIRONMENT_EXIT

    feature_index_meta = features_manifest.get("featureIndex") or {}
    feature_index_path = feature_index_meta.get("path")
    if not feature_index_path:
        log.error("--features-manifest does not contain a featureIndex path")
        return 2
    feature_index = validate_existing_file(str(feature_index_path), "featureIndex.path", log)
    if feature_index is None:
        return 2

    rows = read_jsonl(feature_index)
    examples: list[tuple[Any, Any]] = []
    hidden_dim = None
    vocab_size = 0
    for row in rows:
        feature_file = row.get("feature_file")
        if not feature_file:
            continue
        try:
            feature = torch.load(feature_file, map_location="cpu")
        except Exception as exc:
            log.error("failed to load EAGLE3 feature file %s: %s", feature_file, exc)
            return 2
        hidden = feature.get("hidden")
        labels = feature.get("labels")
        logits = feature.get("logits")
        if hidden is None or labels is None or len(labels) == 0:
            continue
        x = hidden[-1].float()
        y = labels[0].long()
        hidden_dim = int(x.numel())
        if logits is not None and len(logits.shape) >= 2:
            vocab_size = max(vocab_size, int(logits.shape[-1]))
        vocab_size = max(vocab_size, int(y.item()) + 1)
        examples.append((x, y))

    if not examples or hidden_dim is None:
        log.error("no trainable EAGLE3 feature rows found in %s", feature_index)
        return 2

    device = torch.device(args.device)
    model = torch.nn.Sequential(
        torch.nn.LayerNorm(hidden_dim),
        torch.nn.Linear(hidden_dim, vocab_size),
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    loss_fn = torch.nn.CrossEntropyLoss()
    model.train()

    for epoch in range(args.epochs):
        total_loss = 0.0
        for step, (x_cpu, y_cpu) in enumerate(examples, start=1):
            x = x_cpu.to(device).unsqueeze(0)
            y = y_cpu.to(device).unsqueeze(0)
            loss = loss_fn(model(x), y) / args.grad_accum
            loss.backward()
            if step % args.grad_accum == 0 or step == len(examples):
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
            total_loss += float(loss.detach().cpu()) * args.grad_accum
        log.info("epoch=%d loss=%.6f", epoch + 1, total_loss / len(examples))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / "eagle3-drafter.pt"
    config_path = out_dir / "eagle3-drafter.config.json"
    torch.save(model.state_dict(), model_path)
    write_json(
        config_path,
        {
            "kind": "eagle3-drafter-config",
            "tier": args.tier,
            "studentBase": args.student_base,
            "hiddenDim": hidden_dim,
            "vocabSize": vocab_size,
            "architecture": "layernorm-linear-hidden-to-token",
            "trainable": True,
        },
    )
    native_gguf_path = None
    if args.convert_native_gguf:
        if not args.gguf_converter or not args.native_gguf_out:
            log.error("--convert-native-gguf requires --gguf-converter and --native-gguf-out")
            return 2
        native_gguf_path = Path(args.native_gguf_out)
        native_gguf_path.parent.mkdir(parents=True, exist_ok=True)
        command = [
            part.format(
                model=str(model_path),
                config=str(config_path),
                out=str(native_gguf_path),
            )
            for part in shlex.split(args.gguf_converter)
        ]
        if not any(str(native_gguf_path) == part for part in command):
            command.extend(["--model", str(model_path), "--config", str(config_path), "--out", str(native_gguf_path)])
        try:
            subprocess.run(command, check=True)
        except (OSError, subprocess.CalledProcessError) as exc:
            log.error("EAGLE3 native GGUF converter failed: %s", exc)
            return ENVIRONMENT_EXIT
        if not native_gguf_path.is_file():
            log.error("EAGLE3 converter completed but did not write %s", native_gguf_path)
            return ENVIRONMENT_EXIT

    manifest = _build_manifest(
        args=args,
        features_manifest_path=features_manifest_path,
        features_manifest=features_manifest,
        synthetic=False,
        dry_run=False,
        model_path=model_path,
        config_path=config_path,
        native_gguf_path=native_gguf_path,
    )
    write_json(out_dir / "eagle3-drafter.manifest.json", manifest)
    log.info("wrote trainable EAGLE3 PyTorch drafter artifact %s", model_path)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", required=True, choices=ACTIVE_TIERS)
    parser.add_argument("--features-manifest", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--student-base", default=DEFAULT_STUDENT_BASE)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--max-seq-len", type=int, default=2048)
    parser.add_argument(
        "--convert-native-gguf",
        action="store_true",
        help="Request native GGUF conversion after training.",
    )
    parser.add_argument(
        "--gguf-converter",
        help=(
            "External converter command. May include {model}, {config}, and {out}; "
            "otherwise --model/--config/--out are appended."
        ),
    )
    parser.add_argument("--native-gguf-out", help="Output path for --convert-native-gguf.")
    parser.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Write a manifest/config fixture without model weights.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate manifests and write a run manifest; no artifacts.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.epochs <= 0 or args.batch_size <= 0 or args.grad_accum <= 0:
        log.error("--epochs, --batch-size, and --grad-accum must be > 0")
        return 2
    if args.max_seq_len <= 0:
        log.error("--max-seq-len must be > 0")
        return 2
    if args.lr <= 0:
        log.error("--lr must be > 0")
        return 2
    if args.convert_native_gguf:
        return _run_real(args)
    if args.synthetic_smoke:
        return _write_manifest_only(args, synthetic=True, dry_run=False)
    if args.dry_run:
        return _write_manifest_only(args, synthetic=False, dry_run=True)
    return _run_real(args)


if __name__ == "__main__":
    raise SystemExit(main())
