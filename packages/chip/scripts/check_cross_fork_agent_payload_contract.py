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
ANDROID_STAGE = APP_CORE / "scripts/lib/stage-android-agent.mjs"
ANDROID_AGENT_SERVICE = (
    APP_CORE / "platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java"
)
LINUX_AGENT_HOOK = OS_RV64 / "config/hooks/normal/0010-elizaos-agent.hook.chroot"
LINUX_USERLAND_HOOK = OS_RV64 / "config/hooks/normal/0030-elizaos-userland.hook.chroot"
LINUX_AGENT_UNIT = OS_RV64 / "config/includes.chroot/etc/systemd/system/elizaos-agent.service"
LINUX_MANIFEST = OS_RV64 / "manifest.json"

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


def linux_variant_mentions_shared_bun() -> bool:
    if not OS_RV64.is_dir():
        return False
    needles = (
        "bun-linux-riscv64-musl",
        "bun-version.json",
        "MILADY_BUN_RISCV64_FILE",
        "MILADY_BUN_RISCV64_URL",
        "ELIZA_BUN_RISCV64_URL",
    )
    for path in OS_RV64.rglob("*"):
        if not path.is_file() or path.stat().st_size > 2_000_000:
            continue
        try:
            text = read_text(path)
        except OSError:
            continue
        if any(needle in text for needle in needles):
            return True
    return False


def run_check(args: argparse.Namespace) -> dict[str, object]:
    del args
    findings: list[Finding] = []
    inputs = (
        BUN_VERSION_JSON,
        ANDROID_STAGE,
        ANDROID_AGENT_SERVICE,
        LINUX_AGENT_HOOK,
        LINUX_USERLAND_HOOK,
        LINUX_AGENT_UNIT,
        LINUX_MANIFEST,
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
    try:
        linux_manifest = json.loads(read_text(LINUX_MANIFEST))
    except json.JSONDecodeError as exc:
        findings.append(
            Finding(
                "linux_rv64_manifest_invalid_json",
                "blocker",
                "Linux RV64 manifest is invalid JSON",
                f"{rel(LINUX_MANIFEST)}: {exc}",
                "Fix the manifest so agent health evidence requirements are machine-readable.",
            )
        )
        return payload(findings, {})

    android_stage = read_text(ANDROID_STAGE)
    android_service = read_text(ANDROID_AGENT_SERVICE)
    linux_agent_hook = read_text(LINUX_AGENT_HOOK)
    linux_userland_hook = read_text(LINUX_USERLAND_HOOK)
    linux_agent_unit = read_text(LINUX_AGENT_UNIT)

    bun_tag = str(bun_data.get("bun", {}).get("tag", ""))
    expected_bun_version = bun_tag.removeprefix("bun-v")
    android_bun_version = js_const(android_stage, "BUN_VERSION")
    android_bun_channel = js_const(android_stage, "DEFAULT_BUN_CHANNEL")
    bun_channel = str(bun_data.get("bun", {}).get("channel", ""))
    artifact = bun_data.get("artifact", {})
    artifact_filename = artifact.get("filename") if isinstance(artifact, dict) else None
    artifact_layout = artifact.get("internal_layout") if isinstance(artifact, dict) else None
    execstart = service_execstart(linux_agent_unit)
    linux_evidence_ids = manifest_evidence_ids(linux_manifest)
    shared_bun_in_linux = linux_variant_mentions_shared_bun()
    webkit_status = str(bun_data.get("patch_series", {}).get("webkit_recipes_status", ""))

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
            "MILADY_BUN_RISCV64_URL" in android_stage
            or "MILADY_BUN_RISCV64_FILE" in android_stage
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
        "riscv64" not in android_stage or "/api/health" not in android_service,
        "android_agent_payload_contract_incomplete",
        "Android agent staging/service does not expose the expected riscv64 payload plus /api/health contract",
        f"{rel(ANDROID_STAGE)} {rel(ANDROID_AGENT_SERVICE)}",
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
        "STATUS_LATER_AGENT_BINARY" in linux_userland_hook,
        "linux_rv64_status_later_agent_binary_marker",
        "Linux RV64 userland hook deliberately writes a STATUS_LATER marker instead of installing the agent",
        rel(LINUX_USERLAND_HOOK),
        "Remove the marker only when /opt/elizaos/bin/elizaos is installed and verified executable in the image.",
    )
    add_if(
        findings,
        not execstart or "/opt/elizaos/bin/elizaos" not in execstart,
        "linux_rv64_agent_execstart_not_canonical",
        "Linux RV64 agent service does not start the canonical packaged agent binary",
        f"ExecStart={execstart!r}",
        "Use /opt/elizaos/bin/elizaos start --headless --port=31337 as the packaged runtime entrypoint.",
    )
    add_if(
        findings,
        "/api/health" not in linux_agent_unit and "31337" in linux_agent_unit,
        "linux_rv64_agent_unit_has_no_health_probe",
        "Linux RV64 agent unit starts a port but has no service-level health/readiness probe",
        rel(LINUX_AGENT_UNIT),
        "Add an ExecStartPost/readiness helper or runtime evidence gate that proves http://127.0.0.1:31337/api/health is ready.",
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

    evidence = {
        "bun_tag": bun_tag,
        "android_bun_version": android_bun_version,
        "bun_channel": bun_channel,
        "android_bun_channel": android_bun_channel,
        "artifact_filename": artifact_filename,
        "artifact_layout": artifact_layout,
        "linux_agent_execstart": execstart,
        "linux_manifest_evidence_ids": sorted(linux_evidence_ids),
        "linux_mentions_shared_bun_payload": shared_bun_in_linux,
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
