#!/usr/bin/env python3
"""Tests for check-multiarch-boot-contract.py."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "check-multiarch-boot-contract.py"
spec = importlib.util.spec_from_file_location("check_multiarch_boot_contract", MODULE_PATH)
assert spec is not None and spec.loader is not None
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def complete_row(arch: str) -> dict:
    return {
        "arch": arch,
        "status": "candidate",
        "iso": f"out/elizaos-linux-{arch}-default.iso",
        "sha256": "a" * 64,
        "evidence": f"evidence/{arch}.json",
        "os_commit": "1" * 40,
        "source_commit": "2" * 40,
        "runtime_version": "1.4.2",
        "proves": list(gate.ARCH_RUNTIME_EVIDENCE_REQUIREMENTS[arch]),
        "gaps": ["not physical silicon evidence"],
    }


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class MultiarchBootContractTests(unittest.TestCase):
    def runtime_tool_lock(self, row: dict) -> dict:
        arch = row["arch"]
        return {
            "schema": "eliza.os.linux.runtime_tool_inputs.v1",
            "arch": arch,
            "runtime_version": row["runtime_version"],
            "qemu_executable": gate.MATRIX_QEMU_EXECUTABLES[arch],
            "qemu_version": "QEMU emulator version 9.2.2 (Debian 1:9.2.2+ds-1)",
            "firmware_identity": gate.MATRIX_FIRMWARE_IDENTITIES[arch],
            "firmware_version": "2026.05",
            "firmware_path": f"firmware/{arch}.fd",
            "firmware_sha256": sha256_bytes(f"{arch}-firmware".encode()),
        }

    def tool_lock_bytes(self, row: dict) -> bytes:
        return (json.dumps(self.runtime_tool_lock(row)) + "\n").encode()

    def initialize_repository(
        self, root: Path, source_commit: str = "2" * 40, authorize: bool = True
    ) -> str:
        (root / "app-source.lock.json").write_text(
            json.dumps(
                {
                    "schema": "eliza.os.linux.app-source-lock.v1",
                    "repository": "https://github.com/elizaOS/eliza",
                    "commit": source_commit,
                    "buildInfoPath": "Resources/app/eliza-dist/build-info.json",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (root / ".gitignore").write_text(
            "/evidence/\n/out/\n/firmware/\n", encoding="utf-8"
        )
        authorization = {
            "schema": "eliza.os.linux.runtime_tool_input_authorization.v1",
            "authorized_sha256": {
                arch: [sha256_bytes(self.tool_lock_bytes(complete_row(arch)))] if authorize else []
                for arch in ("amd64", "arm64", "riscv64")
            },
        }
        authorization_path = root / "config/multiarch-runtime-tool-inputs.lock.json"
        authorization_path.parent.mkdir(parents=True, exist_ok=True)
        authorization_path.write_text(json.dumps(authorization) + "\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "Contract Test"], cwd=root, check=True)
        subprocess.run(
            ["git", "add", ".gitignore", "app-source.lock.json", "config"],
            cwd=root,
            check=True,
        )
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=root, check=True)
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
        ).stdout.strip()

    def write_runtime_evidence(self, root: Path, row: dict) -> dict:
        arch = row["arch"]
        firmware = root / f"firmware/{arch}.fd"
        firmware.parent.mkdir(parents=True, exist_ok=True)
        firmware.write_bytes(f"{arch}-firmware".encode())
        transcript = root / f"evidence/{arch}.log"
        transcript.parent.mkdir(parents=True, exist_ok=True)
        transcript.write_text(
            "\n".join(gate.MATRIX_RUNTIME_ARCH_MARKERS[arch]) + "\n",
            encoding="utf-8",
        )
        document = {
            "schema": gate.MATRIX_RUNTIME_EVIDENCE_SCHEMA,
            "claim_boundary": gate.MATRIX_RUNTIME_CLAIM_BOUNDARY,
            "arch": arch,
            "os_commit": row["os_commit"],
            "source_commit": row["source_commit"],
            "runtime_version": row["runtime_version"],
            "iso_path": row["iso"],
            "iso_sha256": row["sha256"],
            "qemu_executable": gate.MATRIX_QEMU_EXECUTABLES[arch],
            "qemu_version": "QEMU emulator version 9.2.2 (Debian 1:9.2.2+ds-1)",
            "firmware_identity": gate.MATRIX_FIRMWARE_IDENTITIES[arch],
            "firmware_version": "2026.05",
            "firmware_path": f"firmware/{arch}.fd",
            "firmware_sha256": sha256_bytes(firmware.read_bytes()),
            "transcript_path": f"evidence/{arch}.log",
            "transcript_sha256": sha256_bytes(transcript.read_bytes()),
            "transcript_size": transcript.stat().st_size,
            "tool_inputs_sha256": sha256_bytes(self.tool_lock_bytes(row)),
            "boot_completed": True,
            "markers_found": list(gate.MATRIX_RUNTIME_ARCH_MARKERS[arch]),
            "markers_missing": [],
            "forbidden_markers_present": [],
        }
        evidence = root / row["evidence"]
        evidence.with_suffix(".tool-inputs.json").write_bytes(self.tool_lock_bytes(row))
        evidence.write_text(json.dumps(document) + "\n", encoding="utf-8")
        return document

    def test_build_script_cleans_mutable_gui_profile_overlay(self) -> None:
        build_text = (HERE.parents[1] / "linux" / "elizaos" / "build-live-iso.sh").read_text(encoding="utf-8")
        self.assertIn(
            'rm -f "${HERE}/config/package-lists/elizaos-gui.list.chroot"',
            build_text,
        )
        self.assertIn('cp -a "${HERE}/config/profiles/gui/."', build_text)

    def write_minimal_desktop_contract_tree(
        self, root: Path, gui_packages: str, common_packages: str = ""
    ) -> None:
        files = {
            "config/package-lists/elizaos-common.list.chroot": common_packages,
            "config/profiles/gui/package-lists/elizaos-gui.list.chroot": gui_packages,
            "config/hooks/normal/0025-enable-graphical-session.hook.chroot": (
                "systemctl set-default multi-user.target\n"
                "GUI profile packages absent\n"
                "systemctl set-default graphical.target\n"
                "systemctl enable gdm3.service\n"
                "systemctl disable elizaos-kiosk.service\n"
            ),
            "config/hooks/normal/0020-enable-user-units.hook.chroot": (
                "systemctl --global enable elizaos-launcher.service\n"
            ),
            "config/hooks/normal/0027-pipewire-session.hook.chroot": (
                "systemctl --global enable pipewire-pulse.service wireplumber.service\n"
                "rm -f pulseaudio.service\n"
            ),
            "config/includes.chroot/etc/gdm3/daemon.conf": (
                "WaylandEnable=false\nAutomaticLoginEnable=true\nAutomaticLogin=user\n"
            ),
            "config/includes.chroot/etc/systemd/user/elizaos-launcher.service": (
                "ExecStart=/usr/local/lib/elizaos/start-launcher\n"
            ),
            "config/includes.chroot/etc/modules-load.d/elizaos-virtio-gpu.conf": (
                "virtio_pci\nvirtio_gpu\n"
            ),
        }
        for rel, text in files.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def test_desktop_gui_contract_accepts_graphical_boot_wiring(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_minimal_desktop_contract_tree(
                root,
                "\n".join(gate.GUI_RUNTIME_PACKAGE_REQUIREMENTS + gate.DESKTOP_PACKAGE_REQUIREMENTS) + "\n",
            )
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_desktop_gui_contract(errors)
        self.assertEqual(errors, [])

    def test_desktop_gui_contract_rejects_missing_capture_and_gpu_support(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_minimal_desktop_contract_tree(root, "xorg\ngdm3\n")
            (root / "config/includes.chroot/etc/modules-load.d/elizaos-virtio-gpu.conf").write_text(
                "virtio_pci\n",
                encoding="utf-8",
            )
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_desktop_gui_contract(errors)
        joined = "\n".join(errors)
        self.assertIn("libwebkit2gtk-4.1-0", joined)
        self.assertIn("virtio GPU modules", joined)

    def test_runtime_matrix_rejects_fallback_agent_and_missing_arch(self) -> None:
        matrix = {
            "architectures": [
                {
                    **complete_row("riscv64"),
                    "status": "candidate-reference",
                    "gaps": [
                        "current riscv64 ISO evidence predates verified riscv64 Bun artifact staging and must be recaptured"
                    ],
                },
                complete_row("amd64"),
            ]
        }
        errors: list[str] = []
        gate.validate_runtime_matrix(errors, matrix)
        joined = "\n".join(errors)
        self.assertIn("riscv64 status must be candidate", joined)
        self.assertIn("predates verified riscv64 Bun artifact", joined)
        self.assertIn("missing arm64 row", joined)

    def test_runtime_matrix_rejects_current_iso_timeout_gap(self) -> None:
        matrix = {
            "architectures": [
                {
                    **complete_row("riscv64"),
                    "gaps": [
                        "current riscv64 ISO boot reaches Linux EFI stub then times out before Linux version"
                    ],
                },
                complete_row("amd64"),
                complete_row("arm64"),
            ]
        }
        errors: list[str] = []
        gate.validate_runtime_matrix(errors, matrix)
        self.assertIn("times out before Linux version", "\n".join(errors))

    def test_runtime_matrix_rejects_riscv64_bun_sigill_gap(self) -> None:
        matrix = {
            "architectures": [
                {
                    **complete_row("riscv64"),
                    "gaps": [
                        "rebuilt riscv64 ISO reaches first boot, then Bun traps with SIGILL / unhandled signal 4 before agent health"
                    ],
                },
                complete_row("amd64"),
                complete_row("arm64"),
            ]
        }
        errors: list[str] = []
        gate.validate_runtime_matrix(errors, matrix)
        self.assertIn("SIGILL", "\n".join(errors))

    def test_runtime_matrix_accepts_complete_candidate_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            os_commit = self.initialize_repository(root)
            (root / "out").mkdir()
            (root / "evidence").mkdir()
            rows = []
            for arch in ("amd64", "arm64", "riscv64"):
                iso = root / f"out/elizaos-linux-{arch}-default.iso"
                iso.write_bytes(arch.encode("utf-8"))
                row = {
                    **complete_row(arch),
                    "os_commit": os_commit,
                    "sha256": sha256_bytes(arch.encode("utf-8")),
                }
                self.write_runtime_evidence(root, row)
                rows.append(row)
            matrix = {"architectures": rows}
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_matrix(errors, matrix)
        self.assertEqual(errors, [])

    def test_runtime_matrix_rejects_empty_and_prose_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "evidence").mkdir()
            rows = []
            for arch, payload in (
                ("amd64", {}),
                ("arm64", {"claim": "Trust me, this image booted successfully."}),
            ):
                row = complete_row(arch)
                (root / row["evidence"]).write_text(json.dumps(payload), encoding="utf-8")
                rows.append(row)
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_matrix(errors, {"architectures": rows})
        joined = "\n".join(errors)
        self.assertIn("amd64 evidence missing fields", joined)
        self.assertIn("arm64 evidence missing fields", joined)
        self.assertIn("arm64 evidence has unexpected fields", joined)

    def test_runtime_evidence_rejects_forged_bindings_versions_and_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            os_commit = self.initialize_repository(root)
            (root / "out").mkdir()
            iso = root / "out/elizaos-linux-riscv64-default.iso"
            iso.write_bytes(b"iso")
            row = {
                **complete_row("riscv64"),
                "os_commit": os_commit,
                "sha256": sha256_bytes(iso.read_bytes()),
            }
            document = self.write_runtime_evidence(root, row)
            document.update(
                {
                    "os_commit": "4" * 40,
                    "source_commit": "3" * 40,
                    "runtime_version": "version claimed in prose",
                    "iso_sha256": "0" * 64,
                    "qemu_version": "QEMU was recent enough",
                    "firmware_sha256": "f" * 64,
                    "markers_found": list(gate.MATRIX_RUNTIME_ARCH_MARKERS["riscv64"]),
                }
            )
            transcript = root / document["transcript_path"]
            transcript.write_text("claimed success without runtime markers\n", encoding="utf-8")
            document["transcript_sha256"] = sha256_bytes(transcript.read_bytes())
            document["transcript_size"] = transcript.stat().st_size
            (root / row["evidence"]).write_text(json.dumps(document), encoding="utf-8")
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_evidence(errors, "riscv64", row)
        joined = "\n".join(errors)
        self.assertIn("os_commit does not match matrix row", joined)
        self.assertIn("source_commit does not match matrix row", joined)
        self.assertIn("runtime_version is invalid", joined)
        self.assertIn("ISO sha256 does not match matrix row", joined)
        self.assertIn("qemu_version is invalid", joined)
        self.assertIn("firmware sha256 mismatch", joined)
        self.assertIn("transcript missing marker: Linux version", joined)

    def test_runtime_evidence_fails_closed_without_git_or_valid_source_lock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            row = complete_row("amd64")
            self.write_runtime_evidence(root, row)
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_evidence(errors, "amd64", row)
            self.assertIn("cannot bind os_commit", "\n".join(errors))
            self.assertIn("cannot bind source_commit", "\n".join(errors))

            self.initialize_repository(root)
            (root / "app-source.lock.json").write_text("{bad", encoding="utf-8")
            errors = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_evidence(errors, "amd64", row)
            self.assertIn("cannot bind source_commit", "\n".join(errors))

    def test_source_lock_must_be_tracked_clean_and_present(self) -> None:
        for state in ("valid-dirty-substitution", "untracked", "missing"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                os_commit = self.initialize_repository(root)
                row = {**complete_row("amd64"), "os_commit": os_commit}
                document = self.write_runtime_evidence(root, row)
                source_lock = root / "app-source.lock.json"
                if state == "valid-dirty-substitution":
                    substituted = "3" * 40
                    source_lock.write_text(
                        json.dumps(
                            {
                                "schema": "eliza.os.linux.app-source-lock.v1",
                                "repository": "https://github.com/elizaOS/eliza",
                                "commit": substituted,
                                "buildInfoPath": "Resources/app/eliza-dist/build-info.json",
                            }
                        )
                        + "\n",
                        encoding="utf-8",
                    )
                    row["source_commit"] = substituted
                    document["source_commit"] = substituted
                    (root / row["evidence"]).write_text(
                        json.dumps(document) + "\n", encoding="utf-8"
                    )
                elif state == "untracked":
                    subprocess.run(
                        ["git", "rm", "--cached", "-q", "app-source.lock.json"],
                        cwd=root,
                        check=True,
                    )
                else:
                    source_lock.unlink()
                errors: list[str] = []
                with mock.patch.object(gate, "ROOT", root):
                    gate.validate_runtime_evidence(errors, "amd64", row)
                joined = "\n".join(errors)
                if state == "missing":
                    self.assertIn("app-source.lock.json is missing or unsafe", joined)
                else:
                    self.assertIn(
                        "app-source.lock.json must be tracked and clean at current HEAD",
                        joined,
                    )

    def test_repository_must_be_clean_beyond_evidence_outputs(self) -> None:
        for state in ("unstaged", "staged", "untracked"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                os_commit = self.initialize_repository(root)
                row = {**complete_row("amd64"), "os_commit": os_commit}
                self.write_runtime_evidence(root, row)
                unrelated = root / "config/unrelated-source.conf"
                if state in ("unstaged", "staged"):
                    unrelated.write_text("tracked\n", encoding="utf-8")
                    subprocess.run(["git", "add", str(unrelated)], cwd=root, check=True)
                    subprocess.run(
                        ["git", "commit", "-qm", "add unrelated source"], cwd=root, check=True
                    )
                    row["os_commit"] = subprocess.run(
                        ["git", "rev-parse", "HEAD"], cwd=root, check=True,
                        capture_output=True, text=True,
                    ).stdout.strip()
                    document = json.loads((root / row["evidence"]).read_text(encoding="utf-8"))
                    document["os_commit"] = row["os_commit"]
                    (root / row["evidence"]).write_text(
                        json.dumps(document) + "\n", encoding="utf-8"
                    )
                    unrelated.write_text("dirty\n", encoding="utf-8")
                    if state == "staged":
                        subprocess.run(["git", "add", str(unrelated)], cwd=root, check=True)
                else:
                    unrelated.write_text("untracked\n", encoding="utf-8")
                errors: list[str] = []
                with mock.patch.object(gate, "ROOT", root):
                    gate.validate_runtime_evidence(errors, "amd64", row)
                self.assertIn(
                    "repository must have no staged, unstaged, or non-ignored untracked changes",
                    "\n".join(errors),
                )

    def test_source_lock_requires_exact_established_identity(self) -> None:
        for field, value in (
            ("schema", "eliza.os.linux.app-source-lock.v2"),
            ("repository", "https://example.invalid/forged"),
            ("buildInfoPath", "forged/build-info.json"),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                os_commit = self.initialize_repository(root)
                row = {**complete_row("amd64"), "os_commit": os_commit}
                self.write_runtime_evidence(root, row)
                source_lock = root / "app-source.lock.json"
                lock = json.loads(source_lock.read_text(encoding="utf-8"))
                lock[field] = value
                source_lock.write_text(json.dumps(lock) + "\n", encoding="utf-8")
                subprocess.run(["git", "add", "app-source.lock.json"], cwd=root, check=True)
                subprocess.run(["git", "commit", "-qm", f"alter {field}"], cwd=root, check=True)
                row["os_commit"] = subprocess.run(
                    ["git", "rev-parse", "HEAD"], cwd=root, check=True,
                    capture_output=True, text=True,
                ).stdout.strip()
                document = json.loads((root / row["evidence"]).read_text(encoding="utf-8"))
                document["os_commit"] = row["os_commit"]
                (root / row["evidence"]).write_text(json.dumps(document) + "\n", encoding="utf-8")
                errors: list[str] = []
                with mock.patch.object(gate, "ROOT", root):
                    gate.validate_runtime_evidence(errors, "amd64", row)
                self.assertIn("cannot bind source_commit", "\n".join(errors))

    def test_repo_path_rejects_traversal_and_intermediate_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "real").mkdir()
            (root / "linked").symlink_to(root / "real", target_is_directory=True)
            with mock.patch.object(gate, "ROOT", root):
                self.assertIsNone(gate._repo_path("../outside"))
                self.assertIsNone(gate._repo_path("linked/file"))

    def test_runtime_evidence_rejects_tampered_transcript_and_forbidden_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            os_commit = self.initialize_repository(root)
            row = {**complete_row("amd64"), "os_commit": os_commit}
            document = self.write_runtime_evidence(root, row)
            transcript = root / document["transcript_path"]
            transcript.write_text(transcript.read_text(encoding="utf-8") + "Kernel panic\n", encoding="utf-8")
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_evidence(errors, "amd64", row)
            joined = "\n".join(errors)
            self.assertIn("transcript sha256 mismatch", joined)
            self.assertIn("transcript size mismatch", joined)
            self.assertIn("contains forbidden marker: Kernel panic", joined)

    def test_runtime_evidence_versions_must_match_tool_input_lock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            os_commit = self.initialize_repository(root)
            row = {**complete_row("amd64"), "os_commit": os_commit}
            document = self.write_runtime_evidence(root, row)
            document["runtime_version"] = row["runtime_version"] = "9.9.9"
            evidence = root / row["evidence"]
            evidence.write_text(json.dumps(document), encoding="utf-8")
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_evidence(errors, "amd64", row)
            self.assertIn("runtime_version does not match runtime tool-input lock", "\n".join(errors))

    def test_coordinated_evidence_and_adjacent_tool_lock_forgery_is_not_authorized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            os_commit = self.initialize_repository(root)
            row = {**complete_row("amd64"), "os_commit": os_commit, "runtime_version": "9.9.9"}
            self.write_runtime_evidence(root, row)
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_evidence(errors, "amd64", row)
            self.assertIn("not authorized by current HEAD", "\n".join(errors))

    def test_runtime_tool_input_authorization_must_be_tracked_clean_and_present(self) -> None:
        for state in ("untracked", "dirty", "missing"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                os_commit = self.initialize_repository(root)
                row = {**complete_row("amd64"), "os_commit": os_commit}
                self.write_runtime_evidence(root, row)
                policy = root / "config/multiarch-runtime-tool-inputs.lock.json"
                if state == "untracked":
                    subprocess.run(
                        ["git", "rm", "--cached", "-q", "config/multiarch-runtime-tool-inputs.lock.json"],
                        cwd=root, check=True,
                    )
                elif state == "dirty":
                    policy.write_text(policy.read_text(encoding="utf-8") + "\n", encoding="utf-8")
                else:
                    policy.unlink()
                errors: list[str] = []
                with mock.patch.object(gate, "ROOT", root):
                    gate.validate_runtime_evidence(errors, "amd64", row)
                joined = "\n".join(errors)
                if state == "missing":
                    self.assertIn("authorization is missing or unsafe", joined)
                else:
                    self.assertIn("authorization must be tracked and clean", joined)

    def test_runtime_artifact_checks_verify_bun_sha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "artifacts/arm64/elizaos-app").mkdir(parents=True)
            bun = root / "artifacts/arm64/bun"
            bun.write_bytes(b"arm64-bun")
            matrix = {
                "architectures": [
                    {
                        **complete_row("arm64"),
                        "runtime_artifacts": {
                            "bun": "artifacts/arm64/bun",
                            "bun_sha256": "0" * 64,
                            "agent_bundle": "artifacts/arm64/elizaos-app",
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertIn("sha256 mismatch", "\n".join(errors))

    def test_runtime_artifact_checks_reject_riscv64_wrapper_without_runtime_bun(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "artifacts/riscv64/elizaos-app/musl-runtime").mkdir(parents=True)
            bun = root / "artifacts/riscv64/bun"
            bun.write_text(
                "#!/bin/sh\nexec /opt/elizaos/app/musl-runtime/bun \"$@\"\n",
                encoding="utf-8",
            )
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "runtime_artifacts": {
                            "bun": "artifacts/riscv64/bun",
                            "bun_sha256": sha256_bytes(bun.read_bytes()),
                            "agent_bundle": "artifacts/riscv64/elizaos-app",
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertIn("musl-runtime/bun", "\n".join(errors))

    def test_runtime_artifact_checks_reject_riscv64_wrapper_without_provenance(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / "artifacts/riscv64/elizaos-app/musl-runtime"
            runtime.mkdir(parents=True)
            (runtime / "bun").write_bytes(b"riscv64-bun")
            bun = root / "artifacts/riscv64/bun"
            bun.write_text(
                "#!/bin/sh\nexec /opt/elizaos/app/musl-runtime/bun \"$@\"\n",
                encoding="utf-8",
            )
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "runtime_artifacts": {
                            "bun": "artifacts/riscv64/bun",
                            "bun_sha256": sha256_bytes(bun.read_bytes()),
                            "agent_bundle": "artifacts/riscv64/elizaos-app",
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertIn("riscv64_bun_provenance missing", "\n".join(errors))

    def test_runtime_artifact_checks_verify_riscv64_bun_provenance(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / "artifacts/riscv64/elizaos-app/musl-runtime"
            runtime.mkdir(parents=True)
            runtime_bun = runtime / "bun"
            runtime_bun.write_bytes(b"riscv64-bun")
            bun = root / "artifacts/riscv64/bun"
            bun.write_text(
                "#!/bin/sh\nexec /opt/elizaos/app/musl-runtime/bun \"$@\"\n",
                encoding="utf-8",
            )
            provenance = root / "artifacts/riscv64/riscv64-bun-provenance.json"
            provenance.write_text(
                json.dumps(
                    {
                        "schema": "eliza.os.linux.riscv64_bun_stage_provenance.v1",
                        "inputs": {
                            "toolchains/bun-riscv64/bun-version.json": "0" * 64
                        },
                        "artifact": {
                            "staged_bun_sha256": sha256_bytes(runtime_bun.read_bytes())
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "runtime_artifacts": {
                            "bun": "artifacts/riscv64/bun",
                            "bun_sha256": sha256_bytes(bun.read_bytes()),
                            "agent_bundle": "artifacts/riscv64/elizaos-app",
                            "riscv64_bun_provenance": (
                                "artifacts/riscv64/riscv64-bun-provenance.json"
                            ),
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertEqual(errors, [])

    def test_runtime_artifact_checks_accept_riscv64_node_mode_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "artifacts/riscv64/elizaos-app"
            app.mkdir(parents=True)
            (app / "agent-bundle.js").write_text(
                "#!/usr/bin/env node\nconsole.log('ok')\n",
                encoding="utf-8",
            )
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "runtime_artifacts": {
                            "runtime_mode": "node",
                            "agent_bundle": "artifacts/riscv64/elizaos-app",
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertEqual(errors, [])

    def test_runtime_matrix_verifies_iso_hash_and_evidence_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "out").mkdir()
            (root / "evidence").mkdir()
            (root / "out/elizaos-linux-riscv64-default.iso").write_bytes(b"iso")
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "iso": "out/elizaos-linux-riscv64-default.iso",
                        "sha256": "0" * 64,
                        "evidence": "evidence/missing.json",
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_matrix(errors, matrix)
        joined = "\n".join(errors)
        self.assertIn("ISO sha256 mismatch", joined)
        self.assertIn("evidence artifact missing", joined)

    def test_runtime_matrix_rejects_unsafe_iso_before_hashing(self) -> None:
        for unsafe_iso in ("../outside.iso", "linked/outside.iso"):
            with self.subTest(unsafe_iso=unsafe_iso), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "root"
                root.mkdir()
                outside = root.parent / "outside.iso"
                outside.write_bytes(b"outside")
                if unsafe_iso.startswith("linked/"):
                    (root / "linked").symlink_to(root.parent, target_is_directory=True)
                row = {
                    **complete_row("amd64"),
                    "iso": unsafe_iso,
                    "sha256": sha256_bytes(outside.read_bytes()),
                }
                errors: list[str] = []
                with (
                    mock.patch.object(gate, "ROOT", root),
                    mock.patch.object(
                        gate,
                        "sha256_file",
                        side_effect=AssertionError("unsafe ISO must not be hashed"),
                    ),
                ):
                    gate.validate_runtime_matrix(errors, {"architectures": [row]})
                self.assertIn("ISO artifact missing or unsafe", "\n".join(errors))


if __name__ == "__main__":
    unittest.main()
