"""Assemble a *loadable* Eliza-1 Gemma 4 bundle dir from LOCAL artifacts.

This is a standalone proof/assembler for M8 (see
`plugins/plugin-local-inference/docs/gemma4-next-wave-plans.md`). Given the
already-on-disk Gemma 4 GGUFs, it lays out a bundle directory matching the
runtime's expected shape and writes a Gemma-cutover manifest that the on-device
loader can read:

    text/eliza-1-<tier>-128k.gguf      the Gemma 4 text GGUF (Q8_0)
    vision/mmproj-<tier>.gguf          the per-tier mmproj GGUF
    mtp/drafter-<tier>.gguf            the separate MTP drafter GGUF (if available)
    mtp/target-meta.json               drafter provenance + matchesTargetCheckpoint gate
    eliza-1.manifest.json              tokenizerFamily=gemma4, vocab 262144,
                                       kv=stock-q8_0, mtp=separate-drafter
    checksums/SHA256SUMS               sha256 of every staged file

Unlike `stage_base_v1_candidate.py` (which also downloads frozen voice/ASR/VAD
bytes from HF and folds in the eval suite), this script does NOT touch the
network and does NOT publish. It only assembles the text/vision/(mtp) core
from local files and validates the result, so M8's "assemble a loadable E2B
bundle from local artifacts" goal can be proven offline.

The manifest schema here is the Gemma 4 cutover shape described in the M8 plan
and now mirrored by `scripts/manifest/eliza1_manifest.py` (`schema.ts`: tiers
2b/4b/9b/27b/27b-256k, tokenizerFamily "gemma4", vocab 262144,
REQUIRED_KERNELS = turboquant_q4 + turbo3_tcq, separate-drafter MTP, stock q8_0
KV). This standalone assembler keeps the same contract local so it can prove a
loadable core bundle without running the full publish pipeline.

Usage:
    cd packages/training
    python3 scripts/publish/assemble_local_gemma_bundle.py \
        --tier 2b \
        --text ~/.cache/gemma4-eval/gemma-4-E2B-it-Q8_0.gguf \
        --vision ~/.cache/gemma4-eval/mmproj-gemma-4-E2B-it-Q8_0.gguf \
        --drafter <converted mtp-draft GGUF, optional> \
        --out /tmp/eliza-1-2b.bundle
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# --- Gemma cutover contract (mirror of schema.ts; see M8 plan) -------------
GEMMA_TIERS = ("2b", "4b", "9b", "27b", "27b-256k")
TOKENIZER_FAMILY = "gemma4"
TOKENIZER_VOCAB_SIZE = 262144
KV_POLICY = "stock-q8_0"
MTP_MODE = "separate-drafter"
# Gemma drops QJL/Polar (MQA + windowed-SWA + shared-KV, stock q8_0 KV).
REQUIRED_KERNELS = ("turboquant_q4", "turbo3_tcq")

TEXT_BASE_BY_TIER = {
    "2b": "google/gemma-4-E2B",
    "4b": "google/gemma-4-E4B",
    "9b": "google/gemma-4-12B",
    "27b": "google/gemma-4-31B",
    "27b-256k": "google/gemma-4-31B",
}
RAM_BUDGET_MB = {
    "2b": (4000, 5500),
    "4b": (6000, 8000),
    "9b": (12000, 18000),
    "27b": (32000, 48000),
    "27b-256k": (32000, 48000),
}
# Official Gemma 4 assistant source repos. These publish safetensors sources;
# a runtime bundle still needs a converted `mtp-draft` GGUF plus acceptance
# against the exact Eliza-1 text checkpoint.
DRAFTER_SOURCE_BY_TIER = {
    "2b": "google/gemma-4-E2B-it-qat-q4_0-unquantized-assistant",
    "4b": "google/gemma-4-E4B-it-qat-q4_0-unquantized-assistant",
    "9b": "google/gemma-4-12B-it-qat-q4_0-unquantized-assistant",
    "27b": "google/gemma-4-31B-it-qat-q4_0-unquantized-assistant",
    "27b-256k": "google/gemma-4-31B-it-qat-q4_0-unquantized-assistant",
}
# Source assistant drafters are not checkpoint-matched to fine-tuned Eliza-1
# text weights until the Eliza training pipeline records that match.
DRAFTER_MATCHES_TARGET = {
    "2b": False,
    "4b": False,
    "9b": False,
    "27b": False,
    "27b-256k": False,
}

MIN_TEXT_CONTEXT = 131_072


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _gguf_field(reader: Any, name: str) -> Any:
    field = reader.fields.get(name)
    if field is None:
        return None
    return field.contents() if hasattr(field, "contents") else None


def read_gguf_meta(path: Path) -> dict[str, Any]:
    """Read the load-bearing GGUF header fields (architecture + context).

    A non-GGUF or malformed file raises loudly — a bundle assembled from a
    file the runtime cannot open is broken, not a candidate.
    """
    import gguf

    reader = gguf.GGUFReader(str(path))
    arch = _gguf_field(reader, "general.architecture")
    ctx = _gguf_field(reader, f"{arch}.context_length") if arch else None
    return {"architecture": arch, "context_length": ctx}


def assemble(args: argparse.Namespace) -> dict[str, Any]:
    tier = args.tier
    if tier not in GEMMA_TIERS:
        raise SystemExit(f"--tier {tier!r} is not a Gemma tier {GEMMA_TIERS}")

    text_src = args.text.expanduser().resolve()
    vision_src = args.vision.expanduser().resolve()
    drafter_src = args.drafter.expanduser().resolve() if args.drafter else None
    for label, p in (("--text", text_src), ("--vision", vision_src)):
        if not p.is_file():
            raise SystemExit(f"{label} not found: {p}")
    if drafter_src is not None and not drafter_src.is_file():
        raise SystemExit(f"--drafter not found: {drafter_src}")

    # Refuse safetensors drafters: the runtime loads the mtp-draft GGUF arch
    # only. A .safetensors drafter must be converted first (TODO: the fork's
    # convert_hf_to_gguf.py mtp-draft writer — not yet a one-command recipe).
    if drafter_src is not None and drafter_src.suffix == ".safetensors":
        raise SystemExit(
            f"--drafter is a safetensors file ({drafter_src.name}); the runtime "
            "loads the `mtp-draft` GGUF arch only. Convert it to GGUF first "
            "(TODO: fork convert_hf_to_gguf.py mtp-draft writer), or omit "
            "--drafter to assemble a text+vision-only bundle for smoke loading."
        )

    out = args.out.expanduser().resolve()
    if out.exists():
        shutil.rmtree(out)
    for sub in ("text", "vision", "mtp", "checksums"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    generated_at = now_iso()

    # --- text GGUF -----------------------------------------------------------
    text_meta = read_gguf_meta(text_src)
    if text_meta["architecture"] != "gemma4":
        raise SystemExit(
            f"--text architecture is {text_meta['architecture']!r}, expected "
            "'gemma4' — refusing to stamp a Gemma manifest over a non-Gemma GGUF."
        )
    text_ctx = int(text_meta["context_length"] or 0)
    if text_ctx < MIN_TEXT_CONTEXT:
        raise SystemExit(
            f"--text context_length {text_ctx} < required {MIN_TEXT_CONTEXT}"
        )
    text_rel = f"text/eliza-1-{tier}-128k.gguf"
    text_dest = out / text_rel
    shutil.copy2(text_src, text_dest)
    text_sha = sha256_file(text_dest)

    # --- vision mmproj -------------------------------------------------------
    vision_rel = f"vision/mmproj-{tier}.gguf"
    vision_dest = out / vision_rel
    shutil.copy2(vision_src, vision_dest)
    vision_sha = sha256_file(vision_dest)

    # --- mtp drafter (optional) ---------------------------------------------
    drafter_block: dict[str, Any] | None = None
    if drafter_src is not None:
        drafter_meta = read_gguf_meta(drafter_src)
        drafter_rel = f"mtp/drafter-{tier}.gguf"
        drafter_dest = out / drafter_rel
        shutil.copy2(drafter_src, drafter_dest)
        drafter_sha = sha256_file(drafter_dest)
        matches = DRAFTER_MATCHES_TARGET[tier]
        source = DRAFTER_SOURCE_BY_TIER[tier]
        note = (
            f"Separate MTP drafter for the {tier} Gemma 4 text target; shares "
            f"the {TOKENIZER_VOCAB_SIZE}-token Gemma 4 tokenizer."
        )
        if not matches:
            note += (
                f" Candidate drafter: the upstream assistant source is {source}, "
                "but this local GGUF has not been recorded as trained/distilled "
                "against the exact Eliza-1 text checkpoint. Candidate-only; "
                "never defaultEligible."
            )
        drafter_block = {
            "path": drafter_rel,
            "sha256": drafter_sha,
            "source": source,
            "architecture": drafter_meta["architecture"],
            "matchesTargetCheckpoint": matches,
            "tokenizerVocabSize": TOKENIZER_VOCAB_SIZE,
            "note": note,
        }
        (out / "mtp" / "target-meta.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "tier": tier,
                    "status": "base-v1-candidate",
                    "publishEligible": True,
                    "defaultEligible": False,
                    "targetText": {"path": text_rel, "sha256": text_sha},
                    "drafter": drafter_block,
                    "kernelCaps": {"required": list(REQUIRED_KERNELS), "optional": []},
                },
                indent=2,
            )
            + "\n"
        )
    else:
        # Leave a sentinel so the missing-drafter case is explicit, not silent.
        (out / "mtp" / "MISSING.txt").write_text(
            f"No MTP drafter staged. The official assistant source for this tier "
            f"({DRAFTER_SOURCE_BY_TIER[tier]}) is a .safetensors file and needs "
            "conversion to the `mtp-draft` GGUF arch first. "
            "This bundle is text+vision only and is NOT release-shaped "
            "(AGENTS.md §1 requires MTP on every tier).\n"
        )

    # --- manifest (Gemma cutover shape) -------------------------------------
    base_repo = TEXT_BASE_BY_TIER[tier]
    files: dict[str, Any] = {
        "text": [{"path": text_rel, "sha256": text_sha, "ctx": text_ctx}],
        "vision": [{"path": vision_rel, "sha256": vision_sha}],
    }
    if drafter_block is not None:
        files["mtp"] = [
            {"path": drafter_block["path"], "sha256": drafter_block["sha256"]}
        ]

    manifest = {
        "schemaVersion": 2,
        "tier": tier,
        "version": args.version,
        "generatedAt": generated_at,
        "releaseState": "base-v1-candidate",
        "defaultEligible": False,
        "tokenizer": {"family": TOKENIZER_FAMILY, "vocabSize": TOKENIZER_VOCAB_SIZE},
        "kv": KV_POLICY,
        "mtp": MTP_MODE,
        "kernels": {"required": list(REQUIRED_KERNELS), "optional": []},
        "ramBudgetMb": {
            "min": RAM_BUDGET_MB[tier][0],
            "recommended": RAM_BUDGET_MB[tier][1],
        },
        "lineage": {
            "text": {"base": base_repo, "license": "gemma"},
            "vision": {"base": f"{base_repo} vision projector", "license": "gemma"},
            "drafter": (
                {"base": drafter_block["source"], "license": "gemma"}
                if drafter_block is not None
                else None
            ),
        },
        "files": files,
        "provenance": {
            "assembledFrom": "local artifacts (no network, not published)",
            "text": {"repo": base_repo, "localFile": str(text_src)},
            "vision": {"repo": base_repo, "localFile": str(vision_src)},
            "drafter": (
                {"repo": drafter_block["source"], "localFile": str(drafter_src)}
                if drafter_block is not None
                else {"repo": "n/a", "note": "no drafter staged (see mtp/MISSING.txt)"}
            ),
        },
    }
    (out / "eliza-1.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # --- checksums -----------------------------------------------------------
    lines = []
    for p in sorted(out.rglob("*")):
        if p.is_file() and p.name != "SHA256SUMS":
            lines.append(f"{sha256_file(p)}  {p.relative_to(out)}")
    (out / "checksums" / "SHA256SUMS").write_text("\n".join(lines) + "\n")

    return manifest


def validate(out: Path, manifest: dict[str, Any]) -> list[str]:
    """Re-verify the assembled bundle on disk against its own manifest."""
    errors: list[str] = []
    if manifest["tokenizer"]["family"] != TOKENIZER_FAMILY:
        errors.append("tokenizer family is not gemma4")
    if manifest["tokenizer"]["vocabSize"] != TOKENIZER_VOCAB_SIZE:
        errors.append("tokenizer vocab is not 262144")
    if manifest["kv"] != KV_POLICY:
        errors.append("kv policy is not stock-q8_0")
    if manifest["mtp"] != MTP_MODE:
        errors.append("mtp mode is not separate-drafter")
    for group in manifest["files"].values():
        for entry in group:
            fp = out / entry["path"]
            if not fp.is_file():
                errors.append(f"missing file {entry['path']}")
                continue
            actual = sha256_file(fp)
            if actual != entry["sha256"]:
                errors.append(f"sha256 mismatch for {entry['path']}")
    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", required=True, choices=GEMMA_TIERS)
    ap.add_argument("--text", required=True, type=Path, help="Gemma 4 text GGUF.")
    ap.add_argument("--vision", required=True, type=Path, help="Per-tier mmproj GGUF.")
    ap.add_argument(
        "--drafter",
        type=Path,
        default=None,
        help="Separate MTP-draft GGUF (optional; must be the mtp-draft arch, not safetensors).",
    )
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--version", default="1.0.0-candidate.1")
    args = ap.parse_args(argv)

    manifest = assemble(args)
    out = args.out.expanduser().resolve()
    errors = validate(out, manifest)
    if errors:
        print("VALIDATION FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"assembled {args.tier} bundle at {out}")
    print(f"  tokenizer: {manifest['tokenizer']['family']} / {manifest['tokenizer']['vocabSize']}")
    print(f"  kv={manifest['kv']}  mtp={manifest['mtp']}")
    print(f"  kernels.required={manifest['kernels']['required']}")
    text0 = manifest["files"]["text"][0]
    print(f"  text: {text0['path']} ctx={text0['ctx']} sha256={text0['sha256'][:16]}…")
    vis0 = manifest["files"]["vision"][0]
    print(f"  vision: {vis0['path']} sha256={vis0['sha256'][:16]}…")
    if "mtp" in manifest["files"]:
        mtp0 = manifest["files"]["mtp"][0]
        d = manifest["lineage"]["drafter"]
        print(f"  mtp: {mtp0['path']} source={d['base']} sha256={mtp0['sha256'][:16]}…")
    else:
        print("  mtp: (none staged — text+vision only; see mtp/MISSING.txt)")
    print("  validation: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
