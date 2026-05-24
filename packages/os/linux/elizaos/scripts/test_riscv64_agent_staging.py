#!/usr/bin/env python3
"""Focused tests for riscv64 agent/Bun staging provenance."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
LINUX_DIR = ROOT / "packages/os/linux/elizaos"
SCRIPT = LINUX_DIR / "scripts/stage-agent-artifacts.sh"
BUILD_SH = LINUX_DIR / "build.sh"
INSTALL_HOOK = LINUX_DIR / "config/hooks/normal/0010-elizaos-agent.hook.chroot"
RISCV64_PACKAGE_LIST = LINUX_DIR / "config/package-lists/elizaos-riscv64.list.chroot"
RUN_AGENT = LINUX_DIR / "config/includes.chroot/usr/lib/elizaos/run-agent.sh"
RUN_TUI_SMOKE = LINUX_DIR / "config/includes.chroot/usr/lib/elizaos/run-terminal-tui-smoke.sh"
WAIT_AGENT_HEALTH = LINUX_DIR / "config/includes.chroot/usr/lib/elizaos/wait-agent-health.sh"
FIRST_BOOT = LINUX_DIR / "config/includes.chroot/usr/local/lib/elizaos/first-boot.sh"
TUI_SMOKE_UNIT = LINUX_DIR / "config/includes.chroot/etc/systemd/system/elizaos-terminal-tui-smoke.service"
RISCV64_POSTGRES_HOOK = LINUX_DIR / "config/hooks/normal/0012-riscv64-agent-postgres.hook.chroot"
MUSL_RUNTIME = LINUX_DIR / "artifacts/riscv64/elizaos-app/musl-runtime"
AGENT_BUNDLE = ROOT / "packages/agent/dist-mobile/agent-bundle.js"


def make_bun_zip(path: Path) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("bun-linux-riscv64-musl/", "")
        archive.writestr("bun-linux-riscv64-musl/bun", b"#!/bin/sh\nexit 0\n")
    return path


def run_stage(
    zip_path: Path, out_dir: Path, musl_runtime: Path = MUSL_RUNTIME
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            str(SCRIPT),
            "--arch",
            "riscv64",
            "--skip-build",
            "--riscv64-bun-zip",
            str(zip_path),
            "--riscv64-musl-runtime",
            str(musl_runtime),
            "--out",
            str(out_dir),
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def run_node_only_stage(out_dir: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            str(SCRIPT),
            "--arch",
            "riscv64",
            "--skip-build",
            "--out",
            str(out_dir),
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_stale_riscv64_bun_zip_is_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        stale_zip = make_bun_zip(tmp / "bun-linux-riscv64-musl.zip")
        os.utime(stale_zip, (1, 1))
        result = run_stage(stale_zip, tmp / "out")
        if result.returncode != 66:
            raise AssertionError(f"expected stale zip rejection rc=66, got {result.returncode}\n{result.stdout}")
        if "riscv64 Bun zip predates current patch-series input" not in result.stdout:
            raise AssertionError(result.stdout)


def test_fresh_riscv64_stage_writes_patch_bound_provenance() -> None:
    if not AGENT_BUNDLE.is_file():
        raise AssertionError(f"missing built agent bundle fixture: {AGENT_BUNDLE}")
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        musl_runtime = tmp / "musl-runtime"
        musl_runtime.mkdir()
        for soname in (
            "ld-musl-riscv64.so.1",
            "libstdc++.so.6",
            "libicui18n.so.74",
            "libicuuc.so.74",
            "libicudata.so.74",
        ):
            (musl_runtime / soname).write_bytes(f"fake {soname}\n".encode("utf-8"))
        fresh_zip = make_bun_zip(tmp / "bun-linux-riscv64-musl.zip")
        future = time.time() + 10
        os.utime(fresh_zip, (future, future))
        out_dir = tmp / "out"
        result = run_stage(fresh_zip, out_dir, musl_runtime)
        if result.returncode != 0:
            raise AssertionError(f"stage failed rc={result.returncode}\n{result.stdout}")

        provenance_path = out_dir / "riscv64-bun-provenance.json"
        if not provenance_path.is_file():
            raise AssertionError("stage did not write riscv64-bun-provenance.json")
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        if provenance.get("schema") != "eliza.os.linux.riscv64_bun_stage_provenance.v1":
            raise AssertionError(provenance)
        inputs = provenance.get("inputs", {})
        required_inputs = {
            "packages/app-core/scripts/bun-riscv64/bun-version.json",
            "packages/app-core/scripts/bun-riscv64/bun-patches/0021-fix-riscv64-linux-open-flags.patch",
        }
        missing = sorted(required_inputs - set(inputs))
        if missing:
            raise AssertionError(f"provenance missing current patch inputs: {missing}")
        artifact = provenance.get("artifact", {})
        if artifact.get("zip_path") != str(fresh_zip):
            raise AssertionError(artifact)
        if not artifact.get("staged_bun_sha256"):
            raise AssertionError(artifact)


def test_riscv64_node_only_stage_omits_bun_but_keeps_agent_bundle() -> None:
    if not AGENT_BUNDLE.is_file():
        raise AssertionError(f"missing built agent bundle fixture: {AGENT_BUNDLE}")

    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = Path(tmpdir) / "out"
        result = run_node_only_stage(out_dir)
        if result.returncode != 0:
            raise AssertionError(f"node-only stage failed rc={result.returncode}\n{result.stdout}")

        required = (
            out_dir / "elizaos-app/agent-bundle.js",
            out_dir / "elizaos-app.sha256",
            out_dir / "elizaos-root-assets.sha256",
            out_dir / "manifest.txt",
        )
        for path in required:
            if not path.is_file():
                raise AssertionError(f"node-only stage missing required artifact: {path}")

        forbidden = (
            out_dir / "bun",
            out_dir / "bun.sha256",
            out_dir / "riscv64-bun-provenance.json",
        )
        for path in forbidden:
            if path.exists():
                raise AssertionError(f"node-only stage unexpectedly wrote Bun artifact: {path}")

        manifest = (out_dir / "manifest.txt").read_text(encoding="utf-8")
        if "bun_file=node-shebang-agent-bundle-no-bun" not in manifest:
            raise AssertionError(manifest)
        if "bun_staged_sha256=" not in manifest:
            raise AssertionError(manifest)

        bundle = (out_dir / "elizaos-app/agent-bundle.js").read_text(encoding="utf-8")
        if 'import { createRequire as __elizaCreateRequire } from "node:module";' not in bundle:
            raise AssertionError("node-only riscv64 bundle missing createRequire import")
        if 'import.meta.require : __elizaCreateRequire(import.meta.url)' not in bundle:
            raise AssertionError("node-only riscv64 bundle missing Node-compatible require shim")


def test_live_build_and_install_hook_require_riscv64_bun_provenance() -> None:
    build_text = BUILD_SH.read_text(encoding="utf-8")
    hook_text = INSTALL_HOOK.read_text(encoding="utf-8")
    for label, text in (("build.sh", build_text), ("0010 hook", hook_text)):
        if "riscv64-bun-provenance.json" not in text:
            raise AssertionError(f"{label} does not require riscv64 Bun provenance")
    if "staged_bun_sha256" not in build_text:
        raise AssertionError("build.sh does not verify staged Bun hash against provenance")
    if "eliza.os.linux.riscv64_bun_stage_provenance.v1" not in build_text:
        raise AssertionError("build.sh does not verify the riscv64 Bun provenance schema")


def test_runtime_smoke_requires_riscv64_output_markers() -> None:
    smoke_text = (
        LINUX_DIR / "scripts/check-riscv64-agent-runtime-artifact.sh"
    ).read_text(encoding="utf-8")
    for marker in (
        "elizaos-riscv64-bun-eval-ok riscv64",
        "elizaos-riscv64-bun-script-file-ok riscv64",
        "missing expected marker",
    ):
        if marker not in smoke_text:
            raise AssertionError(f"runtime smoke does not require marker: {marker}")


def test_riscv64_image_has_node_agent_bundle_fallback_before_bun() -> None:
    packages = RISCV64_PACKAGE_LIST.read_text(encoding="utf-8")
    for package in (
        "linux-image-riscv64",
        "grub-efi-riscv64",
        "grub-efi-riscv64-bin",
        "postgresql",
        "postgresql-17-pgvector",
        "nodejs",
        "node-undici",
        "node-ws",
        "node-fetch",
    ):
        if package not in packages:
            raise AssertionError(f"riscv64 package list must install {package}")

    hook = INSTALL_HOOK.read_text(encoding="utf-8")
    for expected in (
        "for module in undici ws node-fetch",
        "/usr/share/nodejs/${module}",
        "${INSTALL}/app/node_modules",
        "${INSTALL}/app/node_modules/${module}",
    ):
        if expected not in hook:
            raise AssertionError(f"install hook must provide app-local Node modules for riscv64 Node ESM: {expected}")

    run_agent = RUN_AGENT.read_text(encoding="utf-8")
    node_agent = "node /opt/elizaos/app/agent-bundle.js serve --headless"
    bun_agent = "/opt/elizaos/bin/bun /opt/elizaos/app/agent-bundle.js serve --headless"
    if node_agent not in run_agent:
        raise AssertionError("run-agent.sh is missing the riscv64 node agent-bundle fallback")
    if run_agent.index(node_agent) > run_agent.index(bun_agent):
        raise AssertionError("riscv64 node fallback must run before the Bun path that can SIGILL")
    if 'ARCH="$(dpkg --print-architecture 2>/dev/null || true)"' not in run_agent:
        raise AssertionError("run-agent.sh must detect the Debian architecture")
    if '[ "${AGENT_RUNTIME}" = "node-agent-bundle" ] || [ "${ARCH}" = "riscv64" ]' not in run_agent:
        raise AssertionError("node fallback must be scoped to riscv64")

    run_tui = RUN_TUI_SMOKE.read_text(encoding="utf-8")
    node_tui = "node /opt/elizaos/app/agent-bundle.js tui-smoke"
    bun_tui = "/opt/elizaos/bin/bun /opt/elizaos/app/agent-bundle.js tui-smoke"
    if node_tui not in run_tui:
        raise AssertionError("run-terminal-tui-smoke.sh is missing the riscv64 node fallback")
    if run_tui.index(node_tui) > run_tui.index(bun_tui):
        raise AssertionError("riscv64 node TUI fallback must run before the Bun path")


def test_boot_health_and_tui_markers_are_serial_provable() -> None:
    wait_health = WAIT_AGENT_HEALTH.read_text(encoding="utf-8")
    for marker in (
        "elizaos-curl-health-ready",
        "elizaos-agent-ready",
        "elizaos-agent-health-failed",
        "tee \"${DEVICE}\"",
        "sudo -n tee \"${DEVICE}\"",
    ):
        if marker not in wait_health:
            raise AssertionError(f"wait-agent-health.sh does not serial-emit marker/proof path: {marker}")

    first_boot = FIRST_BOOT.read_text(encoding="utf-8")
    for expected in (
        "elizaos-agent-starting",
        "systemctl start --no-block elizaos-agent.service",
        "elizaos-agent-health-failed",
        "elizaos-agent-diagnostics-start",
        "elizaos-agent-runtime-log-start",
        "dump_file_to_serial /var/log/elizaos/agent-runtime.log",
        "dump_file_to_serial /var/lib/elizaos/agent-runtime.log",
        "journalctl --no-pager -u elizaos-agent.service -n 120",
        "elizaos-tui-starting",
    ):
        if expected not in first_boot:
            raise AssertionError(f"first-boot.sh missing serial-provable boot diagnostic: {expected}")

    run_agent = RUN_AGENT.read_text(encoding="utf-8")
    if "run_agent_command node-agent-bundle node /opt/elizaos/app/agent-bundle.js" not in run_agent:
        raise AssertionError("run-agent.sh must emit the selected riscv64 agent entrypoint")
    if "elizaos-agent-exited runtime=${RUNTIME} rc=${RC}" not in run_agent:
        raise AssertionError("run-agent.sh must serial-emit nonzero runtime exits")
    if "agent-runtime.log" not in run_agent:
        raise AssertionError("run-agent.sh must preserve agent stderr/stdout for diagnostics")
    if 'AGENT_RUNTIME_LOG="${ELIZA_STATE_DIR}/agent-runtime.log"' not in run_agent:
        raise AssertionError("run-agent.sh must fall back to state dir if /var/log is unavailable")
    if "set +e" not in run_agent or "set -e" not in run_agent:
        raise AssertionError("run-agent.sh must capture nonzero agent exits under set -e")

    tui_unit = TUI_SMOKE_UNIT.read_text(encoding="utf-8")
    if "ExecStartPre=/usr/lib/elizaos/wait-agent-health.sh" not in tui_unit:
        raise AssertionError("terminal TUI smoke must wait for agent health before running")
    if "ELIZA_AGENT_HEALTH_TIMEOUT_SECONDS=240" not in tui_unit:
        raise AssertionError("terminal TUI smoke unit must carry a non-trivial health wait budget")

    rv64_hook = RISCV64_POSTGRES_HOOK.read_text(encoding="utf-8")
    for expected in (
        "/var/lib/elizaos/eliza.json",
        '"provider": "postgres"',
        '"connectionString": "postgresql://elizaos:elizaos@127.0.0.1:5432/elizaos"',
        "CREATE EXTENSION IF NOT EXISTS vector",
        "CREATE EXTENSION IF NOT EXISTS fuzzystrmatch",
        "CREATE EXTENSION IF NOT EXISTS pgcrypto",
        "ELIZA_PLATFORM=android",
        "ELIZA_MOBILE_PLATFORM=android",
        "elizaos-first-boot.service.d/10-riscv64-timeout.conf",
        "ELIZA_AGENT_HEALTH_TIMEOUT_SECONDS=600",
        "elizaos-terminal-tui-smoke.service.d/10-riscv64-timeout.conf",
        "TimeoutStartSec=900",
    ):
        if expected not in rv64_hook:
            raise AssertionError(f"riscv64 hook missing emulated boot proof timeout: {expected}")


if __name__ == "__main__":
    test_stale_riscv64_bun_zip_is_rejected()
    test_fresh_riscv64_stage_writes_patch_bound_provenance()
    test_riscv64_node_only_stage_omits_bun_but_keeps_agent_bundle()
    test_live_build_and_install_hook_require_riscv64_bun_provenance()
    test_runtime_smoke_requires_riscv64_output_markers()
    test_riscv64_image_has_node_agent_bundle_fallback_before_bun()
    test_boot_health_and_tui_markers_are_serial_provable()
    print("OK")
