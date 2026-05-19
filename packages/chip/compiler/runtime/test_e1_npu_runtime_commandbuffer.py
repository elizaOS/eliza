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
    stage_prepared_descriptor_batch,
    stage_prepared_descriptor_execution_batches,
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
    with pytest.raises(ValueError, match="require done bit"):
        stage_host_runtime_sequence(
            {
                **sequence,
                "completion_poll": {
                    **sequence["completion_poll"],
                    "requires_done_bit": False,
                },
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="reject error bit"):
        stage_host_runtime_sequence(
            {
                **sequence,
                "completion_poll": {
                    **sequence["completion_poll"],
                    "rejects_error_bit": False,
                },
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="GEMM preamble register metadata mismatch"):
        stage_host_runtime_sequence(
            {
                **sequence,
                "mmio_preamble_writes": [
                    {
                        **sequence["mmio_preamble_writes"][0],
                        "writes": [
                            {
                                **sequence["mmio_preamble_writes"][0]["writes"][0],
                                "register": "GEMM_BASE",
                            },
                            *sequence["mmio_preamble_writes"][0]["writes"][1:],
                        ],
                    }
                ],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="descriptor submission register address mismatch"):
        stage_host_runtime_sequence(
            {
                **sequence,
                "submission_mmio_writes": [
                    {
                        **sequence["submission_mmio_writes"][0],
                        "address": "0x10020044",
                    },
                    *sequence["submission_mmio_writes"][1:],
                ],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="completion_poll register metadata mismatch"):
        stage_host_runtime_sequence(
            {
                **sequence,
                "completion_poll": {
                    **sequence["completion_poll"],
                    "register": "DESC_TAIL",
                },
            },
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


def test_stage_prepared_descriptor_execution_batches_is_fail_closed() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )

    with pytest.raises(TypeError, match="mapping"):
        stage_prepared_descriptor_execution_batches(
            object(),
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="schema"):
        stage_prepared_descriptor_execution_batches(
            {**prepared, "schema": "unknown"},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="count mismatch"):
        stage_prepared_descriptor_execution_batches(
            {**prepared, "execution_batch_count": 99},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    reversed_batches = list(reversed(prepared["prepared_execution_batches"]))
    with pytest.raises(ValueError, match="ordered by execution_batch_index"):
        stage_prepared_descriptor_execution_batches(
            {**prepared, "prepared_execution_batches": reversed_batches},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="descriptor_stride_bytes must be positive"):
        stage_prepared_descriptor_execution_batches(
            {**prepared, "descriptor_stride_bytes": 0},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="required_runtime_steps mismatch"):
        stage_prepared_descriptor_execution_batches(
            {**prepared, "required_runtime_steps": ["populate_tensor_arena"]},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="arena_total_bytes"):
        stage_prepared_descriptor_execution_batches(
            {**prepared, "arena_total_bytes": 0},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    first_batch = {
        **prepared["prepared_execution_batches"][0],
        "arena_base": 0x8000_1000,
    }
    with pytest.raises(ValueError, match="arena_base does not match outer package"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    first_batch = {
        **prepared["prepared_execution_batches"][0],
        "arena_total_bytes": prepared["arena_total_bytes"] + 4,
    }
    with pytest.raises(ValueError, match="arena sizing does not match outer package"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    first_batch = dict(prepared["prepared_execution_batches"][0])
    first_image = dict(first_batch["descriptor_command_buffer_image"])
    first_image["batch_index"] = 1
    first_batch["descriptor_command_buffer_image"] = first_image
    with pytest.raises(ValueError, match="batch_index does not match descriptor image"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    first_batch = {
        **prepared["prepared_execution_batches"][0],
        "required_runtime_steps": ["populate_tensor_arena"],
    }
    with pytest.raises(ValueError, match="required_runtime_steps mismatch"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )


def test_stage_prepared_descriptor_execution_batches_validates_bases_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    first_image = dict(first_batch["descriptor_command_buffer_image"])
    first_image["descriptor_base"] = 0x2200
    first_batch["descriptor_command_buffer_image"] = first_image

    with pytest.raises(ValueError, match="descriptor_base does not match"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_submission_base() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    first_batch = dict(prepared["prepared_execution_batches"][0])
    sequence = dict(first_batch["host_runtime_sequence"])
    sequence["submission_mmio_writes"] = [
        {**write, "value": 0x2200} if write["register"] == "DESC_BASE" else write
        for write in sequence["submission_mmio_writes"]
    ]
    first_batch["host_runtime_sequence"] = sequence

    with pytest.raises(ValueError, match="DESC_BASE does not match"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )


def test_stage_prepared_descriptor_execution_batches_validates_submission_tail() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    first_image = dict(first_batch["descriptor_command_buffer_image"])
    first_image["submission"] = {**first_image["submission"], "tail": 2}
    first_batch["descriptor_command_buffer_image"] = first_image

    with pytest.raises(ValueError, match="submission tail does not match descriptor_words"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_sequence_submission() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    sequence = dict(first_batch["host_runtime_sequence"])
    sequence["submission_mmio_writes"] = [
        {**write, "value": 0} if write["register"] == "DESC_TAIL" else write
        for write in sequence["submission_mmio_writes"]
    ]
    first_batch["host_runtime_sequence"] = sequence

    with pytest.raises(ValueError, match="DESC_TAIL does not match submission"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_requires_submission_registers() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    sequence = dict(first_batch["host_runtime_sequence"])
    sequence["submission_mmio_writes"] = [
        write for write in sequence["submission_mmio_writes"] if write["register"] != "DESC_HEAD"
    ]
    first_batch["host_runtime_sequence"] = sequence

    with pytest.raises(ValueError, match="submission_mmio_writes missing register"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_sequence_submission_head() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    sequence = dict(first_batch["host_runtime_sequence"])
    sequence["submission_mmio_writes"] = [
        {**write, "value": 1} if write["register"] == "DESC_HEAD" else write
        for write in sequence["submission_mmio_writes"]
    ]
    first_batch["host_runtime_sequence"] = sequence

    with pytest.raises(ValueError, match="DESC_HEAD does not match submission"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_descriptor_image_writes() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    sequence = dict(first_batch["host_runtime_sequence"])
    sequence["descriptor_memory_writes"] = [
        {**write, "value": 0} if write["address"] == "0x00002100" else write
        for write in sequence["descriptor_memory_writes"]
    ]
    first_batch["host_runtime_sequence"] = sequence

    with pytest.raises(ValueError, match="descriptor_memory_writes do not match"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_descriptor_words() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    first_image = dict(first_batch["descriptor_command_buffer_image"])
    first_words = list(first_image["descriptor_words"][0])
    first_words[0] ^= 0x1
    first_image["descriptor_words"] = [first_words]
    first_batch["descriptor_command_buffer_image"] = first_image

    with pytest.raises(ValueError, match="descriptor_words do not match descriptor_image"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_owner_bit() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    first_image = dict(first_batch["descriptor_command_buffer_image"])
    first_words = list(first_image["descriptor_words"][0])
    first_words[0] &= ~E1NpuRuntime.DESC_FLAG_VALID_OWNER
    first_image["descriptor_words"] = [first_words]
    first_batch["descriptor_command_buffer_image"] = first_image

    with pytest.raises(ValueError, match="descriptor word0 missing valid_owner bit"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_descriptor_stream_bits() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    first_image = dict(first_batch["descriptor_command_buffer_image"])
    first_words = list(first_image["descriptor_words"][0])
    first_words[0] &= ~E1NpuRuntime.DESC_FLAG_STREAM_TO_SCRATCH
    first_image["descriptor_words"] = [first_words]
    first_batch["descriptor_command_buffer_image"] = first_image

    with pytest.raises(ValueError, match="descriptor word0 missing stream_to_scratch bit"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_descriptor_byte_count() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    first_image = dict(first_batch["descriptor_command_buffer_image"])
    first_words = list(first_image["descriptor_words"][0])
    first_words[0] &= ~(0x3F << 24)
    first_image["descriptor_words"] = [first_words]
    first_batch["descriptor_command_buffer_image"] = first_image

    with pytest.raises(ValueError, match="descriptor byte_count must be positive and aligned"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_writeback_gemm_output() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    op_preamble = dict(first_batch["op_mmio_preamble"][0])
    mmio_preamble = dict(op_preamble["mmio_preamble"])
    mmio_preamble["GEMM_CFG"] = 0
    op_preamble["mmio_preamble"] = mmio_preamble
    first_batch["op_mmio_preamble"] = [op_preamble]
    sequence = dict(first_batch["host_runtime_sequence"])
    sequence_preamble = dict(sequence["mmio_preamble_writes"][0])
    sequence_preamble["writes"] = [
        {**write, "value": 0} if write["register"] == "GEMM_CFG" else write
        for write in sequence_preamble["writes"]
    ]
    sequence["mmio_preamble_writes"] = [sequence_preamble]
    first_batch["host_runtime_sequence"] = sequence

    with pytest.raises(ValueError, match="writeback_request requires nonzero GEMM output"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_gemm_cfg_metadata() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    op_preamble = dict(first_batch["op_mmio_preamble"][0])
    mmio_preamble = dict(op_preamble["mmio_preamble"])
    mmio_preamble["GEMM_CFG"] = "bad"
    op_preamble["mmio_preamble"] = mmio_preamble
    first_batch["op_mmio_preamble"] = [op_preamble]

    with pytest.raises(ValueError, match="GEMM_CFG must be a uint32"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_mmio_preamble() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    sequence = dict(first_batch["host_runtime_sequence"])
    preamble_entry = dict(sequence["mmio_preamble_writes"][0])
    preamble_entry["writes"] = [
        {**write, "value": 0} if write["register"] == "GEMM_CFG" else write
        for write in preamble_entry["writes"]
    ]
    sequence["mmio_preamble_writes"] = [preamble_entry]
    first_batch["host_runtime_sequence"] = sequence

    with pytest.raises(ValueError, match="mmio_preamble_writes value mismatch"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_execution_batches_validates_op_names() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    first_batch = dict(prepared["prepared_execution_batches"][0])
    first_image = dict(first_batch["descriptor_command_buffer_image"])
    first_image["op_names"] = ["wrong"]
    first_batch["descriptor_command_buffer_image"] = first_image

    with pytest.raises(ValueError, match="op_names do not match op_mmio_preamble"):
        stage_prepared_descriptor_execution_batches(
            {
                **prepared,
                "prepared_execution_batches": [
                    first_batch,
                    prepared["prepared_execution_batches"][1],
                ],
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_is_fail_closed() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    with pytest.raises(TypeError, match="mapping"):
        stage_prepared_descriptor_batch(
            object(),
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="schema"):
        stage_prepared_descriptor_batch(
            {**prepared, "schema": "unknown"},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="required_runtime_steps mismatch"):
        stage_prepared_descriptor_batch(
            {**prepared, "required_runtime_steps": ["populate_tensor_arena"]},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    with pytest.raises(ValueError, match="arena_alignment_bytes"):
        stage_prepared_descriptor_batch(
            {**prepared, "arena_alignment_bytes": 0},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    image = dict(prepared["descriptor_command_buffer_image"])
    image["descriptor_base"] = 0x2100
    with pytest.raises(ValueError, match="descriptor_base does not match image"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    image = dict(prepared["descriptor_command_buffer_image"])
    image["arena_base"] = 0x8000_1000
    with pytest.raises(ValueError, match="arena_base does not match descriptor image"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )
    image = dict(prepared["descriptor_command_buffer_image"])
    image["batch_index"] = 1
    with pytest.raises(ValueError, match="batch_index does not match descriptor image"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda _address, _value: None,
            write_mem32=lambda _address, _value: None,
        )


def test_stage_prepared_descriptor_batch_validates_package_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    sequence = dict(prepared["host_runtime_sequence"])
    sequence["descriptor_memory_writes"] = [
        {**write, "value": 0} if write["address"] == "0x00002000" else write
        for write in sequence["descriptor_memory_writes"]
    ]

    with pytest.raises(ValueError, match="descriptor_memory_writes do not match"):
        stage_prepared_descriptor_batch(
            {**prepared, "host_runtime_sequence": sequence},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_descriptor_words_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    words = list(image["descriptor_words"][0])
    words[0] ^= 0x1
    image["descriptor_words"] = [words]

    with pytest.raises(ValueError, match="descriptor_words do not match descriptor_image"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_descriptor_ring_window_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    image["descriptor_words"] = [
        list(image["descriptor_words"][0]) for _index in range(CommandBuffer.MAX_ENTRIES + 1)
    ]

    with pytest.raises(ValueError, match="descriptor_words exceed RTL ring window"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_owner_bit_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    words = list(image["descriptor_words"][0])
    words[0] &= ~E1NpuRuntime.DESC_FLAG_VALID_OWNER
    image["descriptor_words"] = [words]

    with pytest.raises(ValueError, match="descriptor word0 missing valid_owner bit"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_preamble_count_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    image["op_names"] = [*image["op_names"], "extra"]
    op_preamble = dict(prepared["op_mmio_preamble"][0])
    extra_preamble = {**op_preamble, "op_name": "extra"}
    sequence = dict(prepared["host_runtime_sequence"])
    sequence_preamble = dict(sequence["mmio_preamble_writes"][0])
    extra_sequence_preamble = {**sequence_preamble, "op_name": "extra"}
    sequence["mmio_preamble_writes"] = [sequence_preamble, extra_sequence_preamble]

    with pytest.raises(ValueError, match="descriptor_words count does not match op_mmio_preamble"):
        stage_prepared_descriptor_batch(
            {
                **prepared,
                "descriptor_command_buffer_image": image,
                "op_mmio_preamble": [op_preamble, extra_preamble],
                "host_runtime_sequence": sequence,
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_writeback_opcode_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    words = list(image["descriptor_words"][0])
    words[0] = (words[0] & ~0xF) | E1NpuRuntime.OP_ADD
    image["descriptor_words"] = [words]

    with pytest.raises(ValueError, match="writeback_request requires GEMM opcode"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_writeback_alignment_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    words = list(image["descriptor_words"][0])
    words[2] |= 0x1
    image["descriptor_words"] = [words]

    with pytest.raises(ValueError, match="descriptor writeback address must be aligned"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_scratch_bounds_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    words = list(image["descriptor_words"][0])
    words[0] &= ~((0x3F << 16) | (0x3F << 24))
    words[0] |= (60 << 16) | (8 << 24)
    image["descriptor_words"] = [words]

    with pytest.raises(ValueError, match="descriptor stream exceeds scratchpad"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_writeback_gemm_output_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    op_preamble = dict(prepared["op_mmio_preamble"][0])
    mmio_preamble = dict(op_preamble["mmio_preamble"])
    mmio_preamble["GEMM_CFG"] = 0
    op_preamble["mmio_preamble"] = mmio_preamble
    sequence = dict(prepared["host_runtime_sequence"])
    sequence_preamble = dict(sequence["mmio_preamble_writes"][0])
    sequence_preamble["writes"] = [
        {**write, "value": 0} if write["register"] == "GEMM_CFG" else write
        for write in sequence_preamble["writes"]
    ]
    sequence["mmio_preamble_writes"] = [sequence_preamble]

    with pytest.raises(ValueError, match="writeback_request requires nonzero GEMM output"):
        stage_prepared_descriptor_batch(
            {
                **prepared,
                "op_mmio_preamble": [op_preamble],
                "host_runtime_sequence": sequence,
            },
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_gemm_cfg_metadata_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    op_preamble = dict(prepared["op_mmio_preamble"][0])
    mmio_preamble = dict(op_preamble["mmio_preamble"])
    mmio_preamble["GEMM_CFG"] = "bad"
    op_preamble["mmio_preamble"] = mmio_preamble

    with pytest.raises(ValueError, match="GEMM_CFG must be a uint32"):
        stage_prepared_descriptor_batch(
            {**prepared, "op_mmio_preamble": [op_preamble]},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_submission_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    image["submission"] = {**image["submission"], "tail": 2}

    with pytest.raises(ValueError, match="submission tail does not match descriptor_words"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_submission_head_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    image["submission"] = {**image["submission"], "head": 1}

    with pytest.raises(ValueError, match="submission head must be zero"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_submission_base_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    image["submission"] = {**image["submission"], "base": 0x2100}

    with pytest.raises(ValueError, match="submission base does not match descriptor_base"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


def test_stage_prepared_descriptor_batch_validates_op_names_before_writes() -> None:
    prepared = (
        partition_module(parse_module(_dot_payload()))
        .prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
        .as_dict()
    )
    mmio_writes: list[tuple[int, int]] = []
    memory_writes: list[tuple[int, int]] = []
    image = dict(prepared["descriptor_command_buffer_image"])
    image["op_names"] = ["wrong"]

    with pytest.raises(ValueError, match="op_names do not match op_mmio_preamble"):
        stage_prepared_descriptor_batch(
            {**prepared, "descriptor_command_buffer_image": image},
            write_mmio32=lambda address, value: mmio_writes.append((address, value)),
            write_mem32=lambda address, value: memory_writes.append((address, value)),
        )

    assert mmio_writes == []
    assert memory_writes == []


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

    result = stage_prepared_descriptor_batch(
        prepared,
        write_mmio32=sim.write32,
        write_mem32=write_descriptor_word,
    )

    assert result["schema"] == "eliza.e1_npu_prepared_descriptor_batch_stage_result.v1"
    assert result["host_runtime_sequence_stage_result"]["schema"] == (
        "eliza.e1_npu_host_runtime_sequence_stage_result.v1"
    )
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


def test_prepared_descriptor_execution_batches_stage_and_submit_in_sim() -> None:
    prepared = (
        partition_module(parse_module(_mismatched_dot_payload()))
        .prepared_descriptor_execution_batches(
            arena_base=0x8000_0000,
            descriptor_base=0x2100,
            descriptor_stride_bytes=0x40,
        )
        .as_dict()
    )
    sim = E1NpuMmioSim()
    descriptor_memory: dict[int, int] = {}
    for base, words in {
        0x8000_0010: ([1, 2, 3, 4], [5, 6, 0, 0], [7, 8, 9, 10], [11, 12, 0, 0]),
        0x8000_0038: ([1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 0, 0]),
    }.items():
        for word_index, values in enumerate(words):
            sim.write_mem32(base + word_index * 4, _pack_u8(values))

    def write_descriptor_word(address: int, value: int) -> None:
        descriptor_memory[address] = value
        sim.write_mem32(address, value)

    result = stage_prepared_descriptor_execution_batches(
        prepared,
        write_mmio32=sim.write32,
        write_mem32=write_descriptor_word,
    )

    assert prepared["schema"] == "eliza.e1_npu_prepared_descriptor_execution_batches.v1"
    assert prepared["execution_batch_count"] == 2
    assert [
        batch["descriptor_command_buffer_image"]["descriptor_base"]
        for batch in prepared["prepared_execution_batches"]
    ] == [0x2100, 0x2140]
    assert result == {
        "schema": "eliza.e1_npu_prepared_descriptor_execution_batches_stage_result.v1",
        "execution_batch_count": 2,
        "mmio_writes": 18,
        "memory_writes": 8,
        "batch_results": [
            {
                "schema": "eliza.e1_npu_host_runtime_sequence_stage_result.v1",
                "mmio_writes": 9,
                "memory_writes": 4,
            },
            {
                "schema": "eliza.e1_npu_host_runtime_sequence_stage_result.v1",
                "mmio_writes": 9,
                "memory_writes": 4,
            },
        ],
    }
    assert descriptor_memory == {
        0x2100: 0xD0000108,
        0x2104: 0x8000_0010,
        0x2108: 0x8000_0000,
        0x210C: 0,
        0x2140: 0xCC000108,
        0x2144: 0x8000_0038,
        0x2148: 0x8000_0020,
        0x214C: 0,
    }
    assert sim.runtime.descriptor_counters()["bytes_read"] == 60
    assert sim.runtime.descriptor_counters()["bytes_written"] == 40
    assert {address: sim.memory[address] for address in range(0x8000_0000, 0x8000_0010, 4)} == {
        0x8000_0000: 58,
        0x8000_0004: 64,
        0x8000_0008: 139,
        0x8000_000C: 154,
    }
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
