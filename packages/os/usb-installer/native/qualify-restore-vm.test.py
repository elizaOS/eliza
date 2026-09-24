"""Refusal tests for the asynchronous QMP removal handshake; no VM or disk."""

import importlib.util
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location(
    "restore_vm", Path(__file__).with_name("qualify-restore-vm.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class QmpHandshake(unittest.TestCase):
    def exchange(self, behavior, expect_error=False, device="restore-device"):
        with tempfile.TemporaryDirectory(prefix="elizaos-qmp-") as directory:
            path = Path(directory) / "qmp.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(path))
            server.listen(1)
            errors = []

            def fixture():
                try:
                    with server.accept()[0] as connection:
                        connection.settimeout(2)
                        stream = connection.makefile("rb")

                        def send(message):
                            connection.sendall(json.dumps(message).encode() + b"\n")

                        send({"QMP": {"version": {}}})
                        capabilities = json.loads(stream.readline())
                        self.assertEqual(capabilities["execute"], "qmp_capabilities")
                        send({"return": {}, "id": capabilities["id"]})
                        request = json.loads(stream.readline())
                        self.assertEqual(request["execute"], "device_del")
                        self.assertEqual(request["arguments"], {"id": device})
                        event = {"event": "DEVICE_DELETED", "data": {"device": device}}
                        if behavior == "event-first":
                            send(event)
                        if behavior == "command-error":
                            send({"error": {"class": "DeviceNotFound"}, "id": request["id"]})
                        else:
                            send({"return": {}, "id": request["id"]})
                        if behavior == "reply-first":
                            send(event)
                        if behavior == "wrong-device":
                            event["data"]["device"] = "os-disk"
                            send(event)
                        if behavior == "guest-error":
                            event["event"] = "DEVICE_UNPLUG_GUEST_ERROR"
                            send(event)
                        stream.close()
                except BaseException as error:
                    errors.append(error)
                finally:
                    server.close()

            worker = threading.Thread(target=fixture, daemon=True)
            worker.start()
            control = module.Qmp(path, io.StringIO())
            try:
                if expect_error:
                    with self.assertRaises((RuntimeError, OSError)):
                        control.remove_restore_device(device)
                else:
                    event = control.remove_restore_device(device)
                    self.assertEqual(event["event"], "DEVICE_DELETED")
                    self.assertEqual(event["data"]["device"], device)
            finally:
                control.close()
                worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])

    def test_transaction_usb_removal(self):
        self.exchange("event-first", device="transaction-uas")
        self.exchange("reply-first", device="transaction-uas")

    def test_transaction_usb_requires_its_own_event(self):
        self.exchange("ack-only", True, device="transaction-uas")
        self.exchange("wrong-device", True, device="transaction-uas")

    def test_unlisted_device_cannot_be_removed(self):
        control = object.__new__(module.Qmp)
        with self.assertRaisesRegex(RuntimeError, "restricted"):
            control.remove_restore_device("os-disk")

    def test_event_before_acknowledgement(self):
        self.exchange("event-first")

    def test_acknowledgement_before_event(self):
        self.exchange("reply-first")

    def test_acknowledgement_alone_is_not_removal(self):
        self.exchange("ack-only", True)

    def test_another_device_is_not_the_target(self):
        self.exchange("wrong-device", True)

    def test_guest_refusal_fails(self):
        self.exchange("guest-error", True)

    def test_command_error_fails(self):
        self.exchange("command-error", True)


if __name__ == "__main__":
    unittest.main()
