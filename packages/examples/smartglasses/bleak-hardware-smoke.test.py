#!/usr/bin/env python3
"""Unit checks for the Bleak hardware smoke parser.

The full Bleak smoke needs physical glasses. These checks keep the local parser
aligned with the TypeScript protocol parser without opening Bluetooth.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any


def load_smoke_module() -> Any:
    path = Path(__file__).with_name("bleak-hardware-smoke.py")
    spec = importlib.util.spec_from_file_location("bleak_hardware_smoke", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def assert_event(
    module: Any,
    payload: bytes,
    *,
    event_type: str,
    label: str,
    **expected: Any,
) -> None:
    event = module.parse_event("left", payload)
    assert event["type"] == event_type, event
    assert event["label"] == label, event
    for key, value in expected.items():
        assert event.get(key) == value, event


def main() -> int:
    module = load_smoke_module()

    assert_event(module, bytes([0x4D, 0x01]), event_type="init", label="init", code=1)
    assert_event(
        module,
        bytes([0xF4, 0x01]),
        event_type="init",
        label="right_init",
        code=1,
    )
    assert_event(
        module,
        bytes([0x4E]),
        event_type="display-result",
        label="display_result_ack",
    )
    assert_event(
        module,
        bytes([0x01, 0x0A, 0x01]),
        event_type="settings-response",
        label="brightness",
        code=0x0A,
    )
    assert_event(
        module,
        bytes([0x0B, 0x14, 0x01]),
        event_type="settings-response",
        label="head-up-angle",
        code=0x14,
    )
    assert_event(
        module,
        bytes([0x27, 0x01]),
        event_type="settings-response",
        label="wear-detection",
        code=0x01,
    )
    assert_event(
        module,
        bytes([0x0E, 0xC9, 0x01]),
        event_type="mic-response",
        label="mic_enabled",
        micEnabled=True,
        micRequested=True,
        responseOk=True,
    )
    assert_event(
        module,
        bytes([0x0E, 0xC9, 0x00]),
        event_type="mic-response",
        label="mic_disabled",
        micEnabled=False,
        micRequested=False,
        responseOk=True,
    )
    assert_event(
        module,
        bytes([0x03, 0xC9]),
        event_type="response",
        label="response",
        code=0xC9,
    )
    assert_event(
        module,
        bytes([0xF1]),
        event_type="mic-data",
        label="mic_data",
        sequence=None,
    )
    assert_event(module, b"", event_type="unknown", label="empty")

    report = module.make_report(10, 20, "official")
    assert report["scanDiagnosis"] == "not_scanned"
    assert module.scan_diagnosis(report) == "no_ble_devices"
    report["discoveredDevices"] = [{"name": "Keyboard", "matchesG1": False}]
    assert module.scan_diagnosis(report) == "ble_seen_no_g1_candidates"
    report["discoveredDevices"].append(
        {"name": "Even G1_51_R_TEST", "matchesG1": True}
    )
    assert module.scan_diagnosis(report) == "g1_candidates_seen"
    assert (
        module.scan_diagnosis(
            report, {"right": ("Even G1_51_R_TEST", object())}
        )
        == "left_lens_missing"
    )
    assert (
        module.scan_diagnosis(report, {"left": ("Even G1_51_L_TEST", object())})
        == "right_lens_missing"
    )
    assert (
        module.scan_diagnosis(
            report,
            {
                "left": ("Even G1_51_L_TEST", object()),
                "right": ("Even G1_51_R_TEST", object()),
            },
        )
        == "whole_headset_seen"
    )

    bluetooth = module.parse_system_profiler_bluetooth(
        """
Bluetooth:
  State: On
  Discoverable: Off
  Chipset: BCM_4387
  Address: 00:11:22:33:44:55
  Connected:
    Even G1_51_L_TEST:
  Not Connected:
    Even G1_51_R_TEST:
"""
    )
    assert bluetooth["adapter"]["state"] == "On", bluetooth
    assert bluetooth["adapter"]["address"] == "00:11:22:33:44:55", bluetooth
    assert bluetooth["pairedG1Devices"] == [
        {
            "name": "Even G1_51_L_TEST",
            "side": "left",
            "connected": True,
            "section": "connected",
        },
        {
            "name": "Even G1_51_R_TEST",
            "side": "right",
            "connected": False,
            "section": "not_connected",
        },
    ], bluetooth

    failures = module.missing_complete_hardware_evidence(report)
    for expected in (
        "missingLeftLensConnection",
        "missingRightLensConnection",
        "missingMicEnableWrite",
        "missingMicDisableWrite",
        "missingMicEnableWriteAfterTap",
        "missingMicDisableWriteAfterTap",
        "missingRightLensAudioChunk",
        "wearingStateNotObserved",
    ):
        assert expected in failures, failures

    report["writes"].append(
        {
            "at": "2026-05-20T00:00:00Z",
            "order": module.next_evidence_order(report),
            "side": "right",
            "command": "open-mic",
            "bytes": 2,
            "hex": "0e01",
        }
    )
    report["events"].append(
        {
            "at": "2026-05-20T00:00:01Z",
            "order": module.next_evidence_order(report),
            "side": "left",
            "type": "state",
            "label": "single_tap",
        }
    )
    module.update_tap_driven_mic_write_checks(report)
    assert report["checks"]["microphoneEnableWriteAfterTap"] is False
    assert "missingMicEnableWriteAfterTap" in module.missing_complete_hardware_evidence(report)

    report["writes"].append(
        {
            "at": "2026-05-20T00:00:02Z",
            "order": module.next_evidence_order(report),
            "side": "right",
            "command": "open-mic",
            "bytes": 2,
            "hex": "0e01",
        }
    )
    module.update_tap_driven_mic_write_checks(report)
    assert report["checks"]["microphoneEnableWriteAfterTap"] is True
    assert "missingMicEnableWriteAfterTap" not in module.missing_complete_hardware_evidence(report)

    print("bleak hardware smoke parser checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
