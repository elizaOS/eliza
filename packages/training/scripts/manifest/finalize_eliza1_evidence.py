"""Recompute evidence/release.json + platform/dispatch evidence for a staged Eliza-1 bundle.

This is the deterministic "finalize" step the publish pipeline runs after
weights are staged: it (a) regenerates the licenses/ set + sidecar with
verbatim upstream SPDX text, (b) recomputes the `final.*` flags from the
artifacts actually present, (c) writes the per-platform evidence stubs
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
    from scripts.manifest.eliza1_manifest import SUPPORTED_BACKENDS_BY_TIER
    from scripts.manifest.eliza1_platform_plan import (
        REQUIRED_PLATFORM_EVIDENCE_BY_TIER,
        _target_backend,
    )
except ImportError:  # pragma: no cover - script execution path
    from eliza1_licenses import verify_bundle_licenses, write_bundle_licenses  # type: ignore
    from eliza1_manifest import SUPPORTED_BACKENDS_BY_TIER  # type: ignore
    from eliza1_platform_plan import (  # type: ignore
        REQUIRED_PLATFORM_EVIDENCE_BY_TIER,
        _target_backend,
    )


# How an operator produces each kind of evidence (used in the "pending"
# stubs). Keyed by backend.
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
    components = ["text", "voice", "asr", "vad", "dflash"]
    if (bundle_dir / "vision").is_dir() and any((bundle_dir / "vision").iterdir()):
        components.append("vision")
    elif (bundle_dir / "licenses" / "LICENSE.vision").is_file():
        components.append("vision")
    if (bundle_dir / "embedding").is_dir() and any((bundle_dir / "embedding").iterdir()):
        components.append("embedding")
    elif (bundle_dir / "licenses" / "LICENSE.embedding").is_file():
        components.append("embedding")
    if (bundle_dir / "wakeword").is_dir() or (bundle_dir / "licenses" / "LICENSE.wakeword").is_file():
        components.append("wakeword")
    return components


def _backend_dispatch_runtime_ready(bundle_dir: Path, backend: str) -> bool:
    """True iff the per-backend dispatch report claims runtimeReady against the bundle."""
    report = _read_json(bundle_dir / "evals" / f"{backend}_dispatch.json")
    return bool(report) and report.get("runtimeReady") is True and report.get("status") == "pass"


def _platform_target_pass(bundle_dir: Path, target: str) -> bool:
    report = _read_json(bundle_dir / "evidence" / "platform" / f"{target}.json")
    return bool(report) and report.get("status") == "pass"


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


def write_platform_evidence_stubs(
    bundle_dir: Path, tier: str, commit: str
) -> tuple[list[str], list[str]]:
    """Write a `evidence/platform/<target>.json` for every required target.

    Returns `(passing_targets, pending_targets)`. Existing reports with a
    `pass` status are left untouched; everything else is (re)written as a
    `pending` stub recording the exact command to produce real evidence
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
        if existing and existing.get("status") == "pass":
            passing.append(target)
            continue
        backend = _target_backend(target)
        stub: dict[str, Any] = {
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
                backend, "run the backend kernel verify + verify-on-device against the staged bytes"
            ),
        }
        partial = _DEV_WORKSTATION_PARTIAL.get(target)
        if partial is not None:
            stub["device"] = partial["device"]
            stub["partialEvidence"] = partial["partialEvidence"]
            stub["reason"] = partial["missing"]
        path.write_text(json.dumps(stub, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        pending.append(target)
    return sorted(passing), sorted(pending)


def write_dispatch_stubs(
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
    for backend in SUPPORTED_BACKENDS_BY_TIER[tier]:
        path = evals_dir / f"{backend}_dispatch.json"
        existing = _read_json(path)
        if existing and existing.get("runtimeReady") is True and existing.get("status") == "pass":
            ready.append(backend)
            continue
        stub: dict[str, Any] = {
            "schemaVersion": 1,
            "backend": backend,
            "tier": tier,
            "status": "needs-hardware" if backend in {"metal", "cuda", "rocm"} else "pending",
            "runtimeReady": False,
            "atCommit": commit,
            "generatedAt": now,
            "report": "not-run",
            "reason": (
                f"{backend} kernel-dispatch (verify-on-device against the staged Eliza-1 "
                f"{tier} bundle bytes) not yet run"
            ),
            "howToProduce": _RUNNER_BY_BACKEND.get(backend, "run verify-on-device against the staged bytes"),
        }
        if backend == "cpu":
            stub["partialEvidence"] = {
                "referenceTest": "make -C packages/inference/verify reference-test — clean (gen_fixture --self-test all finite)",
                "kernelContract": "node packages/inference/verify/check_kernel_contract.mjs — OK kernels=6 targets=23",
                "note": "CPU reference path verified on the dev workstation against synthetic fixtures; not yet against the staged bundle GGUFs",
                "evidenceFiles": ["packages/inference/verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json"],
            }
        elif backend == "vulkan":
            stub["partialEvidence"] = {
                "vulkanDispatchSmoke": "make -C packages/inference/verify vulkan-dispatch-smoke — 7/7 PASS on Intel ANV (GGML_OP_ATTN_SCORE_QJL/_TBQ x3/_POLAR x2/FUSED_ATTN_QJL_TBQ)",
                "vulkanVerify": "vulkan-verify 8/8 + multi-block 8/8 + fused 1920/1920 on Intel ANV against synthetic fixtures",
                "note": "kernel dispatch verified on the dev workstation Intel ANV iGPU against synthetic fixtures; not yet a verify-on-device pass against the staged bundle GGUFs",
                "evidenceFiles": ["packages/inference/verify/hardware-results/linux-vulkan-fork-build-a1-a2-d1-2026-05-11.json"],
            }
        path.write_text(json.dumps(stub, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        pending.append(backend)
    return sorted(ready), sorted(pending)


def _evals_pass(bundle_dir: Path) -> tuple[bool, list[str]]:
    """True iff the eval gate report says everything required passed.

    Returns `(ok, failing_gate_names)`. The canonical signal is
    `aggregate.json:gateReport.passed`; we also surface which individual
    required gates failed/were-skipped so the blocking list is precise.
    """
    agg = _read_json(bundle_dir / "evals" / "aggregate.json")
    if not agg:
        return False, ["evals/aggregate.json missing or invalid"]
    gate_report = agg.get("gateReport")
    if not isinstance(gate_report, dict):
        return False, ["evals/aggregate.json missing gateReport"]
    failing: list[str] = []
    gates = gate_report.get("gates")
    if isinstance(gates, list):
        for g in gates:
            if not isinstance(g, dict):
                continue
            if g.get("required") is True and g.get("passed") is not True:
                state = "skipped" if g.get("skipped") else "failed"
                failing.append(f"{g.get('name', '?')} {state} ({g.get('reason', '')})".strip())
    ok = gate_report.get("passed") is True and not failing
    if not ok and not failing:
        failing.append("gateReport.passed is not true")
    return ok, sorted(set(failing))


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


def finalize(bundle_dir: Path, repo_root: Path) -> dict[str, Any]:
    tier = _detect_tier(bundle_dir)
    components = _detect_components(bundle_dir)
    commit = _git_short_sha(repo_root)

    # 1. Licenses — regenerate with verbatim upstream text + sidecar.
    write_bundle_licenses(bundle_dir / "licenses", components)
    license_problems = verify_bundle_licenses(bundle_dir / "licenses", components)
    licenses_ok = not license_problems

    # 2. Platform + dispatch evidence stubs.
    passing_targets, pending_targets = write_platform_evidence_stubs(bundle_dir, tier, commit)
    ready_backends, pending_backends = write_dispatch_stubs(bundle_dir, tier, commit)

    # 3. Checksums (after the above writes so the manifest is fresh).
    regenerate_checksums(bundle_dir)

    # 4. Recompute final.* flags from artifacts present.
    weights_present = (bundle_dir / "text").is_dir() and any((bundle_dir / "text").iterdir())
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
    # sizeFirstRepoIds is set by the HF-push stage; leave it as-is unless absent.
    final.setdefault("sizeFirstRepoIds", False)

    # 5. Derive releaseState. `weights-staged` until evidence fills; we do
    # NOT promote to `base-v1` here (that requires the real fork-build
    # GGUFs + provenance.sourceModels + the runnable-on-base evals — the
    # GPU/operator workstream owns that). We only honestly record the
    # current state and what's blocking.
    release_state = evidence.get("releaseState") or "weights-staged"
    has_provenance = isinstance(evidence.get("sourceModels"), dict) and bool(evidence.get("sourceModels"))
    base_v1_ok = (
        release_state == "base-v1"
        and evidence.get("finetuned") is False
        and has_provenance
        and all(
            final.get(k) is True
            for k in ("hashes", "evals", "licenses", "kernelDispatchReports", "platformEvidence", "sizeFirstRepoIds")
        )
    )
    full_final_ok = all(
        final.get(k) is True
        for k in ("weights", "hashes", "evals", "licenses", "kernelDispatchReports", "platformEvidence", "sizeFirstRepoIds")
    )
    publish_eligible = bool(base_v1_ok or full_final_ok)
    default_eligible = publish_eligible

    # 6. Blocking reasons — accurate, live list.
    blocking: list[str] = []
    if not final["weights"]:
        blocking.append("text/ weights not staged")
    if not final["hashes"]:
        blocking.append("checksums/SHA256SUMS missing or does not cover the bundle")
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
        blocking.append("publish orchestrator will refuse to upload until the above clear")

    # 7. Write back. Keep the existing structure; refresh the derived bits.
    evidence["schemaVersion"] = 1
    evidence["tier"] = tier
    evidence.setdefault("repoId", f"elizaos/eliza-1-{tier}")
    evidence["generatedAt"] = _utc_now()
    evidence["final"] = final
    evidence["releaseState"] = release_state
    evidence["publishEligible"] = publish_eligible
    evidence["defaultEligible"] = default_eligible
    evidence["publishBlockingReasons"] = blocking
    evidence["checksumManifest"] = "checksums/SHA256SUMS"
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
    if (bundle_dir / "vision").is_dir() and any((bundle_dir / "vision").iterdir()):
        license_files.append("licenses/LICENSE.vision")
    if (bundle_dir / "vad").is_dir() and any((bundle_dir / "vad").iterdir()):
        license_files.append("licenses/LICENSE.vad")
    if (bundle_dir / "embedding").is_dir() and any((bundle_dir / "embedding").iterdir()):
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
    hf.setdefault("repoId", f"elizaos/eliza-1-{tier}")
    hf["status"] = "ready" if publish_eligible else f"blocked-{release_state}"
    evidence["hf"] = hf

    rel_path.parent.mkdir(parents=True, exist_ok=True)
    rel_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
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
