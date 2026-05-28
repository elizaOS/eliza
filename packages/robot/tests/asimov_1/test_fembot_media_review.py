from __future__ import annotations

import json

from PIL import Image

from eliza_robot.asimov_1.fembot_media_review import build_fembot_media_review_proof

SCREENSHOT_NAMES = [
    "fembot_front.png",
    "fembot_rear.png",
    "fembot_left.png",
    "fembot_right.png",
    "fembot_three_quarter.png",
    "fembot_upper_three_quarter.png",
]


def test_fembot_media_review_validates_screenshots_and_joint_video(tmp_path) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    for index, name in enumerate(SCREENSHOT_NAMES):
        image = Image.new("RGB", (32, 24), (20 + index * 10, 40, 70))
        image.putpixel((index + 1, 1), (220, 210, 50))
        image.save(media_root / name)
    video = media_root / "fembot_all_joints_simultaneous_constraints.mp4"
    video.write_bytes(b"not a real mp4, but nonzero artifact bytes for wrapper validation")
    proof_path = tmp_path / "fembot-media-review.json"
    proof_path.write_text(
        json.dumps(
            {
                "schema": "asimov-fembot-media-review-v1",
                "source": {"mjcf": "asimov_fembot.xml"},
                "video": {"frame_count": 144},
                "joint_motion": {"joint_count": 27, "joints": []},
                "source_fitted_part_media": [
                    {
                        "link": "LEFT_TOE",
                        "shape_family": "source_fitted_controlled_loft",
                        "path": str(media_root / "fembot_source_fitted_left_toe.png"),
                        "generated_step_path": "left_toe.step",
                        "surface_symmetric_hausdorff_m": 0.002,
                    }
                ],
                "source_fitted_visual_mjcf": {
                    "visual_replacements": 28,
                    "replacement_failures": 0,
                },
                "source_fitted_assembly_media": [
                    {
                        "name": "front",
                        "path": str(media_root / "fembot_source_fitted_assembly_front.png"),
                    },
                    {
                        "name": "left",
                        "path": str(media_root / "fembot_source_fitted_assembly_left.png"),
                    },
                    {
                        "name": "three_quarter",
                        "path": str(
                            media_root / "fembot_source_fitted_assembly_three_quarter.png"
                        ),
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    source_fit_image = Image.new("RGB", (32, 24), (30, 100, 120))
    source_fit_image.putpixel((3, 3), (230, 220, 70))
    source_fit_image.save(media_root / "fembot_source_fitted_left_toe.png")
    for index, name in enumerate(
        [
            "fembot_source_fitted_assembly_front.png",
            "fembot_source_fitted_assembly_left.png",
            "fembot_source_fitted_assembly_three_quarter.png",
        ]
    ):
        image = Image.new("RGB", (32, 24), (80, 30 + index * 20, 120))
        image.putpixel((4, 4), (235, 235, 80))
        image.save(media_root / name)

    report = build_fembot_media_review_proof(media_root=media_root, proof_path=proof_path)

    assert report["schema"] == "asimov-fembot-media-review-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["screenshot_count"] == 6
    assert report["summary"]["missing_screenshots"] == []
    assert report["summary"]["blank_screenshots"] == []
    assert report["summary"]["video_frame_count"] == 144
    assert report["summary"]["joint_count"] == 27
    assert report["summary"]["source_fitted_part_screenshot_count"] == 1
    assert report["summary"]["source_fitted_part_links"] == ["LEFT_TOE"]
    assert report["summary"]["missing_source_fitted_part_screenshots"] == []
    assert report["summary"]["blank_source_fitted_part_screenshots"] == []
    assert report["summary"]["source_fitted_visual_mjcf_replacements"] == 28
    assert report["summary"]["source_fitted_visual_mjcf_replacement_failures"] == 0
    assert report["summary"]["source_fitted_assembly_screenshot_count"] == 3
    assert report["summary"]["source_fitted_assembly_screenshot_names"] == [
        "front",
        "left",
        "three_quarter",
    ]
    assert report["summary"]["missing_source_fitted_assembly_screenshots"] == []
    assert report["summary"]["blank_source_fitted_assembly_screenshots"] == []


def test_fembot_media_review_reports_missing_round_media(tmp_path) -> None:
    report = build_fembot_media_review_proof(
        media_root=tmp_path / "missing-media",
        proof_path=tmp_path / "missing-proof.json",
    )

    assert report["ok"] is False
    assert len(report["summary"]["missing_screenshots"]) == 6
    assert report["summary"]["video_exists"] is False
    assert report["summary"]["joint_count"] is None
