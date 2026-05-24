#!/usr/bin/env python3
"""Static cross-fork agent payload contract gate.

The objective needs both OS forks to boot on the chip target and start the
same local Eliza runtime. AOSP and Debian may package differently, but they
must agree on the Bun pin, riscv64 runtime artifact, agent entrypoint, and
health evidence. This gate blocks when one fork is still placeholder-only or
depends on an unstated operator-provided payload.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
APP_CORE = WORKSPACE / "app-core"
OS_RV64 = WORKSPACE / "os/linux/elizaos"

BUN_VERSION_JSON = APP_CORE / "scripts/bun-riscv64/bun-version.json"
BUN_RISCV64_DOCKERFILE = APP_CORE / "scripts/bun-riscv64/Dockerfile"
BUN_RISCV64_BUILD = APP_CORE / "scripts/bun-riscv64/build.sh"
ANDROID_STAGE = APP_CORE / "scripts/lib/stage-android-agent.mjs"
ANDROID_AGENT_SERVICE = (
    APP_CORE / "platforms/android/app/src/main/java/ai/milady/milady/ElizaAgentService.java"
)
ANDROID_AGENT_SERVICE_CANDIDATES = (
    ANDROID_AGENT_SERVICE,
    APP_CORE / "platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java",
)
LINUX_AGENT_HOOK = OS_RV64 / "config/hooks/normal/0010-elizaos-agent.hook.chroot"
LINUX_AGENT_UNIT = OS_RV64 / "config/includes.chroot/etc/systemd/system/elizaos-agent.service"
LINUX_AGENT_RUNNER = OS_RV64 / "config/includes.chroot/usr/lib/elizaos/run-agent.sh"
LINUX_HEALTH_HELPER = OS_RV64 / "config/includes.chroot/usr/lib/elizaos/wait-agent-health.sh"
LINUX_TUI_SMOKE_UNIT = (
    OS_RV64 / "config/includes.chroot/etc/systemd/system/elizaos-terminal-tui-smoke.service"
)
LINUX_MANIFEST_CANDIDATES = (
    OS_RV64 / "manifest.json",
    OS_RV64 / "manifest.json.template",
)
LINUX_CONTRACT_SCAN_EXCLUDED_DIRS = {
    ".git",
    "build",
    "cache",
    "chroot",
    "dist",
    "node_modules",
    "out",
    "target",
    "tmp",
}

REPORT = ROOT / "build/reports/cross_fork_agent_payload_contract.json"
SCHEMA = "eliza.cross_fork_agent_payload_contract.v1"
CLAIM_BOUNDARY = "static_cross_fork_payload_contract_only_not_runtime_evidence"


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


def resolve_android_agent_service() -> Path:
    if ANDROID_AGENT_SERVICE.is_file():
        return ANDROID_AGENT_SERVICE
    for path in ANDROID_AGENT_SERVICE_CANDIDATES:
        if path.is_file():
            return path
    return ANDROID_AGENT_SERVICE


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
) -> None:
    if condition:
        findings.append(Finding(code, "blocker", message, evidence, next_step))


def js_const(text: str, name: str) -> str | None:
    match = re.search(rf"const\s+{re.escape(name)}\s*=\s*[\"']([^\"']+)[\"']", text)
    return match.group(1) if match else None


def service_execstart(text: str) -> str | None:
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("ExecStart="):
            return line.split("=", 1)[1].strip()
    return None


def heredoc_block(text: str, output_path: str) -> str | None:
    pattern = rf"cat\s*>\s*{re.escape(output_path)}\s*<<'WRAPPER_EOF'\n(.*?)\nWRAPPER_EOF"
    match = re.search(pattern, text, flags=re.DOTALL)
    return match.group(1) if match else None


def bun_riscv64_toolchain_contract_gaps(dockerfile: str, build_sh: str) -> list[str]:
    gaps: list[str] = []
    wrapper_requirements = {
        "/opt/cross/bin/riscv64-linux-musl-clang": (
            "/usr/local/bin/clang",
            "--target=riscv64-unknown-linux-musl",
            "--sysroot=/sysroot",
            "--gcc-toolchain=/sysroot/usr",
            "-Qunused-arguments",
            "-B/sysroot/usr/lib/gcc/riscv64-alpine-linux-musl/",
            "-L/sysroot/usr/lib",
            "-fuse-ld=lld",
            "-march=rv64gc",
            "-mabi=lp64d",
        ),
        "/opt/cross/bin/riscv64-linux-musl-clang++": (
            "/usr/local/bin/clang++",
            "--target=riscv64-unknown-linux-musl",
            "--sysroot=/sysroot",
            "--gcc-toolchain=/sysroot/usr",
            "-Qunused-arguments",
            "-B/sysroot/usr/lib/gcc/riscv64-alpine-linux-musl/",
            "-L/sysroot/usr/lib",
            "-fuse-ld=lld",
            "-stdlib=libstdc++",
            "-march=rv64gc",
            "-mabi=lp64d",
        ),
    }
    for wrapper, required in wrapper_requirements.items():
        body = heredoc_block(dockerfile, wrapper)
        if body is None:
            gaps.append(f"missing wrapper heredoc {wrapper}")
            continue
        for token in required:
            if token not in body:
                gaps.append(f"{wrapper} missing {token}")
    for token in (
        "ln -s /usr/local/bin/ld.lld /opt/cross/bin/riscv64-linux-musl-ld",
        "CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_LINKER=/opt/cross/bin/riscv64-linux-musl-clang",
    ):
        if token not in dockerfile:
            gaps.append(f"Dockerfile missing {token}")
    for token in (
        'WK_LINKER_FLAGS="-fuse-ld=lld"',
        "-DCMAKE_LINKER=/usr/local/bin/ld.lld",
        '-DCMAKE_EXE_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}"',
        '-DCMAKE_SHARED_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}"',
        '-DCMAKE_MODULE_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}"',
        "export BUN_LD=/usr/local/bin/ld.lld",
    ):
        if token not in build_sh:
            gaps.append(f"build.sh missing {token}")
    return gaps


def manifest_evidence_ids(data: dict[str, Any]) -> set[str]:
    validation = data.get("validation", {})
    evidence = validation.get("evidence", []) if isinstance(validation, dict) else []
    ids: set[str] = set()
    if isinstance(evidence, list):
        for item in evidence:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                ids.add(item["id"])
    required = validation.get("requiredEvidence", []) if isinstance(validation, dict) else []
    if isinstance(required, list):
        ids.update(item for item in required if isinstance(item, str))
    return ids


def load_linux_manifest_evidence_ids() -> tuple[Path | None, set[str]]:
    for path in LINUX_MANIFEST_CANDIDATES:
        if not path.is_file():
            continue
        text = read_text(path)
        if "agentHealth" in text:
            return path, {"elizaos-agent-live"}
        try:
            return path, manifest_evidence_ids(json.loads(text))
        except json.JSONDecodeError:
            return path, set()
    return None, set()


def iter_linux_variant_contract_files() -> Iterable[Path]:
    if not OS_RV64.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(OS_RV64):
        dirnames[:] = [
            dirname
            for dirname in dirnames
            if dirname not in LINUX_CONTRACT_SCAN_EXCLUDED_DIRS and not dirname.startswith(".")
        ]
        for filename in filenames:
            path = Path(dirpath) / filename
            try:
                if path.is_file() and path.stat().st_size <= 2_000_000:
                    yield path
            except OSError:
                continue


def linux_variant_mentions_shared_bun() -> bool:
    needles = (
        "bun-linux-riscv64-musl",
        "bun-version.json",
        "ELIZA_BUN_RISCV64_FILE",
        "ELIZA_BUN_RISCV64_URL",
        "ELIZA_BUN_RISCV64_URL",
    )
    for path in iter_linux_variant_contract_files():
        try:
            text = read_text(path)
        except OSError:
            continue
        if any(needle in text for needle in needles):
            return True
    return False


def linux_variant_contains_status_later_marker() -> bool:
    for path in iter_linux_variant_contract_files():
        try:
            if "STATUS_LATER_AGENT_BINARY" in read_text(path):
                return True
        except OSError:
            continue
    return False


def run_check(args: argparse.Namespace) -> dict[str, object]:
    del args
    findings: list[Finding] = []
    android_agent_service = resolve_android_agent_service()
    inputs = (
        BUN_VERSION_JSON,
        BUN_RISCV64_DOCKERFILE,
        BUN_RISCV64_BUILD,
        ANDROID_STAGE,
        android_agent_service,
        LINUX_AGENT_HOOK,
        LINUX_AGENT_UNIT,
        LINUX_AGENT_RUNNER,
        LINUX_HEALTH_HELPER,
        LINUX_TUI_SMOKE_UNIT,
    )
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required cross-fork agent payload input is missing",
            rel(path),
            "Restore the missing AOSP/Linux payload source before claiming cross-fork runtime alignment.",
        )
    if findings:
        return payload(findings, {})

    try:
        bun_data = json.loads(read_text(BUN_VERSION_JSON))
    except json.JSONDecodeError as exc:
        findings.append(
            Finding(
                "bun_riscv64_version_json_invalid",
                "blocker",
                "Bun riscv64 version file is invalid JSON",
                f"{rel(BUN_VERSION_JSON)}: {exc}",
                "Fix bun-version.json so both forks can consume the same machine-readable runtime pin.",
            )
        )
        return payload(findings, {})
    android_stage = read_text(ANDROID_STAGE)
    bun_riscv64_dockerfile = read_text(BUN_RISCV64_DOCKERFILE)
    bun_riscv64_build = read_text(BUN_RISCV64_BUILD)
    android_service = read_text(android_agent_service)
    linux_agent_hook = read_text(LINUX_AGENT_HOOK)
    linux_agent_unit = read_text(LINUX_AGENT_UNIT)
    linux_agent_runner = read_text(LINUX_AGENT_RUNNER)
    linux_health_helper = read_text(LINUX_HEALTH_HELPER)
    linux_tui_smoke_unit = read_text(LINUX_TUI_SMOKE_UNIT)

    bun_tag = str(bun_data.get("bun", {}).get("tag", ""))
    expected_bun_version = bun_tag.removeprefix("bun-v")
    android_bun_version = js_const(android_stage, "BUN_VERSION")
    android_bun_channel = js_const(android_stage, "DEFAULT_BUN_CHANNEL")
    bun_channel = str(bun_data.get("bun", {}).get("channel", ""))
    artifact = bun_data.get("artifact", {})
    artifact_filename = artifact.get("filename") if isinstance(artifact, dict) else None
    artifact_layout = artifact.get("internal_layout") if isinstance(artifact, dict) else None
    execstart = service_execstart(linux_agent_unit)
    linux_manifest_path, linux_evidence_ids = load_linux_manifest_evidence_ids()
    shared_bun_in_linux = linux_variant_mentions_shared_bun()
    webkit_status = str(bun_data.get("patch_series", {}).get("webkit_recipes_status", ""))
    toolchain_gaps = bun_riscv64_toolchain_contract_gaps(bun_riscv64_dockerfile, bun_riscv64_build)

    add_if(
        findings,
        android_bun_version != expected_bun_version,
        "cross_fork_bun_version_mismatch",
        "Android agent staging Bun version does not match the shared riscv64 Bun pin",
        f"android={android_bun_version!r} shared={expected_bun_version!r}",
        "Keep stage-android-agent.mjs:BUN_VERSION aligned with bun-version.json:bun.tag.",
    )
    add_if(
        findings,
        android_bun_channel != bun_channel,
        "cross_fork_bun_channel_mismatch",
        "Android agent staging Bun channel does not match the shared riscv64 Bun channel",
        f"android={android_bun_channel!r} shared={bun_channel!r}",
        "Keep DEFAULT_BUN_CHANNEL aligned with bun-version.json:bun.channel.",
    )
    add_if(
        findings,
        artifact_filename != "bun-linux-riscv64-musl.zip"
        or artifact_layout != "bun-linux-riscv64-musl/bun",
        "bun_riscv64_artifact_layout_mismatch",
        "shared Bun artifact layout does not match the layout Android and Linux runtime installers need",
        f"filename={artifact_filename!r} internal_layout={artifact_layout!r}",
        "Publish a single bun-linux-riscv64-musl.zip with bun-linux-riscv64-musl/bun inside.",
    )
    add_if(
        findings,
        (
            "ELIZA_BUN_RISCV64_URL" in android_stage
            or "ELIZA_BUN_RISCV64_FILE" in android_stage
            or "ELIZA_BUN_RISCV64_URL" in android_stage
        )
        and "sha256" not in android_stage.lower(),
        "android_riscv64_bun_payload_is_url_only",
        "Android riscv64 Bun staging depends on an operator-provided artifact without a local required hash contract",
        rel(ANDROID_STAGE),
        "Require a pinned URL plus SHA-256 for the riscv64 Bun zip or consume a signed release artifact manifest.",
    )
    add_if(
        findings,
        "ELIZA_BUN_RISCV64_REQUIRED" in android_stage
        and "Skipping ABI" in android_stage
        and "no ELIZA_BUN_RISCV64_FILE/URL is set" in android_stage,
        "android_riscv64_agent_payload_can_soft_skip",
        "Android agent staging can silently skip the riscv64 runtime lane unless ELIZA_BUN_RISCV64_REQUIRED=1 is set",
        rel(ANDROID_STAGE),
        "Make riscv64 staging fail-closed for AOSP/chip objective builds and record the Bun riscv64 artifact SHA in the build provenance.",
    )
    add_if(
        findings,
        "riscv64" not in android_stage or "/api/health" not in android_service,
        "android_agent_payload_contract_incomplete",
        "Android agent staging/service does not expose the expected riscv64 payload plus /api/health contract",
        f"{rel(ANDROID_STAGE)} {rel(android_agent_service)}",
        "Keep the Android APK staging riscv64 asset path and ElizaAgentService /api/health watchdog in lockstep.",
    )
    add_if(
        findings,
        'stage": "placeholder"' in linux_agent_hook
        or 'provenance": "scaffolding"' in linux_agent_hook,
        "linux_rv64_agent_install_is_placeholder",
        "Linux RV64 image hook records /opt/elizaos as a placeholder install",
        rel(LINUX_AGENT_HOOK),
        "Install the real elizaOS agent payload under /opt/elizaos and replace placeholder provenance with artifact hash/version metadata.",
    )
    add_if(
        findings,
        linux_variant_contains_status_later_marker(),
        "linux_rv64_status_later_agent_binary_marker",
        "Linux RV64 variant still carries a STATUS_LATER marker instead of installing the agent",
        rel(OS_RV64),
        "Remove the marker only when /opt/elizaos/bin/elizaos is installed and verified executable in the image.",
    )
    add_if(
        findings,
        "install_fallback_payload" in linux_agent_hook
        or "fallback_agent.py" in linux_agent_hook
        or "elizaos-fallback" in linux_agent_hook
        or "fallback_agent.py" in linux_agent_runner,
        "linux_rv64_fallback_agent_can_satisfy_health",
        "Linux RV64 image hook can install a fallback HTTP agent that satisfies /api/health without the shared Eliza payload",
        rel(LINUX_AGENT_HOOK),
        "Make objective builds fail when real agent artifacts are missing, and require /api/health evidence to identify the full Eliza agent bundle rather than a fallback responder.",
    )
    add_if(
        findings,
        not execstart
        or not (
            "/opt/elizaos/bin/elizaos" in execstart
            or (
                execstart == "/usr/lib/elizaos/run-agent.sh"
                and "/opt/elizaos/app/agent-bundle.js" in linux_agent_runner
                and "/opt/elizaos/app/server.js" in linux_agent_runner
            )
            or ("/opt/elizaos/bin/bun" in execstart and "/opt/elizaos/app/server.js" in execstart)
        ),
        "linux_rv64_agent_execstart_not_canonical",
        "Linux RV64 agent service does not start the canonical packaged agent binary",
        f"ExecStart={execstart!r}",
        "Use the packaged elizaOS runtime entrypoint under /opt/elizaos and bind the agent to port 31337.",
    )
    add_if(
        findings,
        "/api/health" not in linux_agent_unit and "/api/health" not in linux_health_helper,
        "linux_rv64_agent_unit_has_no_health_probe",
        "Linux RV64 agent unit starts a port but has no service-level health/readiness probe",
        f"{rel(LINUX_AGENT_UNIT)} {rel(LINUX_HEALTH_HELPER)}",
        "Add an ExecStartPost/readiness helper or runtime evidence gate that proves http://127.0.0.1:31337/api/health is ready.",
    )
    add_if(
        findings,
        "elizaos-agent.service" not in linux_tui_smoke_unit
        or "/api/health" not in linux_health_helper,
        "linux_rv64_tui_smoke_not_chained_to_agent_health",
        "Linux RV64 TUI smoke is not clearly chained behind the agent health helper",
        f"{rel(LINUX_TUI_SMOKE_UNIT)} {rel(LINUX_HEALTH_HELPER)}",
        "Keep the terminal/TUI smoke dependent on the local agent service and the /api/health readiness helper.",
    )
    add_if(
        findings,
        not any(
            "agent" in item and ("health" in item or "live" in item) for item in linux_evidence_ids
        ),
        "linux_rv64_manifest_missing_agent_health_evidence",
        "Linux RV64 release manifest does not require agent health/liveness evidence",
        f"evidence_ids={sorted(linux_evidence_ids)}",
        "Require an agent-live evidence row with systemctl state, pid, /api/health 200+ready, and transcript paths.",
    )
    add_if(
        findings,
        not shared_bun_in_linux,
        "linux_rv64_does_not_consume_shared_bun_payload",
        "Linux RV64 variant does not reference the shared bun-linux-riscv64-musl payload contract",
        rel(OS_RV64),
        "Make the Debian RV64 installer consume the same Bun zip/version/hash contract as Android or explicitly document a different verified runtime.",
    )
    add_if(
        findings,
        "must realize into actual `*.patch` files" in webkit_status,
        "bun_riscv64_webkit_baseline_patches_not_realized",
        "Bun riscv64 Baseline-JIT WebKit patch chain is documented as recipes rather than realized patches",
        rel(BUN_VERSION_JSON),
        "Materialize the WebKit recipe chain into checked patch files and validate the non-C_LOOP riscv64 build path, or update the artifact contract to say C_LOOP-only.",
    )
    add_if(
        findings,
        bool(toolchain_gaps),
        "bun_riscv64_toolchain_can_use_host_ld",
        "Bun riscv64 cross-build toolchain is not pinned tightly enough to prevent host GNU ld from handling riscv64 links",
        "; ".join(toolchain_gaps),
        "Keep clang/clang++ wrappers and WebKit/Bun CMake configuration on lld so CMake compiler probes cannot fall back to /usr/bin/ld.",
    )

    evidence = {
        "bun_tag": bun_tag,
        "android_bun_version": android_bun_version,
        "bun_channel": bun_channel,
        "android_bun_channel": android_bun_channel,
        "android_agent_service": rel(android_agent_service),
        "artifact_filename": artifact_filename,
        "artifact_layout": artifact_layout,
        "linux_agent_execstart": execstart,
        "linux_agent_runner": rel(LINUX_AGENT_RUNNER),
        "linux_manifest_evidence_ids": sorted(linux_evidence_ids),
        "linux_manifest_path": rel(linux_manifest_path) if linux_manifest_path else None,
        "linux_mentions_shared_bun_payload": shared_bun_in_linux,
        "bun_riscv64_toolchain_uses_lld": not toolchain_gaps,
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} cross_fork.agent_payload_contract")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help=f"report path (default: {REPORT.relative_to(ROOT)})",
    )
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = run_check(args)
    write_report(report, Path(args.report))
    if not args.json_only:
        print_summary(report)
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
