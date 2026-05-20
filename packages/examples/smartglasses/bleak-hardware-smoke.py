#!/usr/bin/env python3
"""Physical Even G1 smoke test through Python Bleak/CoreBluetooth.

This path avoids Chrome's Web Bluetooth device picker and Noble's native Node
binding. It writes the same report shape consumed by validate-hardware-report.ts.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import textwrap
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bleak import BleakClient, BleakScanner


UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
UART_TX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
UART_RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

COMMAND_NAMES = {
    0x4D: "init",
    0xF4: "right-init",
    0x4E: "display-result",
    0x0E: "open-mic",
    0x34: "get-serial",
    0x01: "brightness",
    0x22: "dashboard",
    0x0B: "head-up-angle",
    0x27: "wear-detection",
}

SETTINGS_EVENTS = {
    0x01: "brightness",
    0x22: "dashboard",
    0x0B: "head-up-angle",
    0x27: "wear-detection",
}

INTERACTIONS = {
    0x00: "double_tap",
    0x01: "single_tap",
    0x17: "long_press",
    0x18: "stop_ai_recording",
    0x04: "silent_mode_on",
    0x05: "silent_mode_off",
    0x02: "open_dashboard_start",
    0x03: "close_dashboard_start",
    0x1E: "open_dashboard_confirm",
    0x1F: "close_dashboard_confirm",
}

DEVICES = {
    0x0A: "device_unknown_0a",
    0x11: "connected",
    0x12: "device_unknown_12",
    0x14: "device_unknown_14",
    0x15: "device_unknown_15",
}

PHYSICAL_STATES = {
    0x06: "wearing",
    0x07: "transitioning",
    0x08: "cradle_open",
    0x09: "charged_in_cradle",
    0x0B: "cradle_closed",
}

BATTERY_STATES = {
    0x09: "glasses_fully_charged",
    0x0E: "cradle_charging_cable_changed",
    0x0F: "cradle_fully_charged",
}

REQUIRED = (
    "connected",
    "connectionReadySent",
    "displayPacketsSent",
    "serialRequested",
    "serialObserved",
    "settingsSent",
    "tapObserved",
    "microphoneEnabledByTap",
    "microphoneEnableWriteAfterTap",
    "microphoneDisabledByTap",
    "microphoneDisableWriteAfterTap",
    "audioObserved",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def command_name(data: bytes) -> str:
    return COMMAND_NAMES.get(data[0], f"0x{data[0]:02x}") if data else "empty"


def make_report(scan_timeout_ms: int, hold_ms: int, init_mode: str) -> dict[str, Any]:
    return {
        "ok": False,
        "startedAt": now(),
        "scanTimeoutMs": scan_timeout_ms,
        "holdMs": hold_ms,
        "initMode": init_mode,
        "checks": {
            "connected": False,
            "connectionReadySent": False,
            "displayPacketsSent": False,
            "serialRequested": False,
            "serialObserved": False,
            "settingsSent": False,
            "microphoneEnabled": False,
            "microphoneEnabledByTap": False,
            "microphoneEnableWriteAfterTap": False,
            "tapObserved": False,
            "microphoneDisabledByTap": False,
            "microphoneDisableWriteAfterTap": False,
            "microphoneDisabledByCommand": False,
            "audioObserved": False,
        },
        "discoveredDevices": [],
        "pairedG1Devices": [],
        "bluetoothAdapter": None,
        "scanDiagnosis": "not_scanned",
        "evidenceOrder": 0,
        "writes": [],
        "events": [],
        "lenses": {
            "left": {"connected": False},
            "right": {"connected": False},
        },
        "audio": [],
        "headsetState": {
            "physical": None,
            "battery": None,
            "device": None,
        },
        "setupHint": None,
        "status": {
            "available": True,
            "connected": False,
            "transport": "bleak-g1",
            "microphoneEnabled": False,
            "pagesSent": 0,
            "lastSerialNumber": None,
            "audioChunksReceived": 0,
            "audioBytesReceived": 0,
            "lastAudioEncoding": None,
            "audioSequenceGaps": 0,
            "physicalState": None,
            "batteryState": None,
            "deviceState": None,
            "connectedLenses": {},
        },
    }


@dataclass
class Lens:
    side: str
    name: str
    address: str
    device: Any
    client: BleakClient
    tx: Any | None = None
    rx: Any | None = None


class G1BleakSmoke:
    def __init__(self, scan_timeout_ms: int, hold_ms: int, report_path: str | None, init_mode: str):
        self.scan_timeout_ms = scan_timeout_ms
        self.hold_ms = hold_ms
        self.report_path = report_path
        self.init_mode = init_mode
        self.report = make_report(scan_timeout_ms, hold_ms, init_mode)
        self.lenses: dict[str, Lens] = {}
        self._last_audio_sequence: int | None = None
        self._mic_disable_seen = asyncio.Event()
        self._audio_seen = asyncio.Event()
        self._heartbeat_task: asyncio.Task[None] | None = None

    def log(self, message: str, data: Any | None = None) -> None:
        suffix = "" if data is None else f" {json.dumps(data)}"
        print(f"[smartglasses:bleak-smoke] {message}{suffix}", flush=True)

    def record_bluetooth_preflight(self) -> None:
        bluetooth = inspect_macos_bluetooth()
        if bluetooth is None:
            return
        self.report["bluetoothAdapter"] = bluetooth.get("adapter")
        self.report["pairedG1Devices"] = bluetooth.get("pairedG1Devices", [])
        if self.report["pairedG1Devices"]:
            self.log(
                "paired G1 devices",
                {
                    "pairedG1Devices": self.report["pairedG1Devices"],
                    "adapter": self.report["bluetoothAdapter"],
                },
            )

    async def scan(self) -> None:
        self.record_bluetooth_preflight()
        self.log("scanning", {"scanTimeoutMs": self.scan_timeout_ms})
        devices = await BleakScanner.discover(
            timeout=self.scan_timeout_ms / 1000,
            return_adv=True,
        )
        found: dict[str, tuple[str, Any]] = {}
        for _, (device, adv) in devices.items():
            name = device.name or adv.local_name or ""
            service_uuids = [str(uuid).lower() for uuid in (adv.service_uuids or [])]
            manufacturer_ids = sorted(int(key) for key in (adv.manufacturer_data or {}).keys())
            matches_name = "Even" in name or "G1" in name
            matches_uart = UART_SERVICE.lower() in service_uuids
            matches_g1 = matches_name or matches_uart
            match_reason = "name" if matches_name else "uart_service" if matches_uart else None
            self.report["discoveredDevices"].append(
                {
                    "name": name or None,
                    "address": device.address,
                    "rssi": adv.rssi,
                    "serviceUuids": service_uuids,
                    "manufacturerIds": manufacturer_ids,
                    "matchesG1": matches_g1,
                    "matchReason": match_reason,
                }
            )
            if "_L_" in name and "left" not in found:
                found["left"] = (name, device)
            elif "_R_" in name and "right" not in found:
                found["right"] = (name, device)
            if matches_g1:
                self.log(
                    "found",
                    {
                        "name": name,
                        "address": device.address,
                        "rssi": adv.rssi,
                        "matchReason": match_reason,
                    },
                )
        self.report["discoveredDevices"] = sorted(
            self.report["discoveredDevices"],
            key=lambda item: (
                not item["matchesG1"],
                -(item["rssi"] if isinstance(item.get("rssi"), int) else -999),
                item.get("name") or "",
            ),
        )[:50]
        self.report["scanDiagnosis"] = scan_diagnosis(self.report, found)

        missing = [side for side in ("left", "right") if side not in found]
        if missing:
            raise RuntimeError(f"Missing G1 lens during scan: {', '.join(missing)}")

        for side, (name, device) in found.items():
            self.lenses[side] = Lens(side, name, device.address, device, BleakClient(device))

    async def connect(self) -> None:
        await asyncio.gather(*(self._connect_lens(lens) for lens in self.lenses.values()))
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        self.report["checks"]["connected"] = True
        self.report["scanDiagnosis"] = "whole_headset_seen"
        self.report["status"]["connected"] = True
        for side, lens in self.lenses.items():
            lens_report = {
                "connected": lens.client.is_connected,
                "name": lens.name,
                "address": lens.address,
            }
            self.report["lenses"][side] = lens_report
            self.report["status"]["connectedLenses"][side] = lens_report
        self.log("connected", {side: lens.name for side, lens in self.lenses.items()})

    async def _connect_lens(self, lens: Lens) -> None:
        if lens.client.is_connected:
            try:
                await lens.client.stop_notify(lens.rx) if lens.rx else None
            except Exception:
                pass
            await lens.client.disconnect()
        lens.tx = None
        lens.rx = None
        lens.client = BleakClient(lens.device)
        await lens.client.connect()
        lens.tx = lens.client.services.get_characteristic(UART_TX)
        lens.rx = lens.client.services.get_characteristic(UART_RX)
        if not lens.tx or not lens.rx:
            raise RuntimeError(f"{lens.side} lens did not expose UART TX/RX")
        await lens.client.start_notify(lens.rx, self._notification_handler(lens.side))
        self.log("subscribed", {"side": lens.side, "name": lens.name, "address": lens.address})

    async def disconnect(self) -> None:
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        for lens in self.lenses.values():
            try:
                if lens.client.is_connected:
                    if lens.rx:
                        await lens.client.stop_notify(lens.rx)
                    await lens.client.disconnect()
            except Exception as error:  # noqa: BLE001
                self.log("disconnect failed", {"side": lens.side, "error": str(error)})

    def record_write(self, side: str, data: bytes) -> None:
        name = command_name(data)
        self.report["writes"].append(
            {
                "at": now(),
                "order": next_evidence_order(self.report),
                "side": side,
                "command": name,
                "bytes": len(data),
                "hex": data[:24].hex(),
            }
        )
        if name in ("init", "right-init"):
            self.report["checks"]["connectionReadySent"] = True
        if name == "display-result":
            self.report["checks"]["displayPacketsSent"] = True
            self.report["status"]["pagesSent"] += 1
        if name == "get-serial":
            self.report["checks"]["serialRequested"] = True
        if name in ("brightness", "dashboard", "head-up-angle", "wear-detection"):
            self.report["checks"]["settingsSent"] = True
        if name == "open-mic":
            enabled = len(data) > 1 and data[1] == 0x01
            self.report["status"]["microphoneEnabled"] = enabled
            if enabled:
                self.report["checks"]["microphoneEnabled"] = True
            else:
                self.report["checks"]["microphoneDisabledByCommand"] = True
            update_tap_driven_mic_write_checks(self.report)

    async def write(self, side: str, data: bytes) -> None:
        self.record_write(side, data)
        await self._write_with_retry(side, data)

    async def _write_with_retry(self, side: str, data: bytes) -> None:
        lens = self.lenses[side]
        if not lens.tx or not lens.client.is_connected:
            await self._connect_lens(lens)
        try:
            await lens.client.write_gatt_char(lens.tx, data, response=True)
        except Exception:
            try:
                await lens.client.write_gatt_char(lens.tx, data, response=False)
            except Exception as error:
                self.log("write retry after reconnect", {"side": side, "error": str(error)})
                await self._connect_lens(lens)
                await lens.client.write_gatt_char(lens.tx, data, response=False)

    async def _heartbeat_loop(self) -> None:
        seq = 1
        while True:
            await asyncio.sleep(5)
            packet = bytes([0x25, 0x06, 0x00, seq & 0xFF, 0x04, seq & 0xFF])
            try:
                await self.write_both(packet)
            except Exception as error:  # noqa: BLE001
                self.log("heartbeat failed", {"error": str(error)})
            seq = (seq + 1) & 0xFF

    async def write_both(self, data_by_side: dict[str, bytes] | bytes) -> None:
        if isinstance(data_by_side, bytes):
            writes = [(side, data_by_side) for side in ("left", "right")]
        else:
            writes = list(data_by_side.items())
        results = await asyncio.gather(
            *(self.write(side, data) for side, data in writes),
            return_exceptions=True,
        )
        failures = [
            {"side": side, "error": str(result)}
            for (side, _), result in zip(writes, results)
            if isinstance(result, Exception)
        ]
        if failures:
            self.log("write_both partial failure", failures)
            raise RuntimeError(f"write_both failed for {', '.join(item['side'] for item in failures)}")

    async def initialize(self) -> None:
        if self.init_mode == "official":
            await self.write_both(bytes([0x4D, 0x01]))
        elif self.init_mode == "android-f4":
            await self.write_both(bytes([0xF4, 0x01]))
        else:
            await self.write_both({"left": bytes([0x4D, 0x01]), "right": bytes([0xF4, 0x01])})
        await self.write_both(bytes([0x34]))
        for packet in encode_display_text(
            "Eliza smartglasses hardware smoke. Single tap, speak, then double tap."
        ):
            await self.write_both(packet)
            await asyncio.sleep(0.03)
        await self.write_both(bytes([0x01, 0x0A, 0x01]))
        await self.write_both(bytes([0x22, 0x07, 0x00, 0x01, 0x02, 0x01, 0x04]))
        await self.write_both(bytes([0x0B, 0x14, 0x01]))
        await self.write_both(bytes([0x27, 0x01]))
        await self.write("right", bytes([0x0E, 0x00]))

    async def run_direct_mic_diagnostic(self) -> None:
        diagnostic_ms = int(os.environ.get("SMARTGLASSES_DIRECT_MIC_MS", "0"))
        if diagnostic_ms <= 0:
            return
        self.log("direct mic diagnostic", "speak clearly until the diagnostic window ends")
        await self.write("right", bytes([0x0E, 0x01]))
        deadline = asyncio.get_running_loop().time() + (diagnostic_ms / 1000)
        while asyncio.get_running_loop().time() < deadline:
            if self.report["checks"]["audioObserved"]:
                break
            await asyncio.sleep(0.25)
        await self.write("right", bytes([0x0E, 0x00]))

    async def wait_for_wearing(self) -> None:
        timeout_ms = int(os.environ.get("SMARTGLASSES_WEARING_TIMEOUT_MS", "30000"))
        if timeout_ms <= 0:
            return
        if self.report["headsetState"]["physical"] == "wearing":
            return
        self.log(
            "action required",
            "remove the glasses from the charging base and wear them before tap/audio validation",
        )
        deadline = asyncio.get_running_loop().time() + (timeout_ms / 1000)
        while asyncio.get_running_loop().time() < deadline:
            if self.report["headsetState"]["physical"] == "wearing":
                self.log("wearing observed", self.report["headsetState"])
                return
            await asyncio.sleep(0.25)
        raise RuntimeError(
            "Glasses did not report wearing state before tap/audio validation"
        )

    async def validate(self) -> None:
        self.log("action required", "single tap, speak clearly, then double tap")
        deadline = asyncio.get_running_loop().time() + (self.hold_ms / 1000)
        while asyncio.get_running_loop().time() < deadline:
            if all(self.report["checks"][check] for check in REQUIRED):
                break
            await asyncio.sleep(0.25)
        await self.write("right", bytes([0x0E, 0x00]))
        self.finish_status()
        missing = [check for check in REQUIRED if not self.report["checks"][check]]
        if missing:
            raise RuntimeError(f"Missing hardware smoke evidence: {', '.join(missing)}")

    def _notification_handler(self, side: str):
        def callback(_: Any, data: bytearray) -> None:
            asyncio.create_task(self.handle_notification(side, bytes(data)))

        return callback

    async def handle_notification(self, side: str, data: bytes) -> None:
        event = parse_event(side, data)
        state_category = event.get("stateCategory")
        state_name = event.get("stateName") or event.get("label")
        if state_category in ("physical", "battery", "device"):
            self.report["headsetState"][state_category] = state_name
            self.report["status"][f"{state_category}State"] = state_name
        self.report["events"].append(
            {
                "at": now(),
                "order": next_evidence_order(self.report),
                "side": side,
                "type": event["type"],
                "label": event.get("label"),
                "stateCategory": state_category,
                "stateName": event.get("stateName"),
                "sequence": event.get("sequence"),
                "serialNumber": event.get("serialNumber"),
            }
        )
        label = event.get("label")
        self.log("event", {"side": side, "type": event["type"], "label": label})
        if label in ("single_tap", "long_press"):
            self.report["checks"]["tapObserved"] = True
            self.report["checks"]["microphoneEnabled"] = True
            self.report["checks"]["microphoneEnabledByTap"] = True
            await self.write("right", bytes([0x0E, 0x01]))
        elif label in ("double_tap", "stop_ai_recording"):
            self.report["checks"]["tapObserved"] = True
            self.report["checks"]["microphoneDisabledByTap"] = True
            await self.write("right", bytes([0x0E, 0x00]))
            self._mic_disable_seen.set()
        elif label and "tap" in label:
            self.report["checks"]["tapObserved"] = True
        update_tap_driven_mic_write_checks(self.report)

        if event["type"] == "serial" and event.get("serialNumber"):
            self.report["checks"]["serialObserved"] = True
            self.report["status"]["lastSerialNumber"] = event["serialNumber"]

        if event["type"] == "mic-data":
            payload = event["audioData"]
            self.report["checks"]["audioObserved"] = True
            self.report["audio"].append(
                {
                    "at": now(),
                    "order": next_evidence_order(self.report),
                    "side": side,
                    "sampleRate": 16000,
                    "encoding": "lc3",
                    "sequence": event.get("sequence"),
                    "bytes": len(payload),
                }
            )
            self.report["status"]["audioChunksReceived"] += 1
            self.report["status"]["audioBytesReceived"] += len(payload)
            self.report["status"]["lastAudioEncoding"] = "lc3"
            seq = event.get("sequence")
            if isinstance(seq, int) and self._last_audio_sequence is not None:
                expected = (self._last_audio_sequence + 1) & 0xFF
                if seq != expected:
                    self.report["status"]["audioSequenceGaps"] += 1
            if isinstance(seq, int):
                self._last_audio_sequence = seq
            self._audio_seen.set()

    def finish_status(self) -> None:
        self.report["finishedAt"] = now()
        for side, lens in self.lenses.items():
            lens_report = {
                "connected": lens.client.is_connected,
                "name": lens.name,
                "address": lens.address,
            }
            self.report["lenses"][side] = lens_report
            self.report["status"]["connectedLenses"][side] = lens_report
        self.report["status"]["connected"] = whole_headset_connected(self.report)
        if self.report["status"]["connected"]:
            self.report["scanDiagnosis"] = "whole_headset_seen"
        self.report["setupHint"] = setup_hint_for_blocker(physical_blocker(self.report), self.report)
        update_tap_driven_mic_write_checks(self.report)
        self.report["ok"] = len(missing_complete_hardware_evidence(self.report)) == 0

    async def write_report(self) -> None:
        self.finish_status()
        if not self.report_path:
            return
        path = Path(self.report_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.report, indent=2) + "\n")
        self.log("report written", {"reportPath": str(path)})


def parse_event(side: str, data: bytes) -> dict[str, Any]:
    command = data[0] if data else None
    if command is None:
        return {"side": side, "type": "unknown", "label": "empty"}
    if command == 0x4D:
        return {
            "side": side,
            "type": "init",
            "label": "init",
            "code": data[1] if len(data) > 1 else None,
        }
    if command == 0xF4:
        return {
            "side": side,
            "type": "init",
            "label": "right_init",
            "code": data[1] if len(data) > 1 else None,
        }
    if command == 0x4E:
        return {"side": side, "type": "display-result", "label": "display_result_ack"}
    if command in SETTINGS_EVENTS:
        return {
            "side": side,
            "type": "settings-response",
            "label": SETTINGS_EVENTS[command],
            "code": data[1] if len(data) > 1 else None,
        }
    if command == 0xF5:
        code = data[1] if len(data) > 1 else None
        if code in INTERACTIONS:
            return {
                "side": side,
                "type": "state",
                "label": INTERACTIONS[code],
                "stateCategory": "interaction",
                "stateName": INTERACTIONS[code],
            }
        if code in PHYSICAL_STATES:
            return {
                "side": side,
                "type": "state",
                "label": PHYSICAL_STATES[code],
                "stateCategory": "physical",
                "stateName": PHYSICAL_STATES[code],
            }
        if code in BATTERY_STATES:
            return {
                "side": side,
                "type": "state",
                "label": BATTERY_STATES[code],
                "stateCategory": "battery",
                "stateName": BATTERY_STATES[code],
            }
        if code in DEVICES:
            return {
                "side": side,
                "type": "state",
                "label": DEVICES[code],
                "stateCategory": "device",
                "stateName": DEVICES[code],
            }
        return {"side": side, "type": "state", "label": f"unknown_0x{code:02x}"}
    if command == 0x0E:
        enabled = bool(data[-1]) if data else False
        ok = len(data) < 3 or data[1] == 0xC9
        return {
            "side": side,
            "type": "mic-response",
            "label": "mic_enabled" if ok and enabled else "mic_disabled" if ok else "mic_failed",
            "micEnabled": ok and enabled,
            "micRequested": enabled,
            "responseOk": ok,
        }
    if command == 0xF1:
        return {
            "side": side,
            "type": "mic-data",
            "label": "mic_data",
            "sequence": data[1] if len(data) > 1 else None,
            "audioData": data[2:] if len(data) > 2 else b"",
        }
    if command == 0x34:
        serial = data[2:18].decode(errors="ignore").rstrip("\0")
        return {"side": side, "type": "serial", "label": "serial_number", "serialNumber": serial}
    if command == 0x25:
        return {"side": side, "type": "heartbeat", "label": "heartbeat"}
    if len(data) > 1 and data[1] in (0xC9, 0xCA):
        return {
            "side": side,
            "type": "response" if data[1] == 0xC9 else "error",
            "label": "response" if data[1] == 0xC9 else "error",
            "code": data[1],
        }
    return {"side": side, "type": "unknown", "label": f"unknown_0x{command:02x}"}


def missing_complete_hardware_evidence(report: dict[str, Any]) -> list[str]:
    failures = [check for check in REQUIRED if not report["checks"].get(check)]
    lenses = report.get("lenses") or {}
    status = report.get("status") or {}
    connected_lenses = status.get("connectedLenses") or {}
    headset_state = report.get("headsetState") or {}
    physical = headset_state.get("physical") or status.get("physicalState")
    battery = headset_state.get("battery") or status.get("batteryState")
    if not (lenses.get("left") or {}).get("connected"):
        failures.append("missingLeftLensConnection")
    if not (lenses.get("right") or {}).get("connected"):
        failures.append("missingRightLensConnection")
    if not (connected_lenses.get("left") or {}).get("connected"):
        failures.append("missingStatusLeftLensConnection")
    if not (connected_lenses.get("right") or {}).get("connected"):
        failures.append("missingStatusRightLensConnection")
    if not any(
        write.get("command") == "open-mic" and write.get("side") == "right" and "0e01" in write.get("hex", "")
        for write in report.get("writes") or []
    ):
        failures.append("missingMicEnableWrite")
    if not any(
        write.get("command") == "open-mic" and write.get("side") == "right" and "0e00" in write.get("hex", "")
        for write in report.get("writes") or []
    ):
        failures.append("missingMicDisableWrite")
    if not has_tap_driven_right_mic_write(report, "enable"):
        failures.append("missingMicEnableWriteAfterTap")
    if not has_tap_driven_right_mic_write(report, "disable"):
        failures.append("missingMicDisableWriteAfterTap")
    if not any(
        chunk.get("side") == "right" and chunk.get("bytes", 0) > 0
        for chunk in report.get("audio") or []
    ):
        failures.append("missingRightLensAudioChunk")
    if physical != "wearing" and is_cradle_or_charging_state(physical, battery):
        failures.append("headsetInCradle")
    if physical != "wearing":
        failures.append("wearingStateNotObserved")
    return list(dict.fromkeys(failures))


def has_tap_driven_right_mic_write(report: dict[str, Any], mode: str) -> bool:
    labels = (
        ("single_tap", "long_press")
        if mode == "enable"
        else ("double_tap", "stop_ai_recording")
    )
    mic_hex = "0e01" if mode == "enable" else "0e00"
    tap_events = [
        event
        for event in report.get("events") or []
        if event.get("label") in labels
    ]
    mic_writes = [
        write
        for write in report.get("writes") or []
        if write.get("side") == "right"
        and write.get("command") == "open-mic"
        and str(write.get("hex", "")).startswith(mic_hex)
    ]
    return any(
        evidence_happened_after(write, event)
        for event in tap_events
        for write in mic_writes
    )


def update_tap_driven_mic_write_checks(report: dict[str, Any]) -> None:
    checks = report.setdefault("checks", {})
    checks["microphoneEnableWriteAfterTap"] = has_tap_driven_right_mic_write(
        report, "enable"
    )
    checks["microphoneDisableWriteAfterTap"] = has_tap_driven_right_mic_write(
        report, "disable"
    )


def evidence_happened_after(later: dict[str, Any], earlier: dict[str, Any]) -> bool:
    later_order = later.get("order")
    earlier_order = earlier.get("order")
    if isinstance(later_order, int) and isinstance(earlier_order, int):
        return later_order > earlier_order
    try:
        return str(later.get("at", "")) >= str(earlier.get("at", ""))
    except Exception:
        return False


def next_evidence_order(report: dict[str, Any]) -> int:
    report["evidenceOrder"] = int(report.get("evidenceOrder") or 0) + 1
    return report["evidenceOrder"]


def whole_headset_connected(report: dict[str, Any]) -> bool:
    lenses = report.get("lenses") or {}
    status = report.get("status") or {}
    connected_lenses = status.get("connectedLenses") or {}
    return bool(
        status.get("connected")
        and (lenses.get("left") or {}).get("connected")
        and (lenses.get("right") or {}).get("connected")
        and (connected_lenses.get("left") or {}).get("connected")
        and (connected_lenses.get("right") or {}).get("connected")
    )


def scan_diagnosis(report: dict[str, Any], found: dict[str, tuple[str, Any]] | None = None) -> str:
    found = found or {}
    if "left" in found and "right" in found:
        return "whole_headset_seen"
    if "left" in found:
        return "right_lens_missing"
    if "right" in found:
        return "left_lens_missing"
    discovered = report.get("discoveredDevices") or []
    if not discovered:
        return "no_ble_devices"
    if any(device.get("matchesG1") for device in discovered):
        return "g1_candidates_seen"
    return "ble_seen_no_g1_candidates"


def any_lens_connected(report: dict[str, Any]) -> bool:
    lenses = report.get("lenses") or {}
    status = report.get("status") or {}
    connected_lenses = status.get("connectedLenses") or {}
    return bool(
        (lenses.get("left") or {}).get("connected")
        or (lenses.get("right") or {}).get("connected")
        or (connected_lenses.get("left") or {}).get("connected")
        or (connected_lenses.get("right") or {}).get("connected")
    )


def physical_blocker(report: dict[str, Any]) -> str | None:
    status = report.get("status") or {}
    headset_state = report.get("headsetState") or {}
    physical = headset_state.get("physical")
    battery = headset_state.get("battery")
    if status and not status.get("available", True):
        return "transport_unavailable"
    if status.get("available", False) and not any_lens_connected(report):
        return "headset_not_found"
    if not status.get("connected"):
        return "disconnected"
    if not whole_headset_connected(report):
        return "partial_headset"
    if is_cradle_or_charging_state(physical, battery):
        return "in_charging_base"
    return None if physical == "wearing" else "wearing_state_missing"


def setup_hint_for_blocker(blocker: str | None, report: dict[str, Any]) -> str | None:
    if blocker == "transport_unavailable":
        return (
            "The hardware transport is unavailable before headset discovery. Use the "
            "Bleak/CoreBluetooth smoke on macOS, or install/rebuild the Noble native "
            "BLE binding for this runtime."
        )
    if blocker == "disconnected":
        return "Connect both lenses as one headset before running hardware validation."
    if blocker == "headset_not_found":
        return (
            "No G1 lenses were found. Remove both lenses from the charging base, "
            "keep them near this device, and rerun hardware pairing."
        )
    if blocker == "partial_headset":
        return "Reconnect the whole headset so both left and right lenses are present."
    if blocker is None:
        return None
    return setup_hint(report.get("headsetState") or {})


def setup_hint(headset_state: dict[str, str | None]) -> str | None:
    physical = headset_state.get("physical")
    battery = headset_state.get("battery")
    if physical == "wearing":
        return None
    state_text = " / ".join(item for item in (physical, battery) if item) or "no wearing state observed"
    if physical in {"cradle_open", "cradle_closed", "charged_in_cradle"} or battery in {
        "glasses_fully_charged",
        "cradle_charging_cable_changed",
        "cradle_fully_charged",
    }:
        return (
            f"Glasses are reporting {state_text}; remove them from the charging base "
            "and wear them before tap or microphone validation."
        )
    return f"Tap and microphone validation requires wearing state; current state is {state_text}."


def is_cradle_or_charging_state(physical: str | None, battery: str | None) -> bool:
    return physical in {"cradle_open", "cradle_closed", "charged_in_cradle"} or battery in {
        "glasses_fully_charged",
        "cradle_charging_cable_changed",
        "cradle_fully_charged",
    }


def inspect_macos_bluetooth() -> dict[str, Any] | None:
    try:
        result = subprocess.run(
            ["system_profiler", "SPBluetoothDataType"],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception:
        return None
    return parse_system_profiler_bluetooth(result.stdout)


def parse_system_profiler_bluetooth(source: str) -> dict[str, Any]:
    lines = source.splitlines()
    adapter = {
        "available": True,
        "state": value_after(lines, "State:"),
        "discoverable": value_after(lines, "Discoverable:"),
        "chipset": value_after(lines, "Chipset:"),
        "address": value_after(lines, "Address:"),
    }
    paired_g1_devices: list[dict[str, Any]] = []
    section: str | None = None
    for raw_line in lines:
        line = raw_line.strip()
        if line == "Connected:":
            section = "connected"
            continue
        if line == "Not Connected:":
            section = "not_connected"
            continue
        if not line.endswith(":"):
            continue
        name = line[:-1]
        marker = "_L_" if "_L_" in name else "_R_" if "_R_" in name else None
        if not marker or not name.lower().startswith("even g1"):
            continue
        paired_g1_devices.append(
            {
                "name": name,
                "side": "left" if marker == "_L_" else "right",
                "connected": section == "connected",
                "section": section,
            }
        )
    return {"adapter": adapter, "pairedG1Devices": paired_g1_devices}


def value_after(lines: list[str], prefix: str) -> str | None:
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped[len(prefix) :].strip()
    return None


def encode_display_text(text: str) -> list[bytes]:
    lines = []
    for paragraph in text.splitlines() or [text]:
        lines.extend(textwrap.wrap(paragraph, width=40) or [""])
    lines = (lines + [""] * 5)[:5]
    page_text = "\n".join(lines).encode()
    packet = bytearray(9 + len(page_text))
    packet[:9] = bytes([0x4E, 0x00, 0x01, 0x00, 0x40, 0x00, 0x00, 0x01, 0x01])
    packet[9:] = page_text
    return [bytes(packet)]


async def main() -> int:
    scan_timeout_ms = int(os.environ.get("SMARTGLASSES_SCAN_TIMEOUT_MS", "20000"))
    hold_ms = int(os.environ.get("SMARTGLASSES_HOLD_MS", "60000"))
    report_path = os.environ.get("SMARTGLASSES_REPORT_PATH")
    init_mode = os.environ.get("SMARTGLASSES_INIT_MODE", "official").strip().lower()
    if init_mode not in ("official", "android-f4", "lens-specific"):
        raise ValueError("SMARTGLASSES_INIT_MODE must be official, android-f4, or lens-specific")
    smoke = G1BleakSmoke(scan_timeout_ms, hold_ms, report_path, init_mode)
    try:
        await smoke.scan()
        await smoke.connect()
        await smoke.initialize()
        await smoke.wait_for_wearing()
        await smoke.run_direct_mic_diagnostic()
        await smoke.validate()
        smoke.log("pass", {"checks": smoke.report["checks"], "status": smoke.report["status"]})
        return 0
    except Exception as error:  # noqa: BLE001
        smoke.report["error"] = str(error)
        smoke.finish_status()
        smoke.log("failed", {"error": str(error), "checks": smoke.report["checks"]})
        return 1
    finally:
        await smoke.write_report()
        await smoke.disconnect()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
