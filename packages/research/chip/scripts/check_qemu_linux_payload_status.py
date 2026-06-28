#!/usr/bin/env python3
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD_MANIFEST_CANDIDATES = [
    ROOT / "build/qemu/linux_payload/debian-installer-riscv64/manifest.json",
    *sorted((ROOT / "build/qemu/linux_payload").glob("debian-installer-riscv64-*/manifest.json")),
]
BOOT_MANIFEST = ROOT / "build/reports/qemu_os_boot_attempt.json"
BOOT_LOG = ROOT / "build/reports/qemu_os_boot_attempt.log"


REQUIRED_BOOT_MARKERS = (
    "Freeing unused kernel memory",
    "Run /init as init process",
    "Welcome to",
    "login:",
    "Debian GNU/Linux installer",
    "Starting system log daemon",
)
REQUIRED_FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "phone_claim_allowed",
    "release_claim_allowed",
    "hardware_boot_claim_allowed",
    "silicon_evidence_claim_allowed",
    "linux_boot_claim_allowed",
}


def sha256_path(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_payload_manifest() -> tuple[Path | None, list[Path]]:
    checked: list[Path] = []
    for path in PAYLOAD_MANIFEST_CANDIDATES:
        if path in checked:
            continue
        checked.append(path)
        if path.is_file():
            return path, checked
    return None, checked


def main() -> int:
    errors: list[str] = []
    payload_manifest, checked_payload_manifests = find_payload_manifest()
    if payload_manifest is None:
        searched = ", ".join(
            path.relative_to(ROOT).as_posix() for path in checked_payload_manifests
        )
        errors.append(
            f"missing qemu-virt reference artifact: payload manifest; searched {searched}"
        )
    for path in (BOOT_MANIFEST, BOOT_LOG):
        if not path.is_file():
            errors.append(f"missing qemu-virt reference artifact: {path.relative_to(ROOT)}")
    if errors:
        return report(errors)

    assert payload_manifest is not None
    payload = json.loads(payload_manifest.read_text())
    boot = json.loads(BOOT_MANIFEST.read_text())
    log_text = BOOT_LOG.read_text(errors="ignore")

    if payload.get("schema") != "eliza.qemu_linux_payload.v1":
        errors.append("unexpected payload manifest schema")
    if payload.get("claim_boundary") != "qemu_virt_debian_netboot_payload_only":
        errors.append("payload manifest must remain qemu-virt Debian netboot only")
    for key in REQUIRED_FALSE_CLAIM_FLAGS:
        if payload.get(key) is not False:
            errors.append(f"payload manifest {key} must be false")
    payloads = payload.get("payloads", {})
    for name in ("linux", "initrd.gz"):
        item = payloads.get(name)
        if not isinstance(item, dict):
            errors.append(f"payload manifest missing {name}")
            continue
        path = ROOT / item.get("path", "")
        if not path.is_file():
            errors.append(f"payload file missing: {item.get('path')}")
            continue
        if item.get("sha256") != sha256_path(path):
            errors.append(f"payload sha256 mismatch: {item.get('path')}")
        if not isinstance(item.get("bytes"), int) or item["bytes"] <= 0:
            errors.append(f"payload bytes must be positive: {name}")

    if boot.get("schema") != "eliza.qemu_virt_os_boot_attempt.v1":
        errors.append("unexpected qemu OS boot manifest schema")
    if boot.get("claim_boundary") != "qemu_virt_reference_only_not_e1_chip_rtl":
        errors.append("qemu OS boot manifest must remain reference-only, not e1-chip RTL")
    for key in REQUIRED_FALSE_CLAIM_FLAGS:
        if boot.get(key) is not False:
            errors.append(f"qemu OS boot manifest {key} must be false")
    if boot.get("status") != "PASS":
        errors.append(f"qemu OS boot status is not PASS: {boot.get('status')!r}")
    if boot.get("transcript") != "build/reports/qemu_os_boot_attempt.log":
        errors.append("qemu OS boot transcript path must be build/reports/qemu_os_boot_attempt.log")
    if not any(marker in log_text for marker in REQUIRED_BOOT_MARKERS):
        errors.append("qemu OS boot log lacks an accepted Linux init/login marker")
    for forbidden in ("e1-chip boot proven", "RTL boot proven", "Eliza BSP driver proof"):
        if forbidden in log_text or forbidden in json.dumps(boot):
            errors.append(f"qemu reference evidence contains forbidden claim: {forbidden}")

    return report(errors)


def report(errors: list[str]) -> int:
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("qemu-virt Linux payload status check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
