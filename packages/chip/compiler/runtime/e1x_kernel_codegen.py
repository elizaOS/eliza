"""E1X real-graph kernel-dispatch code generation.

This module is the first checked code-generation layer above
``e1x_graph_mapper``. It turns a real quantized graph placement into concrete
RV64IM-compatible per-layer boot programs for the E1X PE core. The generated
program is a deterministic dispatch/control kernel: it materialises layer
metadata in registers, writes a layer-dispatch token to the PE's wavelet TX
MMIO register, then halts. The module also emits checked W4A8 scalar numerical
samples, a row/K-wave tensor schedule, and a deterministic architecture-level
color-pressure and cycle estimates derived from that schedule.

Claim boundary: this is not the full cycle-accurate tensor MAC backend. It does
not emit vectorized full-layer dot-product PE instruction streams, fabric
reduction/merge kernels, or a full-output numerical proof. It proves that the
compiler path emits concrete PE instruction streams tied to the real graph
placement and fabric colors, plus checked schedule and scalar W4A8 semantics.
"""

from __future__ import annotations

from hashlib import blake2s, sha256
from math import ceil

from compiler.runtime.e1x_wafer_model import E1XConfig, artifact_sha256, json_dumps_canonical

KERNEL_PLAN_SCHEMA = "eliza.e1x.kernel_dispatch_plan.v1"
MICROKERNEL_PROOF_SCHEMA = "eliza.e1x.w4a8_microkernel_proof.v1"
TENSOR_SCHEDULE_SCHEMA = "eliza.e1x.tensor_tile_schedule.v1"
COLOR_PRESSURE_SCHEMA = "eliza.e1x.fabric_color_pressure.v1"
COLOR_TIMING_SCHEMA = "eliza.e1x.fabric_color_timing.v1"
SCHEDULE_EXECUTION_SCHEMA = "eliza.e1x.schedule_execution_estimate.v1"

# e1x_pe_core.sv maps WAVELET_TX_DATA at SRAM_BYTES + 0x10.
WAVELET_TX_DATA_OFFSET = 0x10

RV_X0 = 0
RV_X1 = 1
RV_X2 = 2
RV_X3 = 3
RV_X4 = 4
RV_X5 = 5
RV_X6 = 6


def _check_reg(reg: int) -> None:
    if not 0 <= reg < 32:
        raise ValueError(f"invalid RISC-V register x{reg}")


def _signed_imm12(value: int) -> int:
    if not -2048 <= value <= 2047:
        raise ValueError(f"immediate {value} does not fit signed 12-bit field")
    return value & 0xFFF


def rv_addi(rd: int, rs1: int, imm: int) -> int:
    _check_reg(rd)
    _check_reg(rs1)
    return (_signed_imm12(imm) << 20) | (rs1 << 15) | (rd << 7) | 0x13


def rv_lui(rd: int, imm20: int) -> int:
    _check_reg(rd)
    if not 0 <= imm20 < (1 << 20):
        raise ValueError(f"LUI immediate {imm20} does not fit 20 bits")
    return (imm20 << 12) | (rd << 7) | 0x37


def rv_sw(rs2: int, rs1: int, imm: int) -> int:
    _check_reg(rs2)
    _check_reg(rs1)
    enc = _signed_imm12(imm)
    return (
        ((enc >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (0b010 << 12) | ((enc & 0x1F) << 7) | 0x23
    )


def rv_ecall() -> int:
    return 0x00000073


def rv_li(rd: int, value: int) -> list[int]:
    """Load a signed 32-bit constant using LUI/ADDI when needed."""
    _check_reg(rd)
    if not -(1 << 31) <= value < (1 << 32):
        raise ValueError(f"constant 0x{value:x} is outside the supported 32-bit range")
    value &= 0xFFFF_FFFF
    signed = value if value < (1 << 31) else value - (1 << 32)
    if -2048 <= signed <= 2047:
        return [rv_addi(rd, RV_X0, signed)]
    hi = (signed + 0x800) >> 12
    lo = signed - (hi << 12)
    return [rv_lui(rd, hi & 0xFFFFF), rv_addi(rd, rd, lo)]


def _hex_words(words: list[int]) -> list[str]:
    return [f"{word & 0xFFFF_FFFF:08x}" for word in words]


def _stable_u32(parts: tuple[object, ...]) -> int:
    return int.from_bytes(
        blake2s("|".join(str(part) for part in parts).encode(), digest_size=4).digest(),
        "big",
    )


def _s8_from_seed(parts: tuple[object, ...]) -> int:
    return (_stable_u32(parts) & 0xFF) - 128


def _s4_from_seed(parts: tuple[object, ...]) -> int:
    return (_stable_u32(parts) & 0xF) - 8


def pack_signed_w4(values: list[int]) -> list[int]:
    """Pack signed int4 values into little-lane 32-bit words."""
    words: list[int] = []
    for base in range(0, len(values), 8):
        word = 0
        for lane, value in enumerate(values[base : base + 8]):
            if not -8 <= value <= 7:
                raise ValueError(f"W4 value {value} out of signed int4 range")
            word |= (value & 0xF) << (lane * 4)
        words.append(word)
    return words


def unpack_signed_w4_word(word: int) -> list[int]:
    values = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def layer_dispatch_payload(layer: dict) -> int:
    """Pack a deterministic 32-bit wavelet dispatch token for one layer."""
    layer_index = int(layer["index"]) & 0x3FF
    color = int(layer["routing_color"]) & 0x1F
    core_count = int(layer["assigned_cores"]) & 0x1FFFF
    return (layer_index << 22) | (color << 17) | core_count


def layer_dispatch_program_words(config: E1XConfig, layer: dict) -> list[int]:
    """Emit a small RV64IM/Zicsr-compatible dispatch program for one layer."""
    wavelet_tx_addr = config.local_sram_kib_per_core * 1024 + WAVELET_TX_DATA_OFFSET
    words: list[int] = []
    words.extend(rv_li(RV_X1, int(layer["index"])))
    words.extend(rv_li(RV_X2, int(layer["core_index_start"])))
    words.extend(rv_li(RV_X3, int(layer["assigned_cores"])))
    words.extend(rv_li(RV_X4, int(layer["max_core_shard_bytes"])))
    words.extend(rv_li(RV_X5, wavelet_tx_addr))
    words.extend(rv_li(RV_X6, layer_dispatch_payload(layer)))
    words.append(rv_sw(RV_X6, RV_X5, 0))
    words.append(rv_ecall())
    return words


def build_kernel_dispatch_plan(
    placement: dict,
    config: E1XConfig,
    *,
    source_manifest: str,
    max_program_records: int | None = None,
) -> dict:
    """Build a deterministic kernel-dispatch plan from a graph placement."""
    if placement.get("schema") != "eliza.e1x.graph_mesh_placement.v1":
        raise ValueError(f"unsupported placement schema {placement.get('schema')!r}")
    layers = placement.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("placement has no layers")

    program_records = []
    total_instruction_words = 0
    limit = len(layers) if max_program_records is None else min(max_program_records, len(layers))
    for layer in layers:
        words = layer_dispatch_program_words(config, layer)
        total_instruction_words += len(words)
        if int(layer["index"]) < limit:
            program_records.append(
                {
                    "layer_index": int(layer["index"]),
                    "layer_name": str(layer["name"]),
                    "kind": str(layer["kind"]),
                    "routing_color": int(layer["routing_color"]),
                    "core_index_start": int(layer["core_index_start"]),
                    "assigned_cores": int(layer["assigned_cores"]),
                    "max_core_shard_bytes": int(layer["max_core_shard_bytes"]),
                    "dispatch_payload": layer_dispatch_payload(layer),
                    "instruction_word_count": len(words),
                    "boot_words_hex": _hex_words(words),
                    "program_sha256": sha256(
                        ("\n".join(_hex_words(words)) + "\n").encode()
                    ).hexdigest(),
                }
            )

    plan = {
        "schema": KERNEL_PLAN_SCHEMA,
        "claim_boundary": ("deterministic_rv64im_layer_dispatch_codegen_not_full_mac_scheduler"),
        "chip": config.name,
        "model": placement["model"],
        "source_manifest": source_manifest,
        "source_placement_sha256": placement["artifact_sha256"],
        "logical_rows": int(placement["logical_rows"]),
        "logical_cols": int(placement["logical_cols"]),
        "layer_count": int(placement["layer_count"]),
        "programmed_layer_count": len(layers),
        "emitted_program_record_count": len(program_records),
        "total_instruction_words": total_instruction_words,
        "instruction_word_bits": 32,
        "boot_image_format": "little_endian_32_bit_words_for_e1x_pe_core_local_sram",
        "wavelet_tx_data_addr": config.local_sram_kib_per_core * 1024 + WAVELET_TX_DATA_OFFSET,
        "program_records": program_records,
    }
    plan["artifact_sha256"] = artifact_sha256(plan)
    plan["canonical_sha256"] = sha256(json_dumps_canonical(plan).encode()).hexdigest()
    return plan


def _layer_microkernel_record(layer: dict, *, k_sample: int, output_rows: int) -> dict:
    layer_index = int(layer["index"])
    k = min(k_sample, int(layer["cols"]))
    rows = min(output_rows, int(layer["rows"]))
    activations = [_s8_from_seed(("act", layer_index, k_idx)) for k_idx in range(k)]
    row_records = []
    all_accumulators: list[int] = []
    for row in range(rows):
        weights = [_s4_from_seed(("w4", layer_index, row, k_idx)) for k_idx in range(k)]
        packed_words = pack_signed_w4(weights)
        unpacked = [value for word in packed_words for value in unpack_signed_w4_word(word)][:k]
        accumulator = sum(a * w for a, w in zip(activations, unpacked, strict=True))
        # Q8.8-style downshift for a deterministic bounded activation sample.
        requantized = max(-128, min(127, accumulator >> 7))
        all_accumulators.append(accumulator)
        row_records.append(
            {
                "output_row": row,
                "packed_w4_words_hex": _hex_words(packed_words),
                "accumulator": accumulator,
                "requantized_s8": requantized,
            }
        )
    checksum = 0
    for value in activations + all_accumulators:
        checksum = (((checksum << 5) | (checksum >> 27)) & 0xFFFF_FFFF) ^ (value & 0xFFFF_FFFF)
    return {
        "layer_index": layer_index,
        "layer_name": str(layer["name"]),
        "kind": str(layer["kind"]),
        "rows": int(layer["rows"]),
        "cols": int(layer["cols"]),
        "sample_k": k,
        "sample_output_rows": rows,
        "activation_s8": activations,
        "row_results": row_records,
        "checksum": checksum & 0xFFFF_FFFF,
    }


def build_w4a8_microkernel_proof(
    placement: dict,
    kernel_plan: dict,
    *,
    k_sample: int = 32,
    output_rows: int = 4,
    max_layer_records: int | None = None,
) -> dict:
    """Build a deterministic signed W4A8 dot-product proof for placed layers."""
    if kernel_plan.get("schema") != KERNEL_PLAN_SCHEMA:
        raise ValueError(f"unsupported kernel-plan schema {kernel_plan.get('schema')!r}")
    if kernel_plan.get("source_placement_sha256") != placement.get("artifact_sha256"):
        raise ValueError("kernel plan does not reference placement")
    layers = placement.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("placement has no layers")
    limit = len(layers) if max_layer_records is None else min(max_layer_records, len(layers))
    records = [
        _layer_microkernel_record(layer, k_sample=k_sample, output_rows=output_rows)
        for layer in layers[:limit]
    ]
    aggregate_checksum = 0
    total_macs = 0
    for record in records:
        aggregate_checksum = (
            ((aggregate_checksum << 7) | (aggregate_checksum >> 25)) & 0xFFFF_FFFF
        ) ^ int(record["checksum"])
        total_macs += int(record["sample_k"]) * int(record["sample_output_rows"])
    proof = {
        "schema": MICROKERNEL_PROOF_SCHEMA,
        "claim_boundary": (
            "deterministic_signed_w4a8_microkernel_numerical_proof_not_full_tensor_scheduler"
        ),
        "chip": kernel_plan["chip"],
        "model": kernel_plan["model"],
        "source_placement_sha256": placement["artifact_sha256"],
        "source_kernel_plan_sha256": kernel_plan["artifact_sha256"],
        "weight_format": "signed_int4_twos_complement_packed_8_lanes_per_u32",
        "activation_format": "signed_int8",
        "accumulator_format": "signed_int32",
        "requantization": "arithmetic_shift_right_7_saturate_s8",
        "layer_count": int(placement["layer_count"]),
        "proved_layer_record_count": len(records),
        "sample_k": k_sample,
        "sample_output_rows": output_rows,
        "sample_mac_count": total_macs,
        "aggregate_checksum": aggregate_checksum & 0xFFFF_FFFF,
        "records": records,
    }
    proof["artifact_sha256"] = artifact_sha256(proof)
    return proof


def _schedule_layer(
    layer: dict,
    *,
    usable_bytes_per_core: int,
    k_chunk: int,
    max_core_records: int,
) -> dict:
    rows = int(layer["rows"])
    cols = int(layer["cols"])
    weight_bits = int(layer["weight_bits"])
    assigned_cores = int(layer["assigned_cores"])
    rows_per_core = max(1, int(layer["rows_per_core"]))
    bytes_per_row = ceil(cols * weight_bits / 8)
    k_chunks = [
        {
            "k_start": start,
            "k_end_exclusive": min(cols, start + k_chunk),
            "activation_bytes": min(cols, start + k_chunk) - start,
        }
        for start in range(0, cols, k_chunk)
    ]
    core_records = []
    covered_rows = 0
    for ordinal in range(assigned_cores):
        row_start = ordinal * rows_per_core
        if row_start >= rows:
            break
        row_count = min(rows_per_core, rows - row_start)
        shard_bytes = row_count * bytes_per_row
        covered_rows += row_count
        if ordinal < max_core_records:
            core_records.append(
                {
                    "core_ordinal": ordinal,
                    "logical_core_index": int(layer["core_index_start"]) + ordinal,
                    "row_start": row_start,
                    "row_end_exclusive": row_start + row_count,
                    "row_count": row_count,
                    "weight_shard_bytes": shard_bytes,
                    "k_wave_count": len(k_chunks),
                }
            )
    return {
        "layer_index": int(layer["index"]),
        "layer_name": str(layer["name"]),
        "kind": str(layer["kind"]),
        "routing_color": int(layer["routing_color"]),
        "rows": rows,
        "cols": cols,
        "assigned_cores": assigned_cores,
        "rows_per_core": rows_per_core,
        "bytes_per_output_row": bytes_per_row,
        "row_coverage": covered_rows,
        "row_coverage_complete": covered_rows == rows,
        "k_chunk_elements": k_chunk,
        "k_wave_count": len(k_chunks),
        "total_core_wave_count": assigned_cores * len(k_chunks),
        "max_core_shard_bytes": int(layer["max_core_shard_bytes"]),
        "usable_bytes_per_core": usable_bytes_per_core,
        "fits_core_sram": int(layer["max_core_shard_bytes"]) <= usable_bytes_per_core,
        "sampled_core_schedules": core_records,
        "k_schedule": k_chunks[: min(4, len(k_chunks))],
    }


def build_tensor_tile_schedule(
    placement: dict,
    kernel_plan: dict,
    *,
    k_chunk: int = 256,
    max_core_records_per_layer: int = 3,
) -> dict:
    """Build a deterministic output-row x K-wave tensor schedule for every layer."""
    if kernel_plan.get("schema") != KERNEL_PLAN_SCHEMA:
        raise ValueError(f"unsupported kernel-plan schema {kernel_plan.get('schema')!r}")
    if kernel_plan.get("source_placement_sha256") != placement.get("artifact_sha256"):
        raise ValueError("kernel plan does not reference placement")
    if k_chunk <= 0:
        raise ValueError("k_chunk must be positive")
    layers = placement.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("placement has no layers")
    usable = int(placement["usable_bytes_per_core"])
    records = [
        _schedule_layer(
            layer,
            usable_bytes_per_core=usable,
            k_chunk=k_chunk,
            max_core_records=max_core_records_per_layer,
        )
        for layer in layers
    ]
    total_core_waves = sum(int(record["total_core_wave_count"]) for record in records)
    total_k_waves = sum(int(record["k_wave_count"]) for record in records)
    schedule = {
        "schema": TENSOR_SCHEDULE_SCHEMA,
        "claim_boundary": (
            "deterministic_output_row_and_k_wave_schedule_not_cycle_accurate_full_tensor_kernel"
        ),
        "chip": kernel_plan["chip"],
        "model": kernel_plan["model"],
        "source_placement_sha256": placement["artifact_sha256"],
        "source_kernel_plan_sha256": kernel_plan["artifact_sha256"],
        "weight_format": "signed_int4_packed_8_lanes_per_u32",
        "activation_format": "signed_int8",
        "accumulator_format": "signed_int32",
        "layer_count": int(placement["layer_count"]),
        "scheduled_layer_count": len(records),
        "k_chunk_elements": k_chunk,
        "total_k_wave_count": total_k_waves,
        "total_core_wave_count": total_core_waves,
        "all_rows_covered": all(bool(record["row_coverage_complete"]) for record in records),
        "all_shards_fit_sram": all(bool(record["fits_core_sram"]) for record in records),
        "layers": records,
    }
    schedule["artifact_sha256"] = artifact_sha256(schedule)
    return schedule


def build_fabric_color_pressure(schedule: dict, config: E1XConfig) -> dict:
    """Aggregate scheduled wavelet traffic by Cerebras-style routing color."""
    if schedule.get("schema") != TENSOR_SCHEDULE_SCHEMA:
        raise ValueError(f"unsupported schedule schema {schedule.get('schema')!r}")
    records = schedule.get("layers")
    if not isinstance(records, list) or not records:
        raise ValueError("schedule has no layers")
    payload_bytes = max(1, config.fabric_payload_bits // 8)
    by_color: dict[int, dict[str, int]] = {
        color: {
            "routing_color": color,
            "layer_count": 0,
            "k_wave_count": 0,
            "core_wave_count": 0,
            "activation_wavelets": 0,
            "reduction_wavelets": 0,
            "total_wavelets": 0,
        }
        for color in range(config.routing_colors)
    }
    color_layer_samples: dict[int, list[dict[str, int | str]]] = {
        color: [] for color in range(config.routing_colors)
    }
    for record in records:
        color = int(record["routing_color"])
        if color not in by_color:
            raise ValueError(f"routing color {color} outside 0..{config.routing_colors - 1}")
        assigned_cores = int(record["assigned_cores"])
        cols = int(record["cols"])
        rows = int(record["rows"])
        activation_wavelets = ceil(cols / payload_bytes) * assigned_cores
        reduction_wavelets = ceil(rows * 4 / payload_bytes)
        color_record = by_color[color]
        color_record["layer_count"] += 1
        color_record["k_wave_count"] += int(record["k_wave_count"])
        color_record["core_wave_count"] += int(record["total_core_wave_count"])
        color_record["activation_wavelets"] += activation_wavelets
        color_record["reduction_wavelets"] += reduction_wavelets
        color_record["total_wavelets"] += activation_wavelets + reduction_wavelets
        if len(color_layer_samples[color]) < 3:
            color_layer_samples[color].append(
                {
                    "layer_index": int(record["layer_index"]),
                    "layer_name": str(record["layer_name"]),
                    "activation_wavelets": activation_wavelets,
                    "reduction_wavelets": reduction_wavelets,
                    "total_wavelets": activation_wavelets + reduction_wavelets,
                }
            )
    color_records = [
        {**record, "sampled_layers": color_layer_samples[color]}
        for color, record in by_color.items()
    ]
    total_wavelets = sum(int(record["total_wavelets"]) for record in color_records)
    used = [record for record in color_records if int(record["layer_count"]) > 0]
    peak = max((int(record["total_wavelets"]) for record in color_records), default=0)
    pressure = {
        "schema": COLOR_PRESSURE_SCHEMA,
        "claim_boundary": (
            "deterministic_fabric_color_wavelet_pressure_not_cycle_accurate_noc_simulation"
        ),
        "chip": schedule["chip"],
        "model": schedule["model"],
        "source_placement_sha256": schedule["source_placement_sha256"],
        "source_kernel_plan_sha256": schedule["source_kernel_plan_sha256"],
        "source_tensor_schedule_sha256": schedule["artifact_sha256"],
        "fabric_payload_bits": config.fabric_payload_bits,
        "routing_color_capacity": config.routing_colors,
        "used_routing_color_count": len(used),
        "scheduled_layer_count": int(schedule["scheduled_layer_count"]),
        "total_k_wave_count": int(schedule["total_k_wave_count"]),
        "total_core_wave_count": int(schedule["total_core_wave_count"]),
        "total_activation_wavelets": sum(
            int(record["activation_wavelets"]) for record in color_records
        ),
        "total_reduction_wavelets": sum(
            int(record["reduction_wavelets"]) for record in color_records
        ),
        "total_fabric_wavelets": total_wavelets,
        "peak_color_wavelets": peak,
        "peak_color_fraction": peak / max(1, total_wavelets),
        "color_records": color_records,
    }
    pressure["artifact_sha256"] = artifact_sha256(pressure)
    return pressure


def build_fabric_color_timing(
    color_pressure: dict,
    config: E1XConfig,
    *,
    repair_hop_penalty: float,
) -> dict:
    """Estimate per-color fabric cycles from scheduled wavelet pressure."""
    if color_pressure.get("schema") != COLOR_PRESSURE_SCHEMA:
        raise ValueError(f"unsupported color-pressure schema {color_pressure.get('schema')!r}")
    records = color_pressure.get("color_records")
    if not isinstance(records, list) or not records:
        raise ValueError("color pressure has no color records")
    average_hops = max(1.0, config.logical_cols / 24.0 + repair_hop_penalty)
    color_timings = []
    for record in records:
        total_wavelets = int(record["total_wavelets"])
        fabric_bit_hops = total_wavelets * config.fabric_payload_bits * average_hops
        fabric_cycles = ceil(
            fabric_bit_hops / max(1, config.link_bits_per_cycle_bidirectional * config.logical_rows)
        )
        color_timings.append(
            {
                "routing_color": int(record["routing_color"]),
                "layer_count": int(record["layer_count"]),
                "total_wavelets": total_wavelets,
                "fabric_bit_hops": fabric_bit_hops,
                "estimated_fabric_cycles": fabric_cycles,
            }
        )
    total_color_cycles = sum(int(record["estimated_fabric_cycles"]) for record in color_timings)
    peak_record = max(color_timings, key=lambda record: int(record["estimated_fabric_cycles"]))
    timing = {
        "schema": COLOR_TIMING_SCHEMA,
        "claim_boundary": (
            "deterministic_per_color_fabric_cycle_estimate_not_cycle_accurate_noc_simulation"
        ),
        "chip": color_pressure["chip"],
        "model": color_pressure["model"],
        "source_placement_sha256": color_pressure["source_placement_sha256"],
        "source_kernel_plan_sha256": color_pressure["source_kernel_plan_sha256"],
        "source_tensor_schedule_sha256": color_pressure["source_tensor_schedule_sha256"],
        "source_color_pressure_sha256": color_pressure["artifact_sha256"],
        "logical_rows": config.logical_rows,
        "logical_cols": config.logical_cols,
        "fabric_payload_bits": config.fabric_payload_bits,
        "link_bits_per_cycle_bidirectional": config.link_bits_per_cycle_bidirectional,
        "repair_hop_penalty": repair_hop_penalty,
        "average_hops": average_hops,
        "routing_color_capacity": int(color_pressure["routing_color_capacity"]),
        "used_routing_color_count": int(color_pressure["used_routing_color_count"]),
        "total_fabric_wavelets": int(color_pressure["total_fabric_wavelets"]),
        "peak_routing_color": int(peak_record["routing_color"]),
        "peak_color_fabric_cycles": int(peak_record["estimated_fabric_cycles"]),
        "total_color_fabric_cycles": total_color_cycles,
        "color_timings": color_timings,
    }
    timing["artifact_sha256"] = artifact_sha256(timing)
    return timing


def _estimate_schedule_layer(
    record: dict,
    config: E1XConfig,
    *,
    repair_hop_penalty: float,
    dispatch_cycles_per_layer: int,
    wave_setup_cycles: int,
) -> dict:
    rows = int(record["rows"])
    cols = int(record["cols"])
    assigned_cores = max(1, int(record["assigned_cores"]))
    k_wave_count = max(1, int(record["k_wave_count"]))
    mac_count = rows * cols
    int8_op_count = mac_count * 2
    compute_cycles = ceil(mac_count / max(1, assigned_cores * config.int8_lanes_per_core))

    activation_delivery_bytes = cols * assigned_cores
    output_reduction_bytes = rows * 4
    fabric_bytes = activation_delivery_bytes + output_reduction_bytes
    average_hops = max(1.0, config.logical_cols / 24.0 + repair_hop_penalty)
    fabric_cycles = ceil(
        fabric_bytes
        * average_hops
        * 8
        / max(1, config.link_bits_per_cycle_bidirectional * config.logical_rows)
    )
    dispatch_cycles = dispatch_cycles_per_layer + k_wave_count * wave_setup_cycles
    layer_cycles = max(compute_cycles, fabric_cycles) + dispatch_cycles
    return {
        "layer_index": int(record["layer_index"]),
        "layer_name": str(record["layer_name"]),
        "kind": str(record["kind"]),
        "rows": rows,
        "cols": cols,
        "assigned_cores": assigned_cores,
        "k_wave_count": k_wave_count,
        "core_wave_count": int(record["total_core_wave_count"]),
        "mac_count": mac_count,
        "int8_equivalent_op_count": int8_op_count,
        "activation_delivery_bytes": activation_delivery_bytes,
        "output_reduction_bytes": output_reduction_bytes,
        "fabric_bytes": fabric_bytes,
        "average_hops": average_hops,
        "compute_cycles": compute_cycles,
        "fabric_cycles": fabric_cycles,
        "dispatch_cycles": dispatch_cycles,
        "estimated_layer_cycles": layer_cycles,
        "bottleneck": "compute" if compute_cycles >= fabric_cycles else "fabric",
    }


def build_schedule_execution_estimate(
    schedule: dict,
    config: E1XConfig,
    *,
    repair_hop_penalty: float = 0.0,
    dispatch_cycles_per_layer: int = 64,
    wave_setup_cycles: int = 2,
    max_layer_records: int = 8,
) -> dict:
    """Estimate deterministic architecture-level cycles from the tensor schedule."""
    if schedule.get("schema") != TENSOR_SCHEDULE_SCHEMA:
        raise ValueError(f"unsupported schedule schema {schedule.get('schema')!r}")
    if dispatch_cycles_per_layer < 0 or wave_setup_cycles < 0:
        raise ValueError("dispatch and wave setup cycles must be non-negative")
    records = schedule.get("layers")
    if not isinstance(records, list) or not records:
        raise ValueError("schedule has no layers")

    layer_estimates = [
        _estimate_schedule_layer(
            record,
            config,
            repair_hop_penalty=repair_hop_penalty,
            dispatch_cycles_per_layer=dispatch_cycles_per_layer,
            wave_setup_cycles=wave_setup_cycles,
        )
        for record in records
    ]
    total_mac_count = sum(int(record["mac_count"]) for record in layer_estimates)
    total_int8_ops = sum(int(record["int8_equivalent_op_count"]) for record in layer_estimates)
    total_compute_cycles = sum(int(record["compute_cycles"]) for record in layer_estimates)
    total_fabric_cycles = sum(int(record["fabric_cycles"]) for record in layer_estimates)
    total_dispatch_cycles = sum(int(record["dispatch_cycles"]) for record in layer_estimates)
    total_schedule_cycles = sum(int(record["estimated_layer_cycles"]) for record in layer_estimates)
    elapsed_s = total_schedule_cycles / config.core_clock_hz
    estimate = {
        "schema": SCHEDULE_EXECUTION_SCHEMA,
        "claim_boundary": (
            "deterministic_architecture_level_schedule_cycle_estimate_not_cycle_accurate_rtl"
        ),
        "chip": schedule["chip"],
        "model": schedule["model"],
        "source_placement_sha256": schedule["source_placement_sha256"],
        "source_kernel_plan_sha256": schedule["source_kernel_plan_sha256"],
        "source_tensor_schedule_sha256": schedule["artifact_sha256"],
        "logical_rows": config.logical_rows,
        "logical_cols": config.logical_cols,
        "core_clock_hz": config.core_clock_hz,
        "int8_lanes_per_core": config.int8_lanes_per_core,
        "link_bits_per_cycle_bidirectional": config.link_bits_per_cycle_bidirectional,
        "repair_hop_penalty": repair_hop_penalty,
        "dispatch_cycles_per_layer": dispatch_cycles_per_layer,
        "wave_setup_cycles": wave_setup_cycles,
        "layer_count": int(schedule["layer_count"]),
        "estimated_layer_count": len(layer_estimates),
        "total_k_wave_count": int(schedule["total_k_wave_count"]),
        "total_core_wave_count": int(schedule["total_core_wave_count"]),
        "total_mac_count": total_mac_count,
        "total_int8_equivalent_op_count": total_int8_ops,
        "total_compute_cycles": total_compute_cycles,
        "total_fabric_cycles": total_fabric_cycles,
        "total_dispatch_cycles": total_dispatch_cycles,
        "total_schedule_cycles": total_schedule_cycles,
        "estimated_elapsed_ms": elapsed_s * 1000.0,
        "effective_tops": total_int8_ops / elapsed_s / 1e12,
        "layer_execution_sample": layer_estimates[:max_layer_records],
    }
    estimate["artifact_sha256"] = artifact_sha256(estimate)
    return estimate
