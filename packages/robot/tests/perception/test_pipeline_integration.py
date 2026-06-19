"""Integration tests for the perception pipeline."""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.perception.config import PipelineConfig
from eliza_robot.perception.entity_slots.slot_config import TOTAL_ENTITY_DIMS
from eliza_robot.perception.frame_source import ArraySource
from eliza_robot.perception.pipeline import PerceptionPipeline, PipelineResult


class TestPerceptionPipeline:
    def test_process_blank_frame(self):
        """Pipeline should handle a blank frame without errors."""
        pipeline = PerceptionPipeline()
        blank = np.zeros((480, 640, 3), dtype=np.uint8)
        result = pipeline.process_frame(blank)
        assert result.entity_slots.shape == (TOTAL_ENTITY_DIMS,)
        assert result.processing_ms >= 0

    def test_entity_slots_shape(self):
        pipeline = PerceptionPipeline()
        frame = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
        result = pipeline.process_frame(frame)
        assert result.entity_slots.shape == (152,)

    def test_callback_invoked(self):
        results: list[PipelineResult] = []
        pipeline = PerceptionPipeline()
        pipeline.add_callback(lambda r: results.append(r))
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        pipeline.process_frame(frame)
        assert len(results) == 1

    def test_run_array_source(self):
        """Pipeline runs on an ArraySource."""
        frames = [np.zeros((480, 640, 3), dtype=np.uint8) for _ in range(3)]
        source = ArraySource(frames)
        pipeline = PerceptionPipeline()
        results: list[PipelineResult] = []
        pipeline.add_callback(lambda r: results.append(r))
        pipeline.run(source)
        assert len(results) == 3

    def test_pipeline_result_entities_list(self):
        pipeline = PerceptionPipeline()
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        result = pipeline.process_frame(frame)
        assert isinstance(result.entities, list)

    def test_world_state_accessible(self):
        pipeline = PerceptionPipeline()
        assert pipeline.world_state is not None
