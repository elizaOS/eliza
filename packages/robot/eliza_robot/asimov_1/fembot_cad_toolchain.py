"""Command-line CAD toolchain readiness proof for ASIMOV fembot."""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ROBOT_PACKAGE_ROOT
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

CAD_TOOLCHAIN_SCHEMA = "asimov-fembot-cad-toolchain-readiness-v1"

REQUIRED_CAPABILITIES = (
    "cli_only",
    "step_import",
    "step_export",
    "section_loft",
    "sweep",
    "booleans",
    "shell_or_thicken",
    "face_edge_selection",
)

FREECADCMD_CANDIDATES = (
    Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd"),
    Path("/Applications/FreeCAD.app/Contents/Resources/bin/FreeCADCmd"),
    Path("/opt/homebrew/bin/freecadcmd"),
    Path("/opt/homebrew/bin/FreeCADCmd"),
)

FEMBOT_CAD_ENV_ROOT = ROBOT_PACKAGE_ROOT / "cad" / "asimov-fembot" / "cad-env"
FEMBOT_CAD_ENV_VENV = FEMBOT_CAD_ENV_ROOT / ".venv"
FEMBOT_CAD_ENV_REQUIREMENTS = FEMBOT_CAD_ENV_ROOT / "requirements.txt"


def _module_available(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _package_version(package: str) -> str | None:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def _freecadcmd_path() -> str | None:
    for path in FREECADCMD_CANDIDATES:
        if path.is_file():
            return str(path)
    return None


def _candidate(
    *,
    name: str,
    package: str,
    module: str,
    known_capabilities: dict[str, bool],
    role: str,
    notes: str,
) -> dict[str, Any]:
    installed = _module_available(module)
    version = _package_version(package) if installed else None
    capability_status = {
        capability: bool(installed and known_capabilities.get(capability))
        for capability in REQUIRED_CAPABILITIES
    }
    ready = installed and all(capability_status.values())
    return {
        "name": name,
        "package": package,
        "module": module,
        "installed": installed,
        "version": version,
        "role": role,
        "capabilities": capability_status,
        "ready": ready,
        "notes": notes,
    }


def _probe_python_modules(python: Path, *, timeout_s: int = 20) -> dict[str, Any]:
    if not python.is_file():
        return {
            "python": str(python),
            "exists": False,
            "import_ok": False,
            "modules": {},
            "error": "python executable not found",
        }
    code = """
import importlib.metadata
import importlib.util
import json

packages = {
    "cadquery": ("cadquery", "cadquery"),
    "build123d": ("build123d", "build123d"),
    "cadquery-ocp": ("OCP", "cadquery-ocp"),
    "pycad": ("pycad", "pycad"),
}
modules = {}
for package, (module, distribution) in packages.items():
    installed = importlib.util.find_spec(module) is not None
    version = None
    if installed:
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            version = None
    modules[package] = {"module": module, "installed": installed, "version": version}
print(json.dumps({"modules": modules}, sort_keys=True))
"""
    try:
        proc = subprocess.run(
            [str(python), "-c", code],
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "python": str(python),
            "exists": True,
            "import_ok": False,
            "modules": {},
            "error": f"{type(exc).__name__}: {exc}",
        }
    if proc.returncode != 0:
        return {
            "python": str(python),
            "exists": True,
            "import_ok": False,
            "modules": {},
            "error": proc.stderr.strip() or proc.stdout.strip(),
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "python": str(python),
            "exists": True,
            "import_ok": False,
            "modules": {},
            "error": f"JSONDecodeError: {exc}",
        }
    return {
        "python": str(python),
        "exists": True,
        "import_ok": True,
        "modules": parsed.get("modules", {}),
        "error": None,
    }


def isolated_cad_env_status(
    *,
    env_root: Path = FEMBOT_CAD_ENV_ROOT,
    venv: Path = FEMBOT_CAD_ENV_VENV,
    requirements: Path = FEMBOT_CAD_ENV_REQUIREMENTS,
) -> dict[str, Any]:
    python = venv / "bin" / "python"
    probe = _probe_python_modules(python)
    modules = probe.get("modules", {})
    preferred_ready = [
        package
        for package in ("cadquery", "build123d")
        if modules.get(package, {}).get("installed")
    ]
    kernel_ready = bool(modules.get("cadquery-ocp", {}).get("installed"))
    return {
        "env_root": str(env_root),
        "venv": str(venv),
        "python": str(python),
        "requirements": str(requirements),
        "requirements_exists": requirements.is_file(),
        "exists": venv.is_dir(),
        "probe": probe,
        "preferred_ready": preferred_ready,
        "kernel_ready": kernel_ready,
        "ready": bool(preferred_ready and kernel_ready),
        "provision_command": (
            f"uv venv {venv} --python 3.12 && "
            f"uv pip install --python {python} -r {requirements}"
        ),
    }


def _cadquery_capability_smoke(
    python: Path,
    *,
    timeout_s: int = 60,
) -> dict[str, Any]:
    if not python.is_file():
        return {
            "ok": False,
            "python": str(python),
            "backend": "cadquery",
            "capabilities": {capability: False for capability in REQUIRED_CAPABILITIES},
            "error": "python executable not found",
        }
    code = r"""
import json
import math
import sys
from pathlib import Path

import cadquery as cq
from cadquery import exporters, importers

root = Path(sys.argv[1])
step_path = root / "cadquery_cli_capability.step"

capabilities = {}
metrics = {}

box = cq.Workplane("XY").box(1.0, 2.0, 3.0)
exporters.export(box, str(step_path))
capabilities["cli_only"] = True
capabilities["step_export"] = step_path.is_file() and step_path.stat().st_size > 0

imported = importers.importStep(str(step_path))
metrics["imported_box_volume"] = float(imported.val().Volume())
capabilities["step_import"] = math.isfinite(metrics["imported_box_volume"]) and metrics["imported_box_volume"] > 5.9

loft = cq.Workplane("XY").circle(0.5).workplane(offset=1.0).circle(0.25).loft(combine=True)
metrics["loft_volume"] = float(loft.val().Volume())
capabilities["section_loft"] = math.isfinite(metrics["loft_volume"]) and metrics["loft_volume"] > 0.0

path = cq.Workplane("XY").moveTo(0.0, 0.0).lineTo(0.0, 1.0).lineTo(1.0, 1.0).val()
sweep = cq.Workplane("YZ").circle(0.05).sweep(path)
metrics["sweep_volume"] = float(sweep.val().Volume())
capabilities["sweep"] = math.isfinite(metrics["sweep_volume"]) and metrics["sweep_volume"] > 0.0

cut = cq.Workplane("XY").box(1.0, 1.0, 1.0).faces(">Z").workplane().circle(0.2).cutThruAll()
metrics["boolean_cut_volume"] = float(cut.val().Volume())
capabilities["booleans"] = math.isfinite(metrics["boolean_cut_volume"]) and 0.0 < metrics["boolean_cut_volume"] < 1.0

shell = cq.Workplane("XY").box(1.0, 1.0, 1.0).faces(">Z").shell(0.05)
metrics["shell_volume"] = float(shell.val().Volume())
capabilities["shell_or_thicken"] = math.isfinite(metrics["shell_volume"]) and 0.0 < metrics["shell_volume"] < 1.0

metrics["selected_faces"] = len(cut.faces(">Z").vals())
metrics["selected_edges"] = len(cut.edges("|Z").vals())
capabilities["face_edge_selection"] = metrics["selected_faces"] > 0 and metrics["selected_edges"] > 0

print(json.dumps({"capabilities": capabilities, "metrics": metrics}, sort_keys=True))
"""
    with tempfile.TemporaryDirectory(prefix="asimov-fembot-cadquery-smoke-") as tmp:
        try:
            proc = subprocess.run(
                [str(python), "-c", code, tmp],
                text=True,
                capture_output=True,
                check=False,
                timeout=timeout_s,
            )
        except Exception as exc:
            return {
                "ok": False,
                "python": str(python),
                "backend": "cadquery",
                "capabilities": {capability: False for capability in REQUIRED_CAPABILITIES},
                "error": f"{type(exc).__name__}: {exc}",
            }
    if proc.returncode != 0:
        return {
            "ok": False,
            "python": str(python),
            "backend": "cadquery",
            "capabilities": {capability: False for capability in REQUIRED_CAPABILITIES},
            "error": proc.stderr.strip() or proc.stdout.strip(),
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "python": str(python),
            "backend": "cadquery",
            "capabilities": {capability: False for capability in REQUIRED_CAPABILITIES},
            "error": f"JSONDecodeError: {exc}",
        }
    capabilities = {
        capability: bool(parsed.get("capabilities", {}).get(capability))
        for capability in REQUIRED_CAPABILITIES
    }
    return {
        "ok": all(capabilities.values()),
        "python": str(python),
        "backend": "cadquery",
        "capabilities": capabilities,
        "metrics": parsed.get("metrics", {}),
        "error": None,
    }


def build_fembot_cad_toolchain_readiness_proof() -> dict[str, Any]:
    """Return command-line CAD readiness for fembot generation.

    FreeCAD is intentionally not a preferred backend. It is listed only so the
    proof records that a fallback may exist while the production route remains
    pure command-line Python CAD.
    """
    full_occ_capabilities = {capability: True for capability in REQUIRED_CAPABILITIES}
    candidates = [
        _candidate(
            name="CadQuery/OCP",
            package="cadquery",
            module="cadquery",
            known_capabilities=full_occ_capabilities,
            role="preferred",
            notes=(
                "Repo precedent exists in the Unitree R1 bodykit generator for "
                "section lofts and STEP export through CadQuery/OCP."
            ),
        ),
        _candidate(
            name="build123d",
            package="build123d",
            module="build123d",
            known_capabilities=full_occ_capabilities,
            role="preferred",
            notes="Python/OCP CAD DSL suitable for command-line STEP solids and lofted shells.",
        ),
        _candidate(
            name="OCP",
            package="cadquery-ocp",
            module="OCP",
            known_capabilities=full_occ_capabilities,
            role="kernel",
            notes="Raw OpenCascade bindings; acceptable for lower-level import/export, lofts, booleans, and shell operations.",
        ),
        _candidate(
            name="pycad",
            package="pycad",
            module="pycad",
            known_capabilities={
                "cli_only": True,
                "step_import": False,
                "step_export": False,
                "section_loft": False,
                "sweep": False,
                "booleans": False,
                "shell_or_thicken": False,
                "face_edge_selection": False,
            },
            role="candidate_needs_capability_proof",
            notes=(
                "PyPI currently exposes pycad as a minimal 0.0.0.1 package; do not "
                "select it for fembot until it proves OpenCascade-grade STEP import, "
                "STEP export, loft, sweep, boolean, shell/thicken, and face/edge APIs."
            ),
        ),
    ]
    preferred_ready = [candidate for candidate in candidates if candidate["role"] == "preferred" and candidate["ready"]]
    any_python_occ_ready = [candidate for candidate in candidates if candidate["ready"]]
    isolated_env = isolated_cad_env_status()
    capability_smoke = _cadquery_capability_smoke(Path(isolated_env["python"]))
    isolated_preferred_ready = len(isolated_env["preferred_ready"])
    freecadcmd = _freecadcmd_path()
    accepted = bool((preferred_ready or isolated_env["ready"]) and capability_smoke["ok"])
    return {
        "schema": CAD_TOOLCHAIN_SCHEMA,
        "ok": True,
        "accepted": accepted,
        "required_capabilities": list(REQUIRED_CAPABILITIES),
        "selected_backend": (
            preferred_ready[0]["name"]
            if preferred_ready
            else isolated_env["preferred_ready"][0]
            if isolated_env["preferred_ready"]
            else None
        ),
        "summary": {
            "preferred_ready": len(preferred_ready),
            "isolated_preferred_ready": isolated_preferred_ready,
            "isolated_env_ready": bool(isolated_env["ready"]),
            "cadquery_cli_capability_smoke_ok": bool(capability_smoke["ok"]),
            "python_occ_ready": len(any_python_occ_ready),
            "pycad_ready": any(
                candidate["name"] == "pycad" and candidate["ready"] for candidate in candidates
            ),
            "freecadcmd_detected": freecadcmd is not None,
            "freecad_role": "fallback_only_not_preferred",
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else (
                "no preferred command-line Python/OCC CAD backend is installed in "
                "the robot virtualenv or isolated fembot CAD env, or the selected "
                "backend failed the STEP import/export, loft, sweep, boolean, "
                "shell/thicken, and face/edge selection smoke proof; provision "
                "CadQuery/OCP, build123d, or a pycad package that proves all "
                "required capabilities"
            ),
        },
        "candidates": candidates,
        "isolated_env": isolated_env,
        "capability_smoke": capability_smoke,
        "freecad_fallback": {
            "freecadcmd": freecadcmd,
            "detected": freecadcmd is not None,
            "role": "fallback_only_not_preferred",
            "reason": "previous FreeCAD workflow was brittle; fembot production CAD should run through CLI Python/OCC.",
        },
    }


def dump_fembot_cad_toolchain_readiness_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_cad_toolchain_readiness_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-cad-toolchain.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_cad_toolchain_readiness_proof_json(report), encoding="utf-8")
    return output
