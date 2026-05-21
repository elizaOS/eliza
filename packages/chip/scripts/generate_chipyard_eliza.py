#!/usr/bin/env python3
"""Generate and import the pinned ElizaRocketConfig Chipyard artifacts."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKOUT = Path(os.environ.get("CHIPYARD_CHECKOUT", ROOT / "external/chipyard"))
CHIPYARD_GEN = (
    CHECKOUT / "sims/verilator/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig"
)
OUT = ROOT / "build/chipyard/eliza_rocket"
IMPORTED_GEN = OUT / "generated-src"
FIRTOOL_OUT = OUT / "firtool-out/eliza_rocket_ap.sv"
VERILOG = OUT / "eliza_rocket_ap.v"
DTS = OUT / "eliza-e1.dts"
SIMULATOR_DIR = OUT / "simulator"
CHIPYARD_SIMULATOR = CHECKOUT / "sims/verilator/simulator-chipyard.harness-ElizaRocketConfig"
MANIFEST = OUT / "ElizaRocketConfig.manifest.json"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(command: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> str:
    proc = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if proc.returncode != 0:
        print(proc.stdout, end="")
        raise SystemExit(proc.returncode)
    return proc.stdout


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(child for child in path.rglob("*") if child.is_file()):
        digest.update(item.relative_to(path).as_posix().encode())
        digest.update(b"\0")
        digest.update(sha256_file(item).encode())
        digest.update(b"\0")
    return digest.hexdigest()


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def env_with_tools() -> dict[str, str]:
    env = os.environ.copy()
    java_home = Path("/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home")
    if java_home.exists():
        env["JAVA_HOME"] = str(java_home)
        env["PATH"] = f"/opt/homebrew/opt/openjdk@17/bin:{env.get('PATH', '')}"
    for tool_dir in (
        ROOT / "external/oss-cad-suite/bin",
        ROOT / "external/circt/bin",
        ROOT / "tools/bin",
        ROOT / ".venv/bin",
    ):
        if tool_dir.exists():
            env["PATH"] = f"{tool_dir}:{env.get('PATH', '')}"
    env.setdefault("RISCV", str(ROOT / "tools"))
    env.setdefault("CHIPYARD_CHECKOUT", str(CHECKOUT))
    return env


def stage_bootroms() -> None:
    CHIPYARD_GEN.mkdir(parents=True, exist_ok=True)
    source_dir = CHECKOUT / "generators/testchipip/src/main/resources/testchipip/bootrom"
    for name in ("bootrom.rv64.img", "bootrom.rv32.img"):
        shutil.copy2(source_dir / name, CHIPYARD_GEN / name)


def run_generator(env: dict[str, str]) -> None:
    command = [
        "java",
        "-jar",
        "scripts/sbt-launch.jar",
        "-Dsbt.ivy.home=.ivy2-eliza",
        "-Dsbt.global.base=.sbt-eliza",
        "-Dsbt.boot.directory=.sbt-eliza/boot/",
        "-Dsbt.color=always",
        "-Dsbt.supershell=false",
        ";project chipyard; runMain chipyard.Generator "
        f"--target-dir {CHIPYARD_GEN} "
        "--name chipyard.harness.TestHarness.ElizaRocketConfig "
        "--top-module chipyard.harness.TestHarness "
        "--legacy-configs eliza:ElizaRocketConfig",
    ]
    log = run(command, cwd=CHECKOUT, env=env)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "chipyard-generator.log").write_text(log, encoding="utf-8")


def import_artifacts(env: dict[str, str]) -> None:
    if IMPORTED_GEN.exists():
        shutil.rmtree(IMPORTED_GEN)
    shutil.copytree(CHIPYARD_GEN, IMPORTED_GEN)
    shutil.copy2(CHIPYARD_GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.dts", DTS)
    FIRTOOL_OUT.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "firtool",
            "--format=fir",
            "--warn-on-unprocessed-annotations",
            "--disable-annotation-classless",
            "--disable-annotation-unknown",
            "--lowering-options=emittedLineLength=2048,noAlwaysComb,disallowLocalVariables,"
            "verifLabels,disallowPortDeclSharing,locationInfoStyle=wrapInAtSquareBracket",
            "--repl-seq-mem",
            f"--repl-seq-mem-file={OUT / 'eliza_rocket_ap.mems.conf'}",
            "-o",
            str(FIRTOOL_OUT),
            str(IMPORTED_GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.fir"),
        ],
        env=env,
    )
    wrapper = (
        "\nmodule eliza_rocket_ap(\n"
        "  input clock,\n"
        "  input reset,\n"
        "  output io_success\n"
        ");\n"
        "  TestHarness dut (\n"
        "    .clock(clock),\n"
        "    .reset(reset),\n"
        "    .io_success(io_success)\n"
        "  );\n"
        "endmodule\n"
    )
    VERILOG.write_text(FIRTOOL_OUT.read_text(encoding="utf-8") + wrapper, encoding="utf-8")
    SIMULATOR_DIR.mkdir(parents=True, exist_ok=True)
    if CHIPYARD_SIMULATOR.is_file():
        shutil.copy2(CHIPYARD_SIMULATOR, SIMULATOR_DIR / CHIPYARD_SIMULATOR.name)
    (SIMULATOR_DIR / "README.md").write_text(
        "Generated AP collateral import directory. The simulator executable is copied "
        "from external/chipyard/sims/verilator only when that host build artifact exists; "
        "Linux boot remains gated by external transcripts.\n",
        encoding="utf-8",
    )


def require_simulator_executable() -> None:
    executables = [
        item for item in SIMULATOR_DIR.rglob("*") if item.is_file() and item.stat().st_mode & 0o111
    ]
    if not executables:
        raise SystemExit(
            "STATUS: BLOCKED chipyard.eliza_generate - generated RTL/DTS collateral exists, "
            f"but {rel(SIMULATOR_DIR)} lacks an executable Verilator simulator"
        )


def write_manifest(env: dict[str, str]) -> None:
    selected = json.loads(
        (ROOT / "docs/generators/chipyard/eliza-rocket-manifest.json").read_text()
    )
    evidence_manifest = json.loads(
        (ROOT / "docs/evidence/cpu-ap-evidence-manifest.json").read_text()
    )
    submodules = run(["git", "submodule", "status", "--recursive"], cwd=CHECKOUT).splitlines()
    tool_versions = {
        "java": run(["java", "-version"], cwd=ROOT, env=env).strip().splitlines()[0],
        "firtool": run(["firtool", "--version"], cwd=ROOT, env=env).strip().splitlines()[0],
    }
    artifacts = {
        name: spec["path"] for name, spec in evidence_manifest["generated_artifacts"].items()
    }
    evidence = {name: spec["path"] for name, spec in evidence_manifest["transcripts"].items()}
    manifest = {
        "schema": "eliza.cpu_ap_import_manifest.v1",
        "status": "generated",
        "chipyard": {
            "repo": selected["chipyard"]["repo"],
            "tag": selected["chipyard"]["tag"],
            "commit": selected["chipyard"]["commit"],
            "recursive_submodules_recorded": True,
            "submodules": submodules,
        },
        "generation": {
            "config": "ElizaRocketConfig",
            "package": "eliza",
            "config_package": "eliza",
            "top_wrapper": "eliza_rocket_ap",
            "bootstrap_preflight_report": "build/chipyard/eliza_rocket/bootstrap-preflight.json",
            "verilator_preflight_report": "build/chipyard/eliza_rocket/verilator-preflight.json",
            "command": "python3 scripts/generate_chipyard_eliza.py",
            "tool_versions": tool_versions,
            "generated_at_utc": utc_now(),
        },
        "artifacts": artifacts,
        "artifact_sha256": {
            "generated_src_tree_sha256": sha256_tree(IMPORTED_GEN),
            "verilog_sha256": sha256_file(VERILOG),
            "dts_sha256": sha256_file(DTS),
            "simulator_sha256": sha256_tree(SIMULATOR_DIR),
        },
        "evidence": evidence,
        "evidence_sha256": {},
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    env = env_with_tools()
    run(
        [
            sys.executable,
            "scripts/check_chipyard_import_preflight.py",
            "--require-checkout",
            "--skip-remote",
        ],
        env=env,
    )
    run([sys.executable, "scripts/prepare_chipyard_spike_libraries.py"], env=env)
    run([sys.executable, "scripts/check_chipyard_verilator_preflight.py"], env=env)
    stage_bootroms()
    run_generator(env)
    import_artifacts(env)
    require_simulator_executable()
    write_manifest(env)
    run([sys.executable, "scripts/conform_chipyard_ap_dts.py"], env=env)
    print(f"STATUS: PASS chipyard.eliza_generate - wrote {rel(MANIFEST)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
