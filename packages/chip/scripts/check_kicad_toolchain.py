#!/usr/bin/env python3
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".tools" / "kicad-local"


def run(cmd: list[str]) -> tuple[int, str]:
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
        return 0, out.strip()
    except subprocess.CalledProcessError as exc:
        return exc.returncode, exc.output.strip()
    except FileNotFoundError as exc:
        return 127, str(exc)


def run_local(tool: str, *args: str) -> tuple[int, str]:
    env = {
        "PATH": f"{LOCAL / 'usr/bin'}",
        "LD_LIBRARY_PATH": str(LOCAL / "usr/lib/x86_64-linux-gnu"),
        "KICAD7_SYMBOL_DIR": str(LOCAL / "usr/share/kicad/symbols"),
        "KICAD7_FOOTPRINT_DIR": str(LOCAL / "usr/share/kicad/footprints"),
        "KICAD7_TEMPLATE_DIR": str(LOCAL / "usr/share/kicad/template"),
    }
    merged = None
    if (LOCAL / "usr/bin" / tool).is_file():
        import os

        merged = os.environ.copy()
        merged.update(env)
        merged["PATH"] = f"{env['PATH']}:{os.environ.get('PATH', '')}"
        merged["LD_LIBRARY_PATH"] = (
            f"{env['LD_LIBRARY_PATH']}:{os.environ.get('LD_LIBRARY_PATH', '')}"
        )
    try:
        out = subprocess.check_output(
            [str(LOCAL / "usr/bin" / tool), *args],
            stderr=subprocess.STDOUT,
            text=True,
            env=merged,
        )
        return 0, out.strip()
    except subprocess.CalledProcessError as exc:
        return exc.returncode, exc.output.strip()
    except FileNotFoundError as exc:
        return 127, str(exc)


def main() -> int:
    host = shutil.which("kicad-cli")
    if host:
        code, out = run(["kicad-cli", "version"])
        print(f"host kicad-cli: {out if code == 0 else 'FAILED'}")
        return code

    local = LOCAL / "usr/bin" / "kicad-cli"
    if local.is_file():
        code, out = run_local("kicad-cli", "version")
        if code != 0:
            print(f"FAIL: local kicad-cli failed\n{out}", file=sys.stderr)
            return code
        print(f"local kicad-cli: {out}")
        local_checks = [
            ("rsvg-convert", "--version"),
        ]
        for tool, arg in local_checks:
            code, out = run_local(tool, arg)
            if code != 0:
                print(f"FAIL: local {tool} failed\n{out}", file=sys.stderr)
                return code
            print(out.splitlines()[0])
        print(f"KiCad toolchain ok via local extraction {LOCAL}")
        return 0

    docker = shutil.which("docker")
    if not docker:
        print("FAIL: neither host kicad-cli nor docker is available", file=sys.stderr)
        return 1

    code, _ = run(["docker", "image", "inspect", "eliza-chip-kicad-tools:local"])
    if code != 0:
        print("FAIL: KiCad Docker image missing. Run `make kicad-setup`.", file=sys.stderr)
        return 1

    docker_checks: list[list[str]] = [
        ["scripts/kicad_run.sh", "kicad-cli", "version"],
        ["scripts/kicad_run.sh", "kibot", "--version"],
        ["scripts/kicad_run.sh", "pcbdraw", "--version"],
        [
            "scripts/kicad_run.sh",
            "python3",
            "-c",
            "import PIL, yaml, wx; print('python deps ok')",
        ],
    ]
    for cmd in docker_checks:
        code, out = run(cmd)
        if code != 0:
            print(f"FAIL: {' '.join(cmd)}\n{out}", file=sys.stderr)
            return code
        print(out)
    print("KiCad toolchain ok via Docker image eliza-chip-kicad-tools:local")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
