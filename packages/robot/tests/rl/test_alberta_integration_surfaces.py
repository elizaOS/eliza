from __future__ import annotations

from pathlib import Path

from scripts.validate_alberta_integration_surfaces import (
    validate_alberta_integration_surfaces,
)


def test_alberta_integration_surfaces_accept_current_package() -> None:
    report = validate_alberta_integration_surfaces()

    assert report["ok"] is True
    assert all(report["checks"].values())
    assert report["console_scripts"]["eliza-robot-train-alberta"] is True
    assert report["console_scripts"]["eliza-robot-benchmark-alberta"] is True
    assert report["console_scripts"]["eliza-robot-validate-alberta-integration"] is True
    assert report["public_exports"]["AlbertaContinualController"] is True
    assert report["public_exports"]["ObstacleCourseEnv"] is True


def test_alberta_integration_surfaces_reject_missing_console_script(tmp_path: Path) -> None:
    pyproject = Path("pyproject.toml").read_text(encoding="utf-8")
    package = tmp_path / "robot"
    package.mkdir()
    (package / "pyproject.toml").write_text(
        pyproject.replace(
            'eliza-robot-train-alberta = "eliza_robot.rl.alberta.train_robot:main"\n',
            "",
        ),
        encoding="utf-8",
    )

    report = validate_alberta_integration_surfaces(package_root=package)

    assert report["ok"] is False
    assert report["checks"]["console_scripts"] is False
    assert report["console_scripts"]["eliza-robot-train-alberta"] is False
