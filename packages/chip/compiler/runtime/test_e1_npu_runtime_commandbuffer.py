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

from e1_npu_runtime import (
    CommandBuffer,
    E1NpuRuntime,
    NpuDescriptorSubmission,
    NpuRuntimeStatus,
    NpuStreamDescriptor,
)
from test_e1_npu_runtime_sim import E1NpuMmioSim


def _stream_descriptor(scratch_offset: int = 0) -> NpuStreamDescriptor:
    return NpuStreamDescriptor(
        opcode=E1NpuRuntime.OP_GEMM_S8,
        source_addr=0x4000 + scratch_offset,
        scratch_offset=scratch_offset,
        byte_count=4,
        writeback_request=False,
    )


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
