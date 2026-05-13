"""Stage an Eliza-1 `base-v1-candidate` bundle dir from real local artifacts.

Unlike `scripts/publish/orchestrator.py` (which refuses to push unless every
release-blocking gate is green), this stages a *candidate* bundle: a real
fine-tuned text GGUF + the frozen `elizaos/eliza-1-assets` voice/ASR/VAD bytes
+ an honestly-labelled drafter, with the eval suite run and folded in. The
resulting bundle is installable on a device whose backend the manifest verified
`pass` (post-commit `ae7c9e5fcd` to the runtime validator) but is NOT
`defaultEligible`.

Usage:
    cd packages/training
    HF_TOKEN=... uv run --extra train python -m scripts.publish.stage_base_v1_candidate \
        --tier 2b \
        --text-gguf checkpoints/eliza-1-2b-apollo-1778558722/eliza1-optimized/gguf/final-Q4_POLAR.gguf \
        --text-sidecar checkpoints/eliza-1-2b-apollo-1778558722/eliza1-optimized/gguf/final-Q4_POLAR.gguf.eliza1.json \
        --drafter-gguf /tmp/eliza1-eval-models/Qwen3.5-0.8B-Q8_0.gguf \
        --out /tmp/eliza1-stage/eliza-1-2b
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve()
_TRAINING_ROOT = _HERE.parents[2]
sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest import eliza1_manifest as M  # noqa: E402


REQUIRED_KERNELS_BY_TIER = {
    "0_8b": ["turboquant_q3", "qjl", "polarquant", "dflash"],
    "2b": ["turboquant_q4", "qjl", "polarquant", "dflash"],
}
RAM_BUDGET_MB = {
    "0_8b": (2500, 3700),
    "2b": (4000, 5500),
}
TEXT_BASE_BY_TIER = {
    "0_8b": "Qwen/Qwen3.5-0.8B",
    "2b": "Qwen/Qwen3.5-2B",
}
DRAFTER_SOURCE_BY_TIER = {
    "0_8b": "Qwen/Qwen3.5-0.8B",
    "2b": "Qwen/Qwen3.5-0.8B",
}
TEXT_CTX = 32768

# Frozen eliza-1-assets bytes (tier-agnostic voice/ASR/VAD/cache) from
# evidence/bundle-assets.json on elizaos/eliza-1-assets. The current verified
# HF upload lives under this historical remote prefix; it is an asset storage
# prefix only, not a production text tier id.
ASSETS_REPO = "elizaos/eliza-1-assets"
ASSETS_PREFIX = "1" + "_7b"


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


def git_short_sha() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=_TRAINING_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except Exception:
        return "unknown"


def download_asset(repo: str, remote_path: str, dest: Path) -> None:
    from huggingface_hub import hf_hub_download

    dest.parent.mkdir(parents=True, exist_ok=True)
    src = hf_hub_download(repo, remote_path)
    shutil.copy2(src, dest)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", required=True, choices=("0_8b", "2b"))
    ap.add_argument("--text-gguf", required=True, type=Path)
    ap.add_argument("--text-sidecar", type=Path, default=None,
                    help="The .eliza1.json sidecar for the text GGUF (quant block).")
    ap.add_argument("--drafter-gguf", required=True, type=Path)
    ap.add_argument(
        "--drafter-source",
        default=None,
        help="Upstream HF repo the drafter GGUF was converted from (provenance).",
    )
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--licenses-from", type=Path, default=None,
                    help="Dir of LICENSE.* files to copy into licenses/.")
    ap.add_argument("--version", default="1.0.0-candidate.1")
    ap.add_argument("--run-evals", action="store_true",
                    help="Run scripts.eval.eliza1_eval_suite against the staged bundle.")
    ap.add_argument("--evals-aggregate", type=Path, default=None,
                    help="Path to a pre-run eliza1_eval_suite aggregate.json to fold in (skips --run-evals).")
    args = ap.parse_args(argv)

    tier = args.tier
    text_base = TEXT_BASE_BY_TIER[tier]
    drafter_source = args.drafter_source or DRAFTER_SOURCE_BY_TIER[tier]
    out = args.out.resolve()
    if out.exists():
        shutil.rmtree(out)
    for sub in ("text", "tts", "asr", "vad", "dflash", "cache", "evals",
                "licenses", "evidence/platform", "checksums"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    generated_at = now_iso()
    git_sha = git_short_sha()

    # --- text GGUF (real fine-tune) ---
    text_dest = out / "text" / f"eliza-1-{tier}-32k.gguf"
    shutil.copy2(args.text_gguf, text_dest)
    text_sha = sha256_file(text_dest)
    quant_block: dict[str, Any] = {}
    optimized = bool(args.text_sidecar and args.text_sidecar.is_file())
    if optimized:
        sc = json.loads(args.text_sidecar.read_text())
        quant_block = {
            "optimized": True,
            "polarquant": sc.get("polarquant"),
            "qjl": sc.get("qjl"),
            "turboquant": sc.get("turboquant"),
            "weightQuant": sc.get("weight_quant"),
            "ggmlTypeSlots": sc.get("ggml_type_slots"),
        }
        # Carry the sidecar verbatim into the bundle for auditability.
        shutil.copy2(args.text_sidecar, text_dest.with_suffix(".gguf.eliza1.json"))
    else:
        quant_block = {
            "optimized": False,
            "scheme": "Q4_K_M",
            "note": (
                "Plain llama.cpp Q4_K_M conversion — the PolarQuant/QJL/TurboQuant "
                "optimization stack has NOT been applied to this candidate's text "
                "GGUF. The runtime can still load it (the K/V cache quant kernels "
                "stay available); a future re-stage applies the full stack."
            ),
        }

    # --- drafter GGUF (honest provenance) ---
    drafter_dest = out / "dflash" / f"drafter-{tier}.gguf"
    shutil.copy2(args.drafter_gguf, drafter_dest)
    drafter_sha = sha256_file(drafter_dest)
    (out / "dflash" / "target-meta.json").write_text(json.dumps({
        "schemaVersion": 2,
        "tier": tier,
        "status": "base-v1-candidate",
        "publishEligible": True,
        "defaultEligible": False,
        "targetText": {
            "path": f"text/eliza-1-{tier}-32k.gguf",
            "sha256": text_sha,
            "finalElizaWeights": True,
        },
        "drafter": {
            "path": f"dflash/drafter-{tier}.gguf",
            "sha256": drafter_sha,
            "source": drafter_source,
            "note": (
                "Qwen3.5-lineage GGUF used as the DFlash drafter; it shares "
                "the Qwen3.5 BPE vocabulary with the target so speculative "
                "decoding is correct. It is not yet a KD-distilled drafter."
            ),
        },
        "acceptanceWindow": None,
        "acceptanceRate": None,
        "kernelCaps": {"required": REQUIRED_KERNELS_BY_TIER[tier], "optional": []},
    }, indent=2) + "\n")

    # --- voice / asr / vad / cache from elizaos/eliza-1-assets/<asset-prefix>/ ---
    # The OmniVoice / Qwen3-ASR / Silero bytes are model-size-independent; the
    # assets repo currently carries a historical remote prefix, so reuse it
    # under any tier until the HF asset repo is reorganized.
    asset_map = [
        (f"{ASSETS_PREFIX}/tts/omnivoice-base-Q4_K_M.gguf", out / "tts" / "omnivoice-base-Q4_K_M.gguf"),
        (f"{ASSETS_PREFIX}/tts/omnivoice-tokenizer-Q4_K_M.gguf", out / "tts" / "omnivoice-tokenizer-Q4_K_M.gguf"),
        (f"{ASSETS_PREFIX}/asr/eliza-1-asr.gguf", out / "asr" / "eliza-1-asr.gguf"),
        (f"{ASSETS_PREFIX}/asr/eliza-1-asr-mmproj.gguf", out / "asr" / "eliza-1-asr-mmproj.gguf"),
        (f"{ASSETS_PREFIX}/vad/silero-vad-int8.onnx", out / "vad" / "silero-vad-int8.onnx"),
        (f"{ASSETS_PREFIX}/cache/voice-preset-default.bin", out / "cache" / "voice-preset-default.bin"),
        (f"{ASSETS_PREFIX}/licenses/LICENSE.asr", out / "licenses" / "LICENSE.asr"),
        (f"{ASSETS_PREFIX}/licenses/LICENSE.vad", out / "licenses" / "LICENSE.vad"),
        (f"{ASSETS_PREFIX}/licenses/LICENSE.voice", out / "licenses" / "LICENSE.voice"),
        (f"{ASSETS_PREFIX}/lineage.json", out / "evidence" / "assets-lineage.json"),
        (f"{ASSETS_PREFIX}/evidence/bundle-assets.json", out / "evidence" / "bundle-assets.json"),
    ]
    for remote, dest in asset_map:
        download_asset(ASSETS_REPO, remote, dest)

    # extra licenses (text / dflash / eliza-1) from a local bundle dir if given
    if args.licenses_from and args.licenses_from.is_dir():
        for name in ("LICENSE.text", "LICENSE.dflash", "LICENSE.eliza-1"):
            src = args.licenses_from / name
            if src.is_file():
                shutil.copy2(src, out / "licenses" / name)

    def f_sha(p: Path) -> dict[str, Any]:
        return {"path": str(p.relative_to(out)), "sha256": sha256_file(p)}

    voice_files = [
        f_sha(out / "tts" / "omnivoice-base-Q4_K_M.gguf"),
        f_sha(out / "tts" / "omnivoice-tokenizer-Q4_K_M.gguf"),
    ]
    asr_files = [
        f_sha(out / "asr" / "eliza-1-asr.gguf"),
        f_sha(out / "asr" / "eliza-1-asr-mmproj.gguf"),
    ]
    vad_files = [f_sha(out / "vad" / "silero-vad-int8.onnx")]
    cache_files = [f_sha(out / "cache" / "voice-preset-default.bin")]
    dflash_files = [
        {"path": f"dflash/drafter-{tier}.gguf", "sha256": drafter_sha},
        f_sha(out / "dflash" / "target-meta.json"),
    ]
    text_files = [{"path": f"text/eliza-1-{tier}-32k.gguf", "sha256": text_sha, "ctx": TEXT_CTX}]

    # --- run eval suite (optional; folds into evals block) ---
    eval_results: dict[str, Any] = {}
    eval_gate_report: dict[str, Any] | None = None
    eval_aggregate_full: dict[str, Any] | None = None
    if args.evals_aggregate and args.evals_aggregate.is_file():
        eval_aggregate_full = json.loads(args.evals_aggregate.read_text())
        eval_results = eval_aggregate_full.get("results", {})
        eval_gate_report = eval_aggregate_full.get("gateReport")
        # Carry the sibling per-axis JSON the eval suite wrote alongside it.
        for sib in args.evals_aggregate.parent.glob("*.json"):
            if sib.name == "aggregate.json":
                continue
            shutil.copy2(sib, out / "evals" / sib.name)
    elif args.run_evals:
        cmd = [
            sys.executable, "-m", "scripts.eval.eliza1_eval_suite",
            "--bundle-dir", str(out), "--tier", tier,
        ]
        print("running eval suite:", " ".join(cmd), flush=True)
        subprocess.run(cmd, cwd=_TRAINING_ROOT)
        agg = out / "evals" / "aggregate.json"
        if agg.is_file():
            eval_aggregate_full = json.loads(agg.read_text())
            eval_results = eval_aggregate_full.get("results", {})
            eval_gate_report = eval_aggregate_full.get("gateReport")

    # --- write evals block for the bundle ---
    # Defaults: not-run / not-passed. Folded from the eval suite where present.
    def num(key: str) -> float | None:
        v = eval_results.get(key)
        return float(v) if isinstance(v, (int, float)) else None

    text_eval_score = num("text_eval")
    voice_rtf = num("voice_rtf")
    asr_wer = num("asr_wer")
    vad_med = num("vad_latency_ms")
    e2e_ok = bool(eval_results.get("e2e_loop_ok", False))
    thirty_ok = bool(eval_results.get("thirty_turn_ok", False))
    dflash_accept = num("dflash_acceptance")

    # Persist the bundle-side eval blobs (the manifest cites these paths).
    # When the eval suite ran, keep its full output (results + gateReport +
    # per-axis JSON it already wrote into evals/). Otherwise write a stub.
    if eval_aggregate_full is not None:
        (out / "evals" / "aggregate.json").write_text(
            json.dumps(eval_aggregate_full, indent=2) + "\n"
        )
    else:
        (out / "evals" / "aggregate.json").write_text(json.dumps({
            "schemaVersion": 1, "tier": tier, "generatedAt": generated_at,
            "status": "base-v1-candidate", "defaultEligible": False,
            "results": {"note": "eval suite not run; see eliza-1.manifest.json"},
        }, indent=2) + "\n")
    for backend in ("metal", "vulkan", "cuda", "rocm", "cpu"):
        # placeholder per-backend file the manifest points at; the real
        # verify evidence lives in packages/inference/verify/.
        (out / "evals" / f"{backend}_verify.json").write_text(json.dumps({
            "schemaVersion": 1, "backend": backend,
            "see": f"packages/inference/verify/{backend}-runtime-dispatch-evidence.json",
        }, indent=2) + "\n")

    # --- lineage ---
    lineage = {
        "text": M.LineageEntry(
            base=f"{text_base} (SFT: APOLLO full-parameter)",
            license="apache-2.0",
        ),
        "voice": M.LineageEntry(base="Serveurperso/OmniVoice-GGUF@361609388ae572a820d085185bbbe2a2aac4b30e", license="apache-2.0"),
        "drafter": M.LineageEntry(
            base=f"{drafter_source} (upstream base GGUF; used as self/cross-drafter — not distilled)",
            license="apache-2.0",
        ),
        "asr": M.LineageEntry(base="ggml-org/Qwen3-ASR-0.6B-GGUF@928ab958557df9aa2ef1c93e0e83c7ad0933fae2", license="apache-2.0; review upstream model card before release"),
        "vad": M.LineageEntry(base="onnx-community/silero-vad@e71cae966052b992a7eca6b17738916ce0eca4ec", license="mit"),
    }

    # --- kernel verify backends (cite packages/inference/verify/) ---
    vb = {
        "cpu": M.KernelVerification(
            status="pass", at_commit="08032d57",
            report="packages/inference/verify/cpu-runtime-dispatch-evidence.json",
            device="linux-x64 24-core, CPU reference parity (make reference-test 8/8)",
        ),
        "vulkan": M.KernelVerification(
            status="pass", at_commit="08032d57",
            report="packages/inference/verify/vulkan-runtime-dispatch-evidence.json",
            device="Intel(R) Graphics (ARL) Mesa ANV; also RTX 5080",
            caveat="needs-hardware: broader Vulkan device coverage (Adreno/Mali/Apple-Vulkan) not yet measured",
        ),
        "cuda": M.KernelVerification(
            status="pass", at_commit="08032d57",
            report="packages/inference/verify/cuda-runtime-dispatch-evidence.json",
            device="NVIDIA GeForce RTX 5080 Laptop GPU (Blackwell, cc 12.0)",
            caveat="cuda is not a tier-supported backend for 2b/0_8b — recorded as extra evidence",
        ),
        "metal": M.KernelVerification(
            status="skipped", at_commit="08032d57", report="not-run",
            caveat="needs-hardware: no Apple/Metal device on the build host",
        ),
        "rocm": M.KernelVerification(
            status="skipped", at_commit="08032d57", report="not-applicable",
            caveat="rocm is not a tier-supported backend for 2b/0_8b",
        ),
    }

    # --- provenance ---
    provenance = {
        "releaseState": "base-v1-candidate",
        "finetuned": True,
        "sourceModels": {
            "text": {
                "repo": text_base,
                "convertedVia": "packages/inference/llama.cpp/convert_hf_to_gguf.py + scripts/optimize_for_eliza1.py (PolarQuant/QJL/TurboQuant)",
                "note": "Fine-tuned (APOLLO full-parameter SFT) then optimized. NOT strictly base-v1 semantics — this is a finetuned candidate.",
            },
            "voice": {"repo": "Serveurperso/OmniVoice-GGUF", "file": "omnivoice-base-Q4_K_M.gguf", "note": "frozen, not fine-tuned"},
            "asr": {"repo": "ggml-org/Qwen3-ASR-0.6B-GGUF", "note": "frozen, not fine-tuned"},
            "vad": {"repo": "onnx-community/silero-vad", "note": "frozen Silero v5.1.2 int8"},
            "drafter": {
                "repo": drafter_source,
                "note": "upstream Qwen3.5-lineage GGUF used as the DFlash drafter (shares Qwen3.5 vocabulary with the target); not distilled.",
            },
            # The Zod `z.record(z.enum(slots), ...)` treats every slot as a
            # required key. This bundle ships no dedicated embedding model
            # (pools from the text backbone) and no vision mmproj — record
            # that honestly rather than omitting the keys.
            "embedding": {
                "repo": "n/a",
                "note": "not shipped in this candidate bundle; the runtime pools embeddings from the text backbone.",
            },
            "vision": {
                "repo": "n/a",
                "note": "not shipped in this candidate bundle; the text GGUF is text-only (no mmproj).",
            },
        },
    }

    manifest = M.build_manifest(
        tier=tier,
        version=args.version,
        published_at=generated_at,
        lineage=lineage,
        files={
            "text": [M.FileEntry(**f) for f in text_files],
            "voice": [M.FileEntry(**f) for f in voice_files],
            "asr": [M.FileEntry(**f) for f in asr_files],
            "vision": [],
            "dflash": [M.FileEntry(**f) for f in dflash_files],
            "cache": [M.FileEntry(**f) for f in cache_files],
            "vad": [M.FileEntry(**f) for f in vad_files],
        },
        kernels_required=REQUIRED_KERNELS_BY_TIER[tier],
        kernels_optional=[],
        verified_backends=vb,
        text_eval_score=text_eval_score if text_eval_score is not None else 0.0,
        text_eval_passed=False,
        voice_rtf=voice_rtf if voice_rtf is not None else 0.0,
        voice_rtf_passed=False,
        e2e_loop_ok=e2e_ok,
        thirty_turn_ok=thirty_ok,
        ram_budget_min_mb=RAM_BUDGET_MB[tier][0],
        ram_budget_recommended_mb=RAM_BUDGET_MB[tier][1],
        default_eligible=False,
        asr_wer=asr_wer if asr_wer is not None else 1.0,
        asr_wer_passed=False,
        vad_latency_ms_median=vad_med if vad_med is not None else 0.0,
        vad_latency_ms_passed=False,
        expressive_tag_faithfulness=0.0,
        expressive_mos=0.0,
        expressive_tag_leakage=1.0,
        expressive_passed=False,
        dflash_eval=True,
        dflash_acceptance_rate=dflash_accept,
        dflash_speedup=None,
        dflash_passed=False,
        voice_capabilities=["tts", "emotion-tags", "singing"],
        recipe_manifest={
            "turbo3": {"blockLayoutVersion": "block_turbo3_0:v1", "codebookHash": "turbo_centroids_3bit:8xfp32:seed42:v1", "perBlockTolerance": 0.05},
            "turbo4": {"blockLayoutVersion": "block_turbo4_0:v1", "codebookHash": "turbo_centroids_4bit:16xfp32:seed42:v1", "perBlockTolerance": 0.01},
            "qjl1_256": {"blockLayoutVersion": "block_qjl1_256:v1:34bytes:packed", "codebookHash": "qjl1_256_layout:34bytes:lsb_first:bf16_norm:v1", "perBlockTolerance": 0.05},
            "polar_q4": {"blockLayoutVersion": "block_q4_polar:v1:82bytes:packed", "codebookHash": "polar_q4_centroids:16xfp32:lloyd_max_niter100:v1", "perBlockTolerance": 0.001},
        },
        provenance=provenance,
        require_publish_ready=False,
    )
    # Carry the text quant sidecar info into the manifest for the runtime.
    manifest["textQuant"] = quant_block

    (out / "eliza-1.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # --- checksums ---
    lines = []
    for p in sorted(out.rglob("*")):
        if p.is_file() and p.name != "SHA256SUMS":
            lines.append(f"{sha256_file(p)}  {p.relative_to(out)}")
    (out / "checksums" / "SHA256SUMS").write_text("\n".join(lines) + "\n")

    # --- README ---
    (out / "README.md").write_text(
        _render_readme(tier, manifest, args.drafter_source, optimized=optimized,
                       eval_results=eval_results)
    )

    print(f"staged {tier} bundle at {out}")
    print(f"  text sha256={text_sha}")
    print(f"  drafter sha256={drafter_sha} (source {drafter_source})")
    return 0


def _render_readme(
    tier: str,
    manifest: dict[str, Any],
    drafter_source: str,
    *,
    optimized: bool,
    eval_results: dict[str, Any],
) -> str:
    params = "2B" if tier == "2b" else "0.8B"
    base_repo = TEXT_BASE_BY_TIER[tier]
    if optimized:
        text_para = (
            f"- **Text GGUF** (`text/eliza-1-{tier}-32k.gguf`): a **real fine-tune** "
            "— APOLLO full-parameter SFT on the Eliza-1 training corpus, then run "
            "through the PolarQuant / QJL / TurboQuant optimization stack and "
            "converted to GGUF via the elizaOS/llama.cpp fork. The body is `Q8_0` "
            "(the fork's converter does not yet emit `q4_polar`); the K/V cache uses "
            "QJL / TurboQuant slots. "
        )
    else:
        text_para = (
            f"- **Text GGUF** (`text/eliza-1-{tier}-32k.gguf`): a **real fine-tune** "
            "(APOLLO SFT, smoke/slice run), converted to GGUF via the elizaOS/"
            "llama.cpp fork as a **plain `Q4_K_M`** — the PolarQuant / QJL / "
            "TurboQuant optimization stack has **not** been applied to this "
            "candidate yet (see `textQuant` in the manifest). "
        )
    text_para += (
        f"Text backbone is `{base_repo}` (`Qwen3.5-{params}`)."
    )
    ev = eval_results or {}
    te = ev.get("text_eval")
    vr = ev.get("voice_rtf")
    aw = ev.get("asr_wer")
    da = ev.get("dflash_acceptance")
    eval_line = (
        f"  Latest eval-suite numbers (CPU stand-in engine): text_eval={te}, "
        f"voice_rtf={vr}, asr_wer={aw}, dflash_acceptance={da}, "
        f"e2e_loop_ok={ev.get('e2e_loop_ok')}, thirty_turn_ok={ev.get('thirty_turn_ok')}."
        if ev else
        "  Eval suite has not been run against this bundle yet."
    )
    return f"""---
library_name: gguf
tags: [eliza, elizaos, eliza-1, gguf, on-device, candidate]
---

# elizaos/eliza-1/bundles/{tier} - base-v1 candidate bundle

This is the Eliza-1 **{tier}** on-device bundle, published as a
**`base-v1-candidate`** (`defaultEligible: false`). The runtime can download
and load it on a device whose backend the manifest verified `pass`, but the
recommendation engine will not surface it as a device default until the full
release bar (every supported backend kernel-verified, every eval green) is met.

## What is real vs stand-in

{text_para}
- **Voice / ASR / VAD / cache**: the **frozen `elizaos/eliza-1-assets` bytes** —
  OmniVoice (TTS), Qwen3-ASR-0.6B, Silero-VAD v5.1.2, the default speaker
  preset. Not fine-tuned. Licenses in `licenses/`.
- **DFlash drafter** (`dflash/drafter-{tier}.gguf`): the **upstream
  `{drafter_source}` GGUF** — it shares the Qwen3.5 BPE vocabulary with the text
  target so speculative decoding is correct, but it is NOT a distilled drafter
  (modest acceptance expected). Recorded honestly in
  `provenance.sourceModels.drafter`.

## Verified

- `kernels.verifiedBackends`: **CPU + Vulkan + CUDA = `pass`** (see
  `packages/inference/verify/*-runtime-dispatch-evidence.json` at fork commit
  `08032d57`). **Metal = `skipped`** — no Apple device on the build host.

## Not verified (why this is a candidate, not `defaultEligible`)

- Metal / iOS / Android kernel-verify; the full per-platform dispatch evidence.
- Voice-RTF, ASR-WER, VAD-latency, expressive-voice, e2e / 30-turn loop are
  measured only on a CPU stand-in engine and the TTS/ASR numbers are **poor**;
  recorded honestly in `evals/aggregate.json`, not faked.
{eval_line}

See `eliza-1.manifest.json` for the full machine-readable contract.
"""


if __name__ == "__main__":
    sys.exit(main())
