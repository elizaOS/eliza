"""Tests for the CommandBuffer descriptor-batching abstraction (B-4).

The CommandBuffer batches NpuStreamDescriptor entries and dispatches them
through a single completion wait, so the runtime side mirrors the IREE Stream
dialect command-buffer pattern that the partitioner (B-5) builds on. A
one-element buffer is the equivalent of the historical single-op MMIO path.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e1_npu_partitioner import partition_module
from e1_npu_runtime import (
    CommandBuffer,
    E1NpuRuntime,
    NpuDescriptorSubmission,
    NpuRuntimeStatus,
    NpuStreamDescriptor,
    stage_host_runtime_sequence,
)
from e1_npu_stablehlo import parse_module
from test_e1_npu_runtime_sim import E1NpuMmioSim


def _stream_descriptor(scratch_offset: int = 0) -> NpuStreamDescriptor:
    return NpuStreamDescriptor(
        opcode=E1NpuRuntime.OP_GEMM_S8,
        source_addr=0x4000 + scratch_offset,
        scratch_offset=scratch_offset,
        byte_count=4,
        writeback_request=False,
    )


def _host_runtime_sequence() -> dict:
    return {
        "schema": "eliza.e1_npu_host_runtime_sequence.v1",
        "claim_boundary": (
            "host_runtime_sequence_metadata_only_not_tensor_population_or_execution"
        ),
        "mmio_preamble_writes": [
            {
                "op_name": "dot0",
                "writes": [
                    {"register": "GEMM_CFG", "address": "0x10020020", "value": 0x0003_0202},
                    {"register": "GEMM_BASE", "address": "0x10020024", "value": 0x0010_0800},
                    {
                        "register": "GEMM_STRIDE",
                        "address": "0x10020028",
                        "value": 0x0008_0203,
                    },
                ],
            }
        ],
        "descriptor_memory_writes": [
            {"address": "0x00002000", "value": 0xD0000108},
            {"address": "0x00002004", "value": 0x8000_0010},
            {"address": "0x00002008", "value": 0x8000_0000},
            {"address": "0x0000200c", "value": 0},
        ],
        "submission_mmio_writes": [
            {"register": "DESC_BASE", "address": "0x10020040", "value": 0x2000},
            {"register": "DESC_HEAD", "address": "0x10020044", "value": 0},
            {"register": "DESC_TAIL", "address": "0x10020048", "value": 1},
            {"register": "CMD_PARAM", "address": "0x10020030", "value": 1},
            {"register": "CTRL_STATUS", "address": "0x1002000c", "value": 2},
            {"register": "CTRL_STATUS", "address": "0x1002000c", "value": 1},
        ],
        "completion_poll": {
            "register": "DESC_STATUS",
            "address": "0x1002004c",
            "requires_done_bit": True,
            "rejects_error_bit": True,
        },
    }


def _dot_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "runtime_sequence_dot",
        "ops": [
            {
                "op": "stablehlo.dot_general",
                "name": "dot0",
                "lhs_type": {"shape": [2, 3], "dtype": "int8"},
                "rhs_type": {"shape": [3, 2], "dtype": "int8"},
                "result_type": {"shape": [2, 2], "dtype": "int8"},
                "precision": "int8",
            }
        ],
    }


def _mismatched_dot_payload() -> dict:
    payload = _dot_payload()
    payload["name"] = "runtime_sequence_mismatched_dot"
    payload["ops"] = [
        payload["ops"][0],
        {
            "op": "stablehlo.dot_general",
            "name": "dot1",
            "lhs_type": {"shape": [2, 2], "dtype": "int8"},
            "rhs_type": {"shape": [2, 3], "dtype": "int8"},
            "result_type": {"shape": [2, 3], "dtype": "int8"},
            "precision": "int8",
        },
    ]
    return payload


def _pack_u8(values: list[int]) -> int:
    word = 0
    for index, value in enumerate(values):
        word |= (value & 0xFF) << (index * 8)
    return word


def test_command_buffer_rejects_misaligned_or_negative_base() -> None:
    with pytest.raises(ValueError, match="32-bit aligned"):
        CommandBuffer(base=0x2001)
    with pytest.raises(ValueError, match="32-bit aligned"):
        CommandBuffer(base=-4)


def test_command_buffer_rejects_zero_or_negative_timeout() -> None:
    with pytest.raises(ValueError, match="timeout_polls"):
        CommandBuffer(base=0x2000, timeout_polls=0)
    with pytest.raises(ValueError, match="timeout_polls"):
        CommandBuffer(base=0x2000, timeout_polls=-1)


def test_command_buffer_append_only_accepts_stream_descriptors() -> None:
    buffer = CommandBuffer(base=0x2000)
    with pytest.raises(TypeError, match="NpuStreamDescriptor"):
        buffer.append(object())


def test_command_buffer_submission_requires_non_empty_queue() -> None:
    buffer = CommandBuffer(base=0x2000)
    with pytest.raises(ValueError, match="at least one descriptor"):
        buffer.submission()


def test_command_buffer_caps_entries_at_ring_window() -> None:
    buffer = CommandBuffer(base=0x2000)
    for index in range(CommandBuffer.MAX_ENTRIES):
        buffer.append(_stream_descriptor(scratch_offset=index * 4))
    assert len(buffer) == CommandBuffer.MAX_ENTRIES
    with pytest.raises(ValueError, match="ring window"):
        buffer.append(_stream_descriptor(scratch_offset=0))


def test_command_buffer_submission_packs_head_tail_and_base() -> None:
    buffer = CommandBuffer(base=0x2000, timeout_polls=512)
    buffer.append(_stream_descriptor(scratch_offset=0))
    buffer.append(_stream_descriptor(scratch_offset=4))
    buffer.append(_stream_descriptor(scratch_offset=8))

    submission = buffer.submission()

    assert isinstance(submission, NpuDescriptorSubmission)
    assert submission.base == 0x2000
    assert submission.head == 0
    assert submission.tail == 3
    assert submission.timeout_polls == 512


def test_command_buffer_words_match_descriptor_layout() -> None:
    buffer = CommandBuffer(base=0x2000)
    descriptor = _stream_descriptor(scratch_offset=4)
    buffer.append(descriptor)

    assert buffer.words() == (descriptor.words(),)


def test_command_buffer_descriptor_image_is_word_addressed_and_contiguous() -> None:
    buffer = CommandBuffer(base=0x2000)
    first = _stream_descriptor(scratch_offset=0)
    second = _stream_descriptor(scratch_offset=4)
    buffer.extend((first, second))

    assert buffer.descriptor_image() == {
        0x2000: first.words()[0],
        0x2004: first.words()[1],
        0x2008: first.words()[2],
        0x200C: first.words()[3],
        0x2010: second.words()[0],
        0x2014: second.words()[1],
        0x2018: second.words()[2],
        0x201C: second.words()[3],
    }


def test_command_buffer_stage_writes_descriptor_image_once() -> None:
    buffer = CommandBuffer(base=0x2000)
    descriptor = _stream_descriptor(scratch_offset=0)
    writes: list[tuple[int, int]] = []
    buffer.append(descriptor)

    buffer.stage(lambda address, word: writes.append((address, word)))

    assert writes == list(buffer.descriptor_image().items())


def test_command_buffer_stage_rejects_invalid_writer_and_empty_buffer() -> None:
    buffer = CommandBuffer(base=0x2000)
    with pytest.raises(TypeError, match="callable"):
        buffer.stage(None)
    with pytest.raises(ValueError, match="at least one descriptor"):
        buffer.stage(lambda _address, _word: None)


def test_stage_host_runtime_sequence_replays_memory_and_mmio_writes() -> None:
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []

    result = stage_host_runtime_sequence(
        _host_runtime_sequence(),
        write_mmio32=lambda address, value: mmio_writes.append((address, value)),
        write_mem32=lambda address, value: memory_writes.append((address, value)),
    )

    assert result == {
        "schema": "eliza.e1_npu_host_runtime_sequence_stage_result.v1",
        "mmio_writes": 9,
        "memory_writes": 4,
    }
    assert mmio_writes == [
        (E1NpuRuntime.GEMM_CFG, 0x0003_0202),
        (E1NpuRuntime.GEMM_BASE, 0x0010_0800),
        (E1NpuRuntime.GEMM_STRIDE, 0x0008_0203),
        (E1NpuRuntime.DESC_BASE, 0x2000),
        (E1NpuRuntime.DESC_HEAD, 0),
        (E1NpuRuntime.DESC_TAIL, 1),
        (E1NpuRuntime.CMD_PARAM, 1),
        (E1NpuRuntime.CTRL_STATUS, 2),
        (E1NpuRuntime.CTRL_STATUS, 1),
    ]
    assert memory_writes == [
        (0x2000, 0xD0000108),
        (0x2004, 0x8000_0010),
        (0x2008, 0x8000_0000),
        (0x200C, 0),
    ]


def test_stage_host_runtime_sequence_is_fail_closed() -> None:
    sequence = _host_runtime_sequence()

    with pytest.raises(TypeError, match="mapping"):
        stage_host_runtime_sequence(
            object(),
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(TypeError, match="callable"):
        stage_host_runtime_sequence(sequence, write_mmio32=None, write_mem32=lambda *_: None)
    with pytest.raises(ValueError, match="schema"):
        stage_host_runtime_sequence(
            {**sequence, "schema": "unknown"},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="aligned uint32"):
        stage_host_runtime_sequence(
            {
                **sequence,
                "descriptor_memory_writes": [{"address": "0x2002", "value": 0}],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="uint32"):
        stage_host_runtime_sequence(
            {
                **sequence,
                "descriptor_memory_writes": [{"address": "0x2000", "value": -1}],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )


def test_prepared_batch_host_runtime_sequence_stages_and_submits_in_sim() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    sim = E1NpuMmioSim()
    descriptor_memory: dict[int, int] = {}
    for offset, values in {
        0: [1, 2, 3, 4],
        4: [5, 6, 0, 0],
        8: [7, 8, 9, 10],
        12: [11, 12, 0, 0],
    }.items():
        sim.write_mem32(0x8000_0010 + offset, _pack_u8(values))

    def write_descriptor_word(address: int, value: int) -> None:
        descriptor_memory[address] = value
        sim.write_mem32(address, value)

    result = stage_host_runtime_sequence(
        prepared["host_runtime_sequence"],
        write_mmio32=sim.write32,
        write_mem32=write_descriptor_word,
    )

    assert result["schema"] == "eliza.e1_npu_host_runtime_sequence_stage_result.v1"
    assert result["mmio_writes"] == 9
    assert result["memory_writes"] == 4
    assert descriptor_memory == {
        int(address, 16): value
        for address, value in prepared["descriptor_command_buffer_image"][
            "descriptor_image"
        ].items()
    }
    assert sim.regs[sim.runtime.GEMM_CFG] == 0x0003_0202
    assert sim.regs[sim.runtime.GEMM_BASE] == 0x0010_0800
    assert sim.regs[sim.runtime.GEMM_STRIDE] == 0x0008_0203
    assert sim.regs[sim.runtime.DESC_STATUS] == sim.runtime.DESC_STATUS_DONE
    assert sim.regs[sim.runtime.DESC_HEAD] == 1
    assert sim.regs[sim.runtime.DESC_TAIL] == 1
    assert sim.runtime.descriptor_counters()["bytes_read"] == 32
    assert sim.runtime.descriptor_counters()["bytes_written"] == 16
    assert sim.runtime.descriptor_counters()["read_beats"] == 5
    assert sim.runtime.descriptor_counters()["write_beats"] == 4
    assert {address: sim.memory[address] for address in range(0x8000_0000, 0x8000_0010, 4)} == {
        0x8000_0000: 58,
        0x8000_0004: 64,
        0x8000_0008: 139,
        0x8000_000C: 154,
    }


def test_prepared_execution_batch_host_runtime_sequence_stages_and_submits_in_sim() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            execution_batch_index=1,
        )
        .as_dict()
    )
    sim = E1NpuMmioSim()
    descriptor_memory: dict[int, int] = {}
    for offset, values in {
        0: [1, 2, 3, 4],
        4: [5, 6, 7, 8],
        8: [9, 10, 0, 0],
    }.items():
        sim.write_mem32(0x8000_0038 + offset, _pack_u8(values))

    def write_descriptor_word(address: int, value: int) -> None:
        descriptor_memory[address] = value
        sim.write_mem32(address, value)

    result = stage_host_runtime_sequence(
        prepared["host_runtime_sequence"],
        write_mmio32=sim.write32,
        write_mem32=write_descriptor_word,
    )

    assert prepared["descriptor_command_buffer_image"]["execution_batch_index"] == 1
    assert result == {
        "schema": "eliza.e1_npu_host_runtime_sequence_stage_result.v1",
        "mmio_writes": 9,
        "memory_writes": 4,
    }
    assert descriptor_memory == {
        int(address, 16): value
        for address, value in prepared["descriptor_command_buffer_image"][
            "descriptor_image"
        ].items()
    }
    assert sim.regs[sim.runtime.GEMM_CFG] == 0x0002_0302
    assert sim.regs[sim.runtime.GEMM_BASE] == 0x000C_0400
    assert sim.regs[sim.runtime.GEMM_STRIDE] == 0x000C_0302
    assert sim.runtime.descriptor_counters()["bytes_read"] == 28
    assert sim.runtime.descriptor_counters()["bytes_written"] == 24
    assert sim.runtime.descriptor_counters()["read_beats"] == 4
    assert sim.runtime.descriptor_counters()["write_beats"] == 6
    assert {address: sim.memory[address] for address in range(0x8000_0020, 0x8000_0038, 4)} == {
        0x8000_0020: 21,
        0x8000_0024: 24,
        0x8000_0028: 27,
        0x8000_002C: 47,
        0x8000_0030: 54,
        0x8000_0034: 61,
    }


def test_memory_backed_sim_descriptor_rejects_missing_owner_bit() -> None:
    sequence = _host_runtime_sequence()
    sequence["descriptor_memory_writes"] = [
        {**write, "value": write["value"] & ~E1NpuRuntime.DESC_FLAG_VALID_OWNER}
        if write["address"] == "0x00002000"
        else write
        for write in sequence["descriptor_memory_writes"]
    ]
    sim = E1NpuMmioSim()

    result = stage_host_runtime_sequence(
        sequence,
        write_mmio32=sim.write32,
        write_mem32=sim.write_mem32,
    )

    assert result["memory_writes"] == 4
    assert sim.regs[sim.runtime.CTRL_STATUS] == 0x6
    assert sim.regs[sim.runtime.DESC_STATUS] == (
        sim.runtime.DESC_STATUS_ERROR | sim.runtime.DESC_STATUS_OWNER_ERROR
    )
    assert sim.runtime.perf()["errors"] == 1


def test_runtime_submit_dispatches_one_element_buffer_through_single_wait() -> None:
    sim = E1NpuMmioSim()
    buffer = CommandBuffer(base=0x2000)
    buffer.append(_stream_descriptor(scratch_offset=0))

    status = sim.runtime.submit(buffer)

    assert isinstance(status, NpuRuntimeStatus)
    assert status.ok is True
    assert status.desc_status == sim.runtime.DESC_STATUS_DONE
    counters = sim.runtime.descriptor_counters()
    assert counters["bytes_read"] == 16
    assert counters["read_beats"] == 1


def test_runtime_submit_dispatches_multi_entry_buffer_with_one_completion_wait() -> None:
    sim = E1NpuMmioSim()
    buffer = CommandBuffer(base=0x2000)
    buffer.extend(_stream_descriptor(scratch_offset=offset) for offset in (0, 4, 8, 12))

    status = sim.runtime.submit(buffer)

    assert status.ok is True
    assert status.desc_status == sim.runtime.DESC_STATUS_DONE
    counters = sim.runtime.descriptor_counters()
    assert counters["bytes_read"] == 4 * 16
    assert counters["read_beats"] == 4


def test_runtime_submit_rejects_non_command_buffer() -> None:
    sim = E1NpuMmioSim()
    with pytest.raises(TypeError, match="CommandBuffer"):
        sim.runtime.submit(NpuDescriptorSubmission(base=0x2000, head=0, tail=1))
