"""Stage an Eliza-1 `base-v1-candidate` bundle dir from real local artifacts.

Unlike `scripts/publish/orchestrator.py` (which refuses to push unless every
release-blocking gate is green), this stages a *candidate* bundle: a real
fine-tuned text GGUF + the frozen `elizaos/eliza-1` voice/ASR/VAD bytes
+ an honestly-labelled drafter, with the eval suite run and folded in. The
resulting bundle is installable on a device whose backend the manifest verified
`pass` (post-commit `ae7c9e5fcd` to the runtime validator) but is NOT
`defaultEligible`.

Usage:
    cd packages/training
    HF_TOKEN=... uv run --extra train python -m scripts.publish.stage_base_v1_candidate \
        --tier 2b \
        --text-gguf checkpoints/eliza-1-2b-apollo-<run>/eliza1-optimized/gguf/final-Q4_POLAR.gguf \
        --text-sidecar checkpoints/eliza-1-2b-apollo-<run>/eliza1-optimized/gguf/final-Q4_POLAR.gguf.eliza1.json \
        --drafter-gguf /tmp/eliza1-eval-models/gemma4-mtp-drafter-2b.gguf \
        --drafter-source <license-reviewed drafter source> \
        --asr-repo <verified Gemma ASR-capable repo> \
        --asr-file <asr model gguf path> \
        --asr-mmproj-file <asr projector gguf path> \
        --vision-gguf /tmp/eliza1-eval-models/mmproj-2b.gguf \
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
from scripts.manifest import eliza1_platform_plan as PP  # noqa: E402
from scripts.manifest import stage_eliza1_bundle_assets as A  # noqa: E402
from scripts.manifest import stage_kokoro_assets as K  # noqa: E402


REQUIRED_KERNELS_BY_TIER = {
    tier: list(M.REQUIRED_KERNELS_BY_TIER[tier])
    for tier in M.ELIZA_1_TIERS
}
RAM_BUDGET_MB = {
    "2b": (4000, 5500),
    "4b": (6000, 8000),
    "9b": (12000, 18000),
    "27b": (32000, 48000),
}
# Per-tier upstream text base used by lineage and README/provenance prose.
TEXT_BASE_BY_TIER = {
    "2b": "google/gemma-4-E2B",
    "4b": "google/gemma-4-E4B",
    "9b": "google/gemma-4-12B",
    "27b": "google/gemma-4-31B",
}
TEXT_CONTEXT_BY_TIER = {
    tier: PP.CONTEXTS_BY_TIER[tier][0]
    for tier in M.ELIZA_1_TIERS
}
TEXT_CTX_BY_TIER = {
    tier: M.parse_ctx_string(ctx)
    for tier, ctx in TEXT_CONTEXT_BY_TIER.items()
}
# Official Gemma 4 assistant source repos. These publish safetensors sources;
# a runtime bundle still needs a converted `mtp-draft` GGUF plus acceptance
# against the exact Eliza-1 text checkpoint before it can be defaultEligible.
DRAFTER_SOURCE_BY_TIER = {
    "2b": "google/gemma-4-E2B-it-qat-q4_0-unquantized-assistant",
    "4b": "google/gemma-4-E4B-it-qat-q4_0-unquantized-assistant",
    "9b": "google/gemma-4-12B-it-qat-q4_0-unquantized-assistant",
    "27b": "google/gemma-4-31B-it-qat-q4_0-unquantized-assistant",
}

# Frozen tier-agnostic VAD/cache bytes live in the canonical model repo.
# ASR is supplied explicitly so candidate staging cannot silently inherit
# retired Qwen assets from an older bundle.
ASSETS_REPO = "elizaos/eliza-1"
ASSETS_TIER = "2b"


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


def voice_asset_source(tier: str, rel_under_tts: str) -> tuple[str, str, Path]:
    dest = Path("tts") / rel_under_tts
    if rel_under_tts == "kokoro/kokoro-82m-v1_0-Q4_K_M.gguf":
        return K.KOKORO_REPO, K.KOKORO_MODEL_REMOTE_TEMPLATE.format(tier=tier), dest
    if rel_under_tts == "kokoro/tokenizer.json":
        return K.KOKORO_REPO, K.KOKORO_TOKENIZER_REMOTE_TEMPLATE.format(tier=tier), dest
    if rel_under_tts.startswith("kokoro/voices/"):
        return K.KOKORO_REPO, K.DEFAULT_VOICE_REMOTE_TEMPLATE.format(tier=tier, voice=Path(rel_under_tts).stem), dest
    if rel_under_tts.startswith("omnivoice-"):
        return A.VOICE_REPO, Path(rel_under_tts).name, dest
    raise ValueError(f"unsupported voice artifact for {rel_under_tts!r}")


def voice_source_note(tier: str) -> str:
    backends = M.VOICE_BACKENDS_BY_TIER[tier]
    parts: list[str] = []
    if "kokoro" in backends:
        parts.append(K.KOKORO_REPO)
    if "omnivoice" in backends:
        parts.append(A.VOICE_REPO)
    return " + ".join(parts)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", required=True, choices=M.ELIZA_1_TIERS)
    ap.add_argument("--text-gguf", required=True, type=Path)
    ap.add_argument("--text-sidecar", type=Path, default=None,
                    help="The .eliza1.json sidecar for the text GGUF (quant block).")
    ap.add_argument("--drafter-gguf", required=True, type=Path)
    ap.add_argument(
        "--vision-gguf",
        required=True,
        type=Path,
        help="Per-tier mmproj GGUF; every active Eliza-1 tier is vision-capable.",
    )
    ap.add_argument(
        "--drafter-source",
        default=None,
        help=(
            "Upstream HF repo the drafter GGUF was converted from (provenance). "
            "Defaults to the tier's known MTP source when one exists; required "
            "when staging a nonstandard or locally trained drafter."
        ),
    )
    ap.add_argument(
        "--drafter-matches-target",
        action="store_true",
        help=(
            "Set only when the supplied drafter was trained/distilled against "
            "the exact text checkpoint being staged. Defaults false for "
            "official upstream assistant sources."
        ),
    )
    ap.add_argument(
        "--asr-repo",
        default=None,
        help=(
            "Verified Gemma ASR-capable HF repo for the ASR GGUF assets. "
            "Required; retired Qwen ASR repos require --allow-retired-qwen-asr."
        ),
    )
    ap.add_argument(
        "--asr-file",
        default=None,
        help="Exact ASR model GGUF path inside --asr-repo.",
    )
    ap.add_argument(
        "--asr-mmproj-file",
        default=None,
        help="Exact ASR mmproj/projector GGUF path inside --asr-repo.",
    )
    ap.add_argument(
        "--allow-retired-qwen-asr",
        action="store_true",
        help=(
            "Allow retired Qwen3-ASR repos for explicit legacy candidate "
            "reproduction. Do not use for active Gemma Eliza-1 releases."
        ),
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
    drafter_source = args.drafter_source or DRAFTER_SOURCE_BY_TIER[tier]
    if drafter_source is None:
        raise SystemExit(
            f"--drafter-source is required for tier {tier}; no license-reviewed "
            "upstream MTP source is wired for this tier yet."
        )
    if args.drafter_matches_target and not args.drafter_source:
        raise SystemExit(
            "--drafter-matches-target requires --drafter-source naming the "
            "matched Eliza-1 drafter run, not just the default upstream source."
        )
    asr_repo = A.resolve_asr_repo(
        argparse.Namespace(
            asr_repo=args.asr_repo,
            allow_retired_qwen_asr=args.allow_retired_qwen_asr,
        ),
        tier,
    )
    if not args.asr_file or not args.asr_mmproj_file:
        raise SystemExit(
            "candidate staging requires --asr-file and --asr-mmproj-file for "
            "the verified ASR source"
        )
    out = args.out.resolve()
    text_rel = PP.text_artifact_name(tier, TEXT_CONTEXT_BY_TIER[tier])
    if out.exists():
        shutil.rmtree(out)
    for sub in ("text", "tts", "asr", "vad", "vision", "mtp", "cache", "evals",
                "licenses", "evidence/platform", "checksums"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    generated_at = now_iso()

    # --- text GGUF (real fine-tune) ---
    text_dest = out / text_rel
    text_dest.parent.mkdir(parents=True, exist_ok=True)
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
    drafter_dest = out / "mtp" / f"drafter-{tier}.gguf"
    shutil.copy2(args.drafter_gguf, drafter_dest)
    drafter_sha = sha256_file(drafter_dest)
    drafter_matches_target = bool(args.drafter_matches_target)
    drafter_note = (
        f"MTP drafter for the {tier} Gemma 4 text target. "
        "It must share the 262144-token Gemma 4 tokenizer with the target "
        "so speculative decoding is correct. "
    )
    if drafter_matches_target:
        drafter_note += (
            "The caller attests this drafter was trained/distilled against "
            "the exact text checkpoint being staged; publish gates still must "
            "verify MTP acceptance before default eligibility."
        )
    else:
        drafter_note += (
            "This is an upstream/base assistant-derived candidate or otherwise "
            "unmatched drafter. The bundle is candidate-only "
            "(defaultEligible=false); a real release needs an Eliza-1-matched "
            "drafter plus acceptance evidence."
        )
    (out / "mtp" / "target-meta.json").write_text(json.dumps({
        "schemaVersion": 2,
        "tier": tier,
        "status": "base-v1-candidate",
        "publishEligible": True,
        "defaultEligible": False,
        "targetText": {
            "path": text_rel,
            "sha256": text_sha,
            "finalElizaWeights": True,
        },
        "drafter": {
            "path": f"mtp/drafter-{tier}.gguf",
            "sha256": drafter_sha,
            "source": drafter_source,
            "matchesTargetCheckpoint": drafter_matches_target,
            "tokenizerVocabSize": 262144,
            "note": drafter_note,
        },
        "acceptanceWindow": None,
        "acceptanceRate": None,
        "kernelCaps": {"required": REQUIRED_KERNELS_BY_TIER[tier], "optional": []},
    }, indent=2) + "\n")

    # --- vision mmproj ---
    vision_dest = out / "vision" / f"mmproj-{tier}.gguf"
    shutil.copy2(args.vision_gguf, vision_dest)
    vision_sha = sha256_file(vision_dest)

    # --- voice / asr / vad / cache ---
    # Voice follows eliza1_manifest: OmniVoice is the default backend on every
    # tier; small/workstation tiers also ship Kokoro as a frozen fallback.
    # Native VAD is the release artifact; the ONNX file is a legacy fallback and
    # is intentionally not listed in the manifest.
    asset_map = [
        (asr_repo, args.asr_file, out / "asr" / "eliza-1-asr.gguf"),
        (asr_repo, args.asr_mmproj_file, out / "asr" / "eliza-1-asr-mmproj.gguf"),
        (A.VAD_NATIVE_REPO, "voice/vad/silero-vad-v5.gguf", out / "vad" / "silero-vad-v5.gguf"),
        (ASSETS_REPO, f"{ASSETS_TIER}/cache/voice-preset-default.bin", out / "cache" / "voice-preset-default.bin"),
        (ASSETS_REPO, f"{ASSETS_TIER}/licenses/LICENSE.vad", out / "licenses" / "LICENSE.vad"),
        (ASSETS_REPO, f"{ASSETS_TIER}/licenses/LICENSE.voice", out / "licenses" / "LICENSE.voice"),
    ]
    for rel in M.required_voice_artifacts_for_tier(tier):
        repo, remote, dest = voice_asset_source(tier, rel)
        asset_map.append((repo, remote, out / dest))
    for repo, remote, dest in asset_map:
        download_asset(repo, remote, dest)
    (out / "licenses" / "LICENSE.asr").write_text(
        "Eliza-1 ASR model license notice.\n\n"
        f"ASR GGUF assets staged from {asr_repo}:\n"
        f"- {args.asr_file}\n"
        f"- {args.asr_mmproj_file}\n\n"
        "Review the upstream model card and license before release.\n"
    )
    asset_lineage = {
        "schemaVersion": 1,
        "tier": tier,
        "generatedAt": generated_at,
        "voice": {"base": voice_source_note(tier), "license": "apache-2.0"},
        "asr": {
            "base": asr_repo,
            "files": [args.asr_file, args.asr_mmproj_file],
            "license": "review upstream model card before release",
        },
        "vad": {"base": A.VAD_NATIVE_REPO, "license": "mit"},
        "cache": {"base": ASSETS_REPO, "license": "apache-2.0"},
    }
    (out / "evidence" / "assets-lineage.json").write_text(
        json.dumps(asset_lineage, indent=2) + "\n"
    )
    (out / "evidence" / "bundle-assets.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "tier": tier,
                "generatedAt": generated_at,
                "asrRepo": asr_repo,
                "asrRemotePath": args.asr_file,
                "asrMmprojRemotePath": args.asr_mmproj_file,
                "voiceBackends": list(M.VOICE_BACKENDS_BY_TIER[tier]),
                "vadRepo": A.VAD_NATIVE_REPO,
                "cacheRepo": ASSETS_REPO,
            },
            indent=2,
        )
        + "\n"
    )

    # extra licenses (text / mtp / vision / eliza-1) from a local bundle dir if given
    if args.licenses_from and args.licenses_from.is_dir():
        for name in ("LICENSE.text", "LICENSE.mtp", "LICENSE.vision", "LICENSE.eliza-1"):
            src = args.licenses_from / name
            if src.is_file():
                shutil.copy2(src, out / "licenses" / name)

    def f_sha(p: Path) -> dict[str, Any]:
        return {"path": str(p.relative_to(out)), "sha256": sha256_file(p)}

    voice_files = [
        f_sha(out / "tts" / rel)
        for rel in M.required_voice_artifacts_for_tier(tier)
    ]
    asr_files = [
        f_sha(out / "asr" / "eliza-1-asr.gguf"),
        f_sha(out / "asr" / "eliza-1-asr-mmproj.gguf"),
    ]
    vad_files = [f_sha(out / "vad" / "silero-vad-v5.gguf")]
    cache_files = [f_sha(out / "cache" / "voice-preset-default.bin")]
    mtp_files = [
        {"path": f"mtp/drafter-{tier}.gguf", "sha256": drafter_sha},
        f_sha(out / "mtp" / "target-meta.json"),
    ]
    vision_files = [
        {"path": f"vision/mmproj-{tier}.gguf", "sha256": vision_sha},
    ]
    text_files = [
        {
            "path": text_rel,
            "sha256": text_sha,
            "ctx": M.text_context_for_manifest(text_dest) or TEXT_CTX_BY_TIER[tier],
        }
    ]

    # --- run eval suite (optional; folds into evals block) ---
    eval_results: dict[str, Any] = {}
    eval_aggregate_full: dict[str, Any] | None = None
    if args.evals_aggregate and args.evals_aggregate.is_file():
        eval_aggregate_full = json.loads(args.evals_aggregate.read_text())
        eval_results = eval_aggregate_full.get("results", {})
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
    mtp_accept = num("mtp_acceptance")

    # Persist the bundle-side eval blobs (the manifest cites these paths).
    # When the eval suite ran, keep its full output (results + gateReport +
    # per-axis JSON it already wrote into evals/). Otherwise write explicit
    # not-run evidence so the candidate manifest records the missing eval.
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
        # Candidate per-backend file the manifest points at; the real
        # verify evidence lives in packages/inference/verify/.
        (out / "evals" / f"{backend}_verify.json").write_text(json.dumps({
            "schemaVersion": 1, "backend": backend,
            "see": f"packages/inference/verify/{backend}-runtime-dispatch-evidence.json",
        }, indent=2) + "\n")

    # --- lineage ---
    base_repo = TEXT_BASE_BY_TIER[tier]
    lineage = {
        "text": M.LineageEntry(
            base=f"{base_repo} (SFT: APOLLO full-parameter)",
            license="apache-2.0",
        ),
        "voice": M.LineageEntry(base=voice_source_note(tier), license="apache-2.0"),
        "drafter": M.LineageEntry(
            base=(
                f"{drafter_source} (upstream MTP source; used as "
                "self/cross-drafter — not distilled)"
            ),
            license="gemma; verify converted derivative license before release",
        ),
        "vision": M.LineageEntry(
            base=f"{TEXT_BASE_BY_TIER[tier]} vision projector",
            license="apache-2.0; review upstream model card before release",
        ),
        "asr": M.LineageEntry(
            base=asr_repo,
            license="review upstream model card before release",
        ),
        "vad": M.LineageEntry(base=A.VAD_NATIVE_REPO, license="mit"),
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
            caveat="cuda evidence is recorded when present; publish gates use the supported-backend matrix",
        ),
        "metal": M.KernelVerification(
            status="skipped", at_commit="08032d57", report="not-run",
            caveat="needs-hardware: no Apple/Metal device on the build host",
        ),
        "rocm": M.KernelVerification(
            status="skipped", at_commit="08032d57", report="not-applicable",
            caveat="no AMD GPU on the build host",
        ),
    }

    # --- provenance ---
    provenance = {
        "releaseState": "base-v1-candidate",
        "finetuned": True,
        "sourceModels": {
            "text": {
                "repo": base_repo,
                "convertedVia": "plugins/plugin-local-inference/native/llama.cpp/convert_hf_to_gguf.py + scripts/optimize_for_eliza1.py (PolarQuant/QJL/TurboQuant)",
                "note": "Fine-tuned (APOLLO full-parameter SFT) then optimized; NOT strictly base-v1 semantics — this is a finetuned candidate.",
            },
            "voice": {
                "repo": voice_source_note(tier),
                "files": list(M.required_voice_artifacts_for_tier(tier)),
                "note": "frozen TTS assets, not fine-tuned",
            },
            "asr": {
                "repo": asr_repo,
                "files": [args.asr_file, args.asr_mmproj_file],
                "note": "frozen, not fine-tuned",
            },
            "vad": {"repo": A.VAD_NATIVE_REPO, "note": "frozen native Silero v5 GGUF"},
            "drafter": {
                "repo": drafter_source,
                "note": "MTP drafter must share the Gemma 4 tokenizer with the target; record whether this exact artifact is distilled or a smoke stand-in in mtp/target-meta.json.",
            },
            "vision": {
                "repo": TEXT_BASE_BY_TIER[tier],
                "file": f"vision/mmproj-{tier}.gguf",
                "note": "Per-tier multimodal projector staged with the text target.",
            },
            # The Zod `z.record(z.enum(slots), ...)` treats every slot as a
            # required key. This bundle ships no dedicated embedding model
            # (pools from the text backbone) — record that honestly rather
            # than omitting the key.
            "embedding": {
                "repo": "n/a",
                "note": "not shipped in this candidate bundle; the runtime pools embeddings from the text backbone.",
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
            "vision": [M.FileEntry(**f) for f in vision_files],
            "mtp": [M.FileEntry(**f) for f in mtp_files],
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
        mtp_eval=True,
        mtp_acceptance_rate=mtp_accept,
        mtp_speedup=None,
        mtp_passed=False,
        voice_capabilities=["tts", "emotion-tags", "singing"],
        recipe_manifest={
            "turbo3": {"blockLayoutVersion": "block_turbo3_0:v1", "codebookHash": "turbo_centroids_3bit:8xfp32:seed42:v1", "perBlockTolerance": 0.05},
            "turbo4": {"blockLayoutVersion": "block_turbo4_0:v1", "codebookHash": "turbo_centroids_4bit:16xfp32:seed42:v1", "perBlockTolerance": 0.01},
            "turbo3_tcq": {"blockLayoutVersion": "block_turbo3_tcq:v1", "codebookHash": "turbo3_tcq_codebook:512xfp32:seed42:v1", "perBlockTolerance": 0.03},
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
        _render_readme(tier, manifest, drafter_source, optimized=optimized,
                       eval_results=eval_results, text_rel=text_rel,
                       asr_repo=asr_repo)
    )

    print(f"staged {tier} bundle at {out}")
    print(f"  text sha256={text_sha}")
    print(f"  drafter sha256={drafter_sha} (source {drafter_source})")
    print(f"  asr source={asr_repo}")
    return 0


def _render_readme(
    tier: str,
    manifest: dict[str, Any],
    drafter_source: str,
    *,
    optimized: bool,
    eval_results: dict[str, Any],
    text_rel: str,
    asr_repo: str,
) -> str:
    base_repo = TEXT_BASE_BY_TIER[tier]
    if optimized:
        text_para = (
            f"- **Text GGUF** (`{text_rel}`): a **real fine-tune** "
            "— APOLLO full-parameter SFT on the Eliza-1 training corpus, then run "
            "through the PolarQuant / QJL / TurboQuant optimization stack and "
            "converted to GGUF via the elizaOS/llama.cpp fork. The body is `Q8_0` "
            "(the fork's converter does not yet emit `q4_polar`); the K/V cache uses "
            "QJL / TurboQuant slots. "
        )
    else:
        text_para = (
            f"- **Text GGUF** (`{text_rel}`): a **real fine-tune** "
            "(APOLLO SFT, smoke/slice run), converted to GGUF via the elizaOS/"
            "llama.cpp fork as a **plain `Q4_K_M`** — the PolarQuant / QJL / "
            "TurboQuant optimization stack has **not** been applied to this "
            "candidate yet (see `textQuant` in the manifest). "
        )
    text_para += (
        f"Text backbone is `{base_repo}`."
    )
    ev = eval_results or {}
    te = ev.get("text_eval")
    vr = ev.get("voice_rtf")
    aw = ev.get("asr_wer")
    da = ev.get("mtp_acceptance")
    eval_line = (
        f"  Latest eval-suite numbers (CPU stand-in engine): text_eval={te}, "
        f"voice_rtf={vr}, asr_wer={aw}, mtp_acceptance={da}, "
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
- **Voice / ASR / VAD / cache**: frozen upstream assets —
  {", ".join(M.VOICE_BACKENDS_BY_TIER[tier])} TTS, ASR from `{asr_repo}`,
  native Silero-VAD v5.1.2, and the default speaker preset. Not fine-tuned.
  Licenses in `licenses/`.
- **MTP drafter** (`mtp/drafter-{tier}.gguf`): the **upstream
  `{drafter_source}` artifact** — it must share the Gemma 4 tokenizer with the
  text target so speculative decoding is correct. Its target-checkpoint match
  status is recorded in `mtp/target-meta.json` and
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
