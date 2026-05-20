#!/usr/bin/env python3
"""Generate audio, speaker, microphone, haptic, and acoustic closure checks."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/audio-acoustic-closure.yaml"
AUDIO = ROOT / "package/audio/v0-codec.yaml"
PLACEMENT = ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml"
NETLIST = ROOT / "board/kicad/e1-phone/block-netlist.yaml"
ROUTING = ROOT / "board/kicad/e1-phone/routing-constraints.yaml"
ENCLOSURE = ROOT / "docs/board/e1-phone-enclosure-interface.yaml"
OVERLAY = ROOT / "board/kicad/e1-phone/mechanical-overlay.yaml"
FREEZE = ROOT / "board/kicad/e1-phone/pinout-footprint-freeze.yaml"


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def flatten_block_nets(netlist: dict[str, Any]) -> set[str]:
    nets: set[str] = set()
    for block in netlist["blocks"]:
        for group in block["nets"].values():
            if isinstance(group, list):
                nets.update(str(net) for net in group)
    return nets


def placement_by_refdes(placement: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["refdes_group"]: item for item in placement["placements"]}


def audio_host_nets(audio: dict[str, Any]) -> list[str]:
    nets: list[str] = []
    interfaces = audio["host_interfaces"]
    for group in ["i2s", "pdm", "i2c_control", "interrupts"]:
        for signal in interfaces[group]["signals"]:
            nets.append(signal["contract"])
    return sorted(dict.fromkeys(nets))


def main() -> int:
    audio = load_yaml(AUDIO)
    placement = load_yaml(PLACEMENT)
    netlist = load_yaml(NETLIST)
    routing = load_yaml(ROUTING)
    enclosure = load_yaml(ENCLOSURE)
    overlay = load_yaml(OVERLAY)
    freeze = load_yaml(FREEZE)

    all_nets = flatten_block_nets(netlist)
    placements = placement_by_refdes(placement)
    audio_placement = placements["U_AUDIO_SPK_MIC"]
    audio_freeze = next(
        item
        for item in freeze["freeze_records"]
        if item["name"] == "audio_speaker_microphone_flexes"
    )
    host_nets = audio_host_nets(audio)
    required_nets = sorted(
        dict.fromkeys(
            host_nets
            + [
                "IO_1V8",
                "VDD_AUDIO_3V3",
                "VDD_AMP_3V3",
                "SYS",
                "GND",
                "SPK_P",
                "SPK_N",
                "HAPTIC_OUT",
            ]
        )
    )
    missing_required_nets = [net for net in required_nets if net not in all_nets]

    buses = {bus["name"]: bus for bus in routing["single_ended_buses"]}
    missing_routing_buses = [
        name for name in ["AUDIO_I2S_PDM", "AUDIO_I2C_IRQ"] if name not in buses
    ]
    routing_missing_nets: dict[str, list[str]] = {}
    for name in ["AUDIO_I2S_PDM", "AUDIO_I2C_IRQ"]:
        if name in buses:
            missing = [net for net in buses[name]["nets"] if net not in all_nets]
            if missing:
                routing_missing_nets[name] = missing

    edge_constraints = enclosure["edge_interfaces"]
    bottom_constraints = edge_constraints["bottom_edge"]["constraints"]
    top_constraints = edge_constraints["top_edge"]["constraints"]
    acoustic_constraints_found = {
        "bottom_speaker_mic_gasket": any(
            "loudspeaker_chamber_and_microphone_ports_need_acoustic_gasket_stack" in item
            for item in bottom_constraints
        ),
        "top_earpiece_rf_separation": any(
            "earpiece_acoustic_path_must_not_cross_rf_feed" in item for item in top_constraints
        ),
    }
    keepouts = {item["id"]: item for item in overlay["keepouts"]}
    routing_keepouts = routing["mechanical_keepouts"]
    required_mechanical_keepouts = {
        "front_camera_earpiece_keepout": "overlay",
        "haptic_lra_keepout": "overlay",
        "loudspeaker_mic_ports": "routing",
    }
    missing_mechanical_keepouts: list[str] = []
    for name, source in required_mechanical_keepouts.items():
        if source == "overlay" and name not in keepouts:
            missing_mechanical_keepouts.append(name)
        if source == "routing" and name not in routing_keepouts:
            missing_mechanical_keepouts.append(name)

    supplier_evidence_names = [item["name"] for item in audio_freeze["supplier_evidence_required"]]
    required_supplier_evidence = [
        "speaker_box_drawing",
        "microphone_port_drawing",
        "codec_amp_reference_schematic",
        "haptic_lra_part_and_driver_choice",
        "acoustic_leakage_review",
    ]
    missing_supplier_evidence_records = [
        item for item in required_supplier_evidence if item not in supplier_evidence_names
    ]

    out = {
        "schema": "eliza.e1_phone_audio_acoustic_closure.v1",
        "status": "planning_audio_acoustic_cross_checked_not_measured",
        "date": "2026-05-20",
        "claim_boundary": (
            "Audio/acoustic planning closure only. This is not an acoustic simulation, "
            "speaker-box drawing, microphone gasket drawing, codec schematic, ALSA "
            "probe transcript, Android Audio HAL evidence, or measured SPL/SNR result."
        ),
        "source_artifacts": [
            "package/audio/v0-codec.yaml",
            "board/kicad/e1-phone/placement-interface-matrix.yaml",
            "board/kicad/e1-phone/block-netlist.yaml",
            "board/kicad/e1-phone/routing-constraints.yaml",
            "docs/board/e1-phone-enclosure-interface.yaml",
            "board/kicad/e1-phone/mechanical-overlay.yaml",
            "board/kicad/e1-phone/pinout-footprint-freeze.yaml",
        ],
        "audio_components": {
            "codec": audio["codec"]["part"],
            "smart_amp": audio["smart_amp"]["part"],
            "microphone_count": audio["voice_pickup"]["mics"][0]["count"],
            "microphone_part": audio["voice_pickup"]["mics"][0]["part"],
            "placement_region_mm": audio_placement["region_mm"],
        },
        "required_audio_nets": required_nets,
        "missing_required_nets": missing_required_nets,
        "routing_buses_checked": {
            name: buses[name] for name in ["AUDIO_I2S_PDM", "AUDIO_I2C_IRQ"] if name in buses
        },
        "missing_routing_buses": missing_routing_buses,
        "routing_missing_nets": routing_missing_nets,
        "acoustic_constraints_found": acoustic_constraints_found,
        "missing_mechanical_keepouts": missing_mechanical_keepouts,
        "supplier_freeze_record": audio_freeze["name"],
        "missing_supplier_evidence_records": missing_supplier_evidence_records,
        "speaker_microphone_mechanical_requirements": [
            "bottom loudspeaker chamber volume, port path, and gasket compression defined in ME CAD",
            "at least two microphone acoustic ports with dust mesh and gasket stack",
            "top earpiece acoustic path separated from RF feed/antenna keepout",
            "haptic LRA pocket clear of screw bosses and tall components",
            "USB-C shell/grounding kept away from microphone port noise path",
        ],
        "required_measurements_before_release": [
            "ALSA codec and smart-amp probe transcript",
            "Android Audio HAL service and dumpsys media.audio_flinger transcript",
            "speaker SPL, impedance, excursion, and thermal protection measurement",
            "microphone SNR, sensitivity, wind/noise leakage, and wake-word PDM integrity measurement",
            "haptic resonance and enclosure rattle measurement",
            "acoustic leak and dust/water ingress review for speaker, mic, and earpiece openings",
        ],
        "release_blockers": [
            "speaker-box and earpiece acoustic chamber CAD",
            "microphone port, dust mesh, and gasket drawings",
            "codec, smart amp, PDM microphone, and haptic driver schematic capture",
            "real footprints and routed audio nets away from USB/RF aggressors",
            "ALSA/Android Audio HAL bring-up logs and acoustic measurements",
        ],
        "forbidden_claims": [
            "audio_ready",
            "speaker_ready",
            "microphone_ready",
            "haptics_ready",
            "audio_hal_ready",
            "acoustic_enclosure_ready",
        ],
    }
    OUT.write_text(yaml.dump(out, Dumper=IndentedSafeDumper, sort_keys=False, width=100))
    print(f"generated {OUT}")
    print(
        f"status={out['status']} audio_nets={len(required_nets)} "
        f"missing={len(missing_required_nets)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
