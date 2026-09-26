#!/usr/bin/env python3
"""Portable fail-closed tests for mkosi qualification entrypoints."""

from __future__ import annotations

import json
import os
import runpy
import shutil
import time
import socket
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from mkosi_console import FORBIDDEN_MARKERS, GRAPHICAL_MARKERS, normalized_console_text
from qemu_arguments import qemu_path_value

HERE = Path(__file__).resolve().parent


class QualificationPreflightTest(unittest.TestCase):
    def test_powerdown_requires_acknowledgement_for_platform_and_keyboard_requests(self) -> None:
        module = runpy.run_path(str(HERE / "mkosi-persistence-qualify.py"))
        for keyboard in (False, True):
            for rejected in (False, True):
                with self.subTest(keyboard=keyboard, rejected=rejected), tempfile.TemporaryDirectory() as temporary:
                    monitor = Path(temporary) / "qmp.sock"
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                        server.settimeout(5)
                        server.bind(str(monitor))
                        server.listen(1)

                        def serve() -> None:
                            connection, _ = server.accept()
                            with connection:
                                connection.settimeout(5)
                                with connection.makefile("rwb") as stream:
                                    stream.write(b'{"QMP": {}}\n')
                                    stream.flush()
                                    command = "send-key" if keyboard else "system_powerdown"
                                    for name in ("qmp_capabilities", command):
                                        request = json.loads(stream.readline())
                                        expected = {"execute": name, "id": name}
                                        if name == "send-key":
                                            expected["arguments"] = {"keys": [{"type": "qcode", "data": "power"}]}
                                        self.assertEqual(request, expected)
                                        # Unrelated QMP events must not count as acknowledgement.
                                        stream.write(b'{"event": "RESUME"}\n')
                                        response = {"id": name, "return": {}}
                                        if rejected and name == command:
                                            response = {"id": name, "error": {"class": "GenericError", "desc": "rejected"}}
                                        stream.write((json.dumps(response) + "\n").encode())
                                        stream.flush()

                        with ThreadPoolExecutor(max_workers=1) as executor:
                            completed = executor.submit(serve)
                            if rejected:
                                with self.assertRaisesRegex(module["QualificationError"], "QEMU rejected"):
                                    module["request_powerdown"](monitor, keyboard=keyboard)
                            else:
                                module["request_powerdown"](monitor, keyboard=keyboard)
                            completed.result(timeout=5)

    def test_persistence_virt_guests_have_64_bit_cpu_and_desktop_devices(self) -> None:
        command_for = runpy.run_path(str(HERE / "mkosi-persistence-qualify.py"))["qemu_command"]
        for architecture, cpu in (("arm64", "cortex-a72"), ("riscv64", "rv64")):
            with self.subTest(architecture=architecture):
                args = SimpleNamespace(
                    architecture=architecture, memory_mib=1024, cpus=1, cpu=None,
                    firmware_mode="bios", bios=Path("firmware.bin"),
                    work_image=Path("image.raw"))
                command = command_for(args, "qemu", None, Path("monitor.sock"))
                self.assertEqual(command[command.index("-cpu") + 1], cpu)
                devices = [command[index + 1] for index, value in enumerate(command) if value == "-device"]
                self.assertIn("virtio-gpu-pci", devices)
                self.assertIn("virtio-keyboard-pci", devices)
                self.assertIn("virtio-tablet-pci", devices)
                args.cpu = "host"
                command = command_for(args, "qemu", None, Path("monitor.sock"))
                self.assertEqual(command[command.index("-cpu") + 1], "host")

    def test_foreign_binfmt_requires_enabled_fixed_interpreter(self) -> None:
        supports_chroot = runpy.run_path(str(HERE / "mkosi-linux-build.py"))["binfmt_supports_chroot"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry = root / "registry"
            registry.mkdir()
            (registry / "register").touch()
            handler = registry / "qemu-aarch64"
            dpkg = root / "dpkg"
            dpkg.write_text('#!/bin/sh\nprintf "amd64\\n"\n')
            dpkg.chmod(0o755)
            script = (HERE / "ensure-foreign-binfmt.sh").read_text().replace(
                "/proc/sys/fs/binfmt_misc", str(registry))
            for global_state, flags, expected in (
                ("enabled", "PF", True),
                ("enabled", "OPF", True),
                ("enabled", "P", False),
                ("enabled", "", False),
                ("disabled", "PF", False),
            ):
                with self.subTest(global_state=global_state, flags=flags):
                    (registry / "status").write_text(global_state + "\n")
                    handler.write_text(f"enabled\ninterpreter /fixture/qemu\nflags: {flags}\n")
                    self.assertEqual(supports_chroot(handler), expected)
                    result = subprocess.run(
                        ["bash", "-s"], input=script, text=True,
                        capture_output=True, timeout=5,
                        env={**os.environ, "ELIZAOS_ARCH": "arm64",
                             "PATH": str(root) + os.pathsep + os.environ["PATH"]})
                    self.assertEqual(result.returncode == 0, expected, result.stderr)
                    self.assertEqual((registry / "register").read_bytes(), b"")
                    if not expected:
                        self.assertEqual(result.returncode, 65)
                        self.assertRegex(result.stderr, "disabled|fixed interpreter")
            (registry / "status").write_text("enabled\n")
            handler.write_text("disabled\nflags: PF\n")
            self.assertFalse(supports_chroot(handler))
            handler.unlink()
            self.assertFalse(supports_chroot(handler))

    def test_recovery_boundary_requires_observable_inactive_services_and_processes(self) -> None:
        source = HERE.parents[1] / "linux/elizaos/mkosi/mkosi.extra/usr/libexec/elizaos-recovery-verify"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            proc.mkdir()
            (proc / "cmdline").write_text("ro elizaos.recovery=1")
            process = proc / "123/cmdline"
            process.parent.mkdir()
            process.write_bytes(b"/usr/bin/unrelated\0")
            systemctl = root / "systemctl"
            systemctl.write_text(
                '#!/bin/sh\ncase "$1" in\n'
                'show) printf "%s\\n" "$TEST_STATE"; exit "$TEST_SHOW_EXIT" ;;\n'
                'list-units) printf "%s" "$TEST_USERS"; exit "$TEST_LIST_EXIT" ;;\n'
                '*) exit 99 ;;\nesac\n')
            systemctl.chmod(0o755)
            script = source.read_text().replace("/proc/", str(proc) + "/")

            def check(success: bool, **changes: str) -> None:
                env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                       "TEST_STATE": "inactive", "TEST_SHOW_EXIT": "0",
                       "TEST_USERS": "", "TEST_LIST_EXIT": "0", **changes}
                result = subprocess.run(["sh", "-s"], input=script, text=True,
                                        capture_output=True, timeout=5, env=env)
                self.assertEqual(result.returncode == 0, success, result.stderr)
                self.assertEqual("boundary verified" in result.stdout, success)

            check(True)
            check(True, TEST_STATE="failed")
            for state in ("", "active", "activating", "reloading", "deactivating", "unknown"):
                with self.subTest(state=state):
                    check(False, TEST_STATE=state)
            check(False, TEST_SHOW_EXIT="1")
            check(False, TEST_LIST_EXIT="1")
            check(False, TEST_USERS="user@1000.service loaded active running")
            for executable in ("/usr/bin/eliza-agent", "/opt/elizaos/bin/eliza-agent"):
                process.write_bytes(executable.encode() + b"\0--fixture\0")
                check(False)
            process.unlink()
            process.mkdir()  # A present but unreadable cmdline is not absence.
            check(False)
            process.rmdir()
            check(True)  # A process that exited does not prevent recovery.
            process.write_bytes(b"exiting process\0")
            reader = root / "tr"
            reader.write_text('#!/bin/sh\nrm -- "$TEST_PROCESS"\nexit 1\n')
            reader.chmod(0o755)
            check(True, TEST_PROCESS=str(process))

    def test_recovery_menu_does_not_inherit_normal_boot_overrides(self) -> None:
        source = HERE.parents[1] / "linux/elizaos/mkosi/mkosi.extra/etc/grub.d/42_elizaos_recovery"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("vmlinuz", "initrd"):
                (root / name).write_bytes(b"fixture boot input")
            # Relocate only the input-file checks; execute the actual menu generator.
            script = source.read_text().replace("/efi/elizaos-recovery", str(root))
            overrides = ["root=/dev/wrong", "ro", "rw", "init=/bin/sh",
                         "rdinit=/bin/sh", "elizaos.recovery=0"]
            for prefix in ("systemd.", "rd.systemd."):
                overrides.extend(prefix + value for value in (
                    "unit=graphical.target", "volatile=no", "machine_id=wrong",
                    "condition_first_boot=no"))
            diagnostics = "console=ttyS0,115200n8 systemd.show_status=yes"
            for mode, boot_prefix in (([], "($root)/elizaos-recovery"),
                                      (["--embedded"], "(memdisk)")):
                result = subprocess.run(
                    ["sh", "-s", "--", *mode], input=script, text=True,
                    capture_output=True, timeout=5,
                    env={**os.environ, "ELIZAOS_KERNEL_CMDLINE":
                         " ".join(overrides) + " " + diagnostics})
                self.assertEqual(result.returncode, 0, result.stderr)
                linux = next(line.strip() for line in result.stdout.splitlines()
                             if line.strip().startswith("linux "))
                self.assertEqual(linux,
                    f"linux {boot_prefix}/vmlinuz root=LABEL=elizaos-recovery "
                    "ro systemd.volatile=state systemd.unit=rescue.target "
                    "elizaos.recovery=1 " + diagnostics)

    @unittest.skipUnless(shutil.which("systemctl"), "systemd preset engine unavailable")
    def test_network_preset_replaces_vendor_networkd_enablement(self) -> None:
        disabled = ("systemd-networkd.service", "systemd-networkd.socket",
                    "systemd-networkd-wait-online.service")
        enabled = ("NetworkManager.service", "NetworkManager-wait-online.service",
                   "systemd-resolved.service")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            units = root / "usr/lib/systemd/system"
            presets = root / "usr/lib/systemd/system-preset"
            units.mkdir(parents=True)
            presets.mkdir(parents=True)
            for name in (*disabled, *enabled):
                section = ("[Socket]\nListenStream=12345\n" if name.endswith(".socket")
                           else "[Service]\nExecStart=/usr/bin/true\n")
                (units / name).write_text(
                    "[Unit]\nDescription=Preset fixture\n" + section
                    + "[Install]\nWantedBy=multi-user.target\n")
            (units / "multi-user.target").write_text("[Unit]\nDescription=Fixture target\n")
            (presets / "90-vendor.preset").write_text("enable *\n")

            def systemctl(*arguments: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(["systemctl", "--root", str(root), *arguments],
                                      capture_output=True, text=True, timeout=10)

            result = systemctl("preset-all")
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in disabled:
                self.assertEqual(systemctl("is-enabled", name).stdout.strip(), "enabled")
            shutil.copyfile(
                HERE.parents[1] / "linux/elizaos/mkosi/mkosi.extra/usr/lib/systemd/system-preset/00-elizaos-network.preset",
                presets / "00-elizaos-network.preset")
            for _ in range(2):
                result = systemctl("preset-all")
                self.assertEqual(result.returncode, 0, result.stderr)
                for name in disabled:
                    self.assertEqual(systemctl("is-enabled", name).stdout.strip(), "disabled")
                for name in enabled:
                    self.assertEqual(systemctl("is-enabled", name).stdout.strip(), "enabled")

    @unittest.skipUnless(shutil.which("qemu-system-x86_64"), "native QEMU parser unavailable")
    def test_qemu_paths_preserve_commas_without_injecting_options(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "disk,readonly=on.raw"
            image.write_bytes(bytes(4096))
            monitor = root / "monitor,socket"
            command = ["qemu-system-x86_64", "-machine", "none", "-nodefaults",
                       "-display", "none", "-S", "-m", "32", "-monitor", "none",
                       "-qmp", f"unix:{qemu_path_value(monitor)},server=on,wait=off",
                       "-drive", f"if=none,id=testdisk,format=raw,file={qemu_path_value(image)}"]
            process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 3
                while not monitor.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertIsNone(process.poll(), "QEMU rejected escaped path arguments")
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.settimeout(3)
                    connection.connect(str(monitor))
                    with connection.makefile("rwb") as stream:
                        json.loads(stream.readline())

                        def call(name):
                            stream.write(json.dumps({"execute": name, "id": name}).encode() + b"\n")
                            stream.flush()
                            while True:
                                line = stream.readline()
                                if not line:
                                    raise RuntimeError("QEMU closed the monitor")
                                response = json.loads(line)
                                if response.get("id") == name:
                                    self.assertNotIn("error", response)
                                    return response["return"]

                        call("qmp_capabilities")
                        disks = call("query-block")
                        disk = next(item for item in disks if item["device"] == "testdisk")
                        self.assertEqual(disk["inserted"]["file"], str(image))
                        self.assertFalse(disk["inserted"]["ro"])
                        call("quit")
                self.assertEqual(process.wait(timeout=3), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                if process.stderr is not None:
                    process.stderr.close()

    def test_build_accepts_newer_major_mkosi_releases(self) -> None:
        check = runpy.run_path(str(HERE / "mkosi-linux-build.py"))["supported_mkosi_version"]
        for version in ("mkosi 25.3", "mkosi 25.3.1", "mkosi 26", "mkosi 26.1\n"):
            with self.subTest(version=version):
                self.assertTrue(check(version))
        for version in ("mkosi 25", "mkosi 25.2", "mkosi 24.9", "mkosi 26rc1", "unrelated 99.9", "mkosi broken 99.9", ""):
            with self.subTest(version=version):
                self.assertFalse(check(version))

    def test_build_checksum_binds_exact_artifact(self) -> None:
        check = runpy.run_path(str(HERE / "mkosi-linux-build.py"))["checksum_binds_image"]
        name, digest, other = "elizaos-linux-x86-64.raw.zst", "a" * 64, "b" * 64
        for marker in (" ", "*"):
            self.assertTrue(check(f"{digest} {marker}{name}\n", name, digest))
        for text in (
            f"{digest}  other.raw.zst\n{other}  {name}\n",
            f"{digest}  {name}.old\n",
            f"{digest}  {name}\n{other}  {name}\n",
            f"{digest}  {name}\n{digest}  {name}\n",
            f"# {digest}  {name}\n",
            f"{digest}  {name}\nmalformed\n",
            "",
        ):
            with self.subTest(text=text):
                self.assertFalse(check(text, name, digest))

    def test_qemu_observation_failure_stops_the_owned_emulator(self) -> None:
        module = runpy.run_path(str(HERE / "mkosi-qemu-qualify.py"))
        main = module["main"]
        children = []
        popen = subprocess.Popen

        def start(command, *args, **kwargs):
            child = popen(command, *args, **kwargs)
            if "--version" not in command:
                children.append(child)
            return child

        def fail_observation(_text):
            raise OSError("transcript observation failed")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            emulator = root / "qemu-system-x86_64"
            emulator.write_text(
                f"#!{sys.executable}\nimport sys, time\n"
                "if '--version' in sys.argv:\n"
                "    print('QEMU test fixture')\n"
                "else:\n"
                "    time.sleep(60)\n"
            )
            emulator.chmod(0o755)
            image, firmware = root / "image.raw", root / "bios.fd"
            image.write_bytes(b"fixture")
            firmware.write_bytes(b"fixture")
            argv = ["mkosi-qemu-qualify.py", "--architecture", "amd64",
                    "--image", str(image), "--firmware-mode", "bios", "--bios", str(firmware),
                    "--transcript", str(root / "transcript.log"), "--evidence", str(root / "evidence.json")]
            with patch.dict(os.environ, PATH=f"{root}:{os.environ.get('PATH', '')}"), \
                 patch.object(sys, "argv", argv), patch.object(subprocess, "Popen", start), \
                 patch.dict(main.__globals__, normalized_console_text=fail_observation):
                try:
                    with self.assertRaisesRegex(OSError, "transcript observation failed"):
                        main()
                    self.assertEqual(len(children), 1)
                    self.assertIsNotNone(children[0].poll())
                finally:
                    for child in children:
                        if child.poll() is None:
                            child.kill()
                            child.wait()

    def test_persistence_observation_failure_stops_the_owned_emulator(self) -> None:
        module = runpy.run_path(str(HERE / "mkosi-persistence-qualify.py"))
        boot = module["boot"]
        processes = []
        popen = subprocess.Popen

        def start(*args, **kwargs):
            process = popen(*args, **kwargs)
            processes.append(process)
            return process

        def failed_observation(_text):
            raise OSError("read failed")

        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(subprocess, "Popen", start), patch.dict(
                boot.__globals__, normalized_console_text=failed_observation
            ):
                with self.assertRaisesRegex(OSError, "read failed"):
                    boot([sys.executable, "-c", "import time; time.sleep(60)"], Path(temporary) / "boot.log", 5, [])
            self.assertEqual(len(processes), 1)
            self.assertIsNotNone(processes[0].poll())

    def test_failed_persistence_boot_retains_its_observed_receipt(self) -> None:
        module = runpy.run_path(str(HERE / "mkosi-persistence-qualify.py"))
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / "boot.log"
            receipts = []
            with self.assertRaises(module["QualificationError"]):
                module["boot"](
                    [sys.executable, "-c", "print('Kernel panic - not syncing', flush=True)"],
                    transcript, 5, receipts,
                )
            self.assertEqual(len(receipts), 1)
            receipt = receipts[0]
            self.assertFalse(receipt["success"])
            self.assertEqual(receipt["forbiddenMarkersFound"], ["Kernel panic - not syncing"])
            self.assertEqual(receipt["missingMarkers"], list(GRAPHICAL_MARKERS))
            self.assertEqual(receipt["transcript"]["sha256"], module["sha256_file"](transcript))

    def test_persistence_markers_without_clean_shutdown_cannot_pass(self) -> None:
        module = runpy.run_path(str(HERE / "mkosi-persistence-qualify.py"))
        with tempfile.TemporaryDirectory() as temporary:
            receipts = []
            command = [sys.executable, "-c", f"import time; print({chr(10).join(GRAPHICAL_MARKERS)!r}, flush=True); time.sleep(60)"]
            with self.assertRaises(module["QualificationError"]):
                module["boot"](command, Path(temporary) / "boot.log", 5, receipts)
            self.assertFalse(receipts[0]["success"])
            self.assertEqual(receipts[0]["missingMarkers"], [])
            self.assertEqual(receipts[0]["terminationReason"], "shutdown-failed")
            self.assertIn("clean shutdown", receipts[0]["shutdownError"])

    def test_persistence_cleanup_failure_cannot_report_success(self) -> None:
        module = runpy.run_path(str(HERE / "mkosi-persistence-qualify.py"))
        error = module["QualificationError"]
        attached = module["attached_loop"]
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            if command[:2] == ["losetup", "--detach"]:
                raise error("loop detach failed")
            return subprocess.CompletedProcess(command, 0, "/dev/loop999999\n", "")

        with patch.dict(attached.__wrapped__.__globals__, run=run):
            with self.assertRaisesRegex(error, "loop detach failed"):
                with attached(Path("disposable.raw")) as loop:
                    self.assertEqual(loop, Path("/dev/loop999999"))
        self.assertEqual(calls[-1], ["losetup", "--detach", "/dev/loop999999"])

    def test_failed_mount_does_not_unmount_an_unacquired_resource(self) -> None:
        module = runpy.run_path(str(HERE / "mkosi-persistence-qualify.py"))
        error = module["QualificationError"]
        mounted = module["mounted_home"]
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            raise error("mount failed")

        with patch.dict(mounted.__wrapped__.__globals__, run=run):
            with self.assertRaisesRegex(error, "mount failed"):
                with mounted(Path("/dev/loop999999p1"), read_only=True):
                    self.fail("a failed mount must not yield")
        self.assertEqual(len(calls), 1)
        self.assertFalse(Path(calls[0][-1]).exists())

    def test_lazy_loop_detachment_refuses_to_hand_image_to_vm(self) -> None:
        module = runpy.run_path(str(HERE / "mkosi-persistence-qualify.py"))
        attached = module["attached_loop"]

        def run(command, **kwargs):
            stdout = "/dev/loop999999\n" if "--find" in command else ""
            if "--list" in command:
                stdout = "/externally-mounted-test-image.raw\n"
            return subprocess.CompletedProcess(command, 0, stdout, "")

        with patch.dict(attached.__wrapped__.__globals__, run=run):
            with self.assertRaisesRegex(module["QualificationError"], "remains attached"):
                with attached(Path("disposable.raw")):
                    pass

    def test_console_normalization_preserves_success_and_failure_boundaries(self) -> None:
        modern = "\x1b[32m[ OK ]\x1b[0m Reached target graphical.target - Graphical Interface.\r\n"
        self.assertIn(GRAPHICAL_MARKERS[-1], normalized_console_text(modern))
        failure = "Dependency failed for graphical.target - Graphical Interface."
        self.assertIn(FORBIDDEN_MARKERS[-1], normalized_console_text(failure))
        for incomplete in (
            "Starting graphical.target - Graphical Interface.",
            "Reached target graphi… - Graphical Interface.",
        ):
            self.assertNotIn(GRAPHICAL_MARKERS[-1], normalized_console_text(incomplete))

    def test_framebuffer_capture_waits_for_monitor_completion_and_requires_output(self) -> None:
        capture = runpy.run_path(str(HERE / "mkosi-qemu-qualify.py"))["capture_screenshot"]
        for produce_output in (True, False):
            with self.subTest(produce_output=produce_output), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                monitor = root / "monitor.sock"
                output = root / "desktop capture.ppm"
                pixels = b"P6\n1 1\n255\n\x00\x00\x00"
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                    server.settimeout(5)
                    server.bind(str(monitor))
                    server.listen(1)

                    def serve() -> None:
                        connection, _ = server.accept()
                        with connection:
                            connection.settimeout(5)
                            connection.sendall(b"QEMU monitor\n(qemu) ")
                            request = b""
                            while not request.endswith(b"\n"):
                                chunk = connection.recv(4096)
                                if not chunk:
                                    raise RuntimeError("capture client disconnected")
                                request += chunk
                            self.assertEqual(request.decode(), f"screendump {json.dumps(str(output))}\n")
                            if produce_output:
                                output.write_bytes(pixels)
                            connection.sendall(b"\n(qemu) ")

                    with ThreadPoolExecutor(max_workers=1) as executor:
                        completed = executor.submit(serve)
                        if produce_output:
                            capture(monitor, output)
                            self.assertEqual(output.read_bytes(), pixels)
                            with self.assertRaises(FileExistsError):
                                capture(monitor, output)
                        else:
                            with self.assertRaisesRegex(RuntimeError, "did not produce"):
                                capture(monitor, output)
                        completed.result(timeout=5)

    def test_build_preflight_writes_bounded_failure_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "build.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-linux-build.py"),
                    "--architecture", "amd64",
                    "--output-dir", str(root / "out"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertEqual(document["schema"], "ai.elizaos.mkosi-build-evidence.v1")
            self.assertEqual(
                document["claimBoundary"],
                "mkosi_disk_assembly_only_no_boot_or_hardware_claim",
            )
            if sys.platform != "linux":
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(document["success"])
                self.assertIn("only on a Linux host", " ".join(document["errors"]))

    def test_build_rejects_existing_evidence_before_tool_probes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "build.json"
            evidence.write_text("preserve existing evidence")
            tools = root / "bin"
            tools.mkdir()
            marker = root / "mkosi-called"
            mkosi = tools / "mkosi"
            mkosi.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 99\n")
            mkosi.chmod(0o755)
            result = subprocess.run([
                sys.executable, str(HERE / "mkosi-linux-build.py"),
                "--architecture", "amd64", "--output-dir", str(root / "out"),
                "--evidence", str(evidence),
            ], env={**os.environ, "PATH": f"{tools}:{os.environ.get('PATH', '')}"},
               text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("evidence path already exists", result.stderr)
            self.assertEqual(evidence.read_text(), "preserve existing evidence")
            self.assertFalse(marker.exists())
            self.assertFalse((root / "out").exists())

    def test_build_refuses_existing_output_without_touching_artifacts(self) -> None:
        for kind in ("empty", "stale", "symlink", "file"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                output = root / "out"
                if kind == "file":
                    output.write_text("preserve")
                elif kind == "symlink":
                    output.symlink_to(root / "absent", target_is_directory=True)
                else:
                    output.mkdir()
                    if kind == "stale":
                        (output / "elizaos-linux-x86-64.raw.zst").write_text("old image")
                result = subprocess.run([
                    sys.executable, str(HERE / "mkosi-linux-build.py"),
                    "--architecture", "amd64", "--output-dir", str(output),
                    "--evidence", str(root / "evidence.json"),
                ], capture_output=True, text=True, check=False, timeout=5)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("output directory already exists", result.stderr)
                self.assertFalse((root / "evidence.json").exists())
                if kind == "file":
                    self.assertEqual(output.read_text(), "preserve")
                elif kind == "stale":
                    self.assertEqual((output / "elizaos-linux-x86-64.raw.zst").read_text(), "old image")
                elif kind == "empty":
                    self.assertEqual(list(output.iterdir()), [])
                else:
                    self.assertTrue(output.is_symlink())
                    self.assertFalse((root / "absent").exists())

    def test_build_preflight_rejects_linked_package_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.mkdir()
            cache = root / "cache"
            cache.symlink_to(target, target_is_directory=True)
            evidence = root / "build.json"
            result = subprocess.run([
                sys.executable, str(HERE / "mkosi-linux-build.py"),
                "--architecture", "amd64", "--output-dir", str(root / "out"),
                "--evidence", str(evidence), "--package-cache-dir", str(cache),
                "--preflight-only",
            ], text=True, capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            document = json.loads(evidence.read_text())
            self.assertIn("mkosi package cache must be a directory, not a symlink", document["errors"])
            self.assertEqual(list(target.iterdir()), [])

    def test_control_preflight_accepts_complete_inputs_and_rejects_partial_or_linked_inputs(self) -> None:
        validate = runpy.run_path(str(HERE / "mkosi-linux-build.py"))["validate_control_inputs"]
        manifest = HERE.parents[1] / "linux/control-inputs.list"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "linux").mkdir()
            shutil.copyfile(manifest, root / "linux/control-inputs.list")
            validate(root, "development")
            with self.assertRaisesRegex(ValueError, "control inputs are missing"):
                validate(root, "release")
            for entry in manifest.read_text().splitlines():
                target = root / "linux/control" / entry
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("fixture")
            validate(root, "release")
            target = root / "linux/control/eliza_control/installer.py"
            target.unlink()
            for mode in ("release", "development"):
                with self.assertRaisesRegex(ValueError, "eliza_control/installer.py"):
                    validate(root, mode)
            target.symlink_to(root / "linux/control/eliza_control/auth.py")
            with self.assertRaisesRegex(ValueError, "must not be symlinks"):
                validate(root, "release")
            (root / "linux/control-inputs.list").write_text("../outside")
            with self.assertRaisesRegex(ValueError, "invalid or duplicate paths"):
                validate(root, "release")

    def test_release_build_preflight_requires_reproducible_external_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "release-build.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-linux-build.py"),
                    "--architecture", "riscv64",
                    "--build-mode", "release",
                    "--output-dir", str(root / "out"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            joined = " ".join(document["errors"])
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(document["buildMode"], "release")
            self.assertFalse(document["success"])
            self.assertIn("dated snapshot.debian.org", joined)
            self.assertIn("SOURCE_DATE_EPOCH", joined)
            self.assertIn("DESKTOP_SIGNING_PUBLIC_KEY", joined)
            self.assertIn("desktop-artifact-dir", joined)
            self.assertIn("control inputs are missing", joined)

    def test_release_staging_hashes_both_signatures_and_exact_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact_dir = root / "artifact"
            artifact_dir.mkdir()
            manifest = {
                "archive": "desktop.tar.zst",
                "signature": "desktop.tar.zst.sig",
                "manifestSignature": "desktop-artifact-manifest.json.sig",
            }
            (artifact_dir / "desktop-artifact-manifest.json").write_text(
                json.dumps(manifest)
            )
            for name in (
                "desktop.tar.zst",
                "desktop.tar.zst.sig",
                "desktop-artifact-manifest.json.sig",
                "desktop-signing-public.key",
            ):
                (artifact_dir / name).write_bytes(name.encode())
            evidence = root / "release-build.json"
            environment = os.environ.copy()
            environment.update(
                {
                    "SOURCE_DATE_EPOCH": "1700000000",
                    "ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY": "/opt/elizaos/share/desktop-signing-public.key",
                    "ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY_SPKI_SHA256": "0" * 64,
                }
            )
            subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-linux-build.py"),
                    "--architecture", "amd64",
                    "--build-mode", "release",
                    "--debian-snapshot-url", "https://snapshot.debian.org/archive/debian/20260817T000000Z/",
                    "--desktop-artifact-dir", str(artifact_dir),
                    "--output-dir", str(root / "out"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            names = {item["path"] for item in document["desktopArtifactInputs"]}
            self.assertEqual(
                names,
                {
                    "desktop-artifact-manifest.json",
                    "desktop-artifact-manifest.json.sig",
                    "desktop.tar.zst",
                    "desktop.tar.zst.sig",
                    "desktop-signing-public.key",
                },
            )

    def test_release_manifest_invalid_shapes_and_non_files_record_failure(self) -> None:
        for kind in ("null", "[]", '\"text\"', "42", "fifo", "symlink"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                artifact_dir = root / "artifact"
                artifact_dir.mkdir()
                manifest = artifact_dir / "desktop-artifact-manifest.json"
                if kind == "fifo":
                    os.mkfifo(manifest)
                elif kind == "symlink":
                    target = root / "external.json"
                    target.write_text("{}")
                    manifest.symlink_to(target)
                else:
                    manifest.write_text(kind)
                evidence = root / "evidence.json"
                result = subprocess.run(
                    [sys.executable, str(HERE / "mkosi-linux-build.py"),
                     "--architecture", "amd64", "--build-mode", "release",
                     "--desktop-artifact-dir", str(artifact_dir),
                     "--output-dir", str(root / "out"), "--evidence", str(evidence),
                     "--preflight-only"],
                    capture_output=True, text=True, timeout=15, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                document = json.loads(evidence.read_text())
                self.assertFalse(document["success"])
                self.assertTrue(any("desktop artifact manifest must be" in error
                                    for error in document["errors"]))
                self.assertNotIn("Traceback", result.stderr)
                self.assertFalse((root / "out").exists())

    def test_qemu_preflight_never_invents_boot_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "qemu.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "arm64",
                    "--image", str(root / "missing.raw"),
                    "--firmware-code", str(root / "missing-code.fd"),
                    "--firmware-vars", str(root / "missing-vars.fd"),
                    "--transcript", str(root / "transcript.log"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(document["success"])
            self.assertEqual(document["firmwareMode"], "pflash")
            self.assertEqual(document["markersFound"], [])
            self.assertNotIn("inputs", document)
            self.assertIn("no_login_agent_computer_control_or_hardware_claim", document["claimBoundary"])

    def test_qemu_evidence_publication_never_clobbers_an_existing_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "qemu.json"
            original = b"existing evidence must survive\n"
            evidence.write_bytes(original)
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "amd64",
                    "--image", str(root / "missing.raw"),
                    "--firmware-code", str(root / "missing-code.fd"),
                    "--firmware-vars", str(root / "missing-vars.fd"),
                    "--transcript", str(root / "transcript.log"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(evidence.read_bytes(), original)
            self.assertIn("evidence publication failed", result.stderr)

    def test_qemu_rejects_double_firmware_topology(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "qemu.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "riscv64",
                    "--image", str(root / "disk.raw"),
                    "--firmware-code", str(root / "code.fd"),
                    "--firmware-vars", str(root / "vars.fd"),
                    "--bios", str(root / "opensbi.bin"),
                    "--transcript", str(root / "transcript.log"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "--bios cannot be combined with pflash firmware mode",
                document["errors"],
            )

    def test_qemu_preflight_requires_the_promotion_graphical_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "qemu.json"
            subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "amd64",
                    "--image", str(root / "missing.raw"),
                    "--firmware-code", str(root / "missing-code.fd"),
                    "--firmware-vars", str(root / "missing-vars.fd"),
                    "--transcript", str(root / "transcript.log"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertIn(
                "Started gdm.service - GNOME Display Manager",
                document["requiredMarkers"],
            )
            self.assertIn(
                "Reached target Graphical Interface", document["requiredMarkers"]
            )

    def test_qemu_recovery_mode_selects_hotkey_and_requires_boundary_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            emulator = fake_bin / "qemu-system-x86_64"
            emulator.write_text(
                "#!/usr/bin/env python3\n"
                "import socket, sys, time\n"
                "if '--version' in sys.argv:\n"
                "    print('QEMU emulator version 9.2.2')\n"
                "    raise SystemExit(0)\n"
                "monitor = sys.argv[sys.argv.index('-monitor') + 1]\n"
                "path = monitor.removeprefix('unix:').split(',', 1)[0]\n"
                "with socket.socket(socket.AF_UNIX) as server:\n"
                "    server.bind(path)\n"
                "    server.listen(1)\n"
                "    connection, _ = server.accept()\n"
                "    with connection:\n"
                "        command = connection.recv(1024)\n"
                "if command != b'sendkey r\\n':\n"
                "    raise SystemExit(2)\n"
                "print('Linux version 6.12 fixture', flush=True)\n"
                "print('elizaOS recovery boundary verified: Eliza agent and privileged "
                "broker unavailable', flush=True)\n"
                "time.sleep(10)\n"
            )
            emulator.chmod(0o755)
            image = root / "disk.raw"
            bios = root / "bios.fd"
            image.write_bytes(b"immutable image fixture")
            bios.write_bytes(b"firmware fixture")
            evidence = root / "recovery.json"
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}{os.pathsep}{environment['PATH']}"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "amd64",
                    "--boot-mode", "recovery",
                    "--image", str(image),
                    "--firmware-mode", "bios",
                    "--bios", str(bios),
                    "--transcript", str(root / "recovery.log"),
                    "--evidence", str(evidence),
                    "--timeout", "30",
                    "--memory-mib", "1024",
                    "--cpus", "1",
                ],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(document["success"])
            self.assertEqual(document["bootMode"], "recovery")
            self.assertEqual(document["selectionMethod"], "grub-hotkey-r")
            self.assertGreater(document["selectionAttempts"], 0)
            self.assertIn("service_unavailability", document["claimBoundary"])

    def test_qemu_recovery_mode_requires_an_accepted_hotkey(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            emulator = fake_bin / "qemu-system-x86_64"
            emulator.write_text(
                "#!/bin/sh\n"
                "if [ \"${1:-}\" = --version ]; then "
                "printf '%s\\n' 'QEMU emulator version 9.2.2'; exit 0; fi\n"
                "printf '%s\\n' 'Linux version 6.12 fixture' "
                "'elizaOS recovery boundary verified: Eliza agent and privileged "
                "broker unavailable'\n"
                "sleep 10\n"
            )
            emulator.chmod(0o755)
            image = root / "disk.raw"
            bios = root / "bios.fd"
            image.write_bytes(b"immutable image fixture")
            bios.write_bytes(b"firmware fixture")
            evidence = root / "recovery.json"
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}{os.pathsep}{environment['PATH']}"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "amd64",
                    "--boot-mode", "recovery",
                    "--image", str(image),
                    "--firmware-mode", "bios",
                    "--bios", str(bios),
                    "--transcript", str(root / "recovery.log"),
                    "--evidence", str(evidence),
                    "--timeout", "30",
                    "--memory-mib", "1024",
                    "--cpus", "1",
                ],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(document["success"])
            self.assertEqual(document["selectionAttempts"], 0)
            self.assertIn("hotkey was never accepted", " ".join(document["errors"]))

    def test_persistence_preflight_never_invents_write_or_reboot_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "persistence.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-persistence-qualify.py"),
                    "--architecture", "amd64",
                    "--source-image", str(root / "missing.raw"),
                    "--work-image", str(root / "work.raw"),
                    "--firmware-code", str(root / "missing-code.fd"),
                    "--firmware-vars", str(root / "missing-vars.fd"),
                    "--transcript-directory", str(root / "transcripts"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(document["success"])
            self.assertIn("two_boot_home_persistence", document["claimBoundary"])
            self.assertNotIn("virtualUsbReadback", document)
            self.assertNotIn("home", document)
            self.assertNotIn("boots", document)

    def test_persistence_preflight_refuses_an_existing_work_image(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.raw"
            work = root / "work.raw"
            firmware = root / "firmware.fd"
            for path in (source, work, firmware):
                path.write_bytes(b"fixture")
            evidence = root / "persistence.json"
            subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-persistence-qualify.py"),
                    "--architecture", "riscv64",
                    "--source-image", str(source),
                    "--work-image", str(work),
                    "--firmware-mode", "bios",
                    "--bios", str(firmware),
                    "--transcript-directory", str(root / "transcripts"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertIn("work image must not already exist", document["errors"])


if __name__ == "__main__":
    unittest.main()
