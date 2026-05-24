#!/usr/bin/env python3
"""Validate Alberta framework integration surfaces in the robot package."""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT
REQUIRED_MODULES = (
    "eliza_robot.rl.alberta.agent",
    "eliza_robot.rl.alberta.baselines",
    "eliza_robot.rl.alberta.benchmark",
    "eliza_robot.rl.alberta.continual_env",
    "eliza_robot.rl.alberta.features",
    "eliza_robot.rl.alberta.loop",
    "eliza_robot.rl.alberta.metrics",
    "eliza_robot.rl.alberta.obstacle_course",
    "eliza_robot.rl.alberta.train_robot",
)
REQUIRED_PUBLIC_EXPORTS = (
    "AlbertaContinualController",
    "AlbertaControllerConfig",
    "FeatureConfig",
    "FeatureMap",
    "JointReachEnv",
    "ObstacleCourseEnv",
    "train_online",
    "evaluate",
    "compute_continual_metrics",
)
REQUIRED_CONSOLE_SCRIPTS = {
    "eliza-robot-train-alberta": "eliza_robot.rl.alberta.train_robot:main",
    "eliza-robot-benchmark-alberta": "eliza_robot.rl.alberta.benchmark:main",
    "eliza-robot-generate-alberta-report": "scripts.generate_alberta_end_to_end_report:main",
    "eliza-robot-render-alberta-obstacle-demo": "scripts.render_alberta_obstacle_demo:main",
    "eliza-robot-validate-alberta-benchmark": "scripts.validate_alberta_benchmark_artifacts:main",
    "eliza-robot-validate-alberta-checkpoint": "scripts.validate_alberta_robot_checkpoint:main",
    "eliza-robot-validate-alberta-vendoring": "scripts.validate_alberta_vendoring:main",
    "eliza-robot-validate-alberta-integration": "scripts.validate_alberta_integration_surfaces:main",
    "eliza-robot-audit-alberta-objective": "scripts.audit_alberta_objective_completion:main",
}


def _import_target(target: str) -> bool:
    module_name, _, attr = target.partition(":")
    try:
        module = importlib.import_module(module_name)
    except Exception:
        return False
    return bool(not attr or hasattr(module, attr))


def _pyproject(package_root: Path) -> dict[str, Any]:
    path = package_root / "pyproject.toml"
    if not path.is_file():
        return {}
    return tomllib.loads(path.read_text(encoding="utf-8"))


def validate_alberta_integration_surfaces(*, package_root: Path = PACKAGE_ROOT) -> dict[str, Any]:
    package_root = package_root.resolve()
    if str(package_root) not in sys.path:
        sys.path.insert(0, str(package_root))
    pyproject = _pyproject(package_root)
    dependencies = pyproject.get("project", {}).get("dependencies", [])
    scripts = pyproject.get("project", {}).get("scripts", {})
    modules = {
        module_name: _import_target(module_name)
        for module_name in REQUIRED_MODULES
    }
    alberta_pkg = importlib.import_module("eliza_robot.rl.alberta")
    public_exports = {
        name: hasattr(alberta_pkg, name)
        for name in REQUIRED_PUBLIC_EXPORTS
    }
    console_scripts = {
        name: scripts.get(name) == target and _import_target(target)
        for name, target in REQUIRED_CONSOLE_SCRIPTS.items()
    }
    files = {
        "README": (package_root / "eliza_robot" / "rl" / "alberta" / "README.md").is_file(),
        "package_init": (package_root / "eliza_robot" / "rl" / "alberta" / "__init__.py").is_file(),
        "train_robot": (package_root / "eliza_robot" / "rl" / "alberta" / "train_robot.py").is_file(),
        "benchmark": (package_root / "eliza_robot" / "rl" / "alberta" / "benchmark.py").is_file(),
    }
    checks = {
        "dependency": "alberta-framework" in dependencies,
        "source_override": (
            pyproject.get("tool", {})
            .get("uv", {})
            .get("sources", {})
            .get("alberta-framework")
            == {"path": "../alberta", "editable": True}
        ),
        "modules": all(modules.values()),
        "public_exports": all(public_exports.values()),
        "console_scripts": all(console_scripts.values()),
        "files": all(files.values()),
    }
    return {
        "schema": "robot-alberta-integration-surfaces-v1",
        "ok": all(checks.values()),
        "package_root": str(package_root),
        "checks": checks,
        "modules": modules,
        "public_exports": public_exports,
        "console_scripts": console_scripts,
        "files": files,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", type=Path, default=PACKAGE_ROOT)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    report = validate_alberta_integration_surfaces(package_root=args.package_root)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
