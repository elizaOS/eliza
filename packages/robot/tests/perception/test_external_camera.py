"""Test external camera ArUco pipeline integration."""
import numpy as np
import pytest
from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.config import PipelineConfig
from eliza_robot.perception.pipeline import PerceptionPipeline


def _make_aruco_frame(intrinsics, marker_id, marker_pos_3d, marker_size_m=0.0508):
    """Create a synthetic frame with an ArUco marker at a known 3D position.

    Returns a blank image with marker corners projected onto it.
    This doesn't render a real ArUco marker — it tests the pipeline's
    ability to process ArUco detections when they come from the detector.
    """
    # We can't easily render a real ArUco marker, so we test the pipeline
    # components individually instead.
    return np.zeros((intrinsics.height, intrinsics.width, 3), dtype=np.uint8)


class TestExternalCameraPipeline:
    def test_pipeline_init_with_external_camera(self):
        cfg = PipelineConfig()
        cfg.external_camera.enabled = True
        p = PerceptionPipeline(config=cfg)
        assert p._aruco_detector is not None
        assert p._ext_aruco_detector is not None
        assert p._ext_calibrator is not None
        assert p.external_extrinsics is None

    def test_pipeline_init_without_external_camera(self):
        cfg = PipelineConfig()
        cfg.external_camera.enabled = False
        p = PerceptionPipeline(config=cfg)
        assert p._aruco_detector is not None  # ego ArUco still enabled
        assert p._ext_aruco_detector is None

    def test_process_external_frame_no_markers(self):
        cfg = PipelineConfig()
        cfg.external_camera.enabled = True
        p = PerceptionPipeline(config=cfg)

        blank = np.zeros((720, 1280, 3), dtype=np.uint8)
        p.process_external_frame(blank)

        # No markers → no extrinsics, no entities
        assert p.external_extrinsics is None
        assert len(p.world_state.entity_list) == 0

    def test_aruco_to_entity_via_worldstate(self):
        """Test the ArUco → WorldState → entity path directly."""
        from eliza_robot.perception.world_model.world_state import WorldState
        from eliza_robot.perception.entity_slots.slot_encoder import encode_entity_slots

        ws = WorldState(intrinsics=CameraIntrinsics(), stale_timeout_sec=5.0)

        class MockDet:
            def __init__(self, mid, tvec, conf):
                self.marker_id = mid
                self.tvec = np.array(tvec, dtype=np.float64)
                self.confidence = conf

        dets = [
            MockDet(6, [0.5, 0.0, 1.0], 0.9),   # red_ball
            MockDet(7, [-0.3, 0.0, 0.8], 0.85),  # blue_cube
            MockDet(0, [0.0, 0.0, 0.5], 0.95),   # robot (skip)
            MockDet(2, [0.0, 0.0, 0.0], 0.99),   # ground (skip)
        ]

        ws.update_from_aruco(
            dets,
            object_markers={6: "red_ball", 7: "blue_cube", 8: "green_cylinder"},
            robot_marker_ids=[0],
            robot_head_marker_id=1,
        )

        entities = ws.entity_list
        assert len(entities) == 2
        labels = {e.label for e in entities}
        assert "red_ball" in labels
        assert "blue_cube" in labels

        # Robot and ground markers should NOT create entities
        for e in entities:
            assert e.marker_id != 0
            assert e.marker_id != 2
            assert e.source == "aruco"

        # Entity slots should encode these
        slots = encode_entity_slots(entities)
        assert slots.shape == (152,)
        assert slots.sum() > 0

    def test_marker_config_object_markers_filtering(self):
        """Only configured object markers become entities, others are skipped."""
        from eliza_robot.perception.world_model.world_state import WorldState

        ws = WorldState(intrinsics=CameraIntrinsics(), stale_timeout_sec=5.0)

        class MockDet:
            def __init__(self, mid, tvec, conf):
                self.marker_id = mid
                self.tvec = np.array(tvec, dtype=np.float64)
                self.confidence = conf

        # Marker 99 is not in object_markers
        ws.update_from_aruco(
            [MockDet(99, [1, 0, 1], 0.9)],
            object_markers={6: "red_ball"},
            robot_marker_ids=[0],
        )
        assert len(ws.entity_list) == 0  # 99 not configured → no entity
