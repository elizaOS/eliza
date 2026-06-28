#!/usr/bin/env python3
"""Generate audio, speaker, microphone, haptic, and acoustic closure checks."""

from __future__ import annotations

import math
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
PARAMS = ROOT / "mechanical/e1-phone/cad/e1_phone_params.yaml"

# Dry-air acoustic constants at ~20 C used for the planning Helmholtz / sealed-box
# model. These are textbook values, not measured cavity properties.
SPEED_OF_SOUND_M_S = 343.0
AIR_DENSITY_KG_M3 = 1.204


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def helmholtz_frequency_hz(
    *, port_area_mm2: float, port_length_mm: float, back_volume_mm3: float
) -> float:
    """Planning Helmholtz resonance for a vented back chamber.

    f = (c / 2 pi) * sqrt(A / (V * L_eff)). The port is end-corrected by
    0.85 * radius on the chamber side (single unflanged-class correction kept
    conservative for a phone grille). All inputs are CAD-estimate geometry, not
    a measured cavity, so the result is a planning target only.
    """
    area_m2 = port_area_mm2 * 1e-6
    volume_m3 = back_volume_mm3 * 1e-9
    radius_m = math.sqrt(area_m2 / math.pi)
    effective_length_m = port_length_mm * 1e-3 + 0.85 * radius_m
    return (SPEED_OF_SOUND_M_S / (2.0 * math.pi)) * math.sqrt(
        area_m2 / (volume_m3 * effective_length_m)
    )


def envelope_volume_mm3(envelope_mm: list[float]) -> float:
    return float(envelope_mm[0] * envelope_mm[1] * envelope_mm[2])


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


def build_acoustic_model(params: dict[str, Any], envelope_mm: list[float]) -> dict[str, Any]:
    """Planning-class enclosure acoustics from CAD component envelopes.

    Computes a sealed-box back-volume budget for the bottom loudspeaker and a
    Helmholtz target for the vented grille, plus an earpiece front-cavity and
    microphone sound-tunnel plan. Geometry comes from the CAD parameter file;
    nothing here is a measured SPL/SNR or a Thiele-Small fit, so the model is a
    target that the speaker-box drawing and acoustic measurement must confirm.
    """
    components = params["components"]
    speaker = components["speaker_bottom"]
    earpiece = components["earpiece"]
    mic_bottom = components["microphone_bottom"]
    mic_top = components["microphone_top"]
    haptic = components["haptic"]
    wall_mm = params["device"]["wall_thickness_mm"]
    device_thickness_mm = envelope_mm[2]

    speaker_module_volume_mm3 = envelope_volume_mm3(speaker["envelope_mm"])
    # Planning rear chamber: the 1115 module is a sealed-back micro speaker; the
    # additional molded rear cavity sets low-frequency roll-off. A 0.7-1.0 cc
    # back volume is the commodity target for an 11 x 15 mm module in a slim
    # phone; pick 0.8 cc and check it against available depth.
    target_back_volume_cc = 0.8
    target_back_volume_mm3 = target_back_volume_cc * 1000.0
    # Vented grille planning geometry (must be confirmed by the speaker-box
    # drawing). A bottom-firing slot of 8 x 0.8 mm through a 1.0 mm wall is a
    # representative phone loudspeaker port.
    port_width_mm = 8.0
    port_height_mm = 0.8
    port_area_mm2 = port_width_mm * port_height_mm
    port_length_mm = wall_mm
    helmholtz_hz = helmholtz_frequency_hz(
        port_area_mm2=port_area_mm2,
        port_length_mm=port_length_mm,
        back_volume_mm3=target_back_volume_mm3,
    )

    # Earpiece (1206 receiver) front cavity behind the cover-glass slot. The
    # front leak/cavity height between the receiver face and the glass slot sets
    # band-pass behavior; 0.3 mm is a typical bonded-slot air gap.
    earpiece_slot_height_mm = 0.3
    earpiece_front_cavity_mm3 = (
        earpiece["envelope_mm"][0] * earpiece["envelope_mm"][1] * earpiece_slot_height_mm
    )

    # Microphone sound tunnel: a >= 0.8 mm diameter molded port through the
    # 1.0 mm wall, with a hydrophobic mesh, is the planning baseline for the
    # two MEMS mics.
    mic_port_diameter_mm = 0.8
    mic_port_area_mm2 = math.pi * (mic_port_diameter_mm / 2.0) ** 2
    mic_helmholtz_hz = helmholtz_frequency_hz(
        port_area_mm2=mic_port_area_mm2,
        port_length_mm=wall_mm,
        # MEMS front-volume class for a 3.5 x 2.65 x 1.0 mm bottom-port part is
        # ~1-2 mm^3; use the conservative low end for the tuned-port estimate.
        back_volume_mm3=1.5,
    )

    return {
        "model_class": "sealed_box_and_helmholtz_planning_targets_not_measured",
        "constants": {
            "speed_of_sound_m_s": SPEED_OF_SOUND_M_S,
            "air_density_kg_m3": AIR_DENSITY_KG_M3,
            "reference_temperature_c": 20,
        },
        "bottom_loudspeaker": {
            "module": speaker["candidate"],
            "module_envelope_mm": speaker["envelope_mm"],
            "module_displaced_volume_mm3": round(speaker_module_volume_mm3, 1),
            "target_rear_back_volume_cc": target_back_volume_cc,
            "target_rear_back_volume_mm3": target_back_volume_mm3,
            "rear_chamber_depth_budget_mm": round(
                device_thickness_mm - speaker["envelope_mm"][2], 2
            ),
            "vented_grille_port_mm": {
                "width": port_width_mm,
                "height": port_height_mm,
                "wall_length": port_length_mm,
                "area_mm2": round(port_area_mm2, 3),
            },
            "helmholtz_port_resonance_hz": round(helmholtz_hz, 1),
            "interpretation": (
                "Sealed rear chamber sets the box stiffness; the bottom-firing "
                "vented grille adds a port resonance near "
                f"{round(helmholtz_hz)} Hz. The 1115 module is "
                f"{speaker['envelope_mm'][2]} mm tall against a "
                f"{round(device_thickness_mm - speaker['envelope_mm'][2], 2)} mm "
                "depth budget, so the back chamber must be carved laterally, not "
                "stacked, in the flush-back enclosure."
            ),
        },
        "earpiece_receiver": {
            "module": earpiece["candidate"],
            "module_envelope_mm": earpiece["envelope_mm"],
            "front_slot_air_gap_mm": earpiece_slot_height_mm,
            "front_cavity_volume_mm3": round(earpiece_front_cavity_mm3, 2),
            "interpretation": (
                "1206 receiver behind a bonded cover-glass slot. The thin front "
                "cavity and slot leak set the receiver band-pass; the acoustic "
                "path must stay clear of the top antenna feed keepout."
            ),
        },
        "microphones": {
            "count": int(mic_bottom.get("count", 1)) + int(mic_top.get("count", 1)),
            "bottom_port": {
                "part_envelope_mm": mic_bottom["envelope_mm"],
                "port_diameter_mm": mic_port_diameter_mm,
                "port_area_mm2": round(mic_port_area_mm2, 4),
                "wall_length_mm": wall_mm,
                "front_volume_estimate_mm3": 1.5,
                # The mic port is an acoustic resistance, not a tuned vent. The
                # planning goal is that its port resonance stays well above the
                # 20 kHz audio band so it does not color the passband.
                "port_resonance_hz": round(mic_helmholtz_hz, 1),
                "port_resonance_above_audio_band": mic_helmholtz_hz > 20000.0,
            },
            "top_noise_cancel": {
                "part_envelope_mm": mic_top["envelope_mm"],
                "role": "noise_cancel_reference_far_from_bottom_speaker_port",
            },
            "hydrophobic_mesh_required": True,
            "interpretation": (
                "Two MEMS ports through the 1.0 mm wall, each with a hydrophobic "
                "dust/water mesh, separated so the noise-cancel reference does "
                "not couple to the loudspeaker port."
            ),
        },
        "haptic_lra": {
            "part": haptic["candidate"],
            "envelope_mm": haptic["envelope_mm"],
            "interpretation": (
                "X-axis LRA mass pocket must clear screw bosses and tall parts; "
                "resonance and enclosure rattle are a measurement residual."
            ),
        },
        "leakage_and_sealing_paths": [
            "loudspeaker rear chamber must be gasket-sealed against the bottom island and back wall",
            "bottom-firing grille slot needs a hydrophobic mesh and drain path (IP54 design intent)",
            "earpiece front slot gasket compression sets the front leak and must seal to the cover glass",
            "each microphone tunnel needs a compressed gasket boot from the mesh to the MEMS port",
            "USB-C shell drip-break and drain shelf must not vent into the microphone tunnels",
        ],
        "physical_residuals": [
            "speaker-box drawing must confirm the 0.8 cc rear volume and slot port geometry",
            "Thiele-Small parameters and measured SPL/excursion replace the sealed-box target",
            "measured microphone SNR and wind-noise replace the port-geometry estimate",
            "gasket compression set and acoustic-leak test confirm the sealing paths",
        ],
    }


def main() -> int:
    audio = load_yaml(AUDIO)
    placement = load_yaml(PLACEMENT)
    netlist = load_yaml(NETLIST)
    routing = load_yaml(ROUTING)
    enclosure = load_yaml(ENCLOSURE)
    overlay = load_yaml(OVERLAY)
    freeze = load_yaml(FREEZE)
    params = load_yaml(PARAMS)

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

    device_envelope = enclosure["coordinate_system"]["device_envelope"]
    envelope_mm = [
        device_envelope["width"],
        device_envelope["height"],
        device_envelope["max_thickness"],
    ]
    acoustic_model = build_acoustic_model(params, envelope_mm)

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
            "mechanical/e1-phone/cad/e1_phone_params.yaml",
        ],
        "device_envelope_mm": device_envelope,
        "acoustic_planning_model": acoustic_model,
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
