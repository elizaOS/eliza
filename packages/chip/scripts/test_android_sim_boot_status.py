#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOOT = ROOT / "scripts/boot_android_simulator.sh"
CHECK = ROOT / "scripts/check_android_sim_boot.py"
PREFLIGHT = ROOT / "scripts/check_aosp_linux_preflight.py"
CAPTURE_AOSP = ROOT / "sw/aosp-device/capture-aosp-evidence.sh"
IMPORT_AOSP = ROOT / "sw/aosp-device/import-aosp-device.sh"
BOARD_CONFIG = ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/BoardConfig.mk"
FRAMEWORK_MATRIX = ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/device_framework_matrix.xml"
BUILD_AOSP_RISCV64 = ROOT / "sw/aosp-device/build-aosp-riscv64.sh"
TEST_REPORT_DIR = tempfile.TemporaryDirectory()
REPORT = Path(TEST_REPORT_DIR.name) / "android_sim_boot.json"
PREFLIGHT_REPORT = Path(TEST_REPORT_DIR.name) / "aosp_linux_preflight.json"


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"missing {expected!r} in output:\n{text}")


def run(
    command: list[str], env_overrides: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.pop("AOSP_DIR", None)
    env["ANDROID_SIM_BOOT_REPORT"] = str(REPORT)
    env["AOSP_LINUX_PREFLIGHT_REPORT"] = str(PREFLIGHT_REPORT)
    if env_overrides:
        env.update(env_overrides)
    return subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def fake_repo_path(tmp: Path) -> str:
    repo = tmp / "repo"
    repo.write_text(
        "#!/bin/sh\necho '<repo not installed>'\necho 'repo launcher version 2.54'\nexit 0\n"
    )
    repo.chmod(0o755)
    return f"{tmp}{os.pathsep}{os.environ.get('PATH', '')}"


def test_boot_script_blocks_without_aosp_dir() -> None:
    result = run([str(BOOT)])
    if result.returncode != 2:
        raise AssertionError(
            f"expected boot script to block, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "BLOCKED: AOSP_DIR is not set")
    data = json.loads(REPORT.read_text())
    if data.get("schema") != "eliza.android_sim_boot.v1":
        raise AssertionError("android sim report schema mismatch")
    if data.get("status") != "blocked":
        raise AssertionError("android sim report must be blocked without AOSP_DIR")
    if "not e1-chip hardware ABI proof" not in data.get("claim_boundary", ""):
        raise AssertionError("android sim report must keep the e1-chip ABI boundary explicit")
    missing_requirements = data.get("host_requirements", {}).get("missing", [])
    if not any("AOSP_DIR is not set" in item for item in missing_requirements):
        raise AssertionError(
            f"android sim report missing deterministic AOSP_DIR blocker: {missing_requirements}"
        )
    findings = data.get("findings", [])
    if not any(item.get("code") == "android_sim_host_aosp_dir_is_not_set" for item in findings):
        raise AssertionError(f"android sim report missing structured AOSP_DIR finding: {findings}")
    if not any(item.get("code", "").startswith("android_sim_status_") for item in findings):
        raise AssertionError(f"android sim report missing structured status finding: {findings}")
    for key in ("run_qemu", "run_renode"):
        if not isinstance(data.get(key), bool):
            raise AssertionError(f"android sim report must include boolean {key}")
    linux_requirements = data.get("linux_requirements", [])
    for requirement in ("AOSP_DIR", "/dev/kvm", "launch_cvd"):
        if not any(requirement in item for item in linux_requirements):
            raise AssertionError(
                f"android sim report missing Linux requirement {requirement!r}: "
                f"{linux_requirements}"
            )
    handoff_commands = data.get("handoff_commands", [])
    for command in (
        "scripts/check_aosp_linux_preflight.py --write-report",
        "scripts/boot_android_simulator.sh --run-cuttlefish",
        "scripts/check_software_bsp.py aosp --require-evidence",
    ):
        if not any(command in item for item in handoff_commands):
            raise AssertionError(
                f"android sim report missing handoff command {command!r}: {handoff_commands}"
            )
    if data.get("evidence_manifest") != "docs/android/bsp-log-evidence-manifest.json":
        raise AssertionError("android sim report must reference the BSP log evidence manifest")
    required = data.get("required_evidence", [])
    for path in (
        "docs/evidence/android/eliza_ai_soc_sepolicy_build.log",
        "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log",
        "docs/evidence/android/qemu_riscv64_smoke.log",
        "docs/evidence/android/renode_e1_soc_smoke.log",
    ):
        if path not in required:
            raise AssertionError(f"android sim report missing required evidence category {path}")


def test_riscv64_aosp_overlay_materializes_files_not_host_symlinks() -> None:
    text = BUILD_AOSP_RISCV64.read_text(encoding="utf-8")
    if "rsync -aL --delete \"$ELIZA_VENDOR_SRC/\" \"$vendor_dst/\"" not in text:
        raise AssertionError("AOSP riscv64 overlay must dereference vendor/eliza files")
    if "rsync -aL --delete \"$DEVICE_OVERLAY_SRC/\" \"$dst/\"" not in text:
        raise AssertionError("AOSP riscv64 overlay must dereference device overlay files")
    if "assert_no_overlay_symlinks" not in text or "materialize_overlay_symlinks" not in text:
        raise AssertionError("AOSP riscv64 overlay must fail closed on remaining symlinks")
    if "ln -sfn \"$ELIZA_VENDOR_SRC" in text or "ln -sfn \"$DEVICE_OVERLAY_SRC" in text:
        raise AssertionError("AOSP riscv64 overlay must not install host-local symlinks")


def test_checker_reports_blocked_report() -> None:
    if not REPORT.is_file():
        test_boot_script_blocks_without_aosp_dir()
    result = run([sys.executable, str(CHECK)])
    if result.returncode != 2:
        raise AssertionError(
            f"expected checker to return blocked, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "Android simulator boot blocked")
    assert_contains(result.stdout, "AOSP_DIR")


def test_checker_rejects_pass_without_required_aosp_evidence() -> None:
    blocked = json.loads(REPORT.read_text()) if REPORT.is_file() else None
    if blocked is None or blocked.get("status") != "blocked":
        test_boot_script_blocks_without_aosp_dir()
        blocked = json.loads(REPORT.read_text())
    blocked["status"] = "pass"
    blocked["reason"] = "synthetic pass report for checker coverage"
    blocked["next_step"] = "none"
    REPORT.write_text(json.dumps(blocked, indent=2))
    result = run([sys.executable, str(CHECK)])
    if result.returncode != 1:
        raise AssertionError(
            f"expected checker to reject pass without evidence, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "Android simulator boot failed")
    assert_contains(result.stdout, "pass report")


def test_boot_script_reports_uninstalled_repo_launcher() -> None:
    with tempfile.TemporaryDirectory() as td:
        result = run([str(BOOT)], {"PATH": fake_repo_path(Path(td))})
    if result.returncode != 2:
        raise AssertionError(
            f"expected boot script to block, got {result.returncode}\n{result.stdout}"
        )
    data = json.loads(REPORT.read_text())
    missing_requirements = data.get("host_requirements", {}).get("missing", [])
    if not any("repo is not installed" in item for item in missing_requirements):
        raise AssertionError(
            f"android sim report must identify an uninstalled repo launcher: {missing_requirements}"
        )


def test_aosp_linux_preflight_blocks_without_aosp_dir() -> None:
    saved = PREFLIGHT_REPORT.read_bytes() if PREFLIGHT_REPORT.is_file() else None
    try:
        result = run([sys.executable, str(PREFLIGHT), "--json", "--write-report"])
        if result.returncode != 2:
            raise AssertionError(
                f"expected preflight to block, got {result.returncode}\n{result.stdout}"
            )
        data = json.loads(result.stdout)
        if data.get("schema") != "eliza.aosp_linux_preflight.v1":
            raise AssertionError("AOSP Linux preflight schema mismatch")
        if data.get("status") != "blocked":
            raise AssertionError("AOSP Linux preflight must block without AOSP_DIR")
        if "AOSP_DIR is not set" not in data.get("blockers", []):
            raise AssertionError("AOSP Linux preflight must report missing AOSP_DIR")
        if data.get("claim_boundary") != (
            "host_preflight_only_not_aosp_build_boot_cuttlefish_or_e1_chip_hardware_evidence"
        ):
            raise AssertionError("AOSP Linux preflight claim boundary changed")
        if "does not create docs/evidence/android logs" not in data.get("evidence_policy", ""):
            raise AssertionError("AOSP Linux preflight must not fabricate evidence logs")
        linux_requirements = data.get("linux_requirements", [])
        for requirement in ("AOSP_DIR", "/dev/kvm", "launch_cvd"):
            if not any(requirement in item for item in linux_requirements):
                raise AssertionError(
                    f"AOSP Linux preflight missing Linux requirement {requirement!r}: "
                    f"{linux_requirements}"
                )
        handoff_commands = data.get("handoff_commands", [])
        for command in (
            "scripts/check_aosp_linux_preflight.py --write-report",
            "scripts/boot_android_simulator.sh --run-cuttlefish",
            "scripts/check_software_bsp.py aosp --require-evidence",
        ):
            if not any(command in item for item in handoff_commands):
                raise AssertionError(
                    f"AOSP Linux preflight missing handoff command {command!r}: {handoff_commands}"
                )
    finally:
        if saved is None:
            PREFLIGHT_REPORT.unlink(missing_ok=True)
        else:
            PREFLIGHT_REPORT.parent.mkdir(parents=True, exist_ok=True)
            PREFLIGHT_REPORT.write_bytes(saved)


def test_aosp_linux_preflight_reports_uninstalled_repo_launcher() -> None:
    saved = PREFLIGHT_REPORT.read_bytes() if PREFLIGHT_REPORT.is_file() else None
    try:
        with tempfile.TemporaryDirectory() as td:
            result = run(
                [sys.executable, str(PREFLIGHT), "--json", "--write-report"],
                {"PATH": fake_repo_path(Path(td))},
            )
        if result.returncode != 2:
            raise AssertionError(
                f"expected preflight to block, got {result.returncode}\n{result.stdout}"
            )
        data = json.loads(result.stdout)
        blockers = data.get("blockers", [])
        if not any("repo is not installed" in item for item in blockers):
            raise AssertionError(
                f"AOSP Linux preflight must identify an uninstalled repo launcher: {blockers}"
            )
        import_blockers = data.get("execution_tracks", {}).get("import", {}).get("blockers", [])
        if not any("repo is not installed" in item for item in import_blockers):
            raise AssertionError(
                "AOSP Linux preflight import track must identify an uninstalled repo launcher: "
                f"{import_blockers}"
            )
    finally:
        if saved is None:
            PREFLIGHT_REPORT.unlink(missing_ok=True)
        else:
            PREFLIGHT_REPORT.parent.mkdir(parents=True, exist_ok=True)
            PREFLIGHT_REPORT.write_bytes(saved)


def test_aosp_linux_preflight_allows_existing_checkout_without_repo() -> None:
    saved = PREFLIGHT_REPORT.read_bytes() if PREFLIGHT_REPORT.is_file() else None
    try:
        with tempfile.TemporaryDirectory() as checkout, tempfile.TemporaryDirectory() as path_dir:
            checkout_path = Path(checkout)
            (checkout_path / "build").mkdir()
            (checkout_path / "build/envsetup.sh").write_text("# fake envsetup\n")
            (checkout_path / "device").mkdir()
            result = run(
                [
                    sys.executable,
                    str(PREFLIGHT),
                    "--json",
                    "--write-report",
                    "--aosp-dir",
                    str(checkout_path),
                ],
                {"PATH": fake_repo_path(Path(path_dir))},
            )
        data = json.loads(result.stdout)
        blockers = data.get("blockers", [])
        if any("repo is not installed" in item for item in blockers):
            raise AssertionError(
                "existing checkout should not be blocked by an uninstalled repo launcher: "
                f"{blockers}"
            )
        warnings = data.get("warnings", [])
        if not any("repo is not installed" in item for item in warnings):
            raise AssertionError(
                f"existing checkout should still warn about the broken repo launcher: {warnings}"
            )
    finally:
        if saved is None:
            PREFLIGHT_REPORT.unlink(missing_ok=True)
        else:
            PREFLIGHT_REPORT.parent.mkdir(parents=True, exist_ok=True)
            PREFLIGHT_REPORT.write_bytes(saved)


def test_android_handoff_uses_shared_build_evidence_helpers() -> None:
    boot_text = BOOT.read_text()
    for mode in ("sepolicy-build", "selinux-neverallow"):
        expected = f"run_helper_stage {mode}"
        if expected not in boot_text:
            raise AssertionError(f"boot handoff must use shared {mode} evidence helper")
    if "capture_aosp_shell \\\n\teliza_ai_soc_sepolicy_build" in boot_text:
        raise AssertionError("boot handoff must not bypass shared sepolicy-build helper")


def test_aosp_vintf_evidence_maps_all_output_partitions() -> None:
    capture_text = CAPTURE_AOSP.read_text()
    if "checkvintf framework_compatibility_matrix.device.xml" not in capture_text:
        raise AssertionError("checkvintf evidence must rebuild the device framework matrix")
    for partition in ("/system", "/vendor", "/odm", "/product", "/system_ext", "/apex"):
        expected = f'--dirmap {partition}:"$product_out{partition}"'
        if expected not in capture_text:
            raise AssertionError(f"checkvintf evidence must map {partition}")


def test_eliza_device_framework_matrix_is_imported() -> None:
    board_text = BOARD_CONFIG.read_text()
    if "DEVICE_FRAMEWORK_COMPATIBILITY_MATRIX_FILE" not in board_text:
        raise AssertionError("BoardConfig must register the Eliza framework matrix")
    matrix_text = FRAMEWORK_MATRIX.read_text()
    for marker in ("vendor.eliza.e1_npu", "IE1Npu", "default"):
        if marker not in matrix_text:
            raise AssertionError(f"framework matrix missing {marker}")
    import_text = IMPORT_AOSP.read_text()
    if "device_framework_matrix.xml" not in import_text:
        raise AssertionError("import helper must copy/check the framework matrix")


def main() -> int:
    saved = REPORT.read_bytes() if REPORT.is_file() else None
    try:
        for test in (
            test_boot_script_blocks_without_aosp_dir,
            test_checker_reports_blocked_report,
            test_checker_rejects_pass_without_required_aosp_evidence,
            test_boot_script_reports_uninstalled_repo_launcher,
            test_aosp_linux_preflight_blocks_without_aosp_dir,
            test_aosp_linux_preflight_reports_uninstalled_repo_launcher,
            test_aosp_linux_preflight_allows_existing_checkout_without_repo,
            test_riscv64_aosp_overlay_materializes_files_not_host_symlinks,
            test_android_handoff_uses_shared_build_evidence_helpers,
            test_aosp_vintf_evidence_maps_all_output_partitions,
            test_eliza_device_framework_matrix_is_imported,
        ):
            test()
            print(f"PASS {test.__name__}")
    finally:
        if saved is None:
            REPORT.unlink(missing_ok=True)
        else:
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            REPORT.write_bytes(saved)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
