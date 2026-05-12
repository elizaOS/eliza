#!/usr/bin/env python3
"""Validate a freshly distilled DFlash drafter against its Eliza-1 target.

Runs the same publish-gate checks the runtime doctor + dflash/target-meta.json
enforce, but on a single (drafter, target) GGUF pair before they hit a bundle.

Checks performed:

  1. The drafter GGUF carries `dflash-draft.target_checkpoint_sha256` and that
     hash equals the sha256 of the target GGUF (publish gate from
     scripts/manifest/stage_local_eliza1_bundle.py).
  2. Drafter and target share a vocab size (load-bearing: without this DFlash
     speculative decoding rejects every drafted token; see the original audit).
  3. Drafter is genuinely smaller than the target (sanity — a same-size
     "drafter" gives no speed-up).
  4. Optional acceptance-rate rollout: generate N tokens with the target alone
     and with target+drafter, compute the empirical acceptance rate. Gate is
     0.5 by default, but per-tier gates in distill_dflash_drafter.ACCEPTANCE_GATE
     are tighter.

The acceptance rollout requires `llama-cpp-python` + the in-repo llama.cpp
fork (for the custom GGML types). With `--synthetic-smoke`, the rollout is
skipped and a synthetic JSON report is emitted so CI exercises the script.

Exit codes:
  0  all checks pass
  2  bad input (missing files, wrong CLI usage)
  3  drafter/target hash or vocab mismatch
  4  acceptance below gate
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
log = logging.getLogger("validate_drafter")

# Must match the writer in scripts/distill_dflash_drafter.py.
GGUF_TARGET_CHECKPOINT_KEY = "dflash-draft.target_checkpoint_sha256"

# Mirrored from distill_dflash_drafter.ACCEPTANCE_GATE so this script can run
# standalone (no import of distill_dflash_drafter at validate time).
ACCEPTANCE_GATE: dict[str, float] = {
    "0_8b": 0.40,
    "2b": 0.50,
    "4b": 0.52,
    "9b": 0.55,
    "27b": 0.55,
    "27b-256k": 0.55,
    "27b-1m": 0.55,
}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_gguf_metadata(gguf_path: Path) -> dict[str, Any]:
    import gguf  # type: ignore  # noqa: PLC0415

    reader = gguf.GGUFReader(str(gguf_path), "r")
    out: dict[str, Any] = {"path": str(gguf_path)}

    def _read_string(key: str) -> str | None:
        field = reader.fields.get(key)
        if field is None or not field.data:
            return None
        try:
            return str(field.parts[field.data[0]].tobytes().decode("utf-8"))
        except Exception:
            return None

    def _read_uint(key: str) -> int | None:
        field = reader.fields.get(key)
        if field is None or not field.data:
            return None
        try:
            return int(field.parts[field.data[0]][0])
        except Exception:
            return None

    arch_field = reader.fields.get(gguf.Keys.General.ARCHITECTURE)
    arch: str | None = None
    if arch_field is not None and arch_field.data:
        arch = str(arch_field.parts[arch_field.data[0]].tobytes().decode("utf-8"))
    out["arch"] = arch
    out["targetCheckpointSha256"] = _read_string(GGUF_TARGET_CHECKPOINT_KEY)

    vocab_size_keys = (
        "tokenizer.ggml.token_type",  # array length matches vocab on most archs
        "llama.vocab_size",
        f"{arch}.vocab_size" if arch else "",
    )
    vocab_size: int | None = None
    for k in vocab_size_keys:
        if not k:
            continue
        field = reader.fields.get(k)
        if field is None:
            continue
        if k.endswith(".vocab_size"):
            vocab_size = _read_uint(k)
            if vocab_size is not None:
                break
        else:
            try:
                vocab_size = sum(len(d) for d in field.data) or len(field.parts)
                if vocab_size:
                    break
            except Exception:
                continue
    if vocab_size is None:
        tokens_field = reader.fields.get("tokenizer.ggml.tokens")
        if tokens_field is not None:
            vocab_size = len(tokens_field.data)
    out["vocabSize"] = vocab_size

    out["tensorCount"] = len(reader.tensors)
    out["sizeBytes"] = gguf_path.stat().st_size
    return out


def _hash_or_metadata_check(
    drafter_meta: dict[str, Any], target_path: Path
) -> tuple[bool, str]:
    recorded = drafter_meta.get("targetCheckpointSha256")
    if not recorded:
        return False, "drafter missing dflash-draft.target_checkpoint_sha256"
    actual = _sha256_file(target_path)
    if recorded != actual:
        return False, f"target hash mismatch: drafter recorded {recorded}, target is {actual}"
    return True, f"target hash ok ({actual})"


def _vocab_check(drafter_meta: dict[str, Any], target_meta: dict[str, Any]) -> tuple[bool, str]:
    d = drafter_meta.get("vocabSize")
    t = target_meta.get("vocabSize")
    if d is None or t is None:
        return False, f"vocab size unreadable (drafter={d}, target={t})"
    if d != t:
        return False, f"vocab size mismatch: drafter={d}, target={t}"
    return True, f"vocab size ok ({d})"


def _size_check(drafter_meta: dict[str, Any], target_meta: dict[str, Any]) -> tuple[bool, str]:
    d = drafter_meta["sizeBytes"]
    t = target_meta["sizeBytes"]
    if d >= t:
        return False, f"drafter ({d} bytes) is not smaller than target ({t} bytes)"
    return True, f"drafter is smaller ({d} bytes vs target {t} bytes)"


def _run_acceptance_rollout(
    drafter_path: Path,
    target_path: Path,
    *,
    n_tokens: int,
    prompts: list[str],
) -> dict[str, Any]:
    """Measure DFlash speculative acceptance rate.

    Uses llama-cpp-python. This is a smoke-quality measurement (single batch,
    no chat template), not the full eval harness — the real acceptance window
    is measured by the eval harness against the shipped target and written
    into dflash/target-meta.json. The publish gate checks that file, not this
    one. Use this script as the cheap pre-publish sanity check.
    """
    try:
        from llama_cpp import Llama  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "acceptance rollout requires llama-cpp-python (uv --extra train)"
        ) from exc

    target = Llama(model_path=str(target_path), n_ctx=2048, logits_all=True, verbose=False)
    drafter = Llama(model_path=str(drafter_path), n_ctx=2048, logits_all=True, verbose=False)

    accepted = 0
    proposed = 0
    for prompt in prompts:
        prompt_ids = target.tokenize(prompt.encode("utf-8"), add_bos=True)
        ctx = list(prompt_ids)
        produced = 0
        while produced < n_tokens:
            # Draft: ask the small model for the next K tokens greedily.
            k = 4
            drafter.reset()
            drafter.eval(ctx)
            drafted: list[int] = []
            for _ in range(k):
                tok = drafter.sample(top_k=1)
                drafted.append(int(tok))
                drafter.eval([int(tok)])
            # Verify with the target: greedy.
            target.reset()
            target.eval(ctx)
            for i, dtok in enumerate(drafted):
                tgt_tok = int(target.sample(top_k=1))
                proposed += 1
                if tgt_tok == dtok:
                    accepted += 1
                    target.eval([tgt_tok])
                    ctx.append(tgt_tok)
                    produced += 1
                else:
                    ctx.append(tgt_tok)
                    produced += 1
                    break
            else:
                continue
            if produced >= n_tokens:
                break
    rate = accepted / max(proposed, 1)
    return {"proposed": proposed, "accepted": accepted, "acceptanceRate": rate}


def _emit_report(
    report: dict[str, Any], out_path: Path | None
) -> None:
    payload = json.dumps(report, indent=2, sort_keys=True)
    if out_path is not None:
        out_path.write_text(payload + "\n")
        log.info("wrote validation report to %s", out_path)
    else:
        print(payload)


def _run_synthetic_smoke(args: argparse.Namespace) -> int:
    """Emit a synthetic validation report without touching real GGUFs.

    This validates the report shape + exit-code wiring so CI can exercise the
    script on every commit even when no real drafter exists yet.
    """
    fake_target_sha = hashlib.sha256(f"synthetic-target-{args.tier}".encode()).hexdigest()
    report = {
        "schemaVersion": 1,
        "kind": "dflash-drafter-validation",
        "tier": args.tier,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": True,
        "drafter": {"path": "<synthetic>", "sizeBytes": 0, "vocabSize": 151936},
        "target": {"path": "<synthetic>", "sizeBytes": 0, "vocabSize": 151936},
        "checks": {
            "hashMatch": {"pass": True, "detail": f"synthetic ({fake_target_sha})"},
            "vocabMatch": {"pass": True, "detail": "synthetic (vocabSize=151936)"},
            "drafterSmaller": {"pass": True, "detail": "synthetic"},
            "acceptanceRollout": {
                "pass": True,
                "detail": "synthetic (skipped)",
                "acceptanceRate": None,
                "gate": ACCEPTANCE_GATE.get(args.tier),
            },
        },
        "pass": True,
        "notes": "Synthetic smoke validation. NOT a real publish-gate signal.",
    }
    out_path = Path(args.report_out) if args.report_out else None
    _emit_report(report, out_path)
    return 0


def _run_real(args: argparse.Namespace) -> int:
    if not args.drafter_gguf or not args.target_gguf:
        log.error("--drafter-gguf and --target-gguf are required for a real run")
        return 2
    drafter_path = Path(args.drafter_gguf)
    target_path = Path(args.target_gguf)
    if not drafter_path.exists():
        log.error("drafter %s does not exist", drafter_path)
        return 2
    if not target_path.exists():
        log.error("target %s does not exist", target_path)
        return 2

    drafter_meta = _read_gguf_metadata(drafter_path)
    target_meta = _read_gguf_metadata(target_path)

    hash_pass, hash_detail = _hash_or_metadata_check(drafter_meta, target_path)
    vocab_pass, vocab_detail = _vocab_check(drafter_meta, target_meta)
    size_pass, size_detail = _size_check(drafter_meta, target_meta)

    accept_block: dict[str, Any] = {
        "pass": True,
        "detail": "skipped (--skip-acceptance-rollout or no prompts file)",
        "acceptanceRate": None,
        "gate": ACCEPTANCE_GATE.get(args.tier),
    }
    if not args.skip_acceptance_rollout:
        prompts = (
            Path(args.prompts_file).read_text().splitlines()
            if args.prompts_file
            else [
                "Write a short note to a colleague about tomorrow's meeting.",
                "Summarize this in two sentences: ",
                "The quick brown fox ",
            ]
        )
        prompts = [p for p in prompts if p.strip()]
        rollout = _run_acceptance_rollout(
            drafter_path,
            target_path,
            n_tokens=args.acceptance_tokens,
            prompts=prompts,
        )
        gate = args.acceptance_gate
        if gate is None:
            gate = ACCEPTANCE_GATE.get(args.tier, 0.5)
        accept_block = {
            "pass": rollout["acceptanceRate"] >= gate,
            "detail": (
                f"acceptance={rollout['acceptanceRate']:.3f} "
                f"(proposed={rollout['proposed']}, accepted={rollout['accepted']})"
            ),
            "acceptanceRate": rollout["acceptanceRate"],
            "proposed": rollout["proposed"],
            "accepted": rollout["accepted"],
            "gate": gate,
        }

    overall = hash_pass and vocab_pass and size_pass and accept_block["pass"]
    report = {
        "schemaVersion": 1,
        "kind": "dflash-drafter-validation",
        "tier": args.tier,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": False,
        "drafter": drafter_meta,
        "target": target_meta,
        "checks": {
            "hashMatch": {"pass": hash_pass, "detail": hash_detail},
            "vocabMatch": {"pass": vocab_pass, "detail": vocab_detail},
            "drafterSmaller": {"pass": size_pass, "detail": size_detail},
            "acceptanceRollout": accept_block,
        },
        "pass": overall,
    }
    out_path = Path(args.report_out) if args.report_out else None
    _emit_report(report, out_path)

    if not (hash_pass and vocab_pass and size_pass):
        return 3
    if not accept_block["pass"]:
        return 4
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tier", required=True, choices=sorted(ACCEPTANCE_GATE.keys()))
    p.add_argument("--drafter-gguf", help="Path to the distilled drafter GGUF.")
    p.add_argument("--target-gguf", help="Path to the Eliza-1 text target GGUF.")
    p.add_argument(
        "--prompts-file",
        help="One prompt per line. Defaults to 3 built-in prompts.",
    )
    p.add_argument(
        "--acceptance-tokens",
        type=int,
        default=1024,
        help="Tokens to roll out for the acceptance measurement.",
    )
    p.add_argument(
        "--acceptance-gate",
        type=float,
        help="Override the per-tier gate from ACCEPTANCE_GATE.",
    )
    p.add_argument(
        "--skip-acceptance-rollout",
        action="store_true",
        help="Static checks only (hash + vocab + size). No GPU/inference required.",
    )
    p.add_argument(
        "--report-out",
        help="Write the JSON report here instead of stdout.",
    )
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="No GGUFs, no inference: emit a synthetic report for CI.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args)
    return _run_real(args)


if __name__ == "__main__":
    raise SystemExit(main())
