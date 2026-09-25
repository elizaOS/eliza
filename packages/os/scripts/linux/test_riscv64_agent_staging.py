#!/usr/bin/env python3
"""Focused tests for riscv64 agent/Bun staging provenance."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import stat
import struct
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LINUX_DIR = ROOT / "linux/elizaos"
SCRIPT = ROOT / "scripts/linux/stage-agent-artifacts.sh"
BUILD_SH = LINUX_DIR / "build-live-iso.sh"
INSTALL_HOOK = LINUX_DIR / "config/hooks/normal/0010-elizaos-agent.hook.chroot"
RISCV64_PACKAGE_LIST = LINUX_DIR / "config/package-lists/elizaos-riscv64.list.chroot"
RUN_AGENT = LINUX_DIR / "config/includes.chroot/usr/lib/elizaos/run-agent.sh"
WAIT_AGENT_HEALTH = LINUX_DIR / "config/includes.chroot/usr/lib/elizaos/wait-agent-health.sh"
FIRST_BOOT = LINUX_DIR / "config/includes.chroot/usr/local/lib/elizaos/first-boot.sh"
RISCV64_POSTGRES_HOOK = LINUX_DIR / "config/hooks/normal/0012-riscv64-agent-postgres.hook.chroot"
MUSL_RUNTIME = LINUX_DIR / "artifacts/riscv64/elizaos-app/musl-runtime"


def fixture_environment(directory: Path, bundle_source: str = 'export const fixture = true;\n') -> dict[str, str]:
    """Stage synthetic bundles without depending on or modifying a real build."""
    source = directory / "eliza-source"
    app = source / "packages/app"
    app.mkdir(parents=True, exist_ok=True)
    (app / "package.json").write_text('{"name":"@elizaos/app"}\n', encoding="utf-8")
    bundle = source / "packages/agent/dist-mobile/agent-bundle.js"
    bundle.parent.mkdir(parents=True, exist_ok=True)
    bundle.write_text(bundle_source, encoding="utf-8")
    return {**os.environ, "ELIZAOS_ELIZA_ROOT": str(source)}


def executable_elf(machine=243, flags=4, kind=2):
    header = bytearray(64)
    header[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", header, 16, kind, machine, 1)
    struct.pack_into("<I", header, 48, flags)
    struct.pack_into("<H", header, 52, 64)
    return bytes(header)


def make_bun_zip(path: Path) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("bun-linux-riscv64-musl/", "")
        archive.writestr("bun-linux-riscv64-musl/bun", executable_elf())
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
        env=fixture_environment(out_dir.parent),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def run_node_only_stage(out_dir: Path, bundle_source: str = 'export const fixture = true;\n') -> subprocess.CompletedProcess[str]:
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
        env=fixture_environment(out_dir.parent, bundle_source),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_staged_agent_preserves_a_leading_shebang() -> None:
    with tempfile.TemporaryDirectory() as directory:
        out = Path(directory) / "out"
        source = "#!/usr/bin/env node\nexport const fixture = true;\n"
        result = run_node_only_stage(out, source)
        assert result.returncode == 0, result.stdout
        staged = out / "elizaos-app/agent-bundle.js"
        content = staged.read_text()
        assert content.startswith("#!/usr/bin/env node\n")
        assert content.endswith("export const fixture = true;\n")
        checked = subprocess.run(["node", "--check", str(staged)],
                                 text=True, capture_output=True, check=False)
        assert checked.returncode == 0, checked.stderr


def test_stage_options_fail_before_source_resolution() -> None:
    environment = {**os.environ, "ELIZAOS_ELIZA_ROOT": "/missing-eliza-source"}
    for option in ("--arch", "--out", "--bun-source", "--riscv64-bun-zip",
                   "--riscv64-musl-runtime", "--riscv64-icu-data"):
        for values in ([], [""], ["--skip-build"]):
            result = subprocess.run([str(SCRIPT), option, *values], env=environment,
                                    text=True, capture_output=True, check=False)
            assert result.returncode == 64, result.stderr
            assert f"{option} requires a value" in result.stderr, result.stderr
    result = subprocess.run([str(SCRIPT), "--help"], env=environment,
                            text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    assert "usage:" in result.stdout


def test_stale_riscv64_bun_zip_is_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        stale_zip = make_bun_zip(tmp / "bun-linux-riscv64-musl.zip")
        os.utime(stale_zip, (1, 1))
        out_dir = tmp / "out"
        out_dir.mkdir()
        sentinel = out_dir / "previous-artifact"
        sentinel.write_bytes(b"preserve me")
        result = run_stage(stale_zip, out_dir)
        if result.returncode != 66:
            raise AssertionError(f"expected stale zip rejection rc=66, got {result.returncode}\n{result.stdout}")
        if "riscv64 Bun zip predates current patch-series input" not in result.stdout:
            raise AssertionError(result.stdout)
        assert sentinel.read_bytes() == b"preserve me"
        assert sorted(p.name for p in out_dir.iterdir()) == ["previous-artifact"]
        assert not list(tmp.glob(".elizaos-stage*"))


def test_invalid_bun_archive_preserves_prior_artifacts() -> None:
    for variant in ("ambiguous", "wrong-name", "empty", "symlink", "script", "host-elf", "soft-float", "object"):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            archive_path = tmp / "bun.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                if variant == "ambiguous":
                    archive.writestr("first/bun", b"one")
                    archive.writestr("second/bun", b"two")
                elif variant == "wrong-name":
                    archive.writestr("not-bun", b"wrong")
                elif variant == "empty":
                    archive.writestr("bun", b"")
                elif variant in ("script", "host-elf", "soft-float", "object"):
                    payload = {
                        "script": b"#!/bin/sh\nexit 0\n",
                        "host-elf": executable_elf(machine=62),
                        "soft-float": executable_elf(flags=0),
                        "object": executable_elf(kind=1),
                    }[variant]
                    archive.writestr("bun", payload)
                else:
                    entry = zipfile.ZipInfo("bun")
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(entry, b"other-file")
            future = time.time() + 10
            os.utime(archive_path, (future, future))
            out = tmp / "out"
            out.mkdir()
            (out / "previous").write_bytes(b"keep")
            result = run_stage(archive_path, out)
            assert result.returncode != 0, (variant, result.stdout)
            assert "ERROR: riscv64 Bun zip" in result.stdout, result.stdout
            assert (out / "previous").read_bytes() == b"keep"
            assert sorted(p.name for p in out.iterdir()) == ["previous"]
            assert not list(tmp.glob(".elizaos-stage*"))


def test_fresh_riscv64_stage_writes_patch_bound_provenance() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        out_dir = tmp / "out"
        musl_runtime = out_dir / "elizaos-app/musl-runtime"
        musl_runtime.mkdir(parents=True)
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
            "toolchains/bun-riscv64/bun-version.json",
            "toolchains/bun-riscv64/bun-patches/0021-fix-riscv64-linux-open-flags.patch",
        }
        missing = sorted(required_inputs - set(inputs))
        if missing:
            raise AssertionError(f"provenance missing current patch inputs: {missing}")
        artifact = provenance.get("artifact", {})
        if artifact.get("zip_path") != str(fresh_zip.resolve()):
            raise AssertionError(artifact)
        if not artifact.get("staged_bun_sha256"):
            raise AssertionError(artifact)
        assert artifact["staged_bun"] == str(musl_runtime / "bun")
        assert (musl_runtime / "libstdc++.so.6").read_bytes() == b"fake libstdc++.so.6\n"
        assert not list(tmp.glob(".elizaos-stage*"))


def test_riscv64_node_only_stage_omits_bun_but_keeps_agent_bundle() -> None:

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


def test_stage_rejects_output_symlink_without_modifying_its_target() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        target = tmp / "existing"
        target.mkdir()
        sentinel = target / "sentinel"
        sentinel.write_bytes(b"original")
        output = tmp / "out"
        output.symlink_to(target, target_is_directory=True)
        result = run_node_only_stage(output)
        assert result.returncode != 0, result.stdout
        assert "output directory must not be a symlink" in result.stdout
        assert output.is_symlink()
        assert sentinel.read_bytes() == b"original"


def test_live_build_and_install_hook_require_riscv64_bun_provenance() -> None:
    build_text = BUILD_SH.read_text(encoding="utf-8")
    hook_text = INSTALL_HOOK.read_text(encoding="utf-8")
    for label, text in (("build-live-iso.sh", build_text), ("0010 hook", hook_text)):
        if "riscv64-bun-provenance.json" not in text:
            raise AssertionError(f"{label} does not require riscv64 Bun provenance")
    if "staged_bun_sha256" not in build_text:
        raise AssertionError("build-live-iso.sh does not verify staged Bun hash against provenance")
    if "eliza.os.linux.riscv64_bun_stage_provenance.v1" not in build_text:
        raise AssertionError("build-live-iso.sh does not verify the riscv64 Bun provenance schema")


def test_artifact_check_never_claims_runtime_execution() -> None:
    checker = ROOT / "scripts/linux/check-riscv64-agent-runtime-artifact.sh"
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        out = tmp / "out"
        result = run_node_only_stage(out)
        assert result.returncode == 0, result.stdout
        report = tmp / "report.json"
        transcript = tmp / "transcript.log"
        def check():
            return subprocess.run([str(checker), str(out)], env={**os.environ,
                "RISCV64_AGENT_RUNTIME_REPORT": str(report),
                "RISCV64_AGENT_RUNTIME_TRANSCRIPT": str(transcript)},
                text=True, capture_output=True, check=False)
        checked = check()
        assert checked.returncode == 0, checked.stderr
        assert json.loads(report.read_text())["runtime_mode"] == "node"
        assert "artifact-verified" in transcript.read_text()
        assert "eval-ok" not in transcript.read_text()
        bun = out / "bun"
        bun.write_text("#!/bin/sh\nexit 99\n")
        assert check().returncode == 2
        assert json.loads(report.read_text())["status"] == "BLOCKED"
        bun.chmod(0o755)
        (out / "bun.sha256").write_text(hashlib.sha256(bun.read_bytes()).hexdigest() + "  bun\n")
        checked = check()
        assert checked.returncode == 0, checked.stderr
        evidence = json.loads(report.read_text())
        assert evidence["runtime_mode"] == "bun"
        assert evidence["claim_boundary"].startswith("static_staged_runtime_artifact_check_only")
        text = transcript.read_text()
        assert "bun-artifact-hash-verified" in text
        assert "eval-ok" not in text and "script-file-ok" not in text


def test_artifact_check_defaults_to_repository_test_output() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        out = tmp / "out"
        assert run_node_only_stage(out).returncode == 0
        env = fixture_environment(tmp)
        for name in ("RISCV64_AGENT_RUNTIME_REPORT", "RISCV64_AGENT_RUNTIME_TRANSCRIPT"):
            env.pop(name, None)
        helper = Path(env["ELIZAOS_ELIZA_ROOT"]) / "packages/scripts/lib/test-output.ts"
        helper.parent.mkdir(parents=True)
        helper.write_bytes((ROOT.parent / "scripts/lib/test-output.ts").read_bytes())
        result = subprocess.run([str(ROOT / "scripts/linux/check-riscv64-agent-runtime-artifact.sh"), str(out)],
            cwd=tmp, env=env, capture_output=True, text=True, check=False)
        assert result.returncode == 0, result.stderr
        report = Path(env["ELIZAOS_ELIZA_ROOT"]) / "test-results/os-riscv64-runtime-artifact/report.json"
        assert json.loads(report.read_text())["status"] == "pass"
        assert not (tmp / "evidence").exists()


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
    node_agent = "node \\\n            --no-wasm-tier-up"
    bun_agent = "/opt/elizaos/bin/bun /opt/elizaos/app/agent-bundle.js serve --headless"
    if node_agent not in run_agent:
        raise AssertionError("run-agent.sh is missing the node agent-bundle fallback with V8 Wasm tier-up disabled")
    for flag in ("--no-wasm-tier-up", "--no-wasm-dynamic-tiering", "--liftoff-only"):
        if flag not in run_agent:
            raise AssertionError(f"run-agent.sh node fallback is missing {flag}")
    if run_agent.index(node_agent) > run_agent.index(bun_agent):
        raise AssertionError("riscv64 node fallback must run before the Bun path that can SIGILL")
    if 'ARCH="$(dpkg --print-architecture 2>/dev/null || true)"' not in run_agent:
        raise AssertionError("run-agent.sh must detect the Debian architecture")
    if '[ "${AGENT_RUNTIME}" = "node-agent-bundle" ] || [ "${ARCH}" = "riscv64" ]' not in run_agent:
        raise AssertionError("node fallback must include the explicit riscv64 scope")
    if '{ [ "${ARCH}" = "arm64" ] && [ ! -f /opt/elizaos/app/Resources/app/eliza-dist/index.js ]; }' not in run_agent:
        raise AssertionError("node fallback must cover bare arm64 agent bundles without Electrobun")

def test_boot_health_markers_are_serial_provable() -> None:
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
    ):
        if expected not in first_boot:
            raise AssertionError(f"first-boot.sh missing serial-provable boot diagnostic: {expected}")

    run_agent = RUN_AGENT.read_text(encoding="utf-8")
    if "run_agent_command node-agent-bundle node \\" not in run_agent:
        raise AssertionError("run-agent.sh must emit the selected riscv64 agent entrypoint")
    if "/opt/elizaos/app/agent-bundle.js serve --headless" not in run_agent:
        raise AssertionError("run-agent.sh must pass the staged agent-bundle.js to Debian node")
    if "elizaos-agent-exited runtime=${RUNTIME} rc=${RC}" not in run_agent:
        raise AssertionError("run-agent.sh must serial-emit nonzero runtime exits")
    if "agent-runtime.log" not in run_agent:
        raise AssertionError("run-agent.sh must preserve agent stderr/stdout for diagnostics")
    if 'AGENT_RUNTIME_LOG="${ELIZA_STATE_DIR}/agent-runtime.log"' not in run_agent:
        raise AssertionError("run-agent.sh must fall back to state dir if /var/log is unavailable")
    if "set +e" not in run_agent or "set -e" not in run_agent:
        raise AssertionError("run-agent.sh must capture nonzero agent exits under set -e")

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
        "TimeoutStartSec=900",
    ):
        if expected not in rv64_hook:
            raise AssertionError(f"riscv64 hook missing emulated boot proof timeout: {expected}")


if __name__ == "__main__":
    test_staged_agent_preserves_a_leading_shebang()
    test_stage_options_fail_before_source_resolution()
    test_invalid_bun_archive_preserves_prior_artifacts()
    test_stale_riscv64_bun_zip_is_rejected()
    test_fresh_riscv64_stage_writes_patch_bound_provenance()
    test_riscv64_node_only_stage_omits_bun_but_keeps_agent_bundle()
    test_stage_rejects_output_symlink_without_modifying_its_target()
    test_live_build_and_install_hook_require_riscv64_bun_provenance()
    test_artifact_check_defaults_to_repository_test_output()
    test_artifact_check_never_claims_runtime_execution()
    test_riscv64_image_has_node_agent_bundle_fallback_before_bun()
    test_boot_health_markers_are_serial_provable()
    print("OK")
