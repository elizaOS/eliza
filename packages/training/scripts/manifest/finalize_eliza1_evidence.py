"""Recompute evidence/release.json + platform/dispatch evidence for a staged Eliza-1 bundle.

This is the deterministic "finalize" step the publish pipeline runs after
weights are staged: it (a) regenerates the licenses/ set + sidecar with
verbatim upstream SPDX text, (b) recomputes the `final.*` flags from the
artifacts actually present, (c) writes the per-platform pending evidence reports
(`evidence/platform/<target>.json`) so the publish gate sees a complete
set and reports precisely which targets are pending, (d) refreshes the
checksums manifest, and (e) re-derives `releaseState`, `publishEligible`,
`defaultEligible`, and an accurate `publishBlockingReasons` list.

It does NOT fabricate hardware evidence. A platform whose verify run has
not been done against the staged bytes gets `status: "pending"` plus the
exact command to produce the evidence. `final.platformEvidence` /
`final.kernelDispatchReports` are only `true` when *every required*
target / backend has a `pass` / `runtimeReady: true` report — which is
not the case for any tier until at least the desktop/mobile targets have
been run on real hardware against the real fork build.

`final.licenses` IS flipped to `true` here: the real upstream license
text is in place once `eliza1_licenses.write_bundle_licenses()` has run
and `verify_bundle_licenses()` is clean.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, Mapping, Sequence

try:
    from scripts.manifest.eliza1_licenses import (
        verify_bundle_licenses,
        write_bundle_licenses,
    )
    from scripts.manifest.eliza1_manifest import (
        ELIZA_1_HF_REPO,
        ELIZA_1_VISION_TIERS,
        SUPPORTED_BACKENDS_BY_TIER,
        validate_manifest,
    )
    from scripts.manifest.eliza1_platform_plan import (
        REQUIRED_PLATFORM_EVIDENCE_BY_TIER,
        _target_backend,
    )
except ImportError:  # pragma: no cover - script execution path
    from eliza1_licenses import verify_bundle_licenses, write_bundle_licenses  # type: ignore
    from eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_VISION_TIERS, SUPPORTED_BACKENDS_BY_TIER, validate_manifest  # type: ignore
    from eliza1_platform_plan import (  # type: ignore
        REQUIRED_PLATFORM_EVIDENCE_BY_TIER,
        _target_backend,
    )

# How an operator produces each kind of evidence. Keyed by backend.
_RUNNER_BY_BACKEND: Final[Mapping[str, str]] = {
    "metal": (
        "on a real Apple-silicon device: build the fork "
        "(node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal), "
        "then `make -C packages/inference/verify metal_verify metal-dispatch-smoke`, "
        "then run packages/app-core/src/services/local-inference verify-on-device "
        "against the staged bundle bytes and copy the JSON here."
    ),
    "vulkan": (
        "build the fork (node packages/app-core/scripts/build-llama-cpp-dflash.mjs "
        "--target <linux|windows>-x64-vulkan) and `make -C packages/inference/verify "
        "vulkan_verify vulkan-dispatch-smoke`, then run verify-on-device against the "
        "staged bundle bytes on a real GPU and copy the JSON here. (On the dev "
        "workstation Intel ANV iGPU: vulkan-verify 8/8 + multi-block 8/8 + fused "
        "1920/1920 + vulkan-dispatch-smoke 7/7 against synthetic fixtures — see "
        "packages/inference/verify/hardware-results/linux-vulkan-fork-build-a1-a2-d1-2026-05-11.json "
        "— but no verify-on-device pass against the staged GGUFs yet.)"
    ),
    "cuda": (
        "on an NVIDIA host: build the fork "
        "(node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda), "
        "run packages/inference/verify/cuda_runner.sh (cuda_verify.cu), then verify-on-device "
        "against the staged bundle bytes. See packages/inference/reports/porting/2026-05-11/"
        "cuda-bringup-operator-steps.md."
    ),
    "rocm": (
        "on an AMD ROCm host: build the fork with GGML_HIP=ON and run the kernel verify + "
        "verify-on-device against the staged bundle bytes."
    ),
    "cpu": (
        "build the fork (CPU backend) and run packages/inference/verify/cpu_bench "
        "(cpu_bench.c — reference path) + `make -C packages/inference/verify reference-test`, "
        "then run verify-on-device against the staged bundle bytes. The reference path is "
        "verified on the dev workstation (24-core Arrow Lake, AVX-VNNI) — see "
        "packages/inference/verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json "
        "— but no verify-on-device pass against the staged GGUFs yet."
    ),
}

_REQUIRED_GRAPH_CACHE_FAMILIES: Final[tuple[str, ...]] = (
    "turbo3",
    "turbo4",
    "turbo3_tcq",
    "qjl",
    "polar",
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _git_short_sha(repo_root: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def _sha256(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(c in "0123456789abcdef" for c in value)
    )


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _detect_tier(bundle_dir: Path) -> str:
    name = bundle_dir.name
    for suffix in (".bundle",):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    if name.startswith("eliza-1-"):
        return name[len("eliza-1-") :]
    rel = _read_json(bundle_dir / "evidence" / "release.json")
    if rel and isinstance(rel.get("tier"), str):
        return rel["tier"]
    raise SystemExit(f"cannot infer tier from bundle dir {bundle_dir}")


def _detect_components(bundle_dir: Path) -> list[str]:
    tier = _detect_tier(bundle_dir)
    components = ["text", "voice", "asr", "vad", "dflash"]
    tts_dir = bundle_dir / "tts"
    if (tts_dir / "kokoro").is_dir() and any((tts_dir / "kokoro").iterdir()):
        components.append("kokoro")
    if tts_dir.is_dir() and any(tts_dir.glob("omnivoice-*.gguf")):
        components.append("omnivoice")
    if (
        tier in ELIZA_1_VISION_TIERS
        and (bundle_dir / "vision").is_dir()
        and any((bundle_dir / "vision").iterdir())
    ):
        components.append("vision")
    if (bundle_dir / "embedding").is_dir() and any(
        (bundle_dir / "embedding").iterdir()
    ):
        components.append("embedding")
    if (bundle_dir / "wakeword").is_dir() and any((bundle_dir / "wakeword").iterdir()):
        components.append("wakeword")
    return components


def _prune_stale_license_files(
    licenses_dir: Path, written_relpaths: Sequence[str]
) -> list[str]:
    """Remove obsolete LICENSE.* files not selected for this bundle layout."""

    keep = {Path(rel).name for rel in written_relpaths}
    removed: list[str] = []
    if not licenses_dir.is_dir():
        return removed
    for path in sorted(licenses_dir.glob("LICENSE.*")):
        if path.name in keep:
            continue
        path.unlink()
        removed.append(f"licenses/{path.name}")
    return removed


def _lineage_entry(
    data: Mapping[str, Any],
    key: str,
    *,
    fallback_base: str,
    bundle_root: str,
) -> dict[str, Any]:
    existing = data.get(key)
    if isinstance(existing, dict):
        base = str(existing.get("base") or fallback_base)
        license_id = str(existing.get("license") or "apache-2.0")
        out = dict(existing)
        out["base"] = base
        out["license"] = license_id
        out.setdefault("bundleRoot", bundle_root)
        return out
    return {
        "base": fallback_base,
        "license": "apache-2.0",
        "bundleRoot": bundle_root,
    }


def _sync_voice_lineage(bundle_dir: Path, components: Sequence[str]) -> None:
    comp_set = set(components)
    lineage_path = bundle_dir / "lineage.json"
    lineage: dict[str, Any] = {}
    if lineage_path.is_file():
        existing = _read_json(lineage_path)
        if isinstance(existing, dict):
            lineage = dict(existing)

    voice_entries: list[dict[str, Any]] = []
    if "omnivoice" in comp_set:
        omni = _lineage_entry(
            lineage,
            "omnivoice",
            fallback_base="Serveurperso/OmniVoice-GGUF",
            bundle_root="tts",
        )
        lineage["omnivoice"] = omni
        voice_entries.append(omni)
    if "kokoro" in comp_set:
        kokoro = _lineage_entry(
            lineage,
            "kokoro",
            fallback_base="onnx-community/Kokoro-82M-v1.0-ONNX",
            bundle_root="tts/kokoro",
        )
        lineage["kokoro"] = kokoro
        voice_entries.append(kokoro)
    if not voice_entries:
        return

    voice_base = "; ".join(
        str(entry.get("base")) for entry in voice_entries if entry.get("base")
    )
    voice = dict(lineage.get("voice") or {})
    voice["base"] = voice_base
    voice["license"] = "apache-2.0"
    if len(voice_entries) == 1:
        voice["bundleRoot"] = voice_entries[0].get("bundleRoot")
    else:
        voice["bundleRoot"] = "tts"
        voice["backends"] = [
            backend for backend in ("omnivoice", "kokoro") if backend in comp_set
        ]
    lineage["voice"] = voice
    lineage_path.write_text(
        json.dumps(lineage, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    manifest_path = bundle_dir / "eliza-1.manifest.json"
    manifest = _read_json(manifest_path)
    if isinstance(manifest, dict):
        manifest_lineage = manifest.setdefault("lineage", {})
        if isinstance(manifest_lineage, dict):
            manifest_lineage["voice"] = {
                "base": voice["base"],
                "license": voice["license"],
            }
            manifest_path.write_text(
                json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
            )


def _sync_manifest_file_hashes(bundle_dir: Path) -> list[str]:
    manifest_path = bundle_dir / "eliza-1.manifest.json"
    manifest = _read_json(manifest_path)
    if not isinstance(manifest, dict):
        return []
    files = manifest.get("files")
    if not isinstance(files, dict):
        return []

    updated: list[str] = []
    for entries in files.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            rel = entry.get("path")
            if not isinstance(rel, str):
                continue
            path = bundle_dir / rel
            if not path.is_file():
                continue
            digest = _sha256(path)
            if entry.get("sha256") != digest:
                entry["sha256"] = digest
                updated.append(rel)
    if updated:
        manifest_path.write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
    return updated


def _current_text_sha256s(bundle_dir: Path) -> set[str]:
    manifest = _read_json(bundle_dir / "eliza-1.manifest.json") or {}
    files = manifest.get("files")
    out: set[str] = set()
    if isinstance(files, dict):
        text_entries = files.get("text")
        if isinstance(text_entries, list):
            for entry in text_entries:
                if not isinstance(entry, dict):
                    continue
                rel = entry.get("path")
                if not isinstance(rel, str):
                    continue
                path = bundle_dir / rel
                if path.is_file():
                    out.add(_sha256(path))
    if out:
        return out
    text_dir = bundle_dir / "text"
    if text_dir.is_dir():
        for path in text_dir.glob("*.gguf"):
            if path.is_file():
                out.add(_sha256(path))
    return out


def _dispatch_pass_errors(
    report: Mapping[str, Any] | None,
    backend: str,
    text_sha256s: set[str],
) -> list[str]:
    if not report:
        return ["missing or invalid JSON"]
    errors: list[str] = []
    if report.get("backend") != backend:
        errors.append(f"backend {report.get('backend')!r} != {backend!r}")
    if report.get("status") != "pass":
        errors.append(f"status {report.get('status')!r} != 'pass'")
    if report.get("runtimeReady") is not True:
        errors.append("runtimeReady is not true")
    if not isinstance(report.get("atCommit") or report.get("at_commit"), str):
        errors.append("atCommit missing")
    if not isinstance(report.get("report"), str) or not report.get("report"):
        errors.append("report missing")
    model_sha = report.get("modelSha256")
    if not _is_sha256(model_sha):
        errors.append("modelSha256 missing or invalid")
    elif text_sha256s and model_sha not in text_sha256s:
        errors.append("modelSha256 does not match any staged text GGUF")
    kernel_set = report.get("kernelSet")
    if not isinstance(kernel_set, list) or not all(
        isinstance(k, str) for k in kernel_set
    ):
        errors.append("kernelSet must be an array of strings")
    else:
        missing = sorted(set(_REQUIRED_GRAPH_CACHE_FAMILIES) - set(kernel_set))
        if missing:
            errors.append(f"kernelSet missing {missing}")
    graph = report.get("graphDispatch")
    if not isinstance(graph, dict):
        errors.append("graphDispatch missing")
    else:
        families = graph.get("cacheFamilies")
        if not isinstance(families, list) or not all(
            isinstance(f, str) for f in families
        ):
            errors.append("graphDispatch.cacheFamilies must be an array of strings")
        else:
            missing = sorted(set(_REQUIRED_GRAPH_CACHE_FAMILIES) - set(families))
            if missing:
                errors.append(f"graphDispatch.cacheFamilies missing {missing}")
        command = graph.get("command")
        if not isinstance(command, str) or "--cache-type-k" not in command:
            errors.append("graphDispatch.command must include --cache-type-k")
        logs = graph.get("logs")
        if not isinstance(logs, list) or not logs:
            errors.append("graphDispatch.logs missing")
    device = report.get("device")
    if not isinstance(device, (dict, str)) or device == "":
        errors.append("device missing")
    return errors


def _backend_dispatch_runtime_ready(bundle_dir: Path, backend: str) -> bool:
    """True iff the dispatch report proves runtime graph dispatch for the bundle."""
    report = _read_json(bundle_dir / "evals" / f"{backend}_dispatch.json")
    return not _dispatch_pass_errors(report, backend, _current_text_sha256s(bundle_dir))


def _platform_pass_errors(report: Mapping[str, Any] | None, target: str) -> list[str]:
    if not report:
        return ["missing or invalid JSON"]
    errors: list[str] = []
    backend = _target_backend(target)
    if report.get("target") != target:
        errors.append(f"target {report.get('target')!r} != {target!r}")
    if report.get("backend") != backend:
        errors.append(f"backend {report.get('backend')!r} != {backend!r}")
    if report.get("status") != "pass":
        errors.append(f"status {report.get('status')!r} != 'pass'")
    if not isinstance(report.get("device"), (dict, str)) or report.get("device") == "":
        errors.append("device missing")
    if not isinstance(report.get("atCommit") or report.get("at_commit"), str):
        errors.append("atCommit missing")
    if not isinstance(report.get("report"), str) or not report.get("report"):
        errors.append("report missing")
    if report.get("skippedVoiceAbi") is True:
        errors.append("skippedVoiceAbi must not be true")
    if target == "ios-arm64-metal" and report.get("voiceAbi") not in (
        True,
        "pass",
        "passed",
    ):
        errors.append("ios-arm64-metal voiceAbi proof missing")
    return errors


def _platform_target_pass(bundle_dir: Path, target: str) -> bool:
    report = _read_json(bundle_dir / "evidence" / "platform" / f"{target}.json")
    return not _platform_pass_errors(report, target)


# Real partial evidence captured on the dev workstation (24-core Arrow
# Lake, Intel Arc/Xe ANV iGPU). NOT a verify-on-device pass against the
# staged bundle bytes — that requires a real fork build + a GPU pass on
# the actual GGUFs — so status stays `pending`, but the partial evidence
# (kernel verify on synthetic fixtures, dispatch-smoke, bench) is
# recorded so the gate report is precise about what HAS been checked.
_DEV_WORKSTATION_PARTIAL: Final[Mapping[str, Mapping[str, Any]]] = {
    "linux-x64-cpu": {
        "device": "Intel Core Ultra 9 275HX (Arrow Lake-HX, 24 cores; AVX2 + AVX-VNNI + F16C, no AVX-512); 30 GB RAM; Linux 6.17",
        "partialEvidence": {
            "referenceTest": "make -C packages/inference/verify reference-test — clean; gen_fixture --self-test all finite",
            "cpuBench": "cpu_bench.c reference path (single-thread): turbo3=19.41ms turbo4=12.18ms turbo3_tcq=17.66ms qjl=110.77ms polar=31.25ms (median over 3 runs, head_dim=128 seq=4096); AVX-VNNI int8 QJL score 5.25x vs fp32-AVX2",
            "kernelContract": "node packages/inference/verify/check_kernel_contract.mjs — OK kernels=6 targets=23",
            "evidenceFiles": [
                "packages/inference/verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json",
                "packages/inference/verify/bench_results/cpu_avxvnni_2026-05-11.json",
            ],
        },
        "missing": "no verify-on-device pass (load -> 1-token text gen -> 1-phrase voice gen -> barge-in) against the staged bundle GGUFs; the partial evidence above is against synthetic fixtures, not the shipped bytes",
    },
    "linux-x64-vulkan": {
        "device": "Intel(R) Graphics (ARL) — Intel open-source Mesa ANV driver, Vulkan api 1.4.318, warp size 32 (no int dot, no matrix cores)",
        "partialEvidence": {
            "vulkanVerify": "vulkan-verify 8/8 PASS (turbo3/turbo4/turbo3_tcq/qjl/polar/polar+QJL/polar_preht/polar_preht+QJL), max_diff <= 7.6e-6",
            "vulkanVerifyMultiblock": "vulkan-verify-multiblock 8/8 PASS, max_diff <= 7.6e-6",
            "vulkanVerifyFused": "vulkan-verify-fused 1920/1920 PASS across 4 cases, max_diff <= 6.3e-7",
            "vulkanDispatchSmoke": "make -C packages/inference/verify vulkan-dispatch-smoke — 7/7 PASS (GGML_OP_ATTN_SCORE_QJL, _TBQ/turbo3, _TBQ/turbo4, _TBQ/turbo3_tcq, _POLAR x2, GGML_OP_FUSED_ATTN_QJL_TBQ)",
            "forkBuild": "node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-vulkan — OK (15 standalone .comp staged incl 4 *_multi + 2 fused_attn_*; CPU-SIMD QJL avxvnni TUs; runtime graph dispatch)",
            "evidenceFiles": [
                "packages/inference/verify/hardware-results/linux-vulkan-fork-build-a1-a2-d1-2026-05-11.json",
            ],
        },
        "missing": "no verify-on-device pass against the staged bundle GGUFs; the kernel verify + dispatch-smoke above are against synthetic fixtures, not the shipped bytes; also: kernel-contract.json fusedAttn.runtimeStatus.vulkan not yet flipped (evidence-agent call)",
    },
}


def write_platform_pending_evidence(
    bundle_dir: Path, tier: str, commit: str
) -> tuple[list[str], list[str]]:
    """Write a `evidence/platform/<target>.json` for every required target.

    Returns `(passing_targets, pending_targets)`. Existing reports with a
    `pass` status are left untouched; everything else is (re)written as a
    `pending` report recording the exact command to produce real evidence
    (plus any real partial evidence captured on the dev workstation).
    """
    platform_dir = bundle_dir / "evidence" / "platform"
    platform_dir.mkdir(parents=True, exist_ok=True)
    passing: list[str] = []
    pending: list[str] = []
    now = _utc_now()
    for target in REQUIRED_PLATFORM_EVIDENCE_BY_TIER[tier]:
        path = platform_dir / f"{target}.json"
        existing = _read_json(path)
        previous_errors = _platform_pass_errors(existing, target)
        if not previous_errors:
            passing.append(target)
            continue
        backend = _target_backend(target)
        pending_report: dict[str, Any] = {
            "schemaVersion": 1,
            "target": target,
            "backend": backend,
            "tier": tier,
            "status": "pending",
            "atCommit": commit,
            "generatedAt": now,
            "device": f"<not run> ({target})",
            "report": "not-run",
            "reason": (
                f"no verify-on-device pass against the staged Eliza-1 {tier} bundle "
                f"bytes on a {target} host yet"
            ),
            "howToProduce": _RUNNER_BY_BACKEND.get(
                backend,
                "run the backend kernel verify + verify-on-device against the staged bytes",
            ),
        }
        partial = _DEV_WORKSTATION_PARTIAL.get(target)
        if partial is not None:
            pending_report["device"] = partial["device"]
            pending_report["partialEvidence"] = partial["partialEvidence"]
            pending_report["reason"] = partial["missing"]
        if existing and existing.get("status") == "pass":
            pending_report["invalidPreviousReport"] = previous_errors
        path.write_text(
            json.dumps(pending_report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        pending.append(target)
    return sorted(passing), sorted(pending)


def write_dispatch_pending_evidence(
    bundle_dir: Path, tier: str, commit: str
) -> tuple[list[str], list[str]]:
    """Ensure a `evals/<backend>_dispatch.json` exists for every supported backend.

    Returns `(runtime_ready_backends, pending_backends)`. Existing reports
    with `runtimeReady: true` + `status: pass` are left untouched.
    """
    evals_dir = bundle_dir / "evals"
    evals_dir.mkdir(parents=True, exist_ok=True)
    ready: list[str] = []
    pending: list[str] = []
    now = _utc_now()
    text_sha256s = _current_text_sha256s(bundle_dir)
    for backend in SUPPORTED_BACKENDS_BY_TIER[tier]:
        path = evals_dir / f"{backend}_dispatch.json"
        existing = _read_json(path)
        previous_errors = _dispatch_pass_errors(existing, backend, text_sha256s)
        if not previous_errors:
            ready.append(backend)
            continue
        pending_report: dict[str, Any] = {
            "schemaVersion": 1,
            "backend": backend,
            "tier": tier,
            "status": (
                "needs-hardware" if backend in {"metal", "cuda", "rocm"} else "pending"
            ),
            "runtimeReady": False,
            "atCommit": commit,
            "generatedAt": now,
            "report": "not-run",
            "reason": (
                f"{backend} kernel-dispatch (verify-on-device against the staged Eliza-1 "
                f"{tier} bundle bytes) not yet run"
            ),
            "howToProduce": _RUNNER_BY_BACKEND.get(
                backend, "run verify-on-device against the staged bytes"
            ),
        }
        if backend == "cpu":
            pending_report["partialEvidence"] = {
                "referenceTest": "make -C packages/inference/verify reference-test — clean (gen_fixture --self-test all finite)",
                "kernelContract": "node packages/inference/verify/check_kernel_contract.mjs — OK kernels=6 targets=23",
                "note": "CPU reference path verified on the dev workstation against synthetic fixtures; not yet against the staged bundle GGUFs",
                "evidenceFiles": [
                    "packages/inference/verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json"
                ],
            }
        elif backend == "vulkan":
            pending_report["partialEvidence"] = {
                "vulkanDispatchSmoke": "make -C packages/inference/verify vulkan-dispatch-smoke — 7/7 PASS on Intel ANV (GGML_OP_ATTN_SCORE_QJL/_TBQ x3/_POLAR x2/FUSED_ATTN_QJL_TBQ)",
                "vulkanVerify": "vulkan-verify 8/8 + multi-block 8/8 + fused 1920/1920 on Intel ANV against synthetic fixtures",
                "note": "kernel dispatch verified on the dev workstation Intel ANV iGPU against synthetic fixtures; not yet a verify-on-device pass against the staged bundle GGUFs",
                "evidenceFiles": [
                    "packages/inference/verify/hardware-results/linux-vulkan-fork-build-a1-a2-d1-2026-05-11.json"
                ],
            }
        if existing and existing.get("status") == "pass":
            pending_report["invalidPreviousReport"] = previous_errors
        path.write_text(
            json.dumps(pending_report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        pending.append(backend)
    return sorted(ready), sorted(pending)


def _evals_pass(bundle_dir: Path) -> tuple[bool, list[str]]:
    """True iff the eval gate report says every blocking gate passed.

    Returns `(ok, failing_gate_names)`. The canonical signal is
    `aggregate.json:gateReport.passed`; we also surface which individual
    blocking gates failed/were-skipped so the blocking list is precise.
    """
    agg = _read_json(bundle_dir / "evals" / "aggregate.json")
    if not agg:
        return False, ["evals/aggregate.json missing or invalid"]
    tier = _detect_tier(bundle_dir)
    if agg.get("tier") != tier:
        return False, [
            f"evals/aggregate.json tier {agg.get('tier')!r} != bundle tier {tier!r}"
        ]
    gate_report = agg.get("gateReport")
    if not isinstance(gate_report, dict):
        return False, ["evals/aggregate.json missing gateReport"]
    if gate_report.get("tier") != tier:
        return False, [
            f"evals/aggregate.json gateReport.tier {gate_report.get('tier')!r} != bundle tier {tier!r}"
        ]
    failing: list[str] = []
    gates = gate_report.get("gates")
    if isinstance(gates, list):
        for g in gates:
            if not isinstance(g, dict):
                continue
            blocking = g.get("blocking")
            if not isinstance(blocking, bool):
                # Older aggregate reports did not persist the derived
                # `blocking` bit. Match the gate engine fallback: required
                # non-provisional gates block; provisional rows are evidence.
                blocking = (
                    g.get("required") is True and g.get("provisional") is not True
                )
            if blocking and g.get("passed") is not True:
                state = "skipped" if g.get("skipped") else "failed"
                failing.append(
                    f"{g.get('name', '?')} {state} ({g.get('reason', '')})".strip()
                )
    ok = gate_report.get("passed") is True and not failing
    if not ok and not failing:
        failing.append("gateReport.passed is not true")
    return ok, sorted(set(failing))


def _manifest_validation(bundle_dir: Path, tier: str) -> tuple[bool, list[str]]:
    """Validate eliza-1.manifest.json shape and staged file digests."""
    manifest_path = bundle_dir / "eliza-1.manifest.json"
    manifest = _read_json(manifest_path)
    if not manifest:
        return False, ["eliza-1.manifest.json missing or invalid"]
    errors = list(validate_manifest(manifest, require_publish_ready=False))
    if manifest.get("tier") != tier:
        errors.append(
            f"eliza-1.manifest.json tier {manifest.get('tier')!r} != bundle tier {tier!r}"
        )
    files = manifest.get("files")
    if not isinstance(files, dict):
        return False, errors or ["eliza-1.manifest.json files object missing"]
    for kind, entries in files.items():
        if entries is None:
            continue
        if not isinstance(entries, list):
            errors.append(f"manifest files.{kind}: must be an array")
            continue
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                errors.append(f"manifest files.{kind}[{index}]: must be an object")
                continue
            rel = entry.get("path")
            digest = entry.get("sha256")
            if not isinstance(rel, str) or not rel:
                errors.append(f"manifest files.{kind}[{index}].path missing")
                continue
            path = bundle_dir / rel
            if not path.is_file():
                errors.append(
                    f"manifest files.{kind}[{index}] missing staged file {rel}"
                )
                continue
            if not isinstance(digest, str) or _sha256(path) != digest:
                errors.append(
                    f"manifest files.{kind}[{index}] sha256 mismatch for {rel}"
                )
    return not errors, sorted(set(errors))


def _hashes_ok(bundle_dir: Path) -> bool:
    """True iff checksums/SHA256SUMS matches every referenced bundle file.

    This deliberately does not assert that every bundle file is already listed:
    `finalize()` calls `regenerate_checksums()` immediately before this check,
    so coverage is established by construction. The local validation here makes
    `final.hashes` mean the recorded digests are parseable, reference real
    files, and match the bytes on disk.
    """
    sums_path = bundle_dir / "checksums" / "SHA256SUMS"
    if not sums_path.is_file():
        return False
    listed: dict[str, str] = {}
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or "  " not in line:
            return False
        digest, rel = line.split("  ", 1)
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            return False
        path = bundle_dir / rel
        if not path.is_file():
            return False
        if _sha256(path) != digest:
            return False
        listed[rel] = digest
    return len(listed) > 0


def regenerate_checksums(bundle_dir: Path) -> Path:
    """Recompute checksums/SHA256SUMS over every bundle file (sorted)."""
    sums_path = bundle_dir / "checksums" / "SHA256SUMS"
    sums_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for path in sorted(bundle_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(bundle_dir).as_posix()
        if rel == "checksums/SHA256SUMS":
            continue
        lines.append(f"{_sha256(path)}  {rel}")
    sums_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sums_path


def _collect_files_under(bundle_dir: Path, *rels: str) -> list[str]:
    out: list[str] = []
    for rel in rels:
        for path in sorted((bundle_dir / rel).rglob("*")):
            if path.is_file():
                out.append(path.relative_to(bundle_dir).as_posix())
    return out


def _manifest_weight_paths(bundle_dir: Path) -> list[str]:
    """Return final weight payloads from the manifest, not stale disk extras."""

    manifest = _read_json(bundle_dir / "eliza-1.manifest.json") or {}
    files = manifest.get("files")
    if not isinstance(files, dict):
        return []
    weight_dirs = {
        "text",
        "tts",
        "asr",
        "vad",
        "vision",
        "embedding",
        "dflash",
        "wakeword",
    }
    out: set[str] = set()
    for entries in files.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            rel = entry.get("path")
            if isinstance(rel, str) and rel.split("/", 1)[0] in weight_dirs:
                out.add(rel)
    return sorted(out)


def _has_upload_evidence(evidence: Mapping[str, Any], tier: str) -> bool:
    hf = evidence.get("hf")
    if not isinstance(hf, dict):
        return False
    upload = hf.get("uploadEvidence")
    if not isinstance(upload, dict):
        return False
    if upload.get("repoId") != ELIZA_1_HF_REPO:
        return False
    if upload.get("status") != "uploaded":
        return False
    if not isinstance(upload.get("commit"), str) or not upload.get("commit"):
        return False
    if not isinstance(upload.get("url"), str) or not upload.get("url"):
        return False
    uploaded_paths = upload.get("uploadedPaths")
    return (
        isinstance(uploaded_paths, list)
        and all(isinstance(p, str) for p in uploaded_paths)
        and any(p.startswith(f"bundles/{tier}/") for p in uploaded_paths)
    )


def finalize(bundle_dir: Path, repo_root: Path) -> dict[str, Any]:
    tier = _detect_tier(bundle_dir)
    components = _detect_components(bundle_dir)
    commit = _git_short_sha(repo_root)

    # 1. Licenses — regenerate with verbatim upstream text + sidecar.
    written_license_relpaths, _ = write_bundle_licenses(bundle_dir / "licenses", components)
    _prune_stale_license_files(bundle_dir / "licenses", written_license_relpaths)
    license_problems = verify_bundle_licenses(bundle_dir / "licenses", components)
    licenses_ok = not license_problems
    _sync_voice_lineage(bundle_dir, components)
    _sync_manifest_file_hashes(bundle_dir)

    # 2. Platform + dispatch pending evidence.
    passing_targets, pending_targets = write_platform_pending_evidence(
        bundle_dir, tier, commit
    )
    ready_backends, pending_backends = write_dispatch_pending_evidence(
        bundle_dir, tier, commit
    )

    # 3. Checksums (after the above writes so the manifest is fresh).
    regenerate_checksums(bundle_dir)

    # 4. Recompute final.* flags from artifacts present.
    weights_present = (bundle_dir / "text").is_dir() and any(
        (bundle_dir / "text").iterdir()
    )
    manifest_ok, manifest_errors = _manifest_validation(bundle_dir, tier)
    hashes_ok = _hashes_ok(bundle_dir)
    evals_ok, eval_failures = _evals_pass(bundle_dir)
    required_targets = REQUIRED_PLATFORM_EVIDENCE_BY_TIER[tier]
    platform_evidence_ok = bool(required_targets) and all(
        _platform_target_pass(bundle_dir, t) for t in required_targets
    )
    supported_backends = SUPPORTED_BACKENDS_BY_TIER[tier]
    kernel_dispatch_ok = bool(supported_backends) and all(
        _backend_dispatch_runtime_ready(bundle_dir, b) for b in supported_backends
    )

    rel_path = bundle_dir / "evidence" / "release.json"
    evidence = _read_json(rel_path) or {}
    final = dict(evidence.get("final") or {})
    final["weights"] = bool(weights_present)
    final["hashes"] = bool(hashes_ok)
    final["evals"] = bool(evals_ok)
    final["licenses"] = bool(licenses_ok)
    final["kernelDispatchReports"] = bool(kernel_dispatch_ok)
    final["platformEvidence"] = bool(platform_evidence_ok)
    # The HF-push stage is the real source for size-first repo IDs. Fail
    # closed: stale preexisting truthy flags are ignored unless the release
    # evidence records a concrete uploaded commit/url/path payload.
    final["sizeFirstRepoIds"] = bool(_has_upload_evidence(evidence, tier))

    # 5. Derive releaseState. `weights-staged` until evidence fills; we do
    # NOT promote to `base-v1` here (that requires the real fork-build
    # GGUFs + provenance.sourceModels + the runnable-on-base evals — the
    # GPU/operator workstream owns that). We only honestly record the
    # current state and what's blocking.
    release_state = evidence.get("releaseState") or "weights-staged"
    has_provenance = isinstance(evidence.get("sourceModels"), dict) and bool(
        evidence.get("sourceModels")
    )
    base_v1_ok = (
        release_state == "base-v1"
        and evidence.get("finetuned") is False
        and has_provenance
        and all(
            final.get(k) is True
            for k in (
                "hashes",
                "evals",
                "licenses",
                "kernelDispatchReports",
                "platformEvidence",
                "sizeFirstRepoIds",
            )
        )
    )
    full_final_ok = all(
        final.get(k) is True
        for k in (
            "weights",
            "hashes",
            "evals",
            "licenses",
            "kernelDispatchReports",
            "platformEvidence",
            "sizeFirstRepoIds",
        )
    )
    publish_eligible = bool((base_v1_ok or full_final_ok) and manifest_ok and hashes_ok)
    default_eligible = publish_eligible

    # 6. Blocking reasons — accurate, live list.
    blocking: list[str] = []
    if not final["weights"]:
        blocking.append("text/ weights not staged")
    if not final["hashes"]:
        blocking.append(
            "checksums/SHA256SUMS missing, stale, or does not match bundle bytes"
        )
    if not manifest_ok:
        blocking.append(
            "manifest validation failed for staged bytes: "
            + "; ".join(manifest_errors[:6])
        )
    if not final["licenses"]:
        blocking.append("licenses/ set incomplete: " + "; ".join(license_problems))
    if not final["evals"]:
        blocking.append(
            "eval gates not green for the staged bytes: " + "; ".join(eval_failures[:6])
        )
    if not final["kernelDispatchReports"]:
        blocking.append(
            "kernel-dispatch (verify-on-device) not runtimeReady on every supported backend "
            f"for {tier}: pending {pending_backends}"
        )
    if not final["platformEvidence"]:
        blocking.append(
            f"platform evidence not 'pass' on every required target for {tier}: "
            f"pending {pending_targets}"
        )
    if not final["sizeFirstRepoIds"]:
        blocking.append("sizeFirstRepoIds not recorded (set by the HF-push stage)")
    if release_state not in {"base-v1", "upload-candidate", "final"}:
        blocking.append(
            f"releaseState is '{release_state}', not a publishable state "
            "(needs base-v1: the real fork-build GGUFs + provenance.sourceModels + the "
            "runnable-on-base evals — the GPU/operator workstream owns that step)"
        )
    if release_state == "base-v1" and not has_provenance:
        blocking.append("base-v1 release missing provenance.sourceModels")
    if not publish_eligible:
        blocking.append(
            "publish orchestrator will refuse to upload until the above clear"
        )

    # 7. Write back. Keep the existing structure; refresh the derived bits.
    evidence["schemaVersion"] = 1
    evidence["tier"] = tier
    evidence["repoId"] = ELIZA_1_HF_REPO
    evidence["repoPath"] = f"bundles/{tier}"
    evidence["generatedAt"] = _utc_now()
    evidence["final"] = final
    evidence["weights"] = _manifest_weight_paths(bundle_dir)
    evidence["releaseState"] = release_state
    evidence["publishEligible"] = publish_eligible
    evidence["defaultEligible"] = default_eligible
    evidence["publishBlockingReasons"] = blocking
    evidence["checksumManifest"] = "checksums/SHA256SUMS"
    evidence["manifestValidation"] = {
        "ok": manifest_ok,
        "errors": manifest_errors,
    }
    # licenseFiles must equal what the orchestrator's _license_files_for_layout
    # expects: the always-required four + a component license only when that
    # component's weights subdir is present in the bundle layout (vision/,
    # embedding/, wakeword/). asr/ and vad/ are always present in a §2 bundle.
    license_files = [
        "licenses/LICENSE.text",
        "licenses/LICENSE.voice",
        "licenses/LICENSE.dflash",
        "licenses/LICENSE.eliza-1",
    ]
    if (bundle_dir / "asr").is_dir() and any((bundle_dir / "asr").iterdir()):
        license_files.append("licenses/LICENSE.asr")
    if (
        tier in ELIZA_1_VISION_TIERS
        and (bundle_dir / "vision").is_dir()
        and any((bundle_dir / "vision").iterdir())
    ):
        license_files.append("licenses/LICENSE.vision")
    if (bundle_dir / "vad").is_dir() and any((bundle_dir / "vad").iterdir()):
        license_files.append("licenses/LICENSE.vad")
    if (bundle_dir / "embedding").is_dir() and any(
        (bundle_dir / "embedding").iterdir()
    ):
        license_files.append("licenses/LICENSE.embedding")
    if (bundle_dir / "wakeword").is_dir() and any((bundle_dir / "wakeword").iterdir()):
        license_files.append("licenses/LICENSE.wakeword")
    evidence["licenseFiles"] = license_files
    evidence["evalReports"] = _collect_files_under(bundle_dir, "evals")
    evidence["kernelDispatchReports"] = {
        b: f"evals/{b}_dispatch.json" for b in supported_backends
    }
    evidence["platformEvidence"] = {
        t: f"evidence/platform/{t}.json" for t in required_targets
    }
    hf = dict(evidence.get("hf") or {})
    hf["repoId"] = ELIZA_1_HF_REPO
    hf.setdefault("pathPrefix", f"bundles/{tier}")
    if publish_eligible:
        if hf.get("status") == "uploaded" and isinstance(
            hf.get("uploadEvidence"), dict
        ):
            hf["status"] = "uploaded"
        else:
            hf["status"] = "pending-upload"
    else:
        hf["status"] = f"blocked-{release_state}"
    evidence["hf"] = hf

    rel_path.parent.mkdir(parents=True, exist_ok=True)
    rel_path.write_text(
        json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    # Re-checksum after writing release.json so the manifest is consistent.
    regenerate_checksums(bundle_dir)
    return evidence


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Finalize evidence/release.json + platform/dispatch evidence for a staged Eliza-1 bundle."
    )
    parser.add_argument("bundle_dir", type=Path, help="path to the bundle root")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
        help="git repo root (for the commit hash stamped into evidence)",
    )
    args = parser.parse_args(argv)
    evidence = finalize(args.bundle_dir.resolve(), args.repo_root.resolve())
    print(
        json.dumps(
            {
                "tier": evidence["tier"],
                "releaseState": evidence["releaseState"],
                "publishEligible": evidence["publishEligible"],
                "final": evidence["final"],
                "publishBlockingReasons": evidence["publishBlockingReasons"],
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
