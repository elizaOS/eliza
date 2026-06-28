#!/usr/bin/env python3
"""Fail-closed environment check for generating ElizaRocketConfig with Verilator."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/generators/chipyard/eliza-rocket-manifest.json"
checkout_env = os.environ.get("CHIPYARD_CHECKOUT")
CHECKOUT = (
    Path(checkout_env).resolve()
    if checkout_env and Path(checkout_env).is_absolute()
    else (ROOT / (checkout_env or "external/chipyard")).resolve()
)
REPORT = ROOT / "build/chipyard/eliza_rocket/verilator-preflight.json"
CONFIG = "ElizaRocketConfig"
CONFIG_PACKAGE = "eliza"
SIM_DIR = CHECKOUT / "sims/verilator"
MIN_FREE_GIB = int(os.environ.get("CHIPYARD_VERILATOR_MIN_FREE_GIB", "20"))
REQUIRED_RECURSIVE_SUBMODULE_ROOTS = ("generators/rocket-chip",)
REQUIRED_TOP_LEVEL_SUBMODULE_ROOTS = (
    "generators/ara",
    "generators/cva6",
    "generators/ibex",
    "generators/nvdla",
    "sims/firesim",
    "toolchains/riscv-tools/riscv-isa-sim",
    "tools/DRAMSim2",
    "tools/cde",
    "tools/dsptools",
    "tools/fixedpoint",
    "tools/firrtl2",
    "tools/rocket-dsp-utils",
    "tools/torture",
)

BUILD_COMMAND = [
    f"cd {CHECKOUT.relative_to(ROOT) if CHECKOUT.is_relative_to(ROOT) else CHECKOUT}/sims/verilator",
    "source ../../env.sh",
    "make CONFIG=ElizaRocketConfig CONFIG_PACKAGE=eliza",
]
VERILOG_COMMAND = [
    f"cd {CHECKOUT.relative_to(ROOT) if CHECKOUT.is_relative_to(ROOT) else CHECKOUT}/sims/verilator",
    "source ../../env.sh",
    "make CONFIG=ElizaRocketConfig CONFIG_PACKAGE=eliza verilog",
]


def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd or ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_manifest(errors: list[str]) -> dict[str, object]:
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"missing manifest: {rel(MANIFEST)}")
    except json.JSONDecodeError as exc:
        errors.append(f"{rel(MANIFEST)} is invalid JSON: {exc}")
    return {}


def submodule_problems() -> dict[str, list[str]]:
    status = run(
        ["git", "submodule", "status", "--recursive", *REQUIRED_RECURSIVE_SUBMODULE_ROOTS],
        cwd=CHECKOUT,
    )
    problems: dict[str, list[str]] = {"missing": [], "drifted": [], "conflicts": []}
    if status.returncode != 0:
        problems["conflicts"].append("could not read recursive submodule status")
        return problems
    for line in status.stdout.splitlines():
        if not line:
            continue
        fields = line[1:].strip().split()
        path = fields[1] if len(fields) >= 2 else line
        if line.startswith("-"):
            problems["missing"].append(path)
        elif line.startswith("+"):
            problems["drifted"].append(path)
        elif line.startswith("U"):
            problems["conflicts"].append(path)
    return problems


def top_level_submodule_problems() -> dict[str, list[str]]:
    status = run(
        ["git", "submodule", "status", *REQUIRED_TOP_LEVEL_SUBMODULE_ROOTS],
        cwd=CHECKOUT,
    )
    problems: dict[str, list[str]] = {"missing": [], "drifted": [], "conflicts": []}
    if status.returncode != 0:
        problems["conflicts"].append("could not read top-level submodule status")
        return problems
    for line in status.stdout.splitlines():
        if not line:
            continue
        fields = line[1:].strip().split()
        path = fields[1] if len(fields) >= 2 else line
        if line.startswith("-"):
            problems["missing"].append(path)
        elif line.startswith("+"):
            problems["drifted"].append(path)
        elif line.startswith("U"):
            problems["conflicts"].append(path)
    return problems


def direct_generator_submodule_problems() -> dict[str, list[str]]:
    status = run(["git", "submodule", "status", "generators"], cwd=CHECKOUT)
    problems: dict[str, list[str]] = {"missing": [], "drifted": [], "conflicts": []}
    if status.returncode != 0:
        problems["conflicts"].append("could not read direct generator submodule status")
        return problems
    for line in status.stdout.splitlines():
        if not line:
            continue
        fields = line[1:].strip().split()
        path = fields[1] if len(fields) >= 2 else line
        if line.startswith("-"):
            problems["missing"].append(path)
        elif line.startswith("+"):
            problems["drifted"].append(path)
        elif line.startswith("U"):
            problems["conflicts"].append(path)
    return problems


def tool_path(name: str) -> str | None:
    repo_tool_candidates = [
        ROOT / "tools/bin" / name,
        ROOT / "external/oss-cad-suite/bin" / name,
        ROOT / ".venv/bin" / name,
    ]
    if name == "firtool":
        repo_tool_candidates.append(ROOT / "external/circt/bin/firtool")
    if name == "java":
        jdk17_java = Path("/opt/homebrew/opt/openjdk@17/bin/java")
        if jdk17_java.is_file():
            return str(jdk17_java)
    for candidate in repo_tool_candidates:
        if candidate.is_file():
            return str(candidate)
    return shutil.which(name)


def first_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def gibibytes(byte_count: int) -> float:
    return byte_count / (1024**3)


def disk_space_blocker(free_bytes: int, min_free_gib: int = MIN_FREE_GIB) -> str | None:
    if free_bytes >= min_free_gib * 1024**3:
        return None
    return (
        "insufficient free disk for Chipyard setup/generation: "
        f"{gibibytes(free_bytes):.2f} GiB free, "
        f"{min_free_gib} GiB required by this preflight"
    )


def main() -> int:
    errors: list[str] = []
    blockers: list[str] = []
    checks: dict[str, object] = {}

    manifest = load_manifest(errors)
    chipyard_value = manifest.get("chipyard", {}) if manifest else {}
    selected_value = manifest.get("selected_path", {}) if manifest else {}
    chipyard = chipyard_value if isinstance(chipyard_value, dict) else {}
    selected = selected_value if isinstance(selected_value, dict) else {}

    checks["commands"] = {
        "verilator_simulator": " && ".join(BUILD_COMMAND),
        "verilog_only": " && ".join(VERILOG_COMMAND),
    }
    disk_usage = shutil.disk_usage(ROOT)
    checks["disk_free_gib"] = round(gibibytes(disk_usage.free), 2)
    checks["disk_required_free_gib"] = MIN_FREE_GIB
    if blocker := disk_space_blocker(disk_usage.free):
        blockers.append(blocker)
    checks["required_recursive_submodule_roots"] = list(REQUIRED_RECURSIVE_SUBMODULE_ROOTS)
    checks["required_top_level_submodule_roots"] = list(REQUIRED_TOP_LEVEL_SUBMODULE_ROOTS)

    if selected.get("config_name") != CONFIG:
        errors.append(f"selected config must be {CONFIG}")
    if selected.get("package_name") != CONFIG_PACKAGE:
        errors.append(f"selected config package must be {CONFIG_PACKAGE}")

    if not CHECKOUT.is_dir():
        blockers.append(f"missing Chipyard checkout: {rel(CHECKOUT)}")
    else:
        head = run(["git", "rev-parse", "HEAD"], cwd=CHECKOUT)
        checks["checkout_head"] = head.stdout.strip()
        if head.returncode != 0:
            errors.append("could not read Chipyard checkout HEAD")
        elif chipyard.get("commit") and head.stdout.strip() != chipyard.get("commit"):
            errors.append(
                f"checkout HEAD is {head.stdout.strip()}, expected {chipyard.get('commit')}"
            )

        problems = submodule_problems()
        checks["submodule_problems"] = problems
        for path in problems["missing"]:
            errors.append(f"Chipyard recursive submodule is not initialized: {path}")
        for path in problems["drifted"]:
            errors.append(f"Chipyard recursive submodule is not at recorded SHA: {path}")
        for path in problems["conflicts"]:
            errors.append(f"Chipyard recursive submodule has conflict or status error: {path}")

        top_level_problems = top_level_submodule_problems()
        checks["top_level_submodule_problems"] = top_level_problems
        for path in top_level_problems["missing"]:
            errors.append(f"Chipyard top-level submodule is not initialized: {path}")
        for path in top_level_problems["drifted"]:
            errors.append(f"Chipyard top-level submodule is not at recorded SHA: {path}")
        for path in top_level_problems["conflicts"]:
            errors.append(f"Chipyard top-level submodule has conflict or status error: {path}")

        generator_problems = direct_generator_submodule_problems()
        checks["direct_generator_submodule_problems"] = generator_problems
        for path in generator_problems["missing"]:
            errors.append(f"Chipyard generator submodule is not initialized: {path}")
        for path in generator_problems["drifted"]:
            errors.append(f"Chipyard generator submodule is not at recorded SHA: {path}")
        for path in generator_problems["conflicts"]:
            errors.append(f"Chipyard generator submodule has conflict or status error: {path}")

    for relative in (
        "sims/verilator/Makefile",
        "common.mk",
        "variables.mk",
        "generators/ara/chipyard.mk",
        "generators/cva6/chipyard.mk",
        "generators/ibex/chipyard.mk",
        "generators/nvdla/chipyard.mk",
        "generators/tracegen/tracegen.mk",
        "generators/chipyard/src/main/scala",
        "generators/rocket-chip/src/main/resources/vsrc/TestDriver.v",
        "sims/firesim/sim/midas/targetutils/src/main/scala",
        "tools/DRAMSim2/Makefile",
        "tools/cde/cde/src/chipsalliance/rocketchip/config.scala",
        "tools/dsptools/src/main/scala",
        "tools/fixedpoint/src/main/scala",
        "tools/rocket-dsp-utils/src/main/scala",
        "tools/torture.mk",
    ):
        checkout_path = CHECKOUT / relative
        checks[f"exists:{relative}"] = checkout_path.exists()
        if CHECKOUT.is_dir() and not checkout_path.exists():
            errors.append(f"Chipyard checkout lacks required Verilator path: {relative}")

    config_sources = selected.get("config_sources", [])
    config_source_checks: list[dict[str, object]] = []
    checks["config_sources"] = config_source_checks
    if not isinstance(config_sources, list) or not config_sources:
        errors.append("selected_path.config_sources must list the ElizaRocketConfig overlay")
    else:
        for entry in config_sources:
            source = ROOT / str(entry.get("source", ""))
            destination = CHECKOUT / str(entry.get("checkout_destination", ""))
            record = {
                "source": rel(source),
                "destination": rel(destination),
                "source_exists": source.is_file(),
                "destination_exists": destination.is_file(),
                "matches": False,
            }
            if not source.is_file():
                errors.append(f"missing config overlay source: {rel(source)}")
            elif not destination.is_file():
                blockers.append(
                    f"ElizaRocketConfig is not installed in checkout: {rel(destination)}"
                )
            else:
                record["matches"] = source.read_bytes() == destination.read_bytes()
                if not record["matches"]:
                    errors.append(
                        f"installed ElizaRocketConfig differs from repo source: {rel(destination)}"
                    )
            config_source_checks.append(record)

    for tool in ("ar", "make", "java", "verilator", "firtool"):
        resolved_tool = tool_path(tool)
        checks[f"tool:{tool}"] = resolved_tool
        if resolved_tool is None:
            blockers.append(f"missing required tool on PATH: {tool}")

    java_path = tool_path("java")
    if java_path:
        java_version = run([java_path, "-version"])
        checks["java_version"] = first_line(java_version.stdout)
        if java_version.returncode != 0:
            blockers.append("java is on PATH but `java -version` fails")

    sbt_launcher = CHECKOUT / "scripts/sbt-launch.jar"
    checks["exists:scripts/sbt-launch.jar"] = sbt_launcher.is_file()
    checks["tool:sbt"] = tool_path("sbt")
    checks["sbt_invocation"] = "java -jar external/chipyard/scripts/sbt-launch.jar"
    if CHECKOUT.is_dir() and not sbt_launcher.is_file():
        blockers.append("missing Chipyard SBT launcher: external/chipyard/scripts/sbt-launch.jar")

    riscv = os.environ.get("RISCV", "")
    if not riscv:
        default_riscv = Path("/opt/homebrew")
        if any(
            (default_riscv / f"bin/{name}").exists()
            for name in (
                "riscv64-unknown-elf-gcc",
                "riscv64-elf-gcc",
                "riscv64-linux-gnu-gcc",
            )
        ):
            riscv = str(default_riscv)
        elif any(
            (ROOT / f"tools/bin/{name}").is_file()
            for name in (
                "riscv64-unknown-elf-gcc",
                "riscv64-elf-gcc",
                "riscv64-linux-gnu-gcc",
            )
        ):
            riscv = str(ROOT / "tools")
        elif (ROOT / "external/riscv64-linux-gnu/usr/bin/riscv64-linux-gnu-gcc").is_file():
            riscv = str(ROOT / "external/riscv64-linux-gnu/usr")
    checks["env:RISCV"] = riscv
    if not riscv:
        blockers.append(
            "RISCV is unset; exact verilog target stops in external/chipyard/common.mk "
            "before Java/SBT elaboration"
        )
    else:
        toolchain_candidates = [
            Path(riscv) / "bin/riscv64-unknown-elf-gcc",
            Path(riscv) / "bin/riscv64-elf-gcc",
            Path(riscv) / "bin/riscv64-linux-gnu-gcc",
        ]
        found_gcc = next(
            (candidate for candidate in toolchain_candidates if candidate.exists()), None
        )
        checks["tool:RISCV/bin/riscv64-gcc"] = str(found_gcc) if found_gcc else None
        checks["tool:RISCV/bin/riscv64-gcc_candidates"] = [
            str(candidate) for candidate in toolchain_candidates
        ]
        if found_gcc is None:
            blockers.append(
                "missing RISC-V toolchain under RISCV; expected one of: "
                + ", ".join(str(candidate) for candidate in toolchain_candidates)
            )
        fesvr_header = Path(riscv) / "include/fesvr/memif.h"
        spike_cfg_header = Path(riscv) / "include/riscv/cfg.h"
        fesvr_library = Path(riscv) / "lib/libfesvr.a"
        spike_library = Path(riscv) / "lib/libriscv.a"
        checks["exists:RISCV/include/fesvr/memif.h"] = fesvr_header.is_file()
        checks["exists:RISCV/include/riscv/cfg.h"] = spike_cfg_header.is_file()
        checks["exists:RISCV/lib/libfesvr.a"] = fesvr_library.is_file()
        checks["exists:RISCV/lib/libriscv.a"] = spike_library.is_file()
        if not fesvr_header.is_file():
            blockers.append(
                "missing FESVR header under RISCV: "
                f"{fesvr_header}; build/install Chipyard riscv-isa-sim collateral"
            )
        if not spike_cfg_header.is_file():
            blockers.append(
                "missing Spike transitive header under RISCV: "
                f"{spike_cfg_header}; build/install Chipyard riscv-isa-sim collateral"
            )
        if not fesvr_library.is_file():
            blockers.append(
                "missing FESVR static library under RISCV: "
                f"{fesvr_library}; build/install Chipyard riscv-isa-sim collateral"
            )
        if not spike_library.is_file():
            blockers.append(
                "missing Spike static library under RISCV: "
                f"{spike_library}; build/install Chipyard riscv-isa-sim collateral"
            )
        elif ar_path := checks.get("tool:ar"):
            spike_archive = run([str(ar_path), "t", str(spike_library)])
            if spike_archive.returncode != 0:
                blockers.append(f"cannot inspect Spike static library: {spike_library}")
            else:
                members = set(spike_archive.stdout.splitlines())
                excluded_members = {"remote_bitbang.o", "sim.o", "interactive.o"}
                required_members = {
                    "disasm.o",
                    "isa_parser.o",
                    "fdt.o",
                    "f32_add.o",
                    "softfloat_state.o",
                }
                present_excluded = sorted(excluded_members & members)
                missing_required = sorted(required_members - members)
                checks["archive:RISCV/lib/libriscv.a/excluded_members_present"] = present_excluded
                checks["archive:RISCV/lib/libriscv.a/missing_required_members"] = missing_required
                if present_excluded:
                    blockers.append(
                        "Spike static library contains standalone simulator objects "
                        f"that conflict with Chipyard Verilator collateral: {present_excluded}; "
                        "run scripts/prepare_chipyard_spike_libraries.py"
                    )
                if missing_required:
                    blockers.append(
                        "Spike static library is missing companion archive objects "
                        f"needed by the generated Verilator link: {missing_required}; "
                        "run scripts/prepare_chipyard_spike_libraries.py"
                    )

    env_sh = CHECKOUT / "env.sh"
    checks["exists:env.sh"] = env_sh.is_file()
    if CHECKOUT.is_dir() and not env_sh.is_file():
        blockers.append(
            "missing external/chipyard/env.sh; run Chipyard environment setup after submodules are clean"
        )

    report = {
        "schema": "eliza.cpu_ap_chipyard_verilator_preflight.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "status": "fail" if errors else "blocked" if blockers else "pass",
        "manifest": rel(MANIFEST),
        "checkout": rel(CHECKOUT),
        "config": CONFIG,
        "config_package": CONFIG_PACKAGE,
        "errors": errors,
        "blockers": blockers,
        "checks": checks,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if errors:
        print("STATUS: FAIL chipyard.verilator_preflight - checkout is not ready")
        for error in errors:
            print(f"  - {error}")
        if blockers:
            print("BLOCKERS:")
            for blocker in blockers:
                print(f"  - {blocker}")
        print(f"REPORT: {rel(REPORT)}")
        return 1
    if blockers:
        print("STATUS: BLOCKED chipyard.verilator_preflight - environment is not ready")
        for blocker in blockers:
            print(f"  - {blocker}")
        print("COMMAND:")
        print(f"  {' && '.join(VERILOG_COMMAND)}")
        print(f"REPORT: {rel(REPORT)}")
        return 1

    print("STATUS: PASS chipyard.verilator_preflight - ready to generate Verilator artifacts")
    print("COMMAND:")
    print(f"  {' && '.join(VERILOG_COMMAND)}")
    print(f"REPORT: {rel(REPORT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
