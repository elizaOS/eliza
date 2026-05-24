#!/usr/bin/env python3
"""Static contract check for elizaOS Linux multi-arch UEFI boot support."""

from __future__ import annotations

from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]

ARCH_PACKAGE_REQUIREMENTS = {
    "amd64": (
        "linux-image-amd64",
        "grub-efi-amd64-bin",
        "grub-pc-bin",
    ),
    "arm64": (
        "linux-image-arm64",
        "grub-efi-arm64-bin",
    ),
    "riscv64": (
        "linux-image-riscv64",
        "grub-efi-riscv64",
        "grub-efi-riscv64-bin",
    ),
}

DESKTOP_PACKAGE_REQUIREMENTS = (
    "xorg",
    "gdm3",
    "gnome-session",
    "gnome-shell",
    "gnome-terminal",
    "gnome-control-center",
    "nautilus",
    "network-manager",
    "network-manager-gnome",
    "pulseaudio",
    "pipewire",
    "pipewire-pulse",
    "epiphany-browser",
    "plymouth",
    "plymouth-themes",
    "plymouth-label",
)

DOCKERFILE_REQUIREMENTS = (
    "grub-efi-amd64-bin",
    "grub-efi-arm64-bin",
    "grub-pc-bin",
    "ovmf",
    "qemu-system-arm",
    "qemu-system-misc",
    "qemu-efi-aarch64",
    "qemu-efi-riscv64",
    "qemu-user-static",
)

RISCV64_PORT_CONTRACT = {
    "architecture": "riscv64",
    "multiarch_tuple": "riscv64-linux-gnu",
    "gnu_triplet": "riscv64-unknown-linux-gnu",
    "removable_uefi_path": "EFI/boot/bootriscv64.efi",
}
RISCV64_UPSTREAM_REFERENCES = (
    "https://wiki.debian.org/Ports/riscv64",
    "https://wiki.debian.org/UEFI",
    "https://packages.debian.org/sid/grub-efi-riscv64",
)
ARCH_RUNTIME_EVIDENCE_REQUIREMENTS = {
    "amd64": (
        "Debian live ISO root filesystem boots under QEMU via extracted ISO kernel/initrd",
        "guest-side curl reached http://127.0.0.1:31337/api/health",
        "real packaged eliza agent service reported ready",
        "terminal TUI smoke reported ready",
    ),
    "arm64": (
        "Debian live ISO root filesystem boots under QEMU",
        "guest-side curl reached http://127.0.0.1:31337/api/health",
        "real packaged eliza agent service reported ready",
        "terminal TUI smoke reported ready",
    ),
    "riscv64": (
        "Debian live ISO boots under qemu-system-riscv64 -M virt through EDK2/OpenSBI",
        "GRUB EFI path is visible in transcript",
        "guest-side curl reached http://127.0.0.1:31337/api/health",
        "agent readiness marker reported",
        "terminal TUI smoke marker reported",
    ),
}
BLOCKING_GAP_PATTERNS = (
    "fallback agent",
    "missing-current-iso-evidence",
    "must be staged",
    "must be recaptured",
    "need to be collected",
    "predates verified",
    "times out before",
    "runtime binary is missing",
    "illegal instruction",
    "sigill",
    "unhandled signal 4",
)


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def package_lines(path: Path) -> set[str]:
    lines: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.add(line)
    return lines


def require(errors: list[str], condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def architecture_rows(matrix: dict) -> dict[str, dict]:
    rows = matrix.get("architectures", [])
    if not isinstance(rows, list):
        return {}
    return {
        row.get("arch"): row
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("arch"), str)
    }


def matrix_blocking_gaps(row: dict) -> list[str]:
    gaps = row.get("gaps", [])
    if not isinstance(gaps, list):
        return ["gaps field is not a list"]
    blocked: list[str] = []
    for gap in gaps:
        if not isinstance(gap, str):
            continue
        lowered = gap.lower()
        if any(pattern in lowered for pattern in BLOCKING_GAP_PATTERNS):
            blocked.append(gap)
    return blocked


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_runtime_artifacts(errors: list[str], matrix: dict) -> None:
    rows = architecture_rows(matrix)
    for arch, row in rows.items():
        artifacts = row.get("runtime_artifacts")
        if artifacts is None:
            continue
        require(
            errors,
            isinstance(artifacts, dict),
            f"multiarch boot matrix {arch} runtime_artifacts must be an object",
        )
        if not isinstance(artifacts, dict):
            continue
        bun = artifacts.get("bun")
        agent_bundle = artifacts.get("agent_bundle")
        expected_sha = artifacts.get("bun_sha256")
        runtime_mode = artifacts.get("runtime_mode", "bun")
        riscv64_bun_provenance = artifacts.get("riscv64_bun_provenance")
        require(
            errors,
            runtime_mode in ("bun", "node"),
            f"multiarch boot matrix {arch} runtime_artifacts.runtime_mode must be bun or node",
        )
        require(
            errors,
            runtime_mode == "node" or (isinstance(bun, str) and bool(bun)),
            f"multiarch boot matrix {arch} runtime_artifacts.bun missing",
        )
        require(
            errors,
            isinstance(agent_bundle, str) and bool(agent_bundle),
            f"multiarch boot matrix {arch} runtime_artifacts.agent_bundle missing",
        )
        require(
            errors,
            runtime_mode == "node" or (isinstance(expected_sha, str) and len(expected_sha) == 64),
            f"multiarch boot matrix {arch} runtime_artifacts.bun_sha256 must be 64 hex chars",
        )
        if runtime_mode == "node":
            if isinstance(agent_bundle, str):
                agent_bundle_path = ROOT / agent_bundle
                require(
                    errors,
                    agent_bundle_path.is_dir(),
                    f"multiarch boot matrix {arch} agent bundle missing: {agent_bundle}",
                )
                bundle = agent_bundle_path / "agent-bundle.js"
                require(
                    errors,
                    bundle.is_file(),
                    f"multiarch boot matrix {arch} node runtime artifact missing: {agent_bundle}/agent-bundle.js",
                )
                if bundle.is_file():
                    first = bundle.read_text(encoding="utf-8", errors="ignore").splitlines()[:1]
                    require(
                        errors,
                        first in (["#!/usr/bin/env node"], ["#!/usr/bin/node"]),
                        f"multiarch boot matrix {arch} node agent bundle missing node shebang",
                    )
            continue
        if not (isinstance(bun, str) and isinstance(expected_sha, str) and len(expected_sha) == 64):
            continue
        bun_path = ROOT / bun
        require(
            errors,
            bun_path.is_file(),
            f"multiarch boot matrix {arch} runtime artifact missing: {bun}",
        )
        if bun_path.is_file():
            actual_sha = sha256_file(bun_path)
            require(
                errors,
                actual_sha == expected_sha,
                f"multiarch boot matrix {arch} runtime artifact {bun} sha256 mismatch: {actual_sha}",
            )
        if isinstance(agent_bundle, str):
            agent_bundle_path = ROOT / agent_bundle
            require(
                errors,
                agent_bundle_path.is_dir(),
                f"multiarch boot matrix {arch} agent bundle missing: {agent_bundle}",
            )
            if (
                arch == "riscv64"
                and bun_path.is_file()
                and agent_bundle_path.is_dir()
                and "musl-runtime/bun" in bun_path.read_text(
                    encoding="utf-8", errors="ignore"
                )
            ):
                require(
                    errors,
                    (agent_bundle_path / "musl-runtime/bun").is_file(),
                    "multiarch boot matrix riscv64 wrapper requires runtime artifact "
                    f"{agent_bundle}/musl-runtime/bun",
                )
                require(
                    errors,
                    isinstance(riscv64_bun_provenance, str) and bool(riscv64_bun_provenance),
                    "multiarch boot matrix riscv64 runtime_artifacts.riscv64_bun_provenance missing",
                )
                if isinstance(riscv64_bun_provenance, str) and riscv64_bun_provenance:
                    provenance_path = ROOT / riscv64_bun_provenance
                    require(
                        errors,
                        provenance_path.is_file(),
                        "multiarch boot matrix riscv64 Bun provenance artifact missing: "
                        f"{riscv64_bun_provenance}",
                    )
                    if provenance_path.is_file():
                        try:
                            provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
                        except json.JSONDecodeError as exc:
                            errors.append(
                                "multiarch boot matrix riscv64 Bun provenance is invalid JSON: "
                                f"{riscv64_bun_provenance}: {exc}"
                            )
                        else:
                            require(
                                errors,
                                provenance.get("schema")
                                == "eliza.os.linux.riscv64_bun_stage_provenance.v1",
                                "multiarch boot matrix riscv64 Bun provenance schema mismatch",
                            )
                            artifact = provenance.get("artifact", {})
                            recorded_bun_sha = (
                                artifact.get("staged_bun_sha256")
                                if isinstance(artifact, dict)
                                else None
                            )
                            runtime_bun = agent_bundle_path / "musl-runtime/bun"
                            if runtime_bun.is_file():
                                require(
                                    errors,
                                    recorded_bun_sha == sha256_file(runtime_bun),
                                    "multiarch boot matrix riscv64 Bun provenance staged_bun_sha256 "
                                    "does not match runtime musl Bun",
                                )
                            inputs = provenance.get("inputs", {})
                            require(
                                errors,
                                isinstance(inputs, dict)
                                and "packages/app-core/scripts/bun-riscv64/bun-version.json"
                                in inputs,
                                "multiarch boot matrix riscv64 Bun provenance does not record "
                                "bun-version.json",
                            )


def validate_runtime_matrix(errors: list[str], matrix: dict) -> None:
    rows = architecture_rows(matrix)
    for arch, required_proofs in ARCH_RUNTIME_EVIDENCE_REQUIREMENTS.items():
        row = rows.get(arch)
        require(errors, row is not None, f"multiarch boot matrix missing {arch} row")
        if row is None:
            continue
        require(
            errors,
            row.get("status") == "candidate",
            f"multiarch boot matrix {arch} status must be candidate, got {row.get('status')!r}",
        )
        require(
            errors,
            isinstance(row.get("iso"), str) and bool(row["iso"]),
            f"multiarch boot matrix {arch} must record an ISO artifact",
        )
        require(
            errors,
            isinstance(row.get("sha256"), str) and len(row["sha256"]) == 64,
            f"multiarch boot matrix {arch} must record a 64-hex-character ISO sha256",
        )
        require(
            errors,
            isinstance(row.get("evidence"), str) and bool(row["evidence"]),
            f"multiarch boot matrix {arch} must record boot evidence",
        )
        iso = row.get("iso")
        expected_iso_sha = row.get("sha256")
        evidence = row.get("evidence")
        if (
            isinstance(iso, str)
            and iso
            and isinstance(expected_iso_sha, str)
            and len(expected_iso_sha) == 64
        ):
            iso_path = ROOT / iso
            require(
                errors,
                iso_path.is_file(),
                f"multiarch boot matrix {arch} ISO artifact missing: {iso}",
            )
            if iso_path.is_file():
                actual_iso_sha = sha256_file(iso_path)
                require(
                    errors,
                    actual_iso_sha == expected_iso_sha,
                    f"multiarch boot matrix {arch} ISO sha256 mismatch: {actual_iso_sha}",
                )
        if isinstance(evidence, str) and evidence:
            require(
                errors,
                (ROOT / evidence).is_file(),
                f"multiarch boot matrix {arch} evidence artifact missing: {evidence}",
            )
        proves = set(row.get("proves", [])) if isinstance(row.get("proves"), list) else set()
        for proof in required_proofs:
            require(
                errors,
                proof in proves,
                f"multiarch boot matrix {arch} missing runtime proof: {proof}",
            )
        blocking_gaps = matrix_blocking_gaps(row)
        require(
            errors,
            not blocking_gaps,
            f"multiarch boot matrix {arch} still records production-blocking gaps: {blocking_gaps}",
        )
    validate_runtime_artifacts(errors, matrix)


def main() -> int:
    errors: list[str] = []
    auto_config = read("auto/config")
    makefile = read("Makefile")
    build_sh = read("build.sh")
    dockerfile = read("Dockerfile")
    boot_qemu = read("scripts/boot-qemu.sh")
    riscv_harness = read("scripts/qemu_virt_boot_riscv64.sh")
    qemu_virt_smoke = read("scripts/qemu_virt_smoke.py")
    readme = read("README.md")
    multiarch_matrix = json.loads(read("evidence/multiarch_boot_matrix.json"))

    for arch in ARCH_PACKAGE_REQUIREMENTS:
        require(errors, f"{arch})" in auto_config, f"auto/config lacks {arch} case")
        require(errors, arch in makefile, f"Makefile lacks {arch} in supported arch path")

    require(
        errors,
        "SUPPORTED_ARCHES := amd64 arm64 riscv64" in makefile,
        "Makefile supported arch list is not the expected amd64 arm64 riscv64 matrix",
    )
    require(
        errors,
        'BOOTLOADERS="grub-efi"' in auto_config,
        "auto/config must keep UEFI GRUB enabled for non-amd64 architectures",
    )

    package_dir = ROOT / "config/package-lists"
    for arch, required_packages in ARCH_PACKAGE_REQUIREMENTS.items():
        package_file = package_dir / f"elizaos-{arch}.list.chroot"
        require(errors, package_file.is_file(), f"missing package list for {arch}")
        if not package_file.is_file():
            continue
        present = package_lines(package_file)
        for package in required_packages:
            require(
                errors,
                package in present,
                f"{package_file.relative_to(ROOT)} missing required package {package}",
            )
        for package in DESKTOP_PACKAGE_REQUIREMENTS:
            require(
                errors,
                package in present,
                f"{package_file.relative_to(ROOT)} missing GUI parity package {package}",
            )

    riscv_package_file = package_dir / "elizaos-riscv64.list.chroot"
    if riscv_package_file.is_file():
        riscv_packages = package_lines(riscv_package_file)
        require(
            errors,
            "grub-efi-riscv64" in riscv_packages
            and "grub-efi-riscv64-bin" in riscv_packages,
            "riscv64 package list must include Debian's active GRUB package and riscv64 EFI modules",
        )
        require(
            errors,
            "u-boot-menu" not in riscv_packages,
            "riscv64 package list must not pull u-boot-menu; the Debian live path is UEFI/GRUB",
        )

    for package in DOCKERFILE_REQUIREMENTS:
        require(errors, package in dockerfile, f"Dockerfile missing builder package {package}")

    require(
        errors,
        "grub-efi-riscv64-bin" in build_sh,
        "build.sh must patch live-build's riscv64 GRUB EFI package check",
    )
    require(
        errors,
        'gen_efi_boot_img "riscv64-efi" "riscv64"' in build_sh,
        "build.sh must patch live-build's riscv64 EFI image generation",
    )
    require(
        errors,
        "bootriscv64.efi" in readme,
        "README.md must document Debian's riscv64 removable-media UEFI path",
    )
    require(
        errors,
        "qemu_virt_wrapper_grubfix_20260521T130200Z.report.json" not in readme,
        "README.md must not cite stale riscv64 grubfix evidence as current release status",
    )
    require(
        errors,
        "qemu_virt_boot_20260523T071039Z_repoqemu_sigill.report.json" in readme,
        "README.md must cite the fresh repo-QEMU riscv64 boot evidence",
    )
    for token in RISCV64_PORT_CONTRACT.values():
        require(
            errors,
            token in readme,
            f"README.md must document Debian riscv64 port contract token {token}",
        )
    riscv_contract = multiarch_matrix.get("debian_riscv64_port_contract", {})
    for key, expected in RISCV64_PORT_CONTRACT.items():
        require(
            errors,
            riscv_contract.get(key) == expected,
            f"multiarch boot matrix riscv64 contract {key} must be {expected}",
        )
    matrix_packages = set(riscv_contract.get("bootloader_packages", []))
    require(
        errors,
        {"grub-efi-riscv64", "grub-efi-riscv64-bin"} <= matrix_packages,
        "multiarch boot matrix must record Debian riscv64 GRUB package provenance",
    )
    matrix_refs = set(riscv_contract.get("upstream_references_checked", []))
    for reference in RISCV64_UPSTREAM_REFERENCES:
        require(
            errors,
            reference in matrix_refs,
            f"multiarch boot matrix missing upstream reference {reference}",
        )
    validate_runtime_matrix(errors, multiarch_matrix)
    require(
        errors,
        "RISCV_VIRT_CODE.fd" in boot_qemu and "RISCV_VIRT_VARS.fd" in boot_qemu,
        "boot-qemu.sh lacks riscv64 EDK2 firmware drives",
    )
    require(
        errors,
        "AAVMF_CODE.fd" in boot_qemu,
        "boot-qemu.sh lacks arm64 AAVMF firmware",
    )
    require(
        errors,
        "RISCV_VIRT_CODE.fd" in riscv_harness and "--u-boot is not supported" in riscv_harness,
        "riscv64 evidence harness must use EDK2 UEFI and reject the old U-Boot path",
    )
    require(
        errors,
        "bootriscv64.efi" in riscv_harness
        and "boot/grub/grub.cfg" in riscv_harness,
        "riscv64 evidence harness must inspect the ISO for Debian GRUB EFI boot artifacts",
    )
    require(
        errors,
        "REQUIRED_ISO_BOOT_ARTIFACTS" in qemu_virt_smoke
        and "iso_boot_artifacts" in qemu_virt_smoke,
        "qemu_virt_smoke.py must validate recorded riscv64 ISO boot artifacts",
    )

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("OK: multi-arch boot contract passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
